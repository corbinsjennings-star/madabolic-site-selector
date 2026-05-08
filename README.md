# MADabolic Site Selector

Internal tool for evaluating prospective MADabolic locations. Enter a street address, get a 0 to 100 success score with concrete pros, cons, and a benchmark match against existing locations.

## How It Works

1. You enter a prospective address.
2. The server calls Claude (Sonnet) with web search enabled. Claude pulls demographics, walkability, competition, lifestyle indicators, and housing mix data.
3. Claude scores the site across 9 weighted variables totaling 100 points.
4. You get back: total score, tier (Strong / Good / Marginal / Risky), pros and cons grounded in real data, and which existing MADabolic location the site most resembles.

## The Framework

| Variable | Weight | What It Measures |
|----------|--------|------------------|
| Population Stability | 20 | Homeownership %, residency length, married professionals |
| Psychographic Fit | 15 | Age 25-45 mix, structured professionals, identity fit |
| Walkability | 12 | Walk Score, daily anchors, mixed-use density |
| Competition Saturation | 10 | Inverse — high score means LESS saturated |
| Population Density | 10 | Sweet spot 8k to 25k per sq mi |
| Income Sweet Spot | 10 | $100k to $150k median HHI peak |
| Lifestyle Clustering | 10 | Whole Foods, run clubs, athleisure, wellness culture |
| Housing Mix | 8 | Townhomes/condos > student/short-term renter |
| Hybrid Work Patterns | 5 | WFH %, predictable schedules |

Tier cutoffs: 85+ Strong Fit, 75 to 84 Good Fit, 65 to 74 Marginal, below 65 Risky.

## Local Development

```bash
git clone <your-repo-url>
cd "Site Selection New MADabolics"
npm install
cp .env.example .env
# Edit .env to set ANTHROPIC_API_KEY and ADMIN_API_KEY
npm start
```

Open http://localhost:3000

## Deploy to Railway

1. Push this repo to GitHub.
2. Create a new Railway project at https://railway.app/new and choose **Deploy from GitHub repo**. Railway auto-detects Node and runs `npm install` then `node server.js`.
3. In Railway → Variables, set:
   - `NODE_ENV` = `production`
   - `ANTHROPIC_API_KEY` = your key from https://console.anthropic.com/
   - `ADMIN_API_KEY` = a long random string (`openssl rand -hex 32`)
4. Recommended: add a Volume to persist any locations you add manually.
   - Railway → service → Settings → Volumes → New Volume
   - Mount path: `/app/data`
   - Then set env var `DATA_DIR` = `/app/data`
5. Railway gives you a public URL like `madabolic-tool.up.railway.app`. That's the live tool.

Future updates: push to your `main` branch on GitHub, Railway auto-deploys.

## Adding More Benchmark Locations

You said you'd dump franchisee data manually. Two ways:

**Option A: Edit `data/locations.seed.json` and redeploy.** Add a new entry following the same shape as the 5 existing ones. Push to GitHub. Railway redeploys. The seed is the source of truth for fresh deploys.

**Option B: Add via admin API after deploy.** This adds a location to the runtime store without redeploying.

```bash
curl -X POST https://YOUR-DOMAIN/api/admin/locations \
  -H "Content-Type: application/json" \
  -H "x-admin-key: YOUR_ADMIN_KEY" \
  -d '{
    "id": "charleston-sc",
    "studio_address": "MADabolic Charleston, SC",
    "performance_tier": "top",
    "performance_label": "Charleston franchisee — strong retention",
    "current_members": 320,
    "peak_members": 340,
    "price_12_month": 269,
    "price_month_to_month": 329,
    "demographic_scores": {
      "stability": 17, "psychographics": 13, "walkability": 10,
      "competition": 8, "density": 7, "income": 9, "lifestyle": 9,
      "housing": 7, "hybrid": 4
    },
    "notes": "Walkable historic district, affluent professionals, low boutique fitness saturation."
  }'
```

If you add via admin API on a deploy WITHOUT a volume, the data resets on each redeploy. With a volume, it persists.

## API Endpoints

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/health` | — | Health check, shows if LLM is configured |
| GET | `/api/locations` | — | Public list of benchmark locations |
| POST | `/api/score` | — | Score a prospective address. Body: `{"address":"..."}` |
| GET | `/api/admin/locations` | `x-admin-key` | Full record dump |
| POST | `/api/admin/locations` | `x-admin-key` | Add or update a location |
| DELETE | `/api/admin/locations/:id` | `x-admin-key` | Delete a location |
| POST | `/api/admin/reseed` | `x-admin-key` | Wipe runtime store, restore seed |

## File Structure

```
.
├── server.js                     # Express app + Anthropic API integration
├── package.json
├── railway.json                  # Railway deploy config
├── .env.example
├── .gitignore
├── README.md
├── data/
│   ├── locations.seed.json       # Your 5 seed locations (committed)
│   └── locations.json            # Runtime store (gitignored, regenerates from seed)
└── public/
    └── index.html                # Site selector frontend
```

## Cost Notes

Each `/api/score` call uses Claude Sonnet with up to 6 web searches. Rough cost is around $0.10 to $0.30 per evaluation depending on how many searches Claude runs. For internal use scoring a few sites a week, that's negligible.

## Security

- `/api/score` is public on the deployed URL. If you're worried about strangers spamming it, add basic auth or move to a private subdomain.
- Admin endpoints require the `x-admin-key` header.
- No user data is stored. Past evaluations are saved in the user's browser localStorage, not on the server.

## Troubleshooting

- **`/api/score` returns 503**: `ANTHROPIC_API_KEY` is not set in Railway Variables.
- **Scores look wildly off**: Check the evidence strings under each variable in the breakdown — they tell you what data Claude pulled. If Claude made things up because the address is obscure, refine the address (add ZIP code, city, state) and try again, or use the manual sliders.
- **Data resets on each Railway deploy**: You skipped the volume step. See deploy instructions.
