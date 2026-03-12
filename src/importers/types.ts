/**
 * Common interface for all CLI session importers.
 *
 * Each importer reads tool-specific session files and produces
 * ImportedSession objects that can be fed into ingestCapture.
 */

import type { ApiFormat, Provider } from "../types.js";

export interface ImportedMessage {
  role: "user" | "assistant" | "system";
  content: unknown; // Anthropic/OpenAI content array or string
}

export interface ImportedTurn {
  /** ISO timestamp */
  timestamp: string;
  /** Reconstructed messages array up to and including this turn */
  messages: ImportedMessage[];
  /** Exact input token count from the tool's own usage data, if available */
  inputTokens: number | null;
  /** Exact output token count, if available */
  outputTokens: number | null;
  /** Cache read tokens, if available */
  cacheReadTokens: number | null;
  /** Cache creation tokens, if available */
  cacheWriteTokens: number | null;
}

export interface ImportedSession {
  /** The tool's own session/conversation ID */
  sessionId: string;
  /** Source label shown in the UI */
  source: string;
  /** Model used (if known) */
  model: string;
  /** Provider */
  provider: Provider;
  /** API format to pass to parseContextInfo */
  apiFormat: ApiFormat;
  /** Working directory at time of session */
  cwd: string | null;
  /** Git branch, if recorded */
  gitBranch: string | null;
  /** Each API turn (one per assistant response) */
  turns: ImportedTurn[];
}

export interface ImportSummary {
  source: string;
  found: number;
  imported: number;
  skipped: number;
  errors: number;
}
