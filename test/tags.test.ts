import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { Hono } from "hono";
import { parseContextInfo } from "../src/core.js";
import { Store } from "../src/server/store.js";
import { TagsStore } from "../src/server/tags-store.js";
import { createApp } from "../src/server/webui.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-tags-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function makeStore(dir: string): Store {
  return new Store({
    dataDir: path.join(dir, "data"),
    stateFile: path.join(dir, "data", "state.jsonl"),
    maxSessions: 10,
    maxCompactMessages: 60,
  });
}

/**
 * Ingest one conversation into the store and return its ID.
 */
function seedConversation(store: Store, userId: string): string {
  const body = {
    model: "claude-sonnet-4-20250514",
    metadata: { user_id: userId },
    messages: [{ role: "user", content: "hello" }],
  };
  const ci = parseContextInfo("anthropic", body, "anthropic-messages");
  store.storeRequest(
    ci,
    {
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
      usage: { input_tokens: 5, output_tokens: 2 },
    },
    "claude",
    body,
  );
  const convos = Array.from(store.getConversations().keys());
  assert.equal(convos.length, 1);
  return convos[0];
}

// ---------------------------------------------------------------------------
// TagsStore unit tests
// ---------------------------------------------------------------------------

describe("TagsStore", () => {
  let dir: string;
  let cleanup: () => void;
  let ts: TagsStore;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    ts = new TagsStore(dir);
  });

  afterEach(() => cleanup());

  describe("getTags", () => {
    it("returns empty array for unknown conversation", () => {
      assert.deepEqual(ts.getTags("does-not-exist"), []);
    });
  });

  describe("setTags", () => {
    it("sets tags and normalizes them", () => {
      ts.setTags("c1", ["  Hello ", "WORLD", "hello"]);
      // deduped, trimmed, lowercased
      assert.deepEqual(ts.getTags("c1"), ["hello", "world"]);
    });

    it("replaces existing tags", () => {
      ts.setTags("c1", ["a", "b"]);
      ts.setTags("c1", ["c"]);
      assert.deepEqual(ts.getTags("c1"), ["c"]);
    });

    it("removes conversation entry when tags list is emptied", () => {
      ts.setTags("c1", ["a"]);
      ts.setTags("c1", []);
      assert.deepEqual(ts.getTags("c1"), []);
    });

    it("is idempotent when tags are unchanged", () => {
      ts.setTags("c1", ["a"]);
      const before = ts.getTags("c1");
      ts.setTags("c1", ["a"]);
      assert.deepEqual(ts.getTags("c1"), before);
    });
  });

  describe("addTag", () => {
    it("adds a tag", () => {
      ts.addTag("c1", "foo");
      assert.deepEqual(ts.getTags("c1"), ["foo"]);
    });

    it("normalizes the tag", () => {
      ts.addTag("c1", "  BAR  ");
      assert.deepEqual(ts.getTags("c1"), ["bar"]);
    });

    it("does not add duplicates", () => {
      ts.addTag("c1", "foo");
      ts.addTag("c1", "foo");
      assert.deepEqual(ts.getTags("c1"), ["foo"]);
    });

    it("ignores empty/whitespace tags", () => {
      ts.addTag("c1", "   ");
      assert.deepEqual(ts.getTags("c1"), []);
    });
  });

  describe("removeTag", () => {
    it("removes a tag", () => {
      ts.setTags("c1", ["a", "b", "c"]);
      ts.removeTag("c1", "b");
      assert.deepEqual(ts.getTags("c1"), ["a", "c"]);
    });

    it("is a no-op for a tag that does not exist", () => {
      ts.setTags("c1", ["a"]);
      ts.removeTag("c1", "z");
      assert.deepEqual(ts.getTags("c1"), ["a"]);
    });

    it("removes the conversation entry when last tag is removed", () => {
      ts.setTags("c1", ["only"]);
      ts.removeTag("c1", "only");
      assert.deepEqual(ts.getTags("c1"), []);
    });
  });

  describe("getAllTags", () => {
    it("returns counts across all conversations", () => {
      ts.setTags("c1", ["a", "b"]);
      ts.setTags("c2", ["b", "c"]);
      const counts = ts.getAllTags();
      assert.equal(counts.get("a"), 1);
      assert.equal(counts.get("b"), 2);
      assert.equal(counts.get("c"), 1);
    });

    it("returns empty map when no tags exist", () => {
      assert.equal(ts.getAllTags().size, 0);
    });
  });

  describe("removeConversation", () => {
    it("removes all tags for the conversation", () => {
      ts.setTags("c1", ["a", "b"]);
      ts.removeConversation("c1");
      assert.deepEqual(ts.getTags("c1"), []);
    });

    it("is a no-op for unknown conversation", () => {
      ts.removeConversation("never-existed"); // should not throw
      assert.deepEqual(ts.getTags("never-existed"), []);
    });
  });

  describe("syncTags", () => {
    it("removes tags for conversations not in the valid set", () => {
      ts.setTags("c1", ["a"]);
      ts.setTags("c2", ["b"]);
      ts.syncTags(new Set(["c1"]));
      assert.deepEqual(ts.getTags("c1"), ["a"]);
      assert.deepEqual(ts.getTags("c2"), []);
    });

    it("is a no-op when all conversations are still valid", () => {
      ts.setTags("c1", ["a"]);
      ts.syncTags(new Set(["c1", "c2"]));
      assert.deepEqual(ts.getTags("c1"), ["a"]);
    });
  });

  describe("persistence", () => {
    it("saves to disk and reloads correctly", () => {
      ts.setTags("c1", ["alpha", "beta"]);
      ts.addTag("c2", "gamma");

      const tagsFile = path.join(dir, ".tags.json");
      assert.ok(existsSync(tagsFile), ".tags.json should exist after write");

      const ts2 = new TagsStore(dir);
      assert.deepEqual(ts2.getTags("c1"), ["alpha", "beta"]);
      assert.deepEqual(ts2.getTags("c2"), ["gamma"]);
    });

    it("starts clean when the file does not exist", () => {
      // dir has no .tags.json — fresh TagsStore should start empty
      const fresh = new TagsStore(path.join(dir, "nonexistent-subdir"));
      assert.equal(fresh.getAllTags().size, 0);
    });

    it("recovers from a corrupted tags file", () => {
      const tagsFile = path.join(dir, ".tags.json");
      writeFileSync(tagsFile, "not valid json{{{");
      const ts2 = new TagsStore(dir);
      assert.equal(ts2.getAllTags().size, 0);
    });

    it("does not write to disk when nothing changed (idempotent setTags)", () => {
      ts.setTags("c1", ["a"]);
      const tagsFile = path.join(dir, ".tags.json");
      const mtimeBefore = existsSync(tagsFile) ? statSync(tagsFile).mtimeMs : 0;

      // Rely on the dirty flag: same tags should be a no-op with no disk write.
      ts.setTags("c1", ["a"]);

      const mtimeAfter = existsSync(tagsFile) ? statSync(tagsFile).mtimeMs : 0;
      assert.equal(mtimeBefore, mtimeAfter);
    });
  });
});

