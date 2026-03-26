import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as http from "node:http";
import { describe, it, afterEach } from "node:test";
import { createPrunePlugin } from "../src/proxy/prune.js";
import type { RequestContext } from "@contextio/core";

// ---------------------------------------------------------------------------
// Mock analysis server — responds to GET /api/sessions/:id/prunes
// ---------------------------------------------------------------------------

let mockServer: http.Server | null = null;
let mockPrunes: Map<string, string[]> = new Map();

async function startMockServer(): Promise<number> {
  return new Promise((resolve) => {
    mockServer = http.createServer((req, res) => {
      const match = req.url?.match(/\/api\/sessions\/([^/]+)\/prunes/);
      if (match) {
        const id = decodeURIComponent(match[1]);
        const pruned = mockPrunes.get(id) ?? [];
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ prunedMessages: pruned }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    mockServer.listen(0, "127.0.0.1", () => {
      const addr = mockServer!.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function stopMockServer(): Promise<void> {
  return new Promise((resolve) => {
    if (mockServer) {
      mockServer.close(() => resolve());
      mockServer = null;
    } else {
      resolve();
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(sessionId: string | null, messages: unknown[]): RequestContext {
  return {
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    path: "/v1/messages",
    source: "pi",
    sessionId,
    headers: {},
    body: {
      model: "claude-sonnet-4",
      messages,
    },
    rawBody: Buffer.from(""),
  } as unknown as RequestContext;
}

function convId(sessionTag: string): string {
  return createHash("sha256").update(sessionTag).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prune plugin", () => {
  let port = 0;

  afterEach(async () => {
    mockPrunes.clear();
    await stopMockServer();
  });

  it("strips pruned messages by index", async () => {
    port = await startMockServer();
    const tag = "abc12345";
    const cid = convId(tag);

    mockPrunes.set(cid, ["user:2"]);

    const plugin = createPrunePlugin(`http://127.0.0.1:${port}`);
    const ctx = makeCtx(tag, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
      { role: "user", content: "Remember 1928" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "What was the number?" },
    ]);

    const result = await plugin.onRequest!(ctx);
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 4, "should have removed 1 message");

    // Verify the right message was removed
    const contents = body.messages.map(
      (m) => (m as { content: string }).content,
    );
    assert.ok(!contents.includes("Remember 1928"), "pruned message should be gone");
    assert.ok(contents.includes("Hi"), "other messages should remain");
    assert.ok(contents.includes("Hello!"), "other messages should remain");
    assert.ok(contents.includes("Got it."), "other messages should remain");
    assert.ok(contents.includes("What was the number?"), "other messages should remain");
  });

  it("strips tool_use by id", async () => {
    port = await startMockServer();
    const tag = "def67890";
    const cid = convId(tag);

    mockPrunes.set(cid, ["tool_use:toolu_123"]);

    const plugin = createPrunePlugin(`http://127.0.0.1:${port}`);
    const ctx = makeCtx(tag, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_123", name: "Read", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_123", content: "file contents" }] },
    ]);

    const result = await plugin.onRequest!(ctx);
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 2, "should have removed 1 message (tool_use)");
  });

  it("strips tool_result by tool_use_id", async () => {
    port = await startMockServer();
    const tag = "ghi11111";
    const cid = convId(tag);

    mockPrunes.set(cid, ["tool_result:toolu_456"]);

    const plugin = createPrunePlugin(`http://127.0.0.1:${port}`);
    const ctx = makeCtx(tag, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "toolu_456", name: "Bash", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_456", content: "output" }] },
      { role: "assistant", content: "Done." },
    ]);

    const result = await plugin.onRequest!(ctx);
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 3, "should have removed 1 message (tool_result)");
  });

  it("strips multiple pruned messages", async () => {
    port = await startMockServer();
    const tag = "multi123";
    const cid = convId(tag);

    mockPrunes.set(cid, ["user:1", "assistant:2"]);

    const plugin = createPrunePlugin(`http://127.0.0.1:${port}`);
    const ctx = makeCtx(tag, [
      { role: "user", content: "Hi" },
      { role: "user", content: "Secret info" },
      { role: "assistant", content: "Noted." },
      { role: "user", content: "Continue" },
    ]);

    const result = await plugin.onRequest!(ctx);
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 2, "should have removed 2 messages");
  });

  it("does nothing when no prunes are set", async () => {
    port = await startMockServer();
    const tag = "empty123";

    const plugin = createPrunePlugin(`http://127.0.0.1:${port}`);
    const ctx = makeCtx(tag, [
      { role: "user", content: "Hi" },
      { role: "assistant", content: "Hello!" },
    ]);

    const result = await plugin.onRequest!(ctx);
    // Should return same ctx (no modification)
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 2);
  });

  it("does nothing when no sessionId", async () => {
    port = await startMockServer();

    const plugin = createPrunePlugin(`http://127.0.0.1:${port}`);
    const ctx = makeCtx(null, [
      { role: "user", content: "Hi" },
    ]);

    const result = await plugin.onRequest!(ctx);
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 1);
  });

  it("fails open when server is unreachable", async () => {
    // Don't start mock server — port won't be listening
    const plugin = createPrunePlugin("http://127.0.0.1:19999");
    const ctx = makeCtx("tag123", [
      { role: "user", content: "Hi" },
    ]);

    const result = await plugin.onRequest!(ctx);
    const body = result.body as { messages: unknown[] };
    assert.equal(body.messages.length, 1, "should forward unmodified");
  });
});
