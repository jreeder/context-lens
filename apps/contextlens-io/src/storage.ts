/**
 * Session storage: flat files in data/:id.lhar.json, 7-day TTL.
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ID_BYTES = 8; // 16 hex chars

export interface StoredSession {
  id: string;
  createdAt: number;
  content: string; // raw LHAR JSON string
}

export class SessionStorage {
  private dataDir: string;

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    fs.mkdirSync(dataDir, { recursive: true });
  }

  /** Write a session to disk. Returns the generated short ID. */
  save(content: string): string {
    const id = randomBytes(ID_BYTES).toString("hex");
    const meta = { id, createdAt: Date.now() };
    const record = JSON.stringify({ meta, content });
    fs.writeFileSync(this.filePath(id), record, "utf8");
    return id;
  }

  /** Read a session by ID. Returns null if not found or expired. */
  load(id: string): StoredSession | null {
    const fp = this.filePath(id);
    if (!fs.existsSync(fp)) return null;
    try {
      const raw = fs.readFileSync(fp, "utf8");
      const { meta, content } = JSON.parse(raw) as {
        meta: { id: string; createdAt: number };
        content: string;
      };
      if (Date.now() - meta.createdAt > TTL_MS) {
        fs.rmSync(fp, { force: true });
        return null;
      }
      return { id: meta.id, createdAt: meta.createdAt, content };
    } catch {
      return null;
    }
  }

  /** Delete expired sessions. Called on startup and periodically. */
  prune(): number {
    let removed = 0;
    for (const file of fs.readdirSync(this.dataDir)) {
      if (!file.endsWith(".json")) continue;
      const fp = path.join(this.dataDir, file);
      try {
        const raw = fs.readFileSync(fp, "utf8");
        const { meta } = JSON.parse(raw) as { meta: { createdAt: number } };
        if (Date.now() - meta.createdAt > TTL_MS) {
          fs.rmSync(fp, { force: true });
          removed++;
        }
      } catch {
        // Corrupt file, remove it.
        fs.rmSync(fp, { force: true });
        removed++;
      }
    }
    return removed;
  }

  private filePath(id: string): string {
    // Sanitize: only hex chars allowed in ID.
    if (!/^[0-9a-f]+$/.test(id)) throw new Error("Invalid session ID");
    return path.join(this.dataDir, `${id}.json`);
  }
}