// ---------------------------------------------------------------------------
// Store integration tests for tag methods
// ---------------------------------------------------------------------------

describe("Store tag methods", () => {
  let dir: string;
  let cleanup: () => void;
  let store: Store;
  let convoId: string;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    store = makeStore(dir);
    convoId = seedConversation(store, "session_tag-integration-test");
  });

  afterEach(() => cleanup());

  it("getTags returns empty array for a new conversation", () => {
    assert.deepEqual(store.getTags(convoId), []);
  });

  it("setTags and getTags round-trip", () => {
    store.setTags(convoId, ["work", "review"]);
    const tags = store.getTags(convoId);
    assert.equal(tags.length, 2);
    assert.ok(tags.includes("work"));
    assert.ok(tags.includes("review"));
  });

  it("addTag appends and deduplicates", () => {
    store.addTag(convoId, "x");
    store.addTag(convoId, "x");
    assert.deepEqual(store.getTags(convoId), ["x"]);
  });

  it("removeTag removes a specific tag", () => {
    store.setTags(convoId, ["a", "b"]);
    store.removeTag(convoId, "a");
    assert.deepEqual(store.getTags(convoId), ["b"]);
  });

  it("getAllTags aggregates counts across conversations", () => {
    store.setTags(convoId, ["shared", "unique-1"]);

    // Seed a second conversation
    const body2 = {
      model: "claude-sonnet-4-20250514",
      metadata: { user_id: "session_second-convo" },
      messages: [{ role: "user", content: "second" }],
    };
    const ci2 = parseContextInfo("anthropic", body2, "anthropic-messages");
    store.storeRequest(
      ci2,
      { stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } },
      "claude",
      body2,
    );
    const convos = Array.from(store.getConversations().keys());
    const convo2Id = convos.find((id) => id !== convoId)!;
    store.setTags(convo2Id, ["shared", "unique-2"]);

    const all = store.getAllTags();
    assert.equal(all.get("shared"), 2);
    assert.equal(all.get("unique-1"), 1);
    assert.equal(all.get("unique-2"), 1);
  });

  it("setTags throws for unknown conversation", () => {
    assert.throws(
      () => store.setTags("no-such-convo", ["x"]),
      /Conversation not found/,
    );
  });

  it("addTag throws for unknown conversation", () => {
    assert.throws(
      () => store.addTag("no-such-convo", "x"),
      /Conversation not found/,
    );
  });

  it("removeTag throws for unknown conversation", () => {
    assert.throws(
      () => store.removeTag("no-such-convo", "x"),
      /Conversation not found/,
    );
  });

  it("tags are removed when conversation is deleted", () => {
    store.setTags(convoId, ["to-be-orphaned"]);
    store.deleteConversation(convoId);
    // After delete, getAllTags should not include them
    assert.equal(store.getAllTags().get("to-be-orphaned"), undefined);
  });

  it("emits tags-updated change event on setTags", () => {
    const events: string[] = [];
    store.on("change", (e) => events.push(e.type));
    store.setTags(convoId, ["event-test"]);
    assert.ok(events.includes("tags-updated"));
  });

  it("emits tags-updated change event on addTag", () => {
    const events: string[] = [];
    store.on("change", (e) => events.push(e.type));
    store.addTag(convoId, "foo");
    assert.ok(events.includes("tags-updated"));
  });

  it("emits tags-updated change event on removeTag", () => {
    store.addTag(convoId, "foo");
    const events: string[] = [];
    store.on("change", (e) => events.push(e.type));
    store.removeTag(convoId, "foo");
    assert.ok(events.includes("tags-updated"));
  });

  it("tags survive a state save/reload cycle", () => {
    store.setTags(convoId, ["persistent"]);

    const store2 = makeStore(dir);
    store2.loadState();

    // The reloaded store should have the same conversation
    const convos2 = Array.from(store2.getConversations().keys());
    assert.ok(convos2.includes(convoId));
    assert.deepEqual(store2.getTags(convoId), ["persistent"]);
  });

  it("syncTags removes orphaned tags after reset", () => {
    store.setTags(convoId, ["orphan"]);
    store.resetAll();
    // After reset conversations are cleared; tags should be synced away
    const all = store.getAllTags();
    assert.equal(all.get("orphan"), undefined);
  });
});

