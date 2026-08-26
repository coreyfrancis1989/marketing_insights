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

/** All rate keys (built-in + custom) — pre-computed ratios, weighted-averaged by
 * impressions when aggregating, never summed. */
function getRateKeys() {
  const custom = getCustomFields().filter((f) => f.kind === "rate").map((f) => f.key);
  const builtin = BUILTIN_FIELDS.filter((f) => f.kind === "rate").map((f) => f.key);
  return [...new Set([...builtin, ...custom])];
}

/**
 * Remove a custom field from the schema — e.g. cleaning up a field created
 * by an upload that ended up importing zero rows (a bad column mapping, or
 * every row lacking a usable date). Refuses if any fact row actually
 * carries a value for that key, so it can never silently drop real data.
 */
function deleteCustomField(key) {
  ensureSeeded();
  const facts = readJson(filePath("facts"), []);
  const inUse = facts.some((f) => Object.prototype.hasOwnProperty.call(f, key));
  if (inUse) {
    const err = new Error(`"${key}" has data on at least one row — refusing to delete it. Remove those rows first if you really want it gone.`);
    err.code = "FIELD_IN_USE";
    throw err;
  }
  const schema = readJson(filePath("schema"), { customFields: [] });
  const before = schema.customFields.length;
  schema.customFields = schema.customFields.filter((f) => f.key !== key);
  if (schema.customFields.length === before) {
    const err = new Error(`No custom field named "${key}".`);
    err.code = "NOT_FOUND";
    throw err;
  }
  writeJson(filePath("schema"), schema);
  return { deleted: key };
}

/**
 * Reclassify a custom field's kind/unit/label without touching any fact
 * data — e.g. a field that arrived as generic "metric" (summable) but is
 * actually a reported rate/cost-per value that should be weighted-averaged
 * instead. This is metadata-only: existing values on fact rows are
 * untouched, they just get aggregated correctly from now on.
 */
function updateCustomField(key, patch) {
  ensureSeeded();
  const schema = readJson(filePath("schema"), { customFields: [] });
  const field = schema.customFields.find((f) => f.key === key);
  if (!field) {
    const err = new Error(`No custom field named "${key}".`);
    err.code = "NOT_FOUND";
    throw err;
  }
  if (patch.kind && ["metric", "rate", "dimension"].includes(patch.kind)) field.kind = patch.kind;
  if (patch.unit) field.unit = patch.unit;
  if (patch.label) field.label = patch.label;
  writeJson(filePath("schema"), schema);
  return field;
}

/**
 * Move every fact row's value from one field key to another (e.g. an
 * upload created a duplicate custom field for something a later taxonomy
 * update added as a proper builtin) and remove the now-empty custom field
 * definition. Never overwrites a value the target key already has — if a
 * row somehow carries both, the existing target value wins and the source
 * value is just dropped for that row (surfaced in the return count).
 */
function mergeFieldInto(fromKey, toKey) {
  ensureSeeded();
  if (fromKey === toKey) throw Object.assign(new Error("Source and target are the same field."), { code: "BAD_REQUEST" });
  const facts = readJson(filePath("facts"), []);
  let moved = 0, skippedConflict = 0;
  for (const f of facts) {
    if (!Object.prototype.hasOwnProperty.call(f, fromKey)) continue;
    if (Object.prototype.hasOwnProperty.call(f, toKey)) { skippedConflict++; }
    else { f[toKey] = f[fromKey]; moved++; }
    delete f[fromKey];
  }
  writeJson(filePath("facts"), facts);

  const schema = readJson(filePath("schema"), { customFields: [] });
  schema.customFields = schema.customFields.filter((cf) => cf.key !== fromKey);
  writeJson(filePath("schema"), schema);

  return { fromKey, toKey, moved, skippedConflict };
}

/**
 * Commit a mapped, previewed upload into the store.
 * `rows` are raw CSV objects (header -> string value).
 * `mapping` is { header: {action:'map', canonicalKey} | {action:'create', field:{key,label,type,unit}} | {action:'ignore'} }
 * Returns a summary of what happened.
 */
