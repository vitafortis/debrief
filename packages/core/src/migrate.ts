import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getDb } from "./db";

/** Applies the SQL migrations in `folder` (packages/core/drizzle, copied into each image). */
export async function runMigrations(folder = process.env.MIGRATIONS_DIR ?? path.resolve(import.meta.dirname, "../drizzle")) {
  await migrate(getDb(), { migrationsFolder: folder });
}

/** Waits for Postgres to accept connections and for the schema to exist (the web container migrates). */
export async function waitForSchema({ tries = 60, delayMs = 2000 } = {}) {
  const db = getDb();
  for (let i = 1; ; i++) {
    try {
      await db.execute("select 1 from tasks limit 1");
      return;
    } catch (err) {
      if (i >= tries) throw err;
      if (i === 1) console.log("Waiting for the database schema…");
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}
