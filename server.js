// MADabolic Site Selector — Express server
// - Serves the static frontend from /public
// - GET  /api/locations           -> all benchmark locations
// - POST /api/score               -> score a prospective address (calls Anthropic API with web search)
// - POST /api/admin/locations     -> add or update a location (admin)
// - DEL  /api/admin/locations/:id -> delete a location (admin)

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const cors = require('cors');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_API_KEY = process.env.ADMIN_API_KEY || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';
const SCORING_MODEL = process.env.SCORING_MODEL || 'claude-sonnet-4-5-20250929';

// ============ DATA STORE (JSON file) ============
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const SEED_PATH = path.join(__dirname, 'data', 'locations.seed.json');
const STORE_PATH = path.join(DATA_DIR, 'locations.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    fs.writeFileSync(STORE_PATH, JSON.stringify(seed, null, 2));
    console.log('[store] Initialized from seed');
    return;
  }
  // Migration: merge any new seed locations OR new demographic_scores fields into existing store.
  // Preserves runtime-added data (franchisee submissions, manual edits).
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    let changed = false;
    for (const seedLoc of (seed.locations || [])) {
      const existing = (store.locations || []).find(l => l.id === seedLoc.id);
      if (!existing) {
        store.locations.push(seedLoc);
        console.log('[store] Migration: added new seed location', seedLoc.id);
        changed = true;
      } else if (seedLoc.demographic_scores) {
        // Refresh demographic_scores from seed (the framework may have evolved)
        const oldScores = existing.demographic_scores || {};
        const newScores = seedLoc.demographic_scores;
        const oldKeys = Object.keys(oldScores).sort().join(',');
        const newKeys = Object.keys(newScores).sort().join(',');
        if (oldKeys !== newKeys) {
          existing.demographic_scores = newScores;
          existing.performance_tier = seedLoc.performance_tier || existing.performance_tier;
          existing.performance_label = seedLoc.performance_label || existing.performance_label;
          existing.notes = seedLoc.notes || existing.notes;
          console.log('[store] Migration: refreshed demographic_scores for', seedLoc.id);
          changed = true;
        }
      }
    }
    if (changed) {
      fs.writeFileSync(STORE_PATH, JSON.stringify(store, null, 2));
      console.log('[store] Migration: changes saved');
    }
  } catch (e) {
    console.warn('[store] Migration check failed:', e.message);
  }
}
function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
}
function saveStore(data) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2));
}

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  if (!ADMIN_API_KEY) return res.status(500).json({ error: 'ADMIN_API_KEY not configured on server' });
  const provided = req.headers['x-admin-key'] || req.query.admin_key;
  if (provided !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}
function newId(prefix = 'loc') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

// ============ SCORING FRAMEWORK ============
const VARIABLES = [
  { key: 'stability',      name: 'Population Stability',          max: 20 },
  { key: 'psychographics', name: 'Psychographic Fit',             max: 13 },
  { key: 'walkability',    name: 'Walkability/Habit',             max: 10 },
  { key: 'competition',    name: 'Competition Saturation',        max: 9  },
  { key: 'density',        name: 'Population Density',            max: 8  },
  { key: 'income',         name: 'Income Sweet Spot',             max: 10 },
  { key: 'lifestyle',      name: 'Lifestyle Clustering',          max: 8  },
  { key: 'housing',        name: 'Housing Mix',                   max: 6  },
  { key: 'hybrid',         name: 'Hybrid Work Patterns',          max: 2  },
  { key: 'trade_area',     name: 'Habit Corridor & Drive Access', max: 14 }
];

function totalScore(scores) {
  return VARIABLES.reduce((sum, v) => sum + (scores[v.key] || 0), 0);
}
function tierFromScore(score) {
  if (score >= 85) return 'Strong Fit';
  if (score >= 75) return 'Good Fit';
  if (score >= 60) return 'Marginal';
  return 'Risky';
}

