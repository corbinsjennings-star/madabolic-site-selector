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
  // Migration: sync store with seed file.
  // - Adds new seed locations
  // - Refreshes demographic_scores when schema changes
  // - Removes locations that were sourced from seed but no longer exist in seed file
  // - Preserves runtime-added data (typeform/manual entries with source != 'seed')
  try {
    const seed = JSON.parse(fs.readFileSync(SEED_PATH, 'utf8'));
    const store = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
    const seedIds = new Set((seed.locations || []).map(l => l.id));
    let changed = false;

    // Remove orphaned seed-sourced entries
    const beforeCount = store.locations.length;
    store.locations = store.locations.filter(l => {
      if (l.source === 'seed' && !seedIds.has(l.id)) {
        console.log('[store] Migration: removed orphaned seed location', l.id);
        return false;
      }
      return true;
    });
    if (store.locations.length !== beforeCount) changed = true;

    // Add or refresh seed locations
    for (const seedLoc of (seed.locations || [])) {
      const existing = store.locations.find(l => l.id === seedLoc.id);
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
        const oldValues = JSON.stringify(oldScores);
        const newValues = JSON.stringify(newScores);
        if (oldKeys !== newKeys || oldValues !== newValues) {
          existing.demographic_scores = newScores;
          existing.performance_tier = seedLoc.performance_tier || existing.performance_tier;
          existing.performance_label = seedLoc.performance_label || existing.performance_label;
          existing.notes = seedLoc.notes || existing.notes;
          console.log('[store] Migration: refreshed scores for', seedLoc.id);
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
  { key: 'stability',         name: 'Population Stability',          max: 18 },
  { key: 'psychographics',    name: 'Psychographic Fit',             max: 12 },
  { key: 'walkability',       name: 'Walkability/Habit',             max: 10 },
  { key: 'competition',       name: 'Competition Saturation',        max: 9  },
  { key: 'density',           name: 'Population Density',            max: 7  },
  { key: 'income',            name: 'Income Sweet Spot',             max: 10 },
  { key: 'lifestyle',         name: 'Lifestyle Clustering',          max: 8  },
  { key: 'housing',           name: 'Housing Mix',                   max: 6  },
  { key: 'hybrid',            name: 'Hybrid Work Patterns',          max: 1  },
  { key: 'trade_area',        name: 'Habit Corridor & Drive Access', max: 13 },
  { key: 'market_momentum',   name: 'Market Momentum & Growth',      max: 6  }
];

function totalScore(scores) {
  return VARIABLES.reduce((sum, v) => sum + (scores[v.key] || 0), 0);
}
function tierFromScore(score) {
  if (score >= 85) return 'Strong Fit';
  if (score >= 75) return 'Good Fit';
  if (score >= 60) return 'Marginal';
  return 'Risky'; // Underperforming or failure profile
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

AMBIGUITY CHECK — DO THIS FIRST BEFORE ANY WEB SEARCH:
If "${address}" is ambiguous (no state given for a city name that exists in multiple states like "Arlington" / "Springfield" / "Portland" / "Columbus" / "Aurora" / "Richmond"; or no city given for a street name; or otherwise unclear which place is meant), STOP IMMEDIATELY and return ONLY this JSON, no scoring, no searches:
{
  "clarification_needed": true,
  "clarification_prompt": "1-sentence question explaining the ambiguity",
  "clarification_options": [
    {"label": "Human-readable description with city/state", "value": "Disambiguated string to use as new input"},
    {"label": "...", "value": "..."}
  ]
}
List 2-4 most-likely candidates ordered by population. Each label should include city and state plus a brief disambiguator like "(Washington DC area)" or "(Dallas-Fort Worth)". The "value" should be the cleaned-up version (e.g. "Arlington, VA" or "1234 Main St, Arlington VA").
If "${address}" is unambiguous (clear city + state, or specific complete street address), proceed normally and return the full scoring JSON. Do NOT include clarification fields when the input is clear.

When the input IS clear, your task is to score the location:


MADabolic wins in markets that are:
- Affluent but not ultra-elite. Sweet spot household income $100k-$150k. Above $200k median fragments aggressively to country clubs, private trainers, Equinox, Lifetime Fitness — DOWNGRADE these markets even if every other metric looks great.
- Stable and routine-driven. High homeownership, married professionals, long average residency. Transient populations destroy retention.
- Walkable urban villages with daily habit corridors (coffee, grocery, residential mix near studio).
- Moderate fitness culture, not oversaturated with F45, Barry's, Orangetheory, Solidcore, Burn Boot Camp.
- Age 25-45 sweet spot, peaking 32-38. Members want progression, structure, identity, real strength, not random HIIT chaos.
- Wellness culture indicators: Whole Foods, Trader Joe's, run clubs, healthy restaurants, athleisure visibility.

CRITICAL LESSONS FROM REAL DATA:

LESSON 1 — JOHNS CREEK FAILURE PATTERN:
The Johns Creek GA location FAILED despite strong demographics on paper. Why: target customers actually lived in central Alpharetta or western Johns Creek, NOT in the immediate area of the studio. Eastern State Bridge corridor is retail/office, not the residential cluster of the target demo. Heavy commute-hour traffic blocked access during key class times (6am, 5-7pm). Pass-through traffic volume at the exact spot was lower than the broader corridor suggested. Income skewed above sweet spot ($182k+ median) compounded with country-club fragmentation. THE LESSON: demographic catchment alone does NOT save a location if it's off-path from where target demo actually lives, OR if drive friction during class times is severe. SUBURBAN SPRAWL LOCATIONS (Walk Score below 30, density below 4k/sq mi, drive-only access) should score severely on Habit Corridor & Drive Access regardless of how good the broader trade area looks on paper.

LESSON 2 — URBAN VILLAGE COMPENSATION PATTERN:
Hyper-walkable urban village locations (Walk Score 85+, dense daily anchors, foot-traffic dominated) can succeed at 300+ members EVEN WHEN income, housing stability, or housing mix would otherwise look weak. Examples: Asheville South Slope works at ~300 members despite $71k median HHI (below sweet spot), apartment-heavy housing, and relatively low broader-metro density. Why: the habit corridor + lifestyle clustering at the immediate location overwhelms broader trade-area weaknesses. THE RULE: if walkability scores 9+ AND lifestyle scores 7+ AND trade_area scores 11+, apply REDUCED penalty to housing instability and below-sweet-spot income. Habit corridor compensates for tenure instability when foot traffic is the dominant acquisition channel.

LESSON 3 — MARKET-SPECIFIC DRIVABILITY:
Trade area radius MUST adjust by market type. Do not use raw mileage as a single rule:
- Walkable urban village (Asheville, Old Town Alexandria, 14th St DC): trade area is 0.5-1 mile walking radius. Drive doesn't matter.
- Dense urban core (Manhattan, downtown Chicago): trade area 5-10 minute drive or transit, ~1-2 miles.
- Affluent suburban (Atlanta, Charlotte, Dallas suburbs): customers tolerate 15-20 minute drives. Trade area 5-8 mile drive radius.
- Rural / small metro: customers tolerate 25+ minute drives. Trade area 10+ miles.
- BUT high-traffic markets (LA, DC, Atlanta peak hours) shrink effective drive-time tolerance during class times (6am, noon, 5-7pm). Score trade_area lower if peak-hour drive time from primary residential cluster exceeds market norms.

LESSON 4 — UP-AND-COMING GROWTH CORRIDOR PATTERN:
Multiple system locations succeeded by entering emerging neighborhoods early. Austin St Elmo (440 E St Elmo Rd) opened ~10 years ago when South Congress / St Elmo was up-and-coming, now consistently runs 300+ members. Asheville South Slope works because the neighborhood has been on a wellness/fitness growth trajectory for years. THE PATTERN: an emerging market with growing fitness scene + rising demographic match can WORK at 300+ members even when current density or income is below the textbook sweet spot. Conversely, established stable affluent markets (Alexandria) work for different reasons (stability + already-rooted demo). Markets that are FLAT or DECLINING (no growth, no momentum, demographic stable but unchanged) are just OK. Markets that are SHRINKING in target demo (out-migration, business closures, fitness scene cooling) are risky regardless of current state. Score market_momentum based on: population/HHI growth in last 5 years, new business openings (especially boutique fitness/wellness), neighborhood transformation indicators (mixed-use developments, new rentals attracting professionals), tech/professional employer relocations, and "energy" of the corridor.

LESSON 9 — ENTERTAINMENT DISTRICT WALKABILITY TRAP ("HOTTEST NEIGHBORHOOD" TRAP):
The most counterintuitive failure pattern. Neighborhoods with high Walk Score, high density, AND "hot" momentum can underperform because the dominant cultural use is entertainment/nightlife/tourism rather than weekday routine. Confirmed examples:
- H Street DC: trendy/nightlife corridor (262 members, underperforms)
- Ybor City Tampa (2409 E 2nd Ave): historic Latin entertainment district (~125 members)
- RiNo Denver (2520 Wewatta Way): brewery/art district, "hottest neighborhood" (low 100s members, struggling bad)
- Old Fourth Ward Atlanta (BeltLine): mixed entertainment/wellness corridor (~200 members despite great fundamentals)
THE PATTERN: same characteristics that make a neighborhood "hot" — breweries, nightlife, transient creative class, novelty turnover, entertainment density — are NEGATIVE signals for MADabolic's routine-driven 6am-and-5-7pm class consumption model. The location attracts trial but burns retention. Distinguish:
- ROUTINE-ZONE WALKABILITY (Alexandria Old Town, Cincinnati Woodburn, 14th St DC): coffee/grocery/residential intermixed, WEEKDAY morning anchors. Score walkability and trade_area HIGH (9-10 / 11-13).
- ENTERTAINMENT-ZONE WALKABILITY (H Street, RiNo, Ybor, parts of O4W): bars/breweries/restaurants/galleries dominant, evening/weekend energy. Score walkability MODERATE (6-8 max) and trade_area LOWER (5-8 max) regardless of how high the Walk Score is.
WARNING SIGNS THIS IS AN ENTERTAINMENT DISTRICT: brewery district, art district, "nightlife corridor," tourism destination, multiple bars/restaurants per block, "hottest neighborhood" media coverage, Friday-Saturday energy noticeably higher than Monday-Wednesday. If the neighborhood's identity is "fun" rather than "where I live and routine," score it as entertainment-zone.

LESSON 8 — MAJOR METRO ADJACENCY (NUANCED, NOT A KILL CRITERION):
Be careful here — earlier versions of this prompt over-penalized "metro adjacency." The actual MADabolic data shows morning consumption (6am classes, highest volume) anchors NEAR HOME before commute, not at work. So a Falls Church resident commuting to DC will still consume a Falls Church studio for morning classes. Evening fitness can fragment to commute-end, but morning is the LOCAL anchor.
The Stamford CT location's real failure was NOT generic "metro adjacency" — it was luxury rental transience (Harbor Point's 322-unit luxury rental directly across) + Manhattan-scale fitness supply siphoning. Specifically: Stamford has very high commuter density to NYC AND ultra-luxury rental dominance AND Manhattan fitness brands have brand pull even into CT. That's a triple-stack of issues, not a generic adjacency penalty.
RULE: do NOT downgrade affluent walkable suburbs of major metros just because residents commute. Falls Church, Bethesda, Vienna, Reston, Berkeley, Walnut Creek, Pasadena, Naperville, Cambridge can all support local studios because morning consumption is local. Only score adjacency-shadow penalties when the specific location has multiple confounders: luxury rental dominance + scale-supply-siphoning brand from the bigger metro + low local population. Stamford had all three. Most metro suburbs do not.

LESSON 7 — SMALL MARKET DYNAMICS (CRITICAL CALIBRATION):
Locations in small metros (city population under 75k or metro under 500k) need DIFFERENT calibration. The framework's density, walkability, and trade-area penalties were calibrated against major-metro expectations — they over-penalize small markets.
- Charlottesville VA (city pop 45k, 923 Preston Ave): 240-250 members on a strip-center stroad with student-heavy demo and below-sweet-spot income. Works because boutique alternatives are limited and wellness culture supports retention.
- Scotts Valley CA (town pop 12k, 262 Mt Hermon Rd): 230 members in a strip center despite low density (2k/sq mi). Works because there is ESSENTIALLY ZERO local competition AND a strong owner-operator.
SMALL MARKET RULES:
- 200-280 members is a SUCCESSFUL outcome in a small market (not 350+).
- When competition is sparse (1 or fewer direct competitors within 2 miles), score competition 7-9 — limited alternatives concentrate demand.
- Density penalty should soften: small markets are inherently low-density, and that's not a bug. Don't score density below 3 unless truly rural.
- Trade area penalty also softens: in small markets, customers tolerate longer drives because they have to. A 10-15 minute drive in a small town is normal.
- BUT do not soften walkability penalty — strip-center stroad in a small market is still strip-center stroad. Score walkability honestly.
- Saturation in a small market is more dangerous than in a big metro. 2-3 direct competitors in a 50k city is OVERSATURATED. Score competition 3-4 in those cases.
DISTINCTION FROM JOHNS CREEK FAILURE: small market with limited alternatives ≠ suburban sprawl with affluent fragmentation. Charlottesville/Scotts Valley work despite small-market constraints because target demo has few alternatives. Johns Creek failed because target demo had MANY alternatives (country clubs, Equinox-style privates, Lifetime Fitness) competing for their fitness spend.

LESSON 6 — TRUE URBAN VILLAGE CAN ABSORB LOCAL COMPETITION:
Cincinnati Woodburn (2543 Woodburn Ave, East Walnut Hills) is on track for 300+ members in 18 months DESPITE having a competing fitness studio (Fitness Clarified) literally 3 doors away. Why: when fundamentals are strong (income sweet spot $97-107k, true urban village walkability, $55M Woodburn Exchange momentum, perfect demo age 35-37), one local competitor doesn't kill demand — execution and differentiation handle it. Distinguish:
- TRUE URBAN VILLAGE WITH ONE LOCAL COMPETITOR (Cincinnati): absorbable. Score competition 5-7, not 2-3.
- OVERSATURATED BOUTIQUE CORRIDOR (Arlington VA): F45/Barry's/OTF/Solidcore/Burn all stacked within 1-2 miles fighting for the same finite pool. Score competition 3-5.
- OVERSATURATED + STROAD (suburban arterial in major metro with multiple competitors): Planet Fitness within 2 blocks AND F45/OTF/Solidcore stacked in a non-village layout. Score competition 4 AND walkability 4 hard.
A single direct competitor in a real urban village is FAR less damaging than 3 competitors in a saturated stroad market.

CALIBRATION ANCHORS BY ACTUAL MEMBER COUNT (use these to calibrate score gaps):
- 350+ members (Alexandria peak): score 85-90 (Strong Fit)
- 300+ members consistently in major metro (14th St, Cincinnati at 18mo, Arlington, Asheville, Austin St Elmo): score 75-83 (Good Fit)
- 250-300 members operating but underperforming target (H Street at 262 members in major metro): score 65-72 (Marginal)
- 200-250 members in small market with limited alternatives (Charlottesville at 245, Scotts Valley at 230): score 60-68 (Marginal — appropriate for small market)
- 100-200 members severely underperforming in major metro (stroad strip mall layout, multiple competitors nearby): score 45-55 (Risky)
- Closed/failed (St Petersburg, Johns Creek): score 38-48 (Risky)
The score gap between an underperforming-but-viable urban location (H Street, 262 members) and a severely-underperforming stroad location (~125 members in major metro) should be 15-20 POINTS, not 4-5. Member count differences of 2x require score gaps of 15+ points. ALSO: a 230-member small-market location with limited alternatives is NOT the same as a 230-member major-metro location with multiple competitors — context shapes whether 230 is success or failure.

LESSON 5 — STRIP MALL vs URBAN VILLAGE WALKABILITY (CRITICAL DISTINCTION):
Walk Score alone is misleading. A strip mall on a major arterial road can score Walk Score 70-80 because Starbucks/CVS/grocery are nearby — but it is NOT urban village walkability. Example failure pattern: a suburban arterial location with Walk Score 75 can struggle severely (low 100s members at 2 years) because it is a strip-center play in a car corridor where nobody walks to the gym — people drive and park, treating it as a destination not a daily-routine pass-by. Distinguish:
- TRUE URBAN VILLAGE WALKABILITY (Asheville South Slope, 14th St DC, Old Town Alexandria, Cincinnati Woodburn): residential + retail intermixed within 2-4 blocks, members walk from home, daily anchors create habit loops, foot traffic dominates. Score walkability 9-10.
- STROAD STRIP MALL (suburban arterials with retail co-tenants and big parking lots): Walk Score looks fine because there are stores nearby but the layout is car-centric, parking lots dominate, residential is separated from retail by major roads, members must drive and park. Score walkability 4-6 EVEN IF Walk Score is 70+.
- TRUE SUBURBAN SPRAWL (Johns Creek): drive-only, no walkability. Score 0-2.
For trade_area on a stroad strip mall: score 3-6. The location is a destination not a corridor pass-by. Members must DECIDE to drive there rather than passing it on their daily route.

Existing MADabolic locations as benchmarks (use these as calibration anchors):
${benchSummary}

YOUR TASK:
1. Use web search to research "${address}" — pull demographics (median household income, age distribution, homeownership %), Walk Score, boutique fitness competition within 1-2 miles, neighborhood archetype, housing mix, traffic patterns, where the target demo actually clusters relative to the address, growth trajectory of the area, AND determine if the location is true urban village walkability or strip-mall stroad walkability.
2. Score across these 11 variables (totals to 100 points):
   - stability (max 18): Homeownership %, residency length, married professionals, established families IN THE IMMEDIATE 1-MILE TRADE AREA. Higher = more rooted. Penalize "single adult dominance" without families.
   - psychographics (max 12): Fit with target member — career-driven 25-45 professionals in immediate area. Penalize if median age is over 42 or under 28.
   - walkability (max 10): TRUE URBAN VILLAGE walkability. Score 9-10 when location is on a main business district corridor with mixed-use intermixed within 2-3 blocks (coffee, restaurants, retail, residential, daily anchors), Walk Score 70+. Strip mall stroad with Walk Score 70+ but separated layouts scores only 4-6. Suburban sprawl 0-2.
   - competition (max 9): INVERSE — higher score = LESS saturated. Heavy stacking of F45/Barry's/OTF/Solidcore/Burn = low score. Planet Fitness within 2 blocks = price-point confusion penalty.
   - density (max 7): Population per sq mi. Sweet spot 8k-25k. Score 0-2 below 4k/sq mi.
   - income (max 10): MEDIAN HHI is the primary signal. Median $90-150k = bullseye sweet spot, score 9-10. Median $75-90k or $150-180k = score 7-8. Median above $200k = drop to 3-5 (fragmentation to country clubs/Equinox/Lifetime). Median below $75k = drop to 4-6 (price sensitivity, struggle to sustain $200+/mo memberships). IMPORTANT: do NOT drop the score below 8 just because the $200k+ income bracket is large or "largest bracket" — what matters is the MEDIAN. A high-end tail with bullseye median is at most a 1-2 point reduction (score 8 instead of 10), not a tanking. Bend OR example: $96k median = bullseye, score 8 even though $200k+ is largest bracket. Charlottesville example: $69k median below sweet spot = score 6 regardless of any high-end pockets.
   - lifestyle (max 8): Wellness culture indicators (Whole Foods, run clubs, athleisure, healthy restaurants).
   - housing (max 6): Townhomes/condos/owned, married professionals > student/short-term renter / single-adult dominant.
   - hybrid (max 1): Hybrid/remote work patterns, predictable schedules.
   - trade_area (max 13): Habit Corridor & Drive Access. Score on:
     * Is location IN daily routine path of target demo, or off to the side requiring a detour?
     * Drive-time from primary target residential clusters during peak hours (6am, noon, 5-7pm)?
     * Pass-through foot/vehicle traffic at THIS EXACT SPOT (not just corridor average)?
     * Is this a "drive to" destination or a "pass by" routine spot?
     Strip-mall stroad locations score 3-6. Off-path suburban score 1-4. Urban villages on commute corridors score 10-13.
   - market_momentum (max 6): Growth trajectory. Population/HHI growth, new business openings, neighborhood transformation, tech/professional employer relocations, fitness scene maturity. Booming growth corridors (Austin St Elmo, Asheville South Slope, Charlotte South End, Nashville East) score 5-6. Established stable affluent markets (Alexandria, Bethesda) score 3-4. Flat suburban sprawl scores 1-2. Shrinking markets score 0.
3. Identify which existing MADabolic benchmark location it most resembles in profile (including FAILED Johns Creek and St Pete if profiles match).
4. List 4-6 specific, concrete PROS (real reasons it could succeed at this address — cite actual data found).
5. List 3-5 specific, concrete CONS or risks (real concerns based on what you found, especially trade area / habit corridor / momentum / strip-mall mismatches).
6. NEARBY ALTERNATIVE: If your final total score is BELOW 70, identify a better-fit corridor within 15 miles of "${address}" that would score higher (target: 70+). Use the same success/failure patterns. Specify neighborhood + specific street + cross-streets. Estimate roughly what that alternative would score. If your total score is 70+, set nearby_alternative to null.

Return ONLY valid JSON, no markdown, no other text:
{
  "scores": {
    "stability": <number 0-18>,
    "psychographics": <number 0-12>,
    "walkability": <number 0-10>,
    "competition": <number 0-9>,
    "density": <number 0-7>,
    "income": <number 0-10>,
    "lifestyle": <number 0-8>,
    "housing": <number 0-6>,
    "hybrid": <number 0-1>,
    "trade_area": <number 0-13>,
    "market_momentum": <number 0-6>
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
    "trade_area": "...",
    "market_momentum": "..."
  },
  "most_similar_location": "<exact studio_address from benchmarks above>",
  "similarity_explanation": "1-2 sentences on why this profile matches that existing location",
  "pros": ["specific pro with data", "...", ...],
  "cons": ["specific con or risk", "...", ...],
  "nearby_alternative": null,
  "verdict": "3-4 sentence direct operator-level take. No fluff.",
  "confidence": "high" | "medium" | "low"
}

If total score < 70, replace "nearby_alternative": null with:
  "nearby_alternative": {
    "address": "<better corridor within 15 miles, e.g. 'Park Slope Brooklyn — 7th Ave between Union and 9th St'>",
    "estimated_score": <number 70-85>,
    "reasoning": "2-3 sentence explanation of why this is a better fit and how it differs from the original address"
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

  // Short-circuit: if AI requested clarification, return without scoring
  if (parsed.clarification_needed) {
    return parsed;
  }

  // Compute total + tier
  const total = totalScore(parsed.scores);
  return {
    ...parsed,
    total,
    tier: tierFromScore(total)
  };
}

function buildCitySearchPrompt(area, benchmarks) {
  const benchSummary = benchmarks.map(b => {
    const total = b.demographic_scores ? VARIABLES.reduce((s,v) => s + (b.demographic_scores[v.key] || 0), 0) : 0;
    const tierLabel = b.performance_tier === 'top' ? 'TOP PERFORMER' :
                      b.performance_tier === 'mid' ? 'MID-TIER' :
                      b.performance_tier === 'low' ? 'UNDERPERFORMS' :
                      b.performance_tier === 'failed' ? 'FAILED — CLOSED' : 'UNRATED';
    return `- ${b.studio_address}: ${total}/100. ${tierLabel}. ${b.notes || ''}`;
  }).join('\n');

  return `You are a site selection analyst for MADabolic, a strength-focused boutique fitness franchise. The user has asked: "where in ${area} would be the best place to put a MADabolic?"

AMBIGUITY CHECK — DO THIS FIRST BEFORE ANY WEB SEARCH:
If "${area}" is ambiguous (could refer to multiple distinct places, e.g. "Arlington" without state could be VA or TX or MA; "Springfield" could be IL/MO/MA/OR; "Portland" could be OR or ME; "Columbus" could be OH or GA; "Aurora" could be CO or IL; "Richmond" could be VA or CA; "Glendale" could be CA or AZ), STOP IMMEDIATELY and return ONLY this JSON, no scoring, no searches:
{
  "clarification_needed": true,
  "clarification_prompt": "1-sentence question explaining the ambiguity",
  "clarification_options": [
    {"label": "Human-readable description with state and disambiguator", "value": "Disambiguated string to use as new input"},
    {"label": "...", "value": "..."}
  ]
}
List 2-4 most-likely candidates ordered by population. Each label should include the full state plus a brief disambiguator like "(Washington DC area)" or "(Dallas-Fort Worth metro)" or "(Boston suburb)". The "value" should be the cleaned-up version like "Arlington, VA" or "Portland, OR".
If "${area}" is unambiguous (clear state included, or unique well-known region like "Bay Area" / "Northern Virginia" / "Triangle NC"), proceed normally with the full search and scoring. Do NOT include clarification fields when the input is clear.

When the input IS clear:
The input "${area}" may be ANY of the following, and you must adapt:
- A specific city (e.g. "Charlotte NC", "Houston TX") — search corridors within that city
- A metro region or geographic area (e.g. "Northern Virginia", "Bay Area", "Tampa Bay area", "DFW", "Inland Empire", "Triangle NC", "Front Range", "Twin Cities") — identify the candidate cities/towns/sub-areas within the region, then drill down to the best corridor in the best sub-area
- A state or large region (e.g. "Tennessee", "Florida", "Pacific Northwest") — narrow to the best metro within the area, then to the best corridor
- A neighborhood-scale input (e.g. "South End Charlotte") — score that area directly

For broader areas, your job is to NARROW IT DOWN. Examples:
- "Northern Virginia" → consider Arlington, Alexandria, Falls Church, Vienna, McLean, Reston, Tysons, Old Town Manassas, Fairfax. Pick the best sub-city, then the best corridor in that sub-city. (Note: Arlington and Alexandria already have MAD locations — flag cannibalization, recommend a different sub-area like Falls Church or Vienna.)
- "Bay Area" → consider Berkeley, Oakland, Walnut Creek, San Mateo, Palo Alto, Mill Valley, etc. Pick best sub-area, then corridor.
- "Triangle NC" → consider Raleigh, Durham, Chapel Hill, Cary. Pick best sub-area, then corridor.
- "Florida" → narrow to a metro (Tampa, Orlando, Jacksonville, etc.) then to a corridor. Avoid Jupiter (already exists).

Your task is TWO STEPS combined into one response:
STEP 1: Use web search to identify the SINGLE BEST SPECIFIC CORRIDOR within ${area} for a MADabolic location based on the success and failure patterns documented below. If the input is broad, do the narrowing inside this step.
STEP 2: Score that recommended corridor using the 11-variable framework.

MADabolic SUCCESS PATTERNS (from real franchise data):
- Affluent stable urban village with rooted demo (Alexandria VA, Cincinnati Woodburn, 14th St DC) — 300+ members
- Emerging growth corridor early entry (Austin St Elmo, Asheville South Slope) — 300+ members at maturity
- Hyper-walkable neighborhood with strong wellness culture compensates for income/housing weakness (Asheville)
- Small market with limited alternatives + strong owner-operator (Charlottesville, Scotts Valley, Jupiter) — 200-280 members
- True urban village absorbs local competition (Cincinnati works despite Fitness Clarified 3 doors away)

MADabolic FAILURE PATTERNS (kill criteria to AVOID):
- Stroad strip mall layout (suburban arterial with strip-center retail, big parking lots, residential separated from retail) — kills retention even with great Walk Score on paper
- Suburban sprawl + ultra-luxury fragmentation (Johns Creek pattern: $180k+ median, country clubs, Equinox, Lifetime competing for fitness spend)
- Major metro shadow / commuter fragmentation (Stamford pattern: cities within 1-hour rail of NYC/LA/Chicago/SF/DC/Boston where premium fitness demand bleeds to the bigger metro)
- Entertainment district trap (RiNo Denver, Tampa Ybor, H Street DC: high Walk Score and density but nightlife/brewery-dominant cultural use → trial without retention)
- Below-sweet-spot income + stroad combo (St Pete failure: $57-70k median + industrial corridor = closure)

EXISTING MADabolic LOCATIONS (FYI for context — do NOT use these as a cannibalization penalty. MAD corporate enforces territorial protection, and morning consumption anchors at home not at work, so existing nearby studios are not a meaningful negative. Score locations on their own merits.):
- Washington DC metro (Alexandria, Arlington, Dupont, H Street, 14th Street)
- Atlanta (Old Fourth Ward / Sweet Auburn)
- Austin TX (St Elmo)
- Asheville NC (South Slope)
- Bend OR (Old Bend Downtown)
- Cincinnati OH (Woodburn / East Walnut Hills)
- Charlottesville VA (Preston Ave)
- Denver CO (RiNo, Westminster)
- Jupiter FL (Indiantown Rd)
- Scotts Valley CA (Mt Hermon Rd)
- Stamford CT (Harbor Point)
- Tampa FL (Ybor City)

REFERENCE BENCHMARKS:
${benchSummary}

YOUR JOB:
1. Web-search ${area} for: best sub-areas/cities (if broad), best neighborhoods for affluent young/mid-career professionals 25-45, walkable urban villages, mixed-use corridors, recent boutique fitness openings, recent mixed-use developments, neighborhoods with $100-150k median household income.
2. If the input is a broad region/state, narrow to the best metros/sub-areas first, then identify the best corridors across those sub-areas. If the input is already a specific city, identify candidate corridors within it.
3. Identify the TOP 5 candidate corridors total, ranked from best (#1) to fifth-best (#5). Cast a wide net — across sub-cities or across neighborhoods within one city. Each corridor must be specific (city + neighborhood + street + cross-streets).
4. The #1 ranked corridor gets the full 11-variable scoring with detailed pros/cons.
5. Each of the 5 corridors (including #1) gets an estimated score (0-100) and 1-2 sentence reasoning explaining why it ranks where it does.
6. Score the #1 corridor using the full 11-variable framework.
7. Provide pros/cons specific to the #1 corridor.

If the area has no good fit (too small, too saturated, all candidates fit failure patterns), say so honestly in the verdict and give the best of bad options with low scores and warnings.

DO NOT use existing nearby MAD locations as a penalty or kill criterion. MAD corporate enforces territorial protection between franchisees. Morning consumption (the high-volume slot) anchors at home before commute, not at work. So if Falls Church scores well on its own fundamentals, recommend Falls Church even though Arlington and Alexandria exist nearby. Optional brief mention is fine but it should NOT swing the score or verdict. Recommend the corridor that best fits MAD success patterns regardless of nearby existing studios.

Return ONLY valid JSON, no markdown:
{
  "recommended_address": "<the #1 ranked corridor — city + neighborhood + street + cross-streets>",
  "recommendation_reasoning": "2-3 sentences on why this corridor is #1 over the others",
  "top_corridors": [
    {"rank": 1, "address": "<same as recommended_address>", "estimated_score": <number 0-100>, "reasoning": "1-2 sentence why this is #1"},
    {"rank": 2, "address": "<corridor 2 city + neighborhood + street>", "estimated_score": <number 0-100>, "reasoning": "1-2 sentence why this is #2"},
    {"rank": 3, "address": "<corridor 3 ...>", "estimated_score": <number 0-100>, "reasoning": "..."},
    {"rank": 4, "address": "<corridor 4 ...>", "estimated_score": <number 0-100>, "reasoning": "..."},
    {"rank": 5, "address": "<corridor 5 ...>", "estimated_score": <number 0-100>, "reasoning": "..."}
  ],
  "alternative_corridors_considered": ["<short list of any other corridors briefly considered but didn't make top 5>"],
  "scores": {
    "stability": <0-18>, "psychographics": <0-12>, "walkability": <0-10>, "competition": <0-9>,
    "density": <0-7>, "income": <0-10>, "lifestyle": <0-8>, "housing": <0-6>,
    "hybrid": <0-1>, "trade_area": <0-13>, "market_momentum": <0-6>
  },
  "evidence": {
    "stability": "...", "psychographics": "...", "walkability": "...", "competition": "...",
    "density": "...", "income": "...", "lifestyle": "...", "housing": "...",
    "hybrid": "...", "trade_area": "...", "market_momentum": "..."
  },
  "most_similar_location": "<exact studio_address from benchmarks above>",
  "similarity_explanation": "1-2 sentences",
  "pros": ["...", "...", ...],
  "cons": ["...", "...", ...],
  "verdict": "3-4 sentence operator-level take. No fluff.",
  "confidence": "high" | "medium" | "low"
}`;
}

async function findBestInCityWithLLM(area) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not configured.');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });
  const benchmarks = (loadStore().locations || []).filter(l => l.demographic_scores);
  const prompt = buildCitySearchPrompt(area, benchmarks);

  const response = await client.messages.create({
    model: SCORING_MODEL,
    max_tokens: 5000,
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
    messages: [{ role: 'user', content: prompt }]
  });

  const textBlocks = (response.content || []).filter(b => b.type === 'text').map(b => b.text);
  const fullText = textBlocks.join('\n').trim();
  let jsonStr = fullText;
  const fenceMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) jsonStr = fenceMatch[1];
  const objMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (!objMatch) throw new Error('No JSON found in city-search response: ' + fullText.slice(0, 300));
  const parsed = JSON.parse(objMatch[0]);

  // Short-circuit: if AI requested clarification, return without scoring
  if (parsed.clarification_needed) {
    return parsed;
  }

  const total = totalScore(parsed.scores);
  return { ...parsed, total, tier: tierFromScore(total) };
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

// Find best corridor in a city, region, metro area, or state
app.post('/api/find-best-in-city', async (req, res) => {
  const body = req.body || {};
  const area = (body.area || body.city || '').trim();
  if (!area || area.length < 2) {
    return res.status(400).json({ error: 'area or city required (string)' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'Scoring is not configured. Set ANTHROPIC_API_KEY.' });
  }
  try {
    console.log('[find-best] Searching:', area);
    const result = await findBestInCityWithLLM(area);
    res.json(result);
  } catch (e) {
    console.error('[find-best] Error:', e);
    res.status(500).json({ error: e.message || 'Area search failed' });
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
