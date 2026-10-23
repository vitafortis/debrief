import { closeDb } from "./db";
import { runMigrations } from "./migrate";

await runMigrations();
console.log("Migrations applied.");
await closeDb();
