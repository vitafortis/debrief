// Creates the e2e database if it's missing, before the test server starts (global-setup seeds it after).
import pg from "pg";

const url = new URL(process.env.DATABASE_URL);
const name = url.pathname.slice(1);
url.pathname = "/postgres";
const c = new pg.Client({ connectionString: url.toString() });
await c.connect();
const { rowCount } = await c.query("select 1 from pg_database where datname = $1", [name]);
if (!rowCount) await c.query(`create database "${name.replace(/"/g, "")}"`);
await c.end();
