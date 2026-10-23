import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

/** Creates the e2e database if needed, then wipes and seeds it with the demo week. */
export default async function setup() {
  const url = new URL(process.env.E2E_DATABASE_URL!);
  const name = url.pathname.slice(1);
  const admin = new URL(url);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  const { rowCount } = await c.query("select 1 from pg_database where datname = $1", [name]);
  if (!rowCount) await c.query(`create database "${name.replace(/"/g, "")}"`);
  await c.end();
  execFileSync("npx", ["tsx", "scripts/seed-demo.ts"], {
    cwd: path.resolve(import.meta.dirname, "../../packages/core"),
    env: { ...process.env, DATABASE_URL: url.toString(), TZ: "America/New_York" },
    stdio: "inherit",
  });
}
