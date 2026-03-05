/**
 * S3-backed session storage for production deployment.
 *
 * Drop-in replacement for storage.ts. Activated when STORAGE_BACKEND=s3.
 *
 * Uses the AWS SDK v3 S3 client pointing at Scaleway Object Storage
 * (S3-compatible). Credentials come from env vars:
 *   S3_BUCKET, S3_REGION, S3_ENDPOINT, S3_ACCESS_KEY, S3_SECRET_KEY
 *
 * TTL is enforced by an Object Storage lifecycle rule set in Terraform
 * (8-day expiry). The server still checks createdAt on load so it won't
 * serve objects the bucket hasn't cleaned up yet.
 */

import { randomBytes } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";

const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ID_BYTES = 8; // 16 hex chars

export interface StoredSession {
  id: string;
  createdAt: number;
  content: string;
}

function makeClient(): S3Client {
  const region = process.env.S3_REGION ?? "nl-ams";
  const endpoint = process.env.S3_ENDPOINT ?? `https://s3.${region}.scw.cloud`;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;

  if (!accessKeyId || !secretAccessKey) {
    throw new Error("S3_ACCESS_KEY and S3_SECRET_KEY must be set when STORAGE_BACKEND=s3");
  }

  return new S3Client({
    region,
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });
}

export class S3SessionStorage {
  private client: S3Client;
  private bucket: string;

  constructor() {
    this.client = makeClient();
    this.bucket = process.env.S3_BUCKET ?? "contextlens-io-sessions";
  }

  async save(content: string): Promise<string> {
    const id = randomBytes(ID_BYTES).toString("hex");
    const record = JSON.stringify({ id, createdAt: Date.now(), content });
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: `${id}.json`,
        Body: record,
        ContentType: "application/json",
      }),
    );
    return id;
  }

  async load(id: string): Promise<StoredSession | null> {
    if (!/^[0-9a-f]+$/.test(id)) throw new Error("Invalid session ID");
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: `${id}.json` }),
      );
      const raw = await res.Body?.transformToString();
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { id: string; createdAt: number; content: string };
      if (Date.now() - parsed.createdAt > TTL_MS) {
        // Expired: delete and return null.
        await this.client.send(
          new DeleteObjectCommand({ Bucket: this.bucket, Key: `${id}.json` }),
        ).catch(() => {});
        return null;
      }
      return { id: parsed.id, createdAt: parsed.createdAt, content: parsed.content };
    } catch (err: unknown) {
      const code = (err as { name?: string }).name;
      if (code === "NoSuchKey" || code === "NotFound") return null;
      throw err;
    }
  }

  /** No-op: TTL is handled by the S3 lifecycle rule. */
  prune(): number {
    return 0;
  }
}