function buildScoringPrompt(address, benchmarks) {
  const benchSummary = benchmarks.map(b => {
    const total = b.demographic_scores ? VARIABLES.reduce((s,v) => s + (b.demographic_scores[v.key] || 0), 0) : 0;
    const tierLabel = b.performance_tier === 'top' ? 'TOP PERFORMER' :
                      b.performance_tier === 'mid' ? 'MID-TIER' :
                      b.performance_tier === 'low' ? 'UNDERPERFORMS' :
                      b.performance_tier === 'failed' ? 'FAILED — CLOSED' : 'UNRATED';
    return `- ${b.studio_address}: ${total}/100. ${tierLabel}. ${b.notes || ''}`;
  }).join('\n');

  return `You are a site selection analyst for MADabolic, a strength-focused boutique fitness franchise. Score the prospective location at "${address}" for likelihood of success.

MADabolic wins in markets that are:
- Affluent but not ultra-elite. Sweet spot household income $100k-$150k. Above $200k median fragments aggressively to country clubs, private trainers, Equinox, Lifetime Fitness — DOWNGRADE these markets even if every other metric looks great.
- Stable and routine-driven. High homeownership, married professionals, long average residency. Transient populations destroy retention.
- Walkable urban villages with daily habit corridors (coffee, grocery, residential mix near studio).
- Moderate fitness culture, not oversaturated with F45, Barry's, Orangetheory, Solidcore, Burn Boot Camp.
- Age 25-45 sweet spot, peaking 32-38. Members want progression, structure, identity, real strength, not random HIIT chaos.
- Wellness culture indicators: Whole Foods, Trader Joe's, run clubs, healthy restaurants, athleisure visibility.

CRITICAL LESSON FROM A FAILED LOCATION:
The Johns Creek GA location FAILED despite strong demographics on paper. Why: target customers actually lived in central Alpharetta or western Johns Creek, NOT in the immediate area of the studio. Eastern State Bridge corridor is retail/office, not the residential cluster of the target demo. Heavy commute-hour traffic blocked access during key class times (6am, 5-7pm). Pass-through traffic volume at the exact spot was lower than the broader corridor suggested. Income skewed above sweet spot ($182k+ median) compounded with country-club fragmentation. THE LESSON: demographic catchment alone does NOT save a location if it's off-path from where target demo actually lives, OR if drive friction during class times is severe. SUBURBAN SPRAWL LOCATIONS (Walk Score below 30, density below 4k/sq mi, drive-only access) should score severely on Habit Corridor & Drive Access regardless of how good the broader trade area looks on paper.

Existing MADabolic locations as benchmarks (use these as calibration anchors):
${benchSummary}

YOUR TASK:
1. Use web search to research "${address}" — pull demographics (median household income, age distribution, homeownership %), Walk Score, boutique fitness competition within 1-2 miles, neighborhood archetype, housing mix, traffic patterns, where the target demo actually clusters relative to the address.
2. Score across these 10 variables (totals to 100 points):
   - stability (max 20): Homeownership %, residency length, married professionals, established families IN THE IMMEDIATE 1-MILE TRADE AREA. Higher = more rooted.
   - psychographics (max 13): Fit with target member — career-driven 25-45 professionals in immediate area. Penalize if median age is over 42 or under 28.
   - walkability (max 10): Walk Score, daily anchors, mixed-use density. Score 0-2 for car-dependent suburban sprawl.
   - competition (max 9): INVERSE — higher score = LESS saturated. Heavy stacking of F45/Barry's/OTF/Solidcore = low score.
   - density (max 8): Population per sq mi. Sweet spot 8k-25k. Score 0-2 below 4k/sq mi.
   - income (max 10): Median HHI sweet spot $100-150k peaks at 10. Above $200k median: drop to 3-5. Below $75k: drop to 4-6.
   - lifestyle (max 8): Wellness culture indicators (Whole Foods, run clubs, athleisure, healthy restaurants).
   - housing (max 6): Townhomes/condos/owned > student/short-term renter.
   - hybrid (max 2): Hybrid/remote work patterns, predictable schedules.
   - trade_area (max 14): NEW VARIABLE. Habit Corridor & Drive Access. Score on these factors:
     * Is the location IN the daily routine path of the target demo, or off to the side requiring a detour?
     * Drive-time from the primary target residential clusters during peak hours (6am, noon, 5-7pm class times)?
     * Pass-through traffic volume at THIS EXACT SPOT (not just the corridor average)?
     * Is this a destination people drive TO, or a place they pass naturally during their daily routine?
     Off-path suburban locations with bad commute-hour access should score 1-4 here. Urban villages on commute corridors should score 11-14.
3. Identify which existing MADabolic location it most resembles in profile (including the FAILED Johns Creek location if the profile matches).
4. List 4-6 specific, concrete PROS (real reasons it could succeed at this address — cite actual data found).
5. List 3-5 specific, concrete CONS or risks (real concerns based on what you found, especially any trade area / habit corridor mismatches).

Return ONLY valid JSON, no markdown, no other text:
{
  "scores": {
    "stability": <number 0-20>,
    "psychographics": <number 0-13>,
    "walkability": <number 0-10>,
    "competition": <number 0-9>,
    "density": <number 0-8>,
    "income": <number 0-10>,
    "lifestyle": <number 0-8>,
    "housing": <number 0-6>,
    "hybrid": <number 0-2>,
    "trade_area": <number 0-14>
  },
  "evidence": {
    "stability": "1-sentence specific reason citing data",
    "psychographics": "...",
    "walkability": "...",
    "competition": "...",
    "density": "...",
    "income": "...",
    "lifestyle": "...",
    "housing": "...",
    "hybrid": "...",
    "trade_area": "..."
  },
  "most_similar_location": "<exact studio_address from benchmarks above>",
  "similarity_explanation": "1-2 sentences on why this profile matches that existing location",
  "pros": ["specific pro with data", "...", ...],
  "cons": ["specific con or risk", "...", ...],
  "verdict": "3-4 sentence direct operator-level take. No fluff.",
  "confidence": "high" | "medium" | "low"
}`;
}

