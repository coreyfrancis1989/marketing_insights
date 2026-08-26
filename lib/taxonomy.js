"use strict";
/**
 * Canonical data taxonomy for the creative-performance dataset, plus a
 * column-matching engine used by the CSV upload flow to suggest how
 * uploaded columns map onto it (or should become new fields).
 *
 * Two kinds of fields:
 *  - "dimension" fields describe a row (date, creative identity, campaign,
 *    format, audience breakdowns, objective, creative copy/thumbnail).
 *  - "metric" fields are additive numbers that get summed when aggregating
 *    (spend, impressions, clicks, ...). Every metric is what the dashboard
 *    can chart, rank, and build custom formulas from.
 *
 * The built-in list below is fixed. Fields created via "Create new field"
 * during an upload are persisted separately (see store.js) as custom
 * entries with the same shape plus `custom: true`, and are merged in by
 * getSchema() so later uploads can match against them too.
 */

const BUILTIN_FIELDS = [
  // --- identity / dimensions ---
  { key: "date", label: "Date", kind: "dimension", type: "date", required: true,
    aliases: ["day", "report_date", "reporting_date", "date_start"] },
  { key: "creative_id", label: "Creative ID", kind: "dimension", type: "text",
    aliases: ["ad_creative_id", "creative id", "creativeid"] },
  { key: "name", label: "Creative Name", kind: "dimension", type: "text",
    aliases: ["creative_name", "ad_name", "creative title", "title", "ad name"] },
  { key: "body", label: "Ad Copy / Caption", kind: "dimension", type: "text",
    aliases: ["copy", "caption", "ad_text", "body_text", "creative_body"] },
  { key: "thumbnail_url", label: "Thumbnail URL", kind: "dimension", type: "text",
    aliases: ["thumb_url", "image_url", "thumbnail"] },
  { key: "type", label: "Format", kind: "dimension", type: "text",
    aliases: ["format", "ad_format", "creative_type", "ad_object_type", "media_type"] },
  { key: "campaign_id", label: "Campaign ID", kind: "dimension", type: "text",
    aliases: ["campaign id"] },
  { key: "campaign_name", label: "Campaign Name", kind: "dimension", type: "text",
    aliases: ["campaign", "campaign_title"] },
  { key: "objective", label: "Campaign Objective", kind: "dimension", type: "text",
    aliases: ["campaign_objective", "goal"] },
  { key: "age", label: "Age Group", kind: "dimension", type: "text",
    aliases: ["age_range", "age_group", "age_bracket"] },
  { key: "gender", label: "Gender", kind: "dimension", type: "text", aliases: ["sex"] },
  { key: "platform", label: "Platform", kind: "dimension", type: "text",
    aliases: ["publisher_platform", "placement", "channel"] },

  // --- metrics (additive) ---
  { key: "spend", label: "Spend", kind: "metric", type: "number", unit: "currency",
    aliases: ["cost", "amount_spent", "ad_spend", "spend_usd", "total_spend"] },
  { key: "impressions", label: "Impressions", kind: "metric", type: "number", unit: "number",
    aliases: ["impr", "impressions_total", "total_impressions"] },
  { key: "clicks", label: "Clicks", kind: "metric", type: "number", unit: "number",
    aliases: ["clicks_all", "total_clicks"] },
  { key: "link_clicks", label: "Link Clicks", kind: "metric", type: "number", unit: "number",
    aliases: ["outbound_clicks", "link click", "linkclicks"] },
  { key: "engagement", label: "Engagement", kind: "metric", type: "number", unit: "number",
    aliases: ["post_engagement", "engagements", "post engagements"] },
  { key: "hook", label: "Hook (3-sec video plays)", kind: "metric", type: "number", unit: "number",
    aliases: ["video_3s_plays", "hook_plays", "3_second_video_plays", "video_views_3s"] },
  { key: "hold", label: "Hold (ThruPlays)", kind: "metric", type: "number", unit: "number",
    aliases: ["thruplays", "video_thruplay", "thru_plays", "video_completions"] },
  { key: "purchases", label: "Purchases", kind: "metric", type: "number", unit: "number",
    aliases: ["conversions", "orders", "purchase_count"] },
  { key: "purchase_value", label: "Purchase Value", kind: "metric", type: "number", unit: "currency",
    aliases: ["revenue", "conversion_value", "order_value", "purchases_value"] },
];

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "_");
}

function tokenize(normalized) {
  return normalized.split("_").filter(Boolean);
}

// Simple, dependency-free similarity: exact > alias-exact > token-overlap.
function scoreCandidate(headerNorm, headerTokens, field) {
  const fieldNames = [field.key, ...(field.aliases || [])].map(normalize);
  if (fieldNames.includes(headerNorm)) return { score: 1, matchType: "exact" };

  let best = 0;
  for (const fn of fieldNames) {
    // token overlap (handles word-order/synonym variance, e.g. "ad spend" vs "spend_usd")
    const fnTokens = new Set(tokenize(fn));
    if (fnTokens.size > 0) {
      const overlap = headerTokens.filter((t) => fnTokens.has(t)).length;
      const union = new Set([...fnTokens, ...headerTokens]).size;
      const jaccard = union === 0 ? 0 : overlap / union;
      if (jaccard > best) best = jaccard;
    }
    // character-level similarity (handles near-exact variance, e.g. "Saves" vs "Saved")
    const charSim = similarity(headerNorm, fn);
    if (charSim > best) best = charSim;
  }
  if (best >= 0.5) return { score: best, matchType: "fuzzy" };
  return { score: best, matchType: "none" };
}

// Normalized Levenshtein similarity in [0,1]; 1 = identical strings.
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) / Math.max(la, lb) > 0.4) return 0; // cheap early-out for very different lengths
  const dp = Array.from({ length: la + 1 }, (_, i) => [i, ...Array(lb).fill(0)]);
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const dist = dp[la][lb];
  return 1 - dist / Math.max(la, lb);
}

/**
 * Suggest a mapping for each uploaded CSV header against the full field
 * list (built-ins + any persisted custom fields).
 * Returns { header: { canonicalKey, matchType, confidence, label } | null }
 */
function suggestMapping(headers, customFields) {
  const allFields = [...BUILTIN_FIELDS, ...(customFields || [])];
  const result = {};
  for (const header of headers) {
    const hNorm = normalize(header);
    const hTokens = tokenize(hNorm);
    let best = null;
    for (const field of allFields) {
      const { score, matchType } = scoreCandidate(hNorm, hTokens, field);
      if (matchType === "none") continue;
      if (!best || score > best.score) {
        best = { score, matchType, canonicalKey: field.key, label: field.label, kind: field.kind, type: field.type };
      }
    }
    result[header] = best
      ? { canonicalKey: best.canonicalKey, label: best.label, kind: best.kind, type: best.type,
          matchType: best.matchType, confidence: Math.round(best.score * 100) }
      : null;
  }
  return result;
}

module.exports = { BUILTIN_FIELDS, normalize, suggestMapping };