function commitUpload({ rows, mapping, filename, defaultPeriod }) {
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
        kind: ["dimension", "rate"].includes(m.field.kind) ? m.field.kind : "metric",
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

  // Metrics are summed when rows are aggregated; rates are weighted-averaged
  // (never summed) — both get numeric-parsed at ingestion, the distinction
  // only matters downstream in the rollup functions.
  const metricKeySet = new Set([
    ...BUILTIN_FIELDS.filter((f) => f.kind === "metric").map((f) => f.key),
    ...schema.customFields.filter((f) => f.kind === "metric").map((f) => f.key),
  ]);
  const rateKeySet = new Set([
    ...BUILTIN_FIELDS.filter((f) => f.kind === "rate").map((f) => f.key),
    ...schema.customFields.filter((f) => f.kind === "rate").map((f) => f.key),
  ]);
  const numericKeySet = new Set([...metricKeySet, ...rateKeySet]);

  // Dimension keys already handled explicitly below (identity, upserted
  // into dim tables, or folded into the date/period anchor) — anything
  // else dimension-shaped just rides along on the fact row as-is, which
  // is what lets brand/channel/age/gender/platform/etc. all work without
  // bespoke code per field.
  const CONSUMED_DIM_KEYS = new Set([
    "date", "period_start", "period_end", "creative_id", "name", "body",
    "thumbnail_url", "type", "campaign_id", "campaign_name", "objective",
  ]);

  const factIndex = new Map(facts.map((f, i) => [`${f.date}__${f.creative_id}`, i]));
  let created = 0, updated = 0, skipped = 0;
  const warnings = [];
  let sawNoIdentity = false;
  let sawPeriodOnly = false;

  rows.forEach((row, rowIdx) => {
    const dims = {};
    const numerics = {};
    for (const [header, rawVal] of Object.entries(row)) {
      const m = mapping[header];
      if (!m || m.action === "ignore") continue;
      const key = m.action === "create" ? m.resolvedKey : m.canonicalKey;
      if (!key) continue;
      if (numericKeySet.has(key)) {
        const n = parseFloat(String(rawVal).replace(/[,$%]/g, ""));
        numerics[key] = Number.isFinite(n) ? n : 0;
      } else {
        const v = String(rawVal ?? "").trim();
        if (v !== "") dims[key] = v;
      }
    }

    if (!dims.date && !dims.period_start) {
      // No date/period column mapped for this row (or the file has none at
      // all, common for lifetime-totals exports) — fall back to the
      // upload-level default period the user set instead of dropping the
      // row entirely.
      if (defaultPeriod && defaultPeriod.start) {
        dims.period_start = defaultPeriod.start;
        dims.period_end = defaultPeriod.end || defaultPeriod.start;
      } else {
        skipped++;
        return;
      }
    }
    if (!dims.date && dims.period_start) sawPeriodOnly = true;

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
      date: dims.date || dims.period_start,
      creative_id: creativeId,
      type: dims.type || (creatives[creativeId] && creatives[creativeId].type) || null,
      campaign_id: campaignId || null,
    };
    if (dims.period_start) {
      factRow.period_start = dims.period_start;
      factRow.period_end = dims.period_end || dims.period_start;
    }
    for (const [k, v] of Object.entries(dims)) {
      if (!CONSUMED_DIM_KEYS.has(k)) factRow[k] = v; // brand, channel, age, gender, platform, ...
    }
    for (const [k, v] of Object.entries(numerics)) factRow[k] = v;

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
  if (sawPeriodOnly) {
    warnings.push(
      "Some rows had no per-row date, only a Period Start/End — they were stored as lifetime totals for that period, not a daily breakdown. They'll count correctly in totals and the leaderboard, but won't show on the daily trend chart."
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

/**
 * Aggregate a group of fact rows: metric keys are summed; rate keys are
 * weighted-averaged by impressions (never summed — averaging a set of
 * percentages/costs is what makes them meaningful across rows).
 */
function aggregateRows(rows, metricKeys, rateKeys) {
  const a = { impressions: 0, clicks: 0, spend: 0, days: 0 };
  for (const k of metricKeys) a[k] = 0;
  const rateWeighted = {}; // key -> {sum: value*weight, weight}
  for (const k of rateKeys) rateWeighted[k] = { sum: 0, weight: 0 };

  for (const f of rows) {
    for (const k of metricKeys) a[k] += f[k] || 0;
    const weight = f.impressions || 0;
    for (const k of rateKeys) {
      if (typeof f[k] === "number" && weight > 0) {
        rateWeighted[k].sum += f[k] * weight;
        rateWeighted[k].weight += weight;
      }
    }
    a.days += 1;
  }
  const rates = {};
  for (const k of rateKeys) {
    rates[k] = rateWeighted[k].weight ? round2(rateWeighted[k].sum / rateWeighted[k].weight) : null;
  }
  return { ...a, rates };
}

/** Creative-level rollups (for the chat agent's data summary). */
function computeCreativeRollups(facts, creatives) {
  const metricKeys = [...getMetricKeys()].filter((k) => !["spend", "impressions", "clicks"].includes(k));
  const rateKeys = getRateKeys();
  const byId = {};
  for (const f of facts) {
    (byId[f.creative_id] = byId[f.creative_id] || []).push(f);
  }
  return Object.entries(byId).map(([id, rows]) => {
    const a = aggregateRows(rows, ["spend", "impressions", "clicks", ...metricKeys], rateKeys);
    const cr = creatives[id] || {};
    return {
      creative_id: id,
      type: cr.type || null,
      name: cr.name || null,
      spend: round2(a.spend),
      impressions: a.impressions,
      clicks: a.clicks,
      ctr: pct(a.clicks, a.impressions),
      cpc: div(a.spend, a.clicks),
      cpm: a.impressions ? round2((1000 * a.spend) / a.impressions) : 0,
      engagement_rate: pct(a.engagement || 0, a.impressions),
      hook_rate: pct(a.hook || 0, a.impressions),
      hold_rate: pct(a.hold || 0, a.hook || 0),
      purchases: round2(a.purchases || 0),
      purchase_value: round2(a.purchase_value || 0),
      roas: a.spend ? round2((a.purchase_value || 0) / a.spend) : null,
      ...a.rates, // reported_ctr, vtr, vcr, frequency, etc. — weighted averages, when present
    };
  }).sort((a, b) => b.spend - a.spend);
}

function computeCampaignRollups(facts, campaigns) {
  const rateKeys = getRateKeys();
  const byId = {};
  for (const f of facts) {
    const id = f.campaign_id || "unassigned";
    (byId[id] = byId[id] || []).push(f);
  }
  return Object.entries(byId).map(([id, rows]) => {
    const a = aggregateRows(rows, ["spend", "impressions", "clicks"], rateKeys);
    const c = campaigns[id] || {};
    return {
      campaign_id: id,
      name: c.name || id,
      objective: c.objective || null,
      spend: round2(a.spend),
      impressions: a.impressions,
      ctr: pct(a.clicks, a.impressions),
    };
  }).sort((a, b) => b.spend - a.spend);
}

function computeBrandRollups(facts) {
  const byBrand = {};
  for (const f of facts) {
    const b = f.brand || "Unspecified";
    (byBrand[b] = byBrand[b] || []).push(f);
  }
  return Object.entries(byBrand).map(([brand, rows]) => {
    const a = aggregateRows(rows, ["spend", "impressions", "clicks"], []);
    return { brand, spend: round2(a.spend), impressions: a.impressions, ctr: pct(a.clicks, a.impressions) };
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
  getRateKeys,
  deleteCustomField,
  updateCustomField,
  mergeFieldInto,
  commitUpload,
  getUploadsLog,
  computeCreativeRollups,
  computeCampaignRollups,
  computeBrandRollups,
  slugify,
};
