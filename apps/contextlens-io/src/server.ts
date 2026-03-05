#!/usr/bin/env node

/**
 * contextlens.io server
 *
 * POST /api/upload        - Accept LHAR file, redact, store, return share URL
 * GET  /s/:id             - Serve viewer loaded with shared session
 * GET  /s/:id/data        - Return raw redacted LHAR JSON for the viewer
 *
 * Environment variables:
 *   PORT              - Listen port (default: 3000)
 *   DATA_DIR          - Session storage directory (default: ./data)
 *   BASE_URL          - Public base URL (default: http://localhost:PORT)
 *   PRUNE_INTERVAL_MS - How often to prune expired sessions (default: 3600000 = 1h)
 *   RATE_LIMIT_UPLOADS - Max uploads per IP per hour (default: 10)
 */

import fs from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { formatStats, redactLhar } from "./redact.js";
import { S3SessionStorage } from "./storage-s3.js";
import { SessionStorage } from "./storage.js";

const PORT = Number(process.env.PORT ?? 3000);
const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const BASE_URL = process.env.BASE_URL ?? `http://localhost:${PORT}`;
const PRUNE_INTERVAL_MS = Number(process.env.PRUNE_INTERVAL_MS ?? 3_600_000);
const RATE_LIMIT_UPLOADS = Number(process.env.RATE_LIMIT_UPLOADS ?? 10);

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB

// --- Rate limiter ---
// Sliding window: tracks upload timestamps per IP, evicts entries older than 1h.

const RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

const uploadTimestamps = new Map<string, number[]>();

function getClientIp(req: Request): string {
  // Respect X-Forwarded-For when running behind a proxy/load balancer.
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return "unknown";
}

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const cutoff = now - RATE_WINDOW_MS;
  let timestamps = uploadTimestamps.get(ip) ?? [];
  // Evict old entries
  timestamps = timestamps.filter((t) => t > cutoff);
  if (timestamps.length >= RATE_LIMIT_UPLOADS) {
    uploadTimestamps.set(ip, timestamps);
    return true;
  }
  timestamps.push(now);
  uploadTimestamps.set(ip, timestamps);
  return false;
}

// Evict IPs with no recent uploads every hour to prevent unbounded growth.
setInterval(() => {
  const cutoff = Date.now() - RATE_WINDOW_MS;
  for (const [ip, timestamps] of uploadTimestamps) {
    if (timestamps.every((t) => t <= cutoff)) uploadTimestamps.delete(ip);
  }
}, RATE_WINDOW_MS);

// Select storage backend based on environment.
const useS3 = process.env.STORAGE_BACKEND === "s3";

interface AsyncStorage {
  save(content: string): Promise<string>;
  load(id: string): Promise<{ id: string; createdAt: number; content: string } | null>;
  prune(): Promise<number>;
}

function makeStorage(): AsyncStorage {
  if (useS3) {
    const s3 = new S3SessionStorage();
    return {
      save: (c) => s3.save(c),
      load: (id) => s3.load(id),
      prune: async () => s3.prune(),
    };
  }
  const local = new SessionStorage(DATA_DIR);
  return {
    save: async (c) => local.save(c),
    load: async (id) => local.load(id),
    prune: async () => local.prune(),
  };
}

const storage = makeStorage();

// Prune expired sessions on startup and then periodically (local only; S3 uses lifecycle rules).
if (!useS3) {
  storage.prune().then((n) => {
    if (n > 0) console.log(`[startup] Pruned ${n} expired sessions`);
  });
  setInterval(() => {
    storage.prune().then((n) => {
      if (n > 0) console.log(`[prune] Removed ${n} expired sessions`);
    });
  }, PRUNE_INTERVAL_MS);
}

const app = new Hono();

// Allow the local context-lens UI and the production domain to call this endpoint.
app.use(
  "/api/*",
  cors({
    origin: [
      "http://localhost:4041",
      "http://localhost:5173",
      "https://contextlens.io",
      "https://www.contextlens.io",
    ],
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type"],
  }),
);

/**
 * POST /api/upload
 *
 * Body: multipart/form-data with field "file" containing the LHAR file.
 * Or: application/json / application/lhar+json with the raw LHAR content.
 *
 * Response:
 * {
 *   id: string,
 *   url: string,
 *   stats: { total: number, byType: Record<string, number> },
 *   summary: string   // human-readable redaction summary
 * }
 */
