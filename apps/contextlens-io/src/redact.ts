/**
 * LHAR redaction: runs @contextio/redact pii preset over the full
 * parsed LHAR document.
 *
 * Returns the redacted LHAR JSON string and a summary of what was removed.
 */

import { createStats, fromPreset, redactWithPolicy } from "@contextio/redact";

export interface RedactResult {
  redacted: string;
  stats: RedactStats;
}

export interface RedactStats {
  total: number;
  byType: Record<string, number>;
}

/**
 * Redact a raw LHAR JSON string (wrapped .lhar.json format).
 * Walks the entire document through the pii preset.
 */
export function redactLhar(raw: string): RedactResult {
  const policy = fromPreset("pii");
  const engineStats = createStats();

  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON in uploaded file: ${(err as Error).message}`);
  }

  const redactedDoc = redactWithPolicy(doc, policy, engineStats);

  const stats: RedactStats = {
    total: engineStats.totalReplacements,
    byType: { ...engineStats.byRule },
  };

  return { redacted: JSON.stringify(redactedDoc), stats };
}

/** Format stats into a human-readable summary string. */
export function formatStats(stats: RedactStats): string {
  if (stats.total === 0) return "No sensitive data found.";
  const parts = Object.entries(stats.byType).map(
    ([type, count]) =>
      `${count} ${type.toLowerCase()}${count !== 1 ? "s" : ""}`,
  );
  return `${parts.join(", ")} redacted.`;
}
