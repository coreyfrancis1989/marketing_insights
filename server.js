const express = require("express");
const multer = require("multer");
const path = require("path");
const Anthropic = require("@anthropic-ai/sdk");

const store = require("./lib/store");
const { suggestMapping } = require("./lib/taxonomy");
const { parseCsv } = require("./lib/csv");

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// API responses are always dynamic (they reflect the latest uploads) — never
// let a browser or intermediary cache them, or a refresh after uploading can
// silently show stale data.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  next();
});

const PORT = process.env.PORT || 3000;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const OBJECTIVE_LABELS = {
  OUTCOME_AWARENESS: "Awareness",
  OUTCOME_ENGAGEMENT: "Engagement",
  OUTCOME_TRAFFIC: "Traffic",
  OUTCOME_SALES: "Sales",
  OUTCOME_LEADS: "Leads",
  OUTCOME_APP_PROMOTION: "App Promotion",
};

// In-memory holding area for a parsed-but-not-yet-committed upload.
// Keyed by uploadId; expires after a short window so memory doesn't grow.
const pendingUploads = new Map();
const PENDING_TTL_MS = 30 * 60 * 1000;
function stashPending(id, data) {
  pendingUploads.set(id, { data, expiresAt: Date.now() + PENDING_TTL_MS });
  for (const [k, v] of pendingUploads) if (v.expiresAt < Date.now()) pendingUploads.delete(k);
}
function takePending(id) {
  const entry = pendingUploads.get(id);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.data;
}

// ---------- dashboard data (dynamic, reflects uploads immediately) ----------
app.get("/api/data", (req, res) => {
  try {
    const { facts, creatives, campaigns, breakdowns, meta } = store.loadAll();

    const creativesArr = Object.entries(creatives).map(([creative_id, c]) => ({
      creative_id, type: c.type, title: c.name, body: c.body, thumb: c.thumbnail_url,
    }));
    const campaignsArr = Object.entries(campaigns).map(([campaign_id, c]) => ({
      campaign_id, name: c.name, objective: c.objective,
      objective_label: OBJECTIVE_LABELS[c.objective] || c.objective || "Other",
    }));
    const dates = facts.map((f) => f.date).filter(Boolean).sort();

    res.json({
      creatives: creativesArr,
      campaigns: campaignsArr,
      facts,
      breakdowns,
      meta: {
        account: meta.account || "Comfort Colors Wholesale",
        source: meta.source || "Meta Ads via Windsor.ai",
        date_from: dates[0] || null,
        date_to: dates[dates.length - 1] || null,
      },
    });
  } catch (err) {
    console.error("GET /api/data failed:", err);
    res.status(500).json({ error: "Could not load data." });
  }
});

app.get("/api/schema", (req, res) => {
  try {
    res.json(store.getFullSchema());
  } catch (err) {
    res.status(500).json({ error: "Could not load schema." });
  }
});

app.get("/api/uploads", (req, res) => {
  try {
    res.json(store.getUploadsLog());
  } catch (err) {
    res.status(500).json({ error: "Could not load upload history." });
  }
});

