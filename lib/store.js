"use strict";
const fs = require("fs");
const path = require("path");
const { BUILTIN_FIELDS } = require("./taxonomy");

// Where persisted data lives. In Railway, mount a volume here (see README).
// Locally, falls back to a folder inside the repo so `npm start` works with
// zero setup.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data-store");
const SEED_DIR = path.join(__dirname, "..", "data", "seed");

const FILES = {
  facts: "facts.json",
  creatives: "creatives.json",
  campaigns: "campaigns.json",
  breakdowns: "breakdowns.json",
  schema: "schema.json",
  meta: "meta.json",
  uploadsLog: "uploads_log.json",
};

function filePath(name) {
  return path.join(DATA_DIR, FILES[name]);
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data), "utf-8");
}

function slugify(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

let seeded = false;

/** Copy bundled seed data into DATA_DIR on first boot only. Idempotent. */
function ensureSeeded() {
  if (seeded) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(filePath("facts"))) {
    for (const key of ["facts", "creatives", "campaigns", "breakdowns", "meta"]) {
      const seedPath = path.join(SEED_DIR, FILES[key]);
      const data = readJson(seedPath, key === "meta" ? {} : key === "facts" ? [] : {});
      writeJson(filePath(key), data);
    }
    writeJson(filePath("schema"), { customFields: [] });
    writeJson(filePath("uploadsLog"), []);
    console.log(`Seeded persistent store at ${DATA_DIR} from bundled data/seed/.`);
  } else {
    console.log(`Using existing persistent store at ${DATA_DIR}.`);
  }
  seeded = true;
}

function loadAll() {
  ensureSeeded();
  return {
    facts: readJson(filePath("facts"), []),
    creatives: readJson(filePath("creatives"), {}),
    campaigns: readJson(filePath("campaigns"), {}),
    breakdowns: readJson(filePath("breakdowns"), { age: [], gender: [], platform: [] }),
    schema: readJson(filePath("schema"), { customFields: [] }),
    meta: readJson(filePath("meta"), {}),
  };
}

function getCustomFields() {
  ensureSeeded();
  return readJson(filePath("schema"), { customFields: [] }).customFields || [];
}

function getFullSchema() {
  return { builtin: BUILTIN_FIELDS, custom: getCustomFields() };
}

/** All metric keys (built-in + custom) that should be summed when aggregating. */
function getMetricKeys() {
  const custom = getCustomFields().filter((f) => f.kind === "metric").map((f) => f.key);
  const builtin = BUILTIN_FIELDS.filter((f) => f.kind === "metric").map((f) => f.key);
  return [...new Set([...builtin, ...custom])];
}

/**
 * Commit a mapped, previewed upload into the store.
 * `rows` are raw CSV objects (header -> string value).
 * `mapping` is { header: {action:'map', canonicalKey} | {action:'create', field:{key,label,type,unit}} | {action:'ignore'} }
 * Returns a summary of what happened.
 */
function commitUpload({ rows, mapping, filename }) {
  ensureSeeded();
  const facts = readJson(filePath("facts"), []);
  const creatives = readJson(filePath("creatives"), {});
  const campaigns = readJson(filePath("campaigns"), {});
  const schema = readJson(filePath("schema"), { customFields: [] });

  // Register any brand-new fields from this mapping.
  const existingKeys = new Set([...BUILTIN_FIELDS.map((f) => f.key), ...schema.customFields.map((f) => f.key)]);
  const newFieldsCreated = [];
  for (const header of Object.keys(mapping)) {
    const m = mapping[header];
    if (m && m.action === "create") {
      let key = slugify(m.field.key || m.field.label || header) || `field_${Object.keys(mapping).indexOf(header)}`;
      let n = 1;
      const base = key;
      while (existingKeys.has(key)) key = `${base}_${++n}`;
      const field = {
        key,
        label: m.field.label || header,
        kind: m.field.kind === "dimension" ? "dimension" : "metric",
        type: m.field.type || "number",
        unit: m.field.unit || "number",
        aliases: [],
        custom: true,
      };
      schema.customFields.push(field);
      existingKeys.add(key);
      newFieldsCreated.push(field);
      m.resolvedKey = key; // remember for the transform pass below
    }
  }

  const metricKeySet = new Set([
    ...BUILTIN_FIELDS.filter((f) => f.kind === "metric").map((f) => f.key),
    ...schema.customFields.filter((f) => f.kind === "metric").map((f) => f.key),
  ]);

  const factIndex = new Map(facts.map((f, i) => [`${f.date}__${f.creative_id}`, i]));
  let created = 0, updated = 0, skipped = 0;
  const warnings = [];
  let sawNoIdentity = false;

  rows.forEach((row, rowIdx) => {
    const dims = {};
    const metrics = {};
    for (const [header, rawVal] of Object.entries(row)) {
      const m = mapping[header];
      if (!m || m.action === "ignore") continue;
      const key = m.action === "create" ? m.resolvedKey : m.canonicalKey;
      if (!key) continue;
      const isMetric = metricKeySet.has(key);
      if (isMetric) {
        const n = parseFloat(String(rawVal).replace(/[,$%]/g, ""));
        metrics[key] = Number.isFinite(n) ? n : 0;
      } else {
        const v = String(rawVal ?? "").trim();
        if (v !== "") dims[key] = v;
      }
    }

    if (!dims.date) { skipped++; return; }

    let creativeId = dims.creative_id;
    if (!creativeId && dims.name) creativeId = `custom-${slugify(dims.name)}`;
    if (!creativeId) {
      creativeId = `upload-row-${filename ? slugify(filename) : "csv"}-${rowIdx}`;
      sawNoIdentity = true;
    }

    let campaignId = dims.campaign_id;
    if (!campaignId && dims.campaign_name) campaignId = `custom-camp-${slugify(dims.campaign_name)}`;

    // upsert creative dimension
    const prevCreative = creatives[creativeId] || {};
    creatives[creativeId] = {
      type: dims.type || prevCreative.type || null,
      name: dims.name || prevCreative.name || null,
      body: dims.body || prevCreative.body || null,
      thumbnail_url: dims.thumbnail_url || prevCreative.thumbnail_url || null,
    };

    // upsert campaign dimension
    if (campaignId) {
      const prevCampaign = campaigns[campaignId] || {};
      campaigns[campaignId] = {
        name: dims.campaign_name || prevCampaign.name || campaignId,
        objective: dims.objective || prevCampaign.objective || null,
      };
    }

    const factRow = {
      date: dims.date,
      creative_id: creativeId,
      type: dims.type || (creatives[creativeId] && creatives[creativeId].type) || null,
      campaign_id: campaignId || null,
      ...(dims.age ? { age: dims.age } : {}),
      ...(dims.gender ? { gender: dims.gender } : {}),
      ...(dims.platform ? { platform: dims.platform } : {}),
    };
    for (const [k, v] of Object.entries(metrics)) factRow[k] = v;

    const idxKey = `${factRow.date}__${factRow.creative_id}`;
    if (factIndex.has(idxKey)) {
      facts[factIndex.get(idxKey)] = factRow;
      updated++;
    } else {
      factIndex.set(idxKey, facts.length);
      facts.push(factRow);
      created++;
    }
  });

  if (sawNoIdentity) {
    warnings.push(
      "Some rows had neither a Creative ID nor a Creative Name mapped — each such row was stored as its own unique creative. Map one of those columns for cleaner results."
    );
  }

  writeJson(filePath("facts"), facts);
  writeJson(filePath("creatives"), creatives);
  writeJson(filePath("campaigns"), campaigns);
  writeJson(filePath("schema"), schema);

  const meta = readJson(filePath("meta"), {});
  meta.lastUploadAt = new Date().toISOString();
  writeJson(filePath("meta"), meta);

  const log = readJson(filePath("uploadsLog"), []);
  log.push({
    id: `up_${Date.now()}`,
    filename: filename || null,
    uploadedAt: new Date().toISOString(),
    rowCount: rows.length,
    created,
    updated,
    skipped,
    newFieldsCreated: newFieldsCreated.map((f) => f.key),
  });
  writeJson(filePath("uploadsLog"), log);

  return { created, updated, skipped, newFieldsCreated, warnings, totalFacts: facts.length };
}

