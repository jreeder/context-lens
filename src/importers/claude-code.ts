/**
 * Importer for Claude Code (claude CLI) session files.
 *
 * Session files live at:
 *   ~/.claude/projects/<encoded-dir>/<sessionId>.jsonl
 *
 * Each line is a JSON object with type "user" | "assistant" | "system" |
 * "progress" | "queue-operation" | "file-history-snapshot".
 *
 * Only "user" and "assistant" lines carry message content.
 * "assistant" lines carry exact usage in message.usage.
 *
 * The turns form a tree via parentUuid. We walk the longest chain
 * (most assistant turns) to get the main conversation thread.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ImportedMessage,
  ImportedSession,
  ImportedTurn,
} from "./types.js";

interface ClaudeCodeLine {
  uuid: string;
  parentUuid: string | null;
  type:
    | "user"
    | "assistant"
    | "system"
    | "progress"
    | "queue-operation"
    | "file-history-snapshot";
  isMeta?: boolean;
  sessionId: string;
  timestamp: string;
  cwd?: string;
  gitBranch?: string;
  message?: {
    role: string;
    content: unknown;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function defaultClaudeDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/**
 * Walk the tree formed by parentUuid links and return the longest
 * linear chain of uuids ending at a leaf (no children).
 */
function longestChain(lines: ClaudeCodeLine[]): ClaudeCodeLine[] {
  const byUuid = new Map<string, ClaudeCodeLine>();
  const children = new Map<string, string[]>();

  for (const line of lines) {
    byUuid.set(line.uuid, line);
    if (line.parentUuid) {
      const kids = children.get(line.parentUuid) ?? [];
      kids.push(line.uuid);
      children.set(line.parentUuid, kids);
    }
  }

  // Find roots (no parent, or parent not in set)
  const roots = lines.filter((l) => !l.parentUuid || !byUuid.has(l.parentUuid));

  // DFS to find longest path (by assistant-turn count)
  let best: ClaudeCodeLine[] = [];

  function dfs(uuid: string, current: ClaudeCodeLine[]): void {
    const node = byUuid.get(uuid);
    if (!node) return;
    const next = [...current, node];
    const kids = children.get(uuid) ?? [];
    if (kids.length === 0) {
      const assistantCount = next.filter((n) => n.type === "assistant").length;
      const bestCount = best.filter((n) => n.type === "assistant").length;
      if (assistantCount > bestCount) best = next;
    } else {
      for (const kid of kids) dfs(kid, next);
    }
  }

  for (const root of roots) dfs(root.uuid, []);
  return best;
}

/**
 * Convert a chain of Claude Code lines into ImportedTurns.
 *
 * Each turn corresponds to one assistant response. The messages array
 * for that turn contains all user+assistant messages up to that point,
 * which is what the analysis pipeline expects (full context window snapshot).
 */
function chainToTurns(chain: ClaudeCodeLine[]): ImportedTurn[] {
  const turns: ImportedTurn[] = [];
  const accumulated: ImportedMessage[] = [];

  for (const line of chain) {
    if (line.type !== "user" && line.type !== "assistant") continue;
    if (!line.message) continue;
    // Skip injected skill/system content (isMeta lines)
    if (line.isMeta) continue;

    const role = line.message.role as "user" | "assistant" | "system";
    accumulated.push({ role, content: line.message.content });

    if (line.type === "assistant") {
      const usage = line.message.usage;
      turns.push({
        timestamp: line.timestamp,
        messages: [...accumulated],
        inputTokens: usage?.input_tokens ?? null,
        outputTokens: usage?.output_tokens ?? null,
        cacheReadTokens: usage?.cache_read_input_tokens ?? null,
        cacheWriteTokens: usage?.cache_creation_input_tokens ?? null,
      });
    }
  }

  return turns;
}

export function discoverClaudeCodeSessions(
  baseDir: string = defaultClaudeDir(),
): string[] {
  if (!fs.existsSync(baseDir)) return [];
  const files: string[] = [];
  for (const project of fs.readdirSync(baseDir)) {
    const projectDir = path.join(baseDir, project);
    if (!fs.statSync(projectDir).isDirectory()) continue;
    for (const file of fs.readdirSync(projectDir)) {
      if (file.endsWith(".jsonl")) {
        files.push(path.join(projectDir, file));
      }
    }
  }
  return files;
}

export function parseClaudeCodeSession(
  filePath: string,
): ImportedSession | null {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return null;
  }

  const lines: ClaudeCodeLine[] = [];
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let model = "claude";

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as ClaudeCodeLine;
      if (!parsed.type || !parsed.uuid) continue;
      if (parsed.type === "user" || parsed.type === "assistant") {
        lines.push(parsed);
        if (!sessionId && parsed.sessionId) sessionId = parsed.sessionId;
        if (!cwd && parsed.cwd) cwd = parsed.cwd;
        if (!gitBranch && parsed.gitBranch) gitBranch = parsed.gitBranch;
        if (parsed.type === "assistant" && parsed.message?.model) {
          model = parsed.message.model;
        }
      }
    } catch {
      // skip malformed lines
    }
  }

  if (lines.length === 0 || !sessionId) return null;

  const chain = longestChain(lines);
  const turns = chainToTurns(chain);
  if (turns.length === 0) return null;

  return {
    sessionId,
    source: "claude-code",
    model,
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    cwd,
    gitBranch,
    turns,
  };
}
