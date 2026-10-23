import crypto from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { Db } from "./db";
import { apiKeys } from "./schema";

const hash = (key: string) => crypto.createHash("sha256").update(key).digest("hex");

/** A new key, shown once: "dbk_" and 32 random bytes. Only its hash is stored. */
export async function createApiKey(db: Db, name: string) {
  const key = `dbk_${crypto.randomBytes(32).toString("base64url")}`;
  const [row] = await db
    .insert(apiKeys)
    .values({ name: name.trim() || "Key", prefix: key.slice(0, 10), hash: hash(key) })
    .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt });
  return { ...row, key };
}

export async function listApiKeys(db: Db) {
  return db
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, createdAt: apiKeys.createdAt })
    .from(apiKeys)
    .orderBy(desc(apiKeys.createdAt));
}

export async function deleteApiKey(db: Db, id: string) {
  await db.delete(apiKeys).where(eq(apiKeys.id, id));
}

/** The key a bearer token belongs to, or null. Marks it used (at most once a minute). */
export async function verifyApiKey(db: Db, token: string | null | undefined) {
  if (!token?.startsWith("dbk_")) return null;
  const [row] = await db.select({ id: apiKeys.id, name: apiKeys.name, lastUsedAt: apiKeys.lastUsedAt }).from(apiKeys).where(eq(apiKeys.hash, hash(token)));
  if (!row) return null;
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, row.id));
  }
  return { id: row.id, name: row.name };
}

export const bearer = (header: string | null | undefined) => (header ?? "").replace(/^Bearer\s+/i, "").trim() || null;
