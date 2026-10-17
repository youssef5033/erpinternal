/**
 * Wipe and reseed the DEMO database. Refuses unless APP_ENV=demo and the
 * database name contains "demo" or the user passes --i-understand.
 */
import "dotenv/config";
import { rm } from "node:fs/promises";
import { db, pool } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { seedDemo } from "@/server/system/demo-seed";

async function main() {
  if (process.env.APP_ENV !== "demo") throw new Error("APP_ENV must be 'demo'.");
  const url = new URL(process.env.DATABASE_URL!);
  if (!url.pathname.includes("demo") && !process.argv.includes("--i-understand")) {
    throw new Error(`Database "${url.pathname.slice(1)}" does not look like a demo database. Re-run with --i-understand if you are sure.`);
  }
  await runMigrations(db);
  const { rows } = await pool.query(`select tablename from pg_tables where schemaname = 'public'`);
  await pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
  await pool.query(`drop schema if exists pgboss cascade`);
  if ((process.env.STORAGE_DRIVER ?? "local") === "local") await rm(process.env.STORAGE_LOCAL_DIR ?? "./storage", { recursive: true, force: true });
  await seedDemo(db);
  console.log("Demo reset complete.");
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
