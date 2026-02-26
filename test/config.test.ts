import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { exampleConfig, loadConfig } from "../src/config.js";

describe("config", () => {
  it("returns defaults when no config file exists", () => {
    // loadConfig reads from ~/.context-lens/config.toml which won't exist in CI
    const cfg = loadConfig();
    assert.equal(typeof cfg.proxy.port, "number");
    assert.equal(typeof cfg.ui.port, "number");
    assert.equal(typeof cfg.ui.noOpen, "boolean");
    assert.equal(typeof cfg.proxy.noRehydrate, "boolean");
  });

  it("exampleConfig returns a non-empty string", () => {
    const example = exampleConfig();
    assert.ok(example.includes("[proxy]"));
    assert.ok(example.includes("[ui]"));
    assert.ok(example.includes("[privacy]"));
  });
});
