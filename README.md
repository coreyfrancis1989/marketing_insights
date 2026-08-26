# Marketing Insights — Comfort Colors Creative Board

An interactive dashboard of Meta Ads creative performance (Comfort Colors Wholesale), a
data-aware chat agent ("Ask the data"), and a CSV upload flow that lets you extend the dataset
yourself — mapping new columns onto the existing schema, or creating new fields on the spot.

## What's in here

- `public/index.html` — the dashboard. Fetches its data live from `/api/data` and `/api/schema`
  on every load, so uploads show up immediately without a rebuild or redeploy.
- `public/upload.html` — the upload UI: pick a CSV, review the suggested column mapping (or
  override it / create new fields), commit.
- `server.js` — Express server: static hosting, `POST /api/chat` (streams a Claude response
  grounded in the live dataset), `GET /api/data`, `GET /api/schema`, `POST /api/upload/parse`,
  `POST /api/upload/commit`, `GET /api/uploads` (history).
- `lib/taxonomy.js` — the canonical field list (date, spend, impressions, clicks, engagement,
  hook, hold, purchases, purchase_value, creative/campaign identity, age/gender/platform, ...)
  and the column-matching engine (exact match → token overlap → character-level similarity).
- `lib/store.js` — persistent storage: loads/saves the dataset as JSON files, seeds itself from
  `data/seed/` on first boot, and merges uploads in with upsert semantics (same date + creative
  = update; otherwise a new row).
- `lib/csv.js` — CSV parsing (`csv-parse`).
- `data/seed/` — the original Comfort Colors dataset, used to seed the persistent store the
  first time the app boots against an empty volume. Never touched after that.

## How the upload → mapping → dashboard flow works

1. You upload a CSV at `/upload`. Each column gets matched against the taxonomy — exactly
   (`spend` ↔ `spend`), by alias (`Amount Spent` ↔ `spend`), or fuzzily (token overlap or
   near-exact spelling, e.g. `Saved` ↔ a previously-created `Saves` field).
2. For each column you can: accept the suggested mapping, pick a different existing field,
   ignore it, or create a brand-new field (naming it, and marking it a metric or a dimension).
3. On commit, rows merge into the same dataset the dashboard reads — by `(date, creative)`, so
   re-uploading a corrected export for a date you already have replaces those rows rather than
   duplicating them.
4. Any new field you created becomes a real metric everywhere in the dashboard immediately:
   the leaderboard, the scatter axis pickers, table columns, and it's usable in the "Your
   metrics" formula builder too. It's also remembered in the taxonomy, so the *next* upload can
   match a differently-named column (`Saved`, `save_count`, ...) back onto it instead of
   creating a duplicate.
5. Age/gender/platform breakdown charts are the one thing uploads don't currently extend —
   those stay as the original seeded breakdowns regardless of what you upload. Everything else
   (creative/campaign/format/objective views, the leaderboard, the table, the chat agent)
   reflects uploads immediately.

## Local development

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm start
```

Visit `http://localhost:3000`. With no `DATA_DIR` set, uploaded data is stored in a local
`data-store/` folder (gitignored) — fine for testing, wiped if you delete that folder.

## Deploying on Railway

Auto-detected from `package.json`; runs `npm start`.

### 1. Add the API key
Service → **Variables** → add `ANTHROPIC_API_KEY` (from
[console.anthropic.com](https://console.anthropic.com/settings/keys)). Without it, everything
works except the chat agent, which shows a clear "not configured" message.

### 2. Attach a volume so uploads survive redeploys
Without this, anything uploaded lives only on the running container's disk and is **lost on the
next deploy or restart** — fine for trying the feature, not for real use.

1. Service → **Settings → Volumes → + New Volume**.
2. Mount path: **`/data`**.
3. Add an environment variable: `DATA_DIR=/data`.
4. Redeploy. On first boot with an empty volume, the app seeds `/data` from the bundled
   `data/seed/` files (the original Comfort Colors dataset) — after that, uploads accumulate on
   top of it and persist across every future deploy.

### 3. Custom domain
Service → **Settings → Networking → Custom Domain** → add your subdomain (e.g.
`insights.apertur.app`) → add the CNAME Railway gives you at your DNS provider. If your DNS
proxies through Cloudflare, either setting is fine, but if you hit a certificate error, try
switching that record to "DNS only" first.

## Cost note

The chat agent calls the Claude API (`claude-opus-5`) per question, billed to whatever
`ANTHROPIC_API_KEY` you configure — separate from any Claude subscription. Its context (a
rollup of the live dataset, not the raw upload files) is sent with a prompt-cache breakpoint, so
repeated questions in the same session are cheaper after the first.
