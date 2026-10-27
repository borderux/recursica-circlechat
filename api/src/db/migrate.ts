import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { config } from "../lib/config.js";

const sql = postgres(config.databaseUrl, { max: 1 });
const db = drizzle(sql);

await migrate(db, { migrationsFolder: "./migrations" });
// Fork: our own tables, outside drizzle's journal so upstream's
// numbered migrations never collide with ours. Idempotent; run in name order.
const forkDir = "./migrations/fork";
for (const f of readdirSync(forkDir).filter((n) => n.endsWith(".sql")).sort()) {
  await sql.unsafe(readFileSync(join(forkDir, f), "utf8"));
}
await sql.end();
console.log("migrations applied");
