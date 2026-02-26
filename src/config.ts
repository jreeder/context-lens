/**
 * Context Lens user configuration.
 *
 * Loaded from ~/.context-lens/config.toml on startup.
 * All settings can be overridden with CLI flags.
 *
 * Precedence: defaults → config file → CLI flags
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";

export interface ContextLensConfig {
  proxy: {
    port: number;
    redact?: "secrets" | "pii" | "strict";
    noRehydrate: boolean;
  };
  ui: {
    port: number;
    noOpen: boolean;
  };
  privacy: {
    level?: "minimal" | "standard" | "full";
  };
}

const DEFAULTS: ContextLensConfig = {
  proxy: {
    port: 4040,
    redact: undefined,
    noRehydrate: false,
  },
  ui: {
    port: 4041,
    noOpen: false,
  },
  privacy: {
    level: undefined,
  },
};

export function getConfigPath(): string {
  return join(homedir(), ".context-lens", "config.toml");
}

/**
 * Load and parse the user config file.
 *
 * Returns merged defaults + file values. Missing keys fall back to defaults.
 * Parse errors are logged and defaults are returned.
 */
export function loadConfig(): ContextLensConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULTS);
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    raw = parse(text);
  } catch (err: unknown) {
    console.warn(
      `Warning: Could not parse config file ${configPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return structuredClone(DEFAULTS);
  }

  return mergeConfig(raw);
}

const VALID_REDACT = new Set(["secrets", "pii", "strict"]);
const VALID_PRIVACY = new Set(["minimal", "standard", "full"]);

function mergeConfig(raw: unknown): ContextLensConfig {
  const cfg = structuredClone(DEFAULTS);
  if (typeof raw !== "object" || raw === null) return cfg;
  const r = raw as Record<string, unknown>;

  const proxy = r["proxy"];
  if (typeof proxy === "object" && proxy !== null) {
    const p = proxy as Record<string, unknown>;
    if (typeof p["port"] === "number") cfg.proxy.port = p["port"];
    if (typeof p["redact"] === "string" && VALID_REDACT.has(p["redact"])) {
      cfg.proxy.redact = p["redact"] as ContextLensConfig["proxy"]["redact"];
    }
    if (typeof p["no_rehydrate"] === "boolean") {
      cfg.proxy.noRehydrate = p["no_rehydrate"];
    }
  }

  const ui = r["ui"];
  if (typeof ui === "object" && ui !== null) {
    const u = ui as Record<string, unknown>;
    if (typeof u["port"] === "number") cfg.ui.port = u["port"];
    if (typeof u["no_open"] === "boolean") cfg.ui.noOpen = u["no_open"];
  }

  const privacy = r["privacy"];
  if (typeof privacy === "object" && privacy !== null) {
    const pv = privacy as Record<string, unknown>;
    if (typeof pv["level"] === "string" && VALID_PRIVACY.has(pv["level"])) {
      cfg.privacy.level = pv["level"] as ContextLensConfig["privacy"]["level"];
    }
  }

  return cfg;
}

/**
 * Generate a commented example config file.
 */
export function exampleConfig(): string {
  return [
    "# Context Lens configuration",
    "# Location: ~/.context-lens/config.toml",
    "# All settings can be overridden with CLI flags.",
    "",
    "[proxy]",
    "# port = 4040",
    '# redact = "secrets"   # secrets | pii | strict',
    "# no_rehydrate = false",
    "",
    "[ui]",
    "# port = 4041",
    "# no_open = false",
    "",
    "[privacy]",
    '# level = "standard"   # minimal | standard | full',
  ].join("\n");
}