// ---------------------------------------------------------------------------
// HTTP API tests
// ---------------------------------------------------------------------------

describe("Tags HTTP API", () => {
  let dir: string;
  let cleanup: () => void;
  let store: Store;
  let app: Hono;
  let convoId: string;

  beforeEach(() => {
    ({ dir, cleanup } = makeTempDir());
    store = makeStore(dir);
    app = createApp(store, "<html>ok</html>");
    convoId = seedConversation(store, "session_tags-api-test");
  });

  afterEach(() => cleanup());

  // --- GET /api/tags ---

  it("GET /api/tags returns empty list initially", async () => {
    const res = await app.request("/api/tags");
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.tags, []);
  });

  it("GET /api/tags returns sorted tags with counts", async () => {
    store.setTags(convoId, ["z-tag", "a-tag"]);
    const res = await app.request("/api/tags");
    const data = await res.json();
    assert.equal(data.tags[0].name, "a-tag");
    assert.equal(data.tags[0].count, 1);
    assert.equal(data.tags[1].name, "z-tag");
    assert.equal(data.tags[1].count, 1);
  });

  // --- POST /api/sessions/:id/tags (add single tag) ---

  it("POST /api/sessions/:id/tags adds a tag", async () => {
    const res = await app.request(
      `/api/sessions/${encodeURIComponent(convoId)}/tags`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "mytag" }),
      },
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.tags, ["mytag"]);
  });

  it("POST /api/sessions/:id/tags rejects empty tag", async () => {
    const res = await app.request(
      `/api/sessions/${encodeURIComponent(convoId)}/tags`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tag: "  " }),
      },
    );
    assert.equal(res.status, 400);
  });

  it("POST /api/sessions/:id/tags rejects missing tag field", async () => {
    const res = await app.request(
      `/api/sessions/${encodeURIComponent(convoId)}/tags`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    assert.equal(res.status, 400);
  });

  it("POST /api/sessions/:id/tags returns 404 for unknown conversation", async () => {
    const res = await app.request("/api/sessions/no-such-id/tags", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "x" }),
    });
    assert.equal(res.status, 404);
  });

  // --- PATCH /api/sessions/:id/tags (replace all tags) ---

  it("PATCH /api/sessions/:id/tags replaces all tags", async () => {
    store.setTags(convoId, ["old"]);
    const res = await app.request(
      `/api/sessions/${encodeURIComponent(convoId)}/tags`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: ["new-a", "new-b"] }),
      },
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    // Should only have new tags
    assert.ok(!data.tags.includes("old"));
    assert.ok(data.tags.includes("new-a"));
    assert.ok(data.tags.includes("new-b"));
  });

  it("PATCH /api/sessions/:id/tags rejects non-array body", async () => {
    const res = await app.request(
      `/api/sessions/${encodeURIComponent(convoId)}/tags`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tags: "not-an-array" }),
      },
    );
    assert.equal(res.status, 400);
  });

  it("PATCH /api/sessions/:id/tags returns 404 for unknown conversation", async () => {
    const res = await app.request("/api/sessions/no-such-id/tags", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tags: ["x"] }),
    });
    assert.equal(res.status, 404);
  });

  // --- DELETE /api/sessions/:id/tags/:tag ---

  it("DELETE /api/sessions/:id/tags/:tag removes a tag", async () => {
    store.setTags(convoId, ["keep", "remove-me"]);
    const res = await app.request(
      `/api/sessions/${encodeURIComponent(convoId)}/tags/${encodeURIComponent("remove-me")}`,
      { method: "DELETE" },
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.ok, true);
    assert.deepEqual(data.tags, ["keep"]);
  });

  it("DELETE /api/sessions/:id/tags/:tag returns 404 for unknown conversation", async () => {
    const res = await app.request("/api/sessions/no-such-id/tags/foo", {
      method: "DELETE",
    });
    assert.equal(res.status, 404);
  });

  // --- Normalization through the API ---

  it("tags are normalized (lowercase, trimmed) through the HTTP API", async () => {
    await app.request(`/api/sessions/${encodeURIComponent(convoId)}/tags`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "  UPPER-CASE  " }),
    });
    assert.deepEqual(store.getTags(convoId), ["upper-case"]);
  });

  // --- tags included in conversation responses ---

  it("GET /api/conversations/:id includes tags", async () => {
    store.setTags(convoId, ["visible"]);
    const res = await app.request(
      `/api/conversations/${encodeURIComponent(convoId)}`,
    );
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.deepEqual(data.tags, ["visible"]);
  });

  it("GET /api/requests?summary=true includes tags per conversation", async () => {
    store.setTags(convoId, ["summary-tag"]);
    const res = await app.request("/api/requests?summary=true");
    const data = await res.json();
    const summary = data.conversations[0];
    assert.deepEqual(summary.tags, ["summary-tag"]);
  });

  // --- DELETE conversation clears its tags ---

  it("DELETE /api/conversations/:id removes associated tags", async () => {
    store.setTags(convoId, ["ephemeral"]);

    await app.request(`/api/conversations/${encodeURIComponent(convoId)}`, {
      method: "DELETE",
    });

    const tagsRes = await app.request("/api/tags");
    const tagsData = await tagsRes.json();
    assert.deepEqual(tagsData.tags, []);
  });
});