app.post("/api/upload", async (c) => {
  const ip = getClientIp(c.req.raw);
  if (isRateLimited(ip)) {
    return c.json(
      { error: `Rate limit exceeded. Max ${RATE_LIMIT_UPLOADS} uploads per hour per IP.` },
      429,
    );
  }

  const contentType = c.req.header("content-type") ?? "";

  let raw: string;

  try {
    if (contentType.includes("multipart/form-data")) {
      const body = await c.req.formData();
      const file = body.get("file");
      if (!file || typeof file === "string") {
        return c.json({ error: "Missing file field in form data" }, 400);
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        return c.json(
          {
            error: `File too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`,
          },
          413,
        );
      }
      raw = await file.text();
    } else {
      // Raw JSON body.
      const buf = await c.req.arrayBuffer();
      if (buf.byteLength > MAX_UPLOAD_BYTES) {
        return c.json(
          {
            error: `Body too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)`,
          },
          413,
        );
      }
      raw = new TextDecoder().decode(buf);
    }
  } catch (err) {
    return c.json(
      { error: `Failed to read upload: ${(err as Error).message}` },
      400,
    );
  }

  // Validate: must be parseable JSON (wrapped .lhar.json format).
  // We intentionally only accept the wrapped format for uploads since it's
  // self-contained and easier to validate.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return c.json({ error: "Invalid JSON. Upload a .lhar.json file." }, 400);
  }

  // Basic structure check.
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("lhar" in (parsed as object))
  ) {
    return c.json(
      {
        error:
          'Missing "lhar" root key. Upload a .lhar.json file, not a .lhar file.',
      },
      400,
    );
  }

  // Redact.
  let redacted: string;
  let stats: ReturnType<typeof import("./redact.js").redactLhar>["stats"];
  try {
    const result = redactLhar(raw);
    redacted = result.redacted;
    stats = result.stats;
  } catch (err) {
    return c.json(
      { error: `Redaction failed: ${(err as Error).message}` },
      500,
    );
  }

  // Store.
  let id: string;
  try {
    id = await storage.save(redacted);
  } catch (err) {
    return c.json({ error: `Storage failed: ${(err as Error).message}` }, 500);
  }

  const url = `${BASE_URL}/s/${id}`;
  const summary = formatStats(stats);

  console.log(
    `[upload] id=${id} size=${raw.length} redacted=${stats.total} url=${url}`,
  );

  return c.json({ id, url, stats, summary });
});

/**
 * GET /s/:id/data
 *
 * Returns the raw redacted LHAR JSON for a shared session.
 * Called by the viewer iframe to load session data.
 */
app.get("/s/:id/data", async (c) => {
  const { id } = c.req.param();
  let session: Awaited<ReturnType<typeof storage.load>>;
  try {
    session = await storage.load(id);
  } catch {
    return c.json({ error: "Invalid session ID" }, 400);
  }

  if (!session) {
    return c.json({ error: "Session not found or expired" }, 404);
  }

  return c.text(session.content, 200, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, max-age=300",
  });
});

/**
 * GET /s/:id
 *
 * Serves the viewer HTML. The viewer fetches /s/:id/data to load the session.
 */
app.get("/s/:id", async (c) => {
  const { id } = c.req.param();

  // Quick existence check before serving HTML.
  let exists = false;
  try {
    exists = (await storage.load(id)) !== null;
  } catch {
    return c.html("<h1>Invalid session ID</h1>", 400);
  }

  if (!exists) {
    return c.html(
      `<!DOCTYPE html><html><head><title>Not found</title></head><body>
      <h1>Session not found</h1>
      <p>This session may have expired (sessions are kept for 7 days).</p>
      </body></html>`,
      404,
    );
  }

  // Serve viewer HTML. The viewer JS fetches /s/:id/data and renders it.
  const html = buildViewerHtml(id);
  return c.html(html);
});

/** Static viewer HTML that loads the LHAR session from /s/:id/data. */
function buildViewerHtml(id: string): string {
  // Check if a built UI dist is available next to this server.
  const distIndex = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "../ui-dist/index.html",
  );
  if (fs.existsSync(distIndex)) {
    // Inject a bootstrap script that sets the session data URL before Vue mounts.
    const base = fs.readFileSync(distIndex, "utf8");
    const bootstrap = `<script>window.__CONTEXTLENS_SHARED_SESSION_URL__ = "/s/${id}/data";</script>`;
    return base.replace("</head>", `${bootstrap}</head>`);
  }

  // Fallback: minimal HTML pointing to the public contextlens.io viewer.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Shared Context Lens Session</title>
  <style>
    body { margin: 0; font-family: system-ui, sans-serif; background: #0a0a0a; color: #e5e5e5; display: flex; align-items: center; justify-content: center; height: 100vh; flex-direction: column; gap: 1rem; }
    a { color: #60a5fa; }
    code { background: #1a1a1a; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
  </style>
</head>
<body>
  <h1>Shared Context Lens Session</h1>
  <p>Session ID: <code>${id}</code></p>
  <p>Session data: <a href="/s/${id}/data">/s/${id}/data</a></p>
  <p>
    To view this session, run <code>context-lens</code> locally and import the
    <a href="/s/${id}/data">session data file</a>.
  </p>
  <p><a href="https://github.com/larsderidder/context-lens">context-lens on GitHub</a></p>
</body>
</html>`;
}

// Health check.
app.get("/health", (c) => c.json({ ok: true }));

console.log(`[contextlens.io] Listening on port ${PORT}`);
console.log(`[contextlens.io] Data directory: ${DATA_DIR}`);
console.log(`[contextlens.io] Base URL: ${BASE_URL}`);

serve({ fetch: app.fetch, port: PORT });
