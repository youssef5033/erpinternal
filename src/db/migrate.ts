import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { DB } from "./client";

/**
 * Apply pending SQL migrations from ./drizzle using the app's own connection
 * (so DATABASE_CA_CERT and pool settings apply). Uses the same bookkeeping
 * table as `drizzle-kit migrate`, so either can be used on the same database.
 */
export async function runMigrations(db: DB) {
  await migrate(db, { migrationsFolder: path.resolve(process.cwd(), "drizzle") });
  console.log("Migrations applied.");
}
