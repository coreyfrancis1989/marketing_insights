"use strict";
/**
 * Canonical data taxonomy for the creative-performance dataset, plus a
 * column-matching engine used by the CSV upload flow to suggest how
 * uploaded columns map onto it (or should become new fields).
 *
 * Three kinds of fields:
 *  - "dimension" — describes a row (date, creative/campaign identity,
 *    brand, channel, format, audience breakdowns, objective, creative
 *    copy/thumbnail, or the period_start/period_end pair a lifetime/
 *    cumulative upload carries instead of a per-row date).
 *  - "metric" — an additive raw count (spend, impressions, clicks, ...).
 *    Summed when aggregating multiple rows together.
 *  - "rate" — a pre-computed ratio the SOURCE platform reported (CTR,
 *    Hook Rate, VTR, CPC, ...), not a raw count. Never summed — when
 *    rows are aggregated, rate fields are weighted-averaged by
 *    impressions instead (see store.js). Kept distinct from the
 *    dashboard's own *computed* rates (e.g. its client-side CTR/hook
 *    rate derived from raw counts) — those aren't schema fields at all,
 *    they're calculated on the fly, so there's no key collision; the
 *    "reported_" prefix on a few of these just keeps them visually
 *    unambiguous from the computed equivalents in the mapping UI.
 *
 * Fields created via "Create new field" during an upload are persisted
 * separately (see store.js) as custom entries with the same shape plus
 * `custom: true`, and are merged in by getSchema() so later uploads can
 * match against them too.
 */