// Removes an unused custom field (e.g. one created by an upload that ended
// up importing zero rows). Refuses if any fact row actually has data under
// that key — see lib/store.js.
app.delete("/api/schema/custom/:key", (req, res) => {
  try {
    const result = store.deleteCustomField(req.params.key);
    res.json(result);
  } catch (err) {
    const status = err.code === "FIELD_IN_USE" ? 409 : err.code === "NOT_FOUND" ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// ---------- upload: parse + suggest mapping (does not persist anything) ----------
app.post("/api/upload/parse", upload.single("file"), (req, res) => {
  if (!req.file) {
    res.status(400).json({ error: "No file was uploaded (expected form field `file`)." });
    return;
  }
  let headers, rows;
  try {
    ({ headers, rows } = parseCsv(req.file.buffer.toString("utf-8")));
  } catch (err) {
    res.status(400).json({ error: err.message });
    return;
  }
  if (rows.length > 20000) {
    res.status(400).json({ error: `This file has ${rows.length.toLocaleString()} rows — please split uploads under 20,000 rows.` });
    return;
  }

  const customFields = store.getCustomFields();
  const suggestions = suggestMapping(headers, customFields);
  const uploadId = `parsed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  stashPending(uploadId, { rows, filename: req.file.originalname });

  res.json({
    uploadId,
    filename: req.file.originalname,
    rowCount: rows.length,
    columns: headers,
    sampleRows: rows.slice(0, 5),
    suggestions,
    schema: store.getFullSchema(),
  });
});

// ---------- upload: commit a confirmed mapping ----------
app.post("/api/upload/commit", (req, res) => {
  const { uploadId, mapping } = req.body || {};
  if (!uploadId || !mapping) {
    res.status(400).json({ error: "Request must include `uploadId` and `mapping`." });
    return;
  }
  const pending = takePending(uploadId);
  if (!pending) {
    res.status(410).json({ error: "This upload has expired or was already committed. Please upload the file again." });
    return;
  }
  try {
    const result = store.commitUpload({ rows: pending.rows, mapping, filename: pending.filename });
    pendingUploads.delete(uploadId);
    res.json(result);
  } catch (err) {
    console.error("Upload commit failed:", err);
    res.status(500).json({ error: err.message || "Could not commit the upload." });
  }
});

// ---------- chat agent ----------
function buildSystemPrompt() {
  const { facts, creatives, campaigns } = store.loadAll();
  const creativeRollups = store.computeCreativeRollups(facts, creatives);
  const campaignRollups = store.computeCampaignRollups(facts, campaigns);
  const brandRollups = store.computeBrandRollups(facts);
  const totalSpend = facts.reduce((s, f) => s + (f.spend || 0), 0);
  const totalImpr = facts.reduce((s, f) => s + (f.impressions || 0), 0);
  const totalClicks = facts.reduce((s, f) => s + (f.clicks || 0), 0);
  const dates = facts.map((f) => f.date).filter(Boolean).sort();
  const periodRows = facts.filter((f) => f.period_start).length;

  const dataset = {
    totals: {
      spend: Math.round(totalSpend * 100) / 100,
      impressions: totalImpr,
      clicks: totalClicks,
      ctr: totalImpr ? Math.round((10000 * totalClicks) / totalImpr) / 100 : 0,
      date_from: dates[0] || null,
      date_to: dates[dates.length - 1] || null,
    },
    metric_definitions: {
      ctr: "clicks / impressions * 100",
      cpc: "spend / clicks",
      cpm: "spend / impressions * 1000",
      engagement_rate: "engagement / impressions * 100",
      hook_rate: "3-second video plays (hook) / impressions * 100",
      hold_rate: "ThruPlays (hold) / hook * 100",
      roas: "purchase_value / spend",
      note: "Fields prefixed 'reported_', plus vtr/vcr/frequency, are rates the source platform reported directly (not derived from raw counts here) — they're weighted-averaged by impressions across rows, never summed.",
    },
    brands: brandRollups,
    campaigns: campaignRollups,
    creatives: creativeRollups,
  };
  if (periodRows > 0) {
    dataset.note = `${periodRows} row(s) in this dataset are lifetime/cumulative totals for a date range (no daily breakdown), not single-day figures — they're already folded into the totals and rollups above correctly, but don't imply a daily trend for them.`;
  }
  const dataJson = JSON.stringify(dataset);

  return `You are a marketing analyst embedded in a cross-channel creative-performance dashboard. The dataset spans multiple brands and ad platforms, and may include data uploaded manually by the user in addition to any originally-connected source — don't assume every row is from the same brand or platform.

Answer questions about this dataset precisely and concisely, in plain language a marketer would use — not a data engineer. Always ground answers in the numbers below; never invent figures. If a question can't be answered from this data, say so plainly instead of guessing. When a question could mean multiple brands, ask which one or answer for all of them clearly labeled.

Formatting: short paragraphs or a tight bullet list. Lead with the answer, then the supporting number(s). Cite spend in $ and rates as %. Name creatives/campaigns/brands by their actual name, not their ID, unless the name is missing.

Dataset (JSON):
${dataJson}`;
}

app.post("/api/chat", async (req, res) => {
  const { messages } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    res.status(400).json({ error: "Request body must include a non-empty `messages` array." });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({
      error: "ANTHROPIC_API_KEY is not set on the server. Add it as an environment variable in Railway, then redeploy.",
    });
    return;
  }

  const cleanMessages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .slice(-40)
    .map((m) => ({ role: m.role, content: m.content }));

  if (cleanMessages.length === 0 || cleanMessages[0].role !== "user") {
    res.status(400).json({ error: "Message history must start with a `user` message." });
    return;
  }

  let systemPrompt;
  try {
    systemPrompt = buildSystemPrompt();
  } catch (err) {
    console.error("Could not build chat context:", err);
    res.status(500).json({ error: "Could not load the dataset for the chat agent." });
    return;
  }

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");

  const client = new Anthropic();

  try {
    const stream = client.messages.stream({
      model: "claude-opus-5",
      max_tokens: 4096,
      system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: cleanMessages,
    });

    stream.on("text", (delta) => res.write(delta));
    stream.on("error", (err) => {
      console.error("Anthropic stream error:", err);
      try { res.write(`\n\n[error: ${err.message || "the model call failed"}]`); res.end(); } catch (_) {}
    });

    await stream.finalMessage();
    res.end();
  } catch (err) {
    console.error("Chat request failed:", err);
    if (!res.headersSent) {
      const status = err && err.status ? err.status : 500;
      res.status(status).json({ error: err.message || "Chat request failed." });
    } else {
      try { res.write(`\n\n[error: ${err.message || "the model call failed"}]`); res.end(); } catch (_) {}
    }
  }
});

app.get("/api/health", (req, res) => {
  let dataOk = false, factCount = 0;
  try {
    factCount = store.loadAll().facts.length;
    dataOk = true;
  } catch (_) {}
  res.json({
    ok: true,
    dataLoaded: dataOk,
    factCount,
    apiKeyConfigured: !!process.env.ANTHROPIC_API_KEY,
    dataDir: store.DATA_DIR,
  });
});

app.get("/upload", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "upload.html"));
});

app.listen(PORT, () => {
  console.log(`Marketing insights app listening on port ${PORT}`);
  console.log(`Persistent data directory: ${store.DATA_DIR}`);
});
