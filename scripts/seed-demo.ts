/** Seed the DEMO database (requires APP_ENV=demo). */
import "dotenv/config";
import { db, pool } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { seedDemo } from "@/server/system/demo-seed";

async function main() {
  if (process.env.APP_ENV !== "demo") throw new Error("APP_ENV must be 'demo' to seed demo data. Use a separate DATABASE_URL for the demo.");
  await runMigrations(db);
  const { rows } = await pool.query("select count(*)::int as n from accounts");
  if (rows[0].n > 0 && !process.argv.includes("--force")) throw new Error("The demo database already has data. Run `npm run demo:reset` to wipe and reseed.");
  await seedDemo(db);
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