function getUploadsLog() {
  ensureSeeded();
  return readJson(filePath("uploadsLog"), []);
}

/** Creative-level rollups (for the chat agent's data summary). */
function computeCreativeRollups(facts, creatives) {
  const byId = {};
  for (const f of facts) {
    const id = f.creative_id;
    if (!byId[id]) {
      byId[id] = { creative_id: id, spend: 0, impressions: 0, clicks: 0, engagement: 0, hook: 0, hold: 0, purchases: 0, purchase_value: 0, days: 0 };
    }
    const a = byId[id];
    a.spend += f.spend || 0;
    a.impressions += f.impressions || 0;
    a.clicks += f.clicks || 0;
    a.engagement += f.engagement || 0;
    a.hook += f.hook || 0;
    a.hold += f.hold || 0;
    a.purchases += f.purchases || 0;
    a.purchase_value += f.purchase_value || 0;
    a.days += 1;
  }
  return Object.values(byId).map((a) => {
    const cr = creatives[a.creative_id] || {};
    return {
      creative_id: a.creative_id,
      type: cr.type || null,
      name: cr.name || null,
      spend: round2(a.spend),
      impressions: a.impressions,
      clicks: a.clicks,
      ctr: pct(a.clicks, a.impressions),
      cpc: div(a.spend, a.clicks),
      cpm: a.impressions ? round2((1000 * a.spend) / a.impressions) : 0,
      engagement_rate: pct(a.engagement, a.impressions),
      hook_rate: pct(a.hook, a.impressions),
      hold_rate: pct(a.hold, a.hook),
      purchases: round2(a.purchases),
      purchase_value: round2(a.purchase_value),
      roas: a.spend ? round2(a.purchase_value / a.spend) : null,
    };
  }).sort((a, b) => b.spend - a.spend);
}

function computeCampaignRollups(facts, campaigns) {
  const byId = {};
  for (const f of facts) {
    const id = f.campaign_id || "unassigned";
    if (!byId[id]) byId[id] = { campaign_id: id, spend: 0, impressions: 0, clicks: 0 };
    byId[id].spend += f.spend || 0;
    byId[id].impressions += f.impressions || 0;
    byId[id].clicks += f.clicks || 0;
  }
  return Object.values(byId).map((a) => {
    const c = campaigns[a.campaign_id] || {};
    return {
      campaign_id: a.campaign_id,
      name: c.name || a.campaign_id,
      objective: c.objective || null,
      spend: round2(a.spend),
      impressions: a.impressions,
      ctr: pct(a.clicks, a.impressions),
    };
  }).sort((a, b) => b.spend - a.spend);
}

function round2(n) { return Math.round(n * 100) / 100; }
function div(n, d) { return d ? round2(n / d) : null; }
function pct(n, d) { return d ? round2((100 * n) / d) : 0; }

module.exports = {
  DATA_DIR,
  loadAll,
  getFullSchema,
  getCustomFields,
  getMetricKeys,
  commitUpload,
  getUploadsLog,
  computeCreativeRollups,
  computeCampaignRollups,
  slugify,
};
