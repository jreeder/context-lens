/**
 * Header redaction utilities for captures and LHAR export.
 *
 * `selectHeaders` and `SENSITIVE_HEADERS` are re-exported from @contextio/core
 * (single source of truth). `redactHeaders` is context-lens-specific: it
 * strips sensitive headers from an already-string-valued map (used in LHAR
 * export where multi-value arrays are not possible).
 */

export { SENSITIVE_HEADERS, selectHeaders } from "@contextio/core";

import { SENSITIVE_HEADERS } from "@contextio/core";

/**
 * Remove sensitive headers from a string-valued header map.
 *
 * Unlike `selectHeaders`, this does not filter non-string values —
 * it assumes all values are already strings (as in LHAR export).
 */
export function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, val] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(key.toLowerCase())) continue;
    result[key] = val;
  }
  return result;
}
