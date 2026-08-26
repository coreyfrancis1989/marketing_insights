"use strict";
const { parse } = require("csv-parse/sync");

/**
 * Parse a CSV buffer/string into { headers, rows }.
 * `rows` is an array of plain objects keyed by the original header text.
 * Throws with a readable message on malformed CSV.
 */
function parseCsv(input) {
  let records;
  try {
    records = parse(input, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });
  } catch (err) {
    throw new Error(`Could not parse CSV: ${err.message}`);
  }
  if (records.length === 0) {
    throw new Error("The CSV has no data rows.");
  }
  const headers = Object.keys(records[0]);
  return { headers, rows: records };
}

module.exports = { parseCsv };
