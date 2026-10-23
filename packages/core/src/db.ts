import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

const g = globalThis as unknown as { __debriefDb?: { db: Db; pool: pg.Pool } };

/** The shared connection pool, made on first use from DATABASE_URL. */
export function getDb(): Db {
  if (!g.__debriefDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    const pool = new pg.Pool({ connectionString: url, max: Number(process.env.DB_POOL_SIZE ?? 10) });
    g.__debriefDb = { pool, db: drizzle(pool, { schema }) };
  }
  return g.__debriefDb.db;
}

export async function closeDb() {
  await g.__debriefDb?.pool.end();
  g.__debriefDb = undefined;
}