const BUILTIN_FIELDS = [
  // --- identity / dimensions ---
  { key: "date", label: "Date", kind: "dimension", type: "date", required: true,
    aliases: ["day", "report_date", "reporting_date", "date_start"] },
  { key: "period_start", label: "Period Start", kind: "dimension", type: "date",
    aliases: ["reporting_starts", "starts", "start_date", "period_from"] },
  { key: "period_end", label: "Period End", kind: "dimension", type: "date",
    aliases: ["reporting_ends", "ends", "end_date", "period_to"] },
  { key: "brand", label: "Brand", kind: "dimension", type: "text",
    aliases: ["advertiser", "account_name", "client"] },
  { key: "channel", label: "Ad Platform", kind: "dimension", type: "text",
    aliases: ["platform_group", "ad_platform", "network", "source", "media_source"] },
  { key: "channel_type", label: "Channel Type", kind: "dimension", type: "text",
    aliases: ["channel_group", "media_type_group"] },
  { key: "channel_format", label: "Channel Format", kind: "dimension", type: "text", aliases: [] },
  { key: "market", label: "Market", kind: "dimension", type: "text", aliases: ["us_uk", "region", "country"] },
  { key: "creative_id", label: "Creative ID", kind: "dimension", type: "text",
    aliases: ["ad_creative_id", "creative id", "creativeid"] },
  { key: "name", label: "Creative Name", kind: "dimension", type: "text",
    aliases: ["creative_name", "ad_name", "creative title", "title", "ad name", "creative"] },
  { key: "body", label: "Ad Copy / Caption", kind: "dimension", type: "text",
    aliases: ["copy", "caption", "ad_text", "body_text", "creative_body"] },
  { key: "thumbnail_url", label: "Thumbnail URL", kind: "dimension", type: "text",
    aliases: ["thumb_url", "image_url", "thumbnail"] },
  { key: "type", label: "Format", kind: "dimension", type: "text",
    aliases: ["format", "ad_format", "creative_type", "ad_object_type", "media_type"] },
  { key: "delivery_status", label: "Delivery Status", kind: "dimension", type: "text",
    aliases: ["status", "delivery"] },
  { key: "campaign_id", label: "Campaign ID", kind: "dimension", type: "text",
    aliases: ["campaign id"] },
  { key: "campaign_name", label: "Campaign Name", kind: "dimension", type: "text",
    aliases: ["campaign", "campaign_title"] },
  { key: "adset_name", label: "Ad Set / Ad Group", kind: "dimension", type: "text",
    aliases: ["ad_set_name", "ad_group", "adgroup", "adset"] },
  { key: "objective", label: "Campaign Objective", kind: "dimension", type: "text",
    aliases: ["campaign_objective", "goal"] },
  { key: "phase", label: "Phase", kind: "dimension", type: "text", aliases: [] },
  { key: "initiative", label: "Initiative", kind: "dimension", type: "text", aliases: [] },
  { key: "audience", label: "Audience", kind: "dimension", type: "text", aliases: ["tactic"] },
  { key: "creative_concept", label: "Creative Concept", kind: "dimension", type: "text", aliases: [] },
  { key: "creative_size", label: "Creative Size", kind: "dimension", type: "text", aliases: [] },
  { key: "age", label: "Age Group", kind: "dimension", type: "text",
    aliases: ["age_range", "age_group", "age_bracket"] },
  { key: "gender", label: "Gender", kind: "dimension", type: "text", aliases: ["sex"] },
  { key: "platform", label: "Meta Placement", kind: "dimension", type: "text",
    aliases: ["publisher_platform", "placement"] },

  // --- metrics (additive — summed when aggregating) ---
  { key: "spend", label: "Spend", kind: "metric", type: "number", unit: "currency",
    aliases: ["cost", "amount_spent", "ad_spend", "spend_usd", "total_spend", "amount_spent_usd"] },
  { key: "impressions", label: "Impressions", kind: "metric", type: "number", unit: "number",
    aliases: ["impr", "impressions_total", "total_impressions"] },
  { key: "reach", label: "Reach", kind: "metric", type: "number", unit: "number", aliases: [] },
  { key: "clicks", label: "Clicks", kind: "metric", type: "number", unit: "number",
    aliases: ["clicks_all", "total_clicks"] },
  { key: "link_clicks", label: "Link Clicks", kind: "metric", type: "number", unit: "number",
    aliases: ["outbound_clicks", "link click", "linkclicks"] },
  { key: "landing_page_views", label: "Landing Page Views", kind: "metric", type: "number", unit: "number", aliases: [] },
  { key: "engaged_views", label: "Engaged Views", kind: "metric", type: "number", unit: "number", aliases: [] },
  { key: "video_plays", label: "Video Plays", kind: "metric", type: "number", unit: "number", aliases: [] },
  { key: "engagement", label: "Engagement (blended)", kind: "metric", type: "number", unit: "number",
    aliases: ["post_engagement", "engagements", "post engagements"] },
  { key: "post_comments", label: "Post Comments", kind: "metric", type: "number", unit: "number",
    aliases: ["comments"] },
  { key: "post_reactions", label: "Post Reactions", kind: "metric", type: "number", unit: "number",
    aliases: ["reactions", "likes"] },
  { key: "post_saves", label: "Post Saves", kind: "metric", type: "number", unit: "number",
    aliases: ["saves"] },
  { key: "post_shares", label: "Post Shares", kind: "metric", type: "number", unit: "number",
    aliases: ["shares"] },
  { key: "hook", label: "Hook (3-sec video plays)", kind: "metric", type: "number", unit: "number",
    aliases: ["video_3s_plays", "hook_plays", "3_second_video_plays", "video_views_3s"] },
  { key: "hold", label: "Hold (ThruPlays / Completes)", kind: "metric", type: "number", unit: "number",
    aliases: ["thruplays", "video_thruplay", "thru_plays", "video_completions", "completes"] },
  { key: "purchases", label: "Purchases", kind: "metric", type: "number", unit: "number",
    aliases: ["conversions", "orders", "purchase_count"] },
  { key: "purchase_value", label: "Purchase Value", kind: "metric", type: "number", unit: "currency",
    aliases: ["revenue", "conversion_value", "order_value", "purchases_value"] },

  // --- rates (pre-computed ratios the source platform reported — never
  // summed; weighted-averaged by impressions when rows are aggregated) ---
  { key: "reported_ctr", label: "CTR (reported)", kind: "rate", type: "number", unit: "percent",
    aliases: ["ctr", "ctr_all", "click_through_rate"] },
  { key: "reported_cpc", label: "CPC (reported)", kind: "rate", type: "number", unit: "currency",
    aliases: ["cpc", "cost_per_link_click", "cost_per_click"] },
  { key: "reported_cpm", label: "CPM (reported)", kind: "rate", type: "number", unit: "currency",
    aliases: ["cpm", "cost_per_1000_impressions"] },
  { key: "frequency", label: "Frequency", kind: "rate", type: "number", unit: "number", aliases: [] },
  { key: "reported_hook_rate", label: "Hook Rate (reported)", kind: "rate", type: "number", unit: "percent",
    aliases: ["hook_rate"] },
  { key: "reported_hold_rate", label: "Hold Rate (reported)", kind: "rate", type: "number", unit: "percent",
    aliases: ["hold_rate"] },
  { key: "vtr", label: "VTR (View-Through Rate)", kind: "rate", type: "number", unit: "percent", aliases: [] },
  { key: "vcr", label: "VCR (Video Completion Rate)", kind: "rate", type: "number", unit: "percent", aliases: [] },
  { key: "engagement_rate_reported", label: "Engagement Rate (reported)", kind: "rate", type: "number", unit: "percent",
    aliases: ["engagement_rate"] },
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

// Simple, dependency-free similarity: exact > token-overlap > character-level.
function scoreCandidate(headerNorm, headerTokens, field) {
  const fieldNames = [field.key, ...(field.aliases || [])].map(normalize);
  if (fieldNames.includes(headerNorm)) return { score: 1, matchType: "exact" };

  let best = 0;
  for (const fn of fieldNames) {
    const fnTokens = new Set(tokenize(fn));
    if (fnTokens.size > 0) {
      const overlap = headerTokens.filter((t) => fnTokens.has(t)).length;
      const union = new Set([...fnTokens, ...headerTokens]).size;
      const jaccard = union === 0 ? 0 : overlap / union;
      if (jaccard > best) best = jaccard;
    }
    const charSim = similarity(headerNorm, fn);
    if (charSim > best) best = charSim;
  }
  if (best >= 0.5) return { score: best, matchType: "fuzzy" };
  return { score: best, matchType: "none" };
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
