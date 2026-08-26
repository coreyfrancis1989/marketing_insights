# Marketing Insights — Comfort Colors Creative Board

An interactive dashboard of Meta Ads creative performance (Comfort Colors Wholesale), plus a
data-aware chat agent ("Ask the data") that answers questions grounded in the same dataset.

## What's in here

- `public/index.html` — the full dashboard (self-contained HTML/CSS/JS). Data is baked into the
  page as a snapshot — see **Refreshing the data** below.
- `data/data_summary.json` — a compact rollup of the same dataset (creatives, campaigns, and
  age/gender/platform breakdowns) that the chat agent uses as context.
- `server.js` — a small Express server. Serves `public/` as static files, and exposes
  `POST /api/chat`, which streams a response from the Claude API grounded in `data_summary.json`.

## Local development

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY
npm start
```

Visit `http://localhost:3000`.

## Deploying on Railway

This repo is set up to deploy as-is — Railway auto-detects the Node app from `package.json` and
runs `npm start`.

1. **Add the API key.** In the Railway project's service → **Variables**, add:
   - `ANTHROPIC_API_KEY` — your key from [console.anthropic.com](https://console.anthropic.com/settings/keys).

   Without this, the dashboard still works fully — only the chat agent will show a clear
   "not configured" message instead of answering.

2. **Custom domain.** In the service → **Settings → Networking → Custom Domain**, add either:
   - A subdomain, e.g. `insights.apertur.app` — Railway gives you a CNAME target to add at your
     DNS provider.
   - Or point this service behind a path on your existing site if that site can reverse-proxy to
     it (this app does not itself handle path-prefixed subfolder routing — see note below).

3. Push to `main` (or whichever branch Railway is watching) and Railway redeploys automatically.

### Subfolder vs. subdomain

This app serves everything from `/`. A **subdomain** (`insights.apertur.app`) works with zero
changes. A **subfolder** on your main site (`apertur.app/insights`) requires either:
- Your main site's server reverse-proxying that path to this Railway service, or
- Rebasing this app's asset paths and `/api/chat` calls under a fixed prefix.

If you want the subfolder route, say so and this can be adjusted.

## Refreshing the data

Both `public/index.html`'s embedded dataset and `data/data_summary.json` are point-in-time
snapshots pulled from Meta Ads via Windsor.ai. There's no scheduled refresh wired up yet — ask
to have one added (e.g. a periodic job that re-pulls from Windsor.ai and regenerates both files)
if you want the dashboard to stay current automatically.

## Cost note

The chat agent calls the Claude API (`claude-opus-5`) per question, billed to whatever
`ANTHROPIC_API_KEY` you configure — separate from any Claude subscription. The dataset context
(~22KB) is sent with a prompt-cache breakpoint, so repeated questions in the same session are
cheaper after the first.