async function scoreAddressWithLLM(address) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY not configured. Set it in environment variables.');
  }
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const benchmarks = (loadStore().locations || []).filter(l => l.demographic_scores);
  const prompt = buildScoringPrompt(address, benchmarks);

  const response = await client.messages.create({
    model: SCORING_MODEL,
    max_tokens: 4000,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 6
    }],
    messages: [{ role: 'user', content: prompt }]
  });

  // Concatenate text blocks from final response
  const textBlocks = (response.content || []).filter(b => b.type === 'text').map(b => b.text);
  const fullText = textBlocks.join('\n').trim();

  // Extract JSON (may be wrapped in code fence or have other text)
  let jsonStr = fullText;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1];
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('No JSON found in response: ' + fullText.slice(0, 300));
  const parsed = JSON.parse(objMatch[0]);

  // Compute total + tier
  const total = totalScore(parsed.scores);
  return {
    ...parsed,
    total,
    tier: tierFromScore(total)
  };
}

// ============ ROUTES ============
app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '1.0.0', uptime_seconds: Math.floor(process.uptime()), llm_configured: !!ANTHROPIC_API_KEY });
});

// Public: list all locations
app.get('/api/locations', (req, res) => {
  const store = loadStore();
  const locations = (store.locations || []).map(l => ({
    id: l.id,
    studio_address: l.studio_address,
    neighborhood: l.neighborhood || null,
    city: l.city || null,
    state: l.state || null,
    performance_tier: l.performance_tier || null,
    performance_label: l.performance_label || null,
    opened_date: l.opened_date || null,
    class_capacity: l.class_capacity || null,
    price_12_month: l.price_12_month || null,
    price_month_to_month: l.price_month_to_month || null,
    current_members: l.current_members || null,
    peak_members: l.peak_members || null,
    avg_leads: l.avg_leads || null,
    avg_trials: l.avg_trials || null,
    avg_new_members: l.avg_new_members || null,
    avg_terminations: l.avg_terminations || null,
    commitment_split: l.commitment_split || null,
    gender_split: l.gender_split || null,
    avg_member_age: l.avg_member_age || null,
    competitors_2mi: l.competitors_2mi || null,
    parking_issue: l.parking_issue || null,
    demographic_scores: l.demographic_scores || null,
    notes: l.notes || null,
    source: l.source || null
  }));
  res.json({ locations });
});

// Score a prospective address
app.post('/api/score', async (req, res) => {
  const { address } = req.body || {};
  if (!address || typeof address !== 'string' || address.trim().length < 3) {
    return res.status(400).json({ error: 'address required (string, min 3 chars)' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Scoring is not configured. Set ANTHROPIC_API_KEY in environment variables.' });
  }
  try {
    console.log('[score] Scoring:', address);
    const result = await scoreAddressWithLLM(address.trim());
    res.json(result);
  } catch (e) {
    console.error('[score] Error:', e);
    res.status(500).json({ error: e.message || 'Scoring failed' });
  }
});

// Admin: full record dump
app.get('/api/admin/locations', requireAdmin, (req, res) => {
  res.json(loadStore());
});

// Admin: add or update a location
app.post('/api/admin/locations', requireAdmin, (req, res) => {
  const body = req.body || {};
  if (!body.studio_address) return res.status(400).json({ error: 'studio_address required' });
  const store = loadStore();
  const id = body.id || slugify(body.studio_address) || newId('loc');
  const idx = store.locations.findIndex(l => l.id === id);
  const record = {
    ...(idx >= 0 ? store.locations[idx] : {}),
    ...body,
    id,
    updated_at: new Date().toISOString()
  };
  if (idx >= 0) store.locations[idx] = record;
  else store.locations.push(record);
  saveStore(store);
  res.json({ ok: true, location: record });
});

// Admin: delete
app.delete('/api/admin/locations/:id', requireAdmin, (req, res) => {
  const store = loadStore();
  const before = store.locations.length;
  store.locations = store.locations.filter(l => l.id !== req.params.id);
  if (store.locations.length === before) return res.status(404).json({ error: 'Not found' });
  saveStore(store);
  res.json({ ok: true });
});

// Admin: reseed
app.post('/api/admin/reseed', requireAdmin, (req, res) => {
  const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
  saveStore(seed);
  res.json({ ok: true });
});

// Fallback: serve frontend
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ START ============
ensureStore();
app.listen(PORT, () => {
  console.log(`MADabolic Site Selector running on port ${PORT}`);
  console.log(`  Frontend:      http://localhost:${PORT}/`);
  console.log(`  Score API:     POST /api/score  { "address": "..." }`);
  if (!ANTHROPIC_API_KEY) console.log('  WARN: ANTHROPIC_API_KEY not set — scoring endpoint will return 503');
  if (!ADMIN_API_KEY) console.log('  WARN: ADMIN_API_KEY not set — admin endpoints will return 500');
});
