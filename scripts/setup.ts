/**
 * Production/first-run setup: applies migrations, creates reference data and
 * (optionally) the first Owner account.
 *
 *   npm run db:setup -- --owner-email you@agency.com --owner-name "Your Name"
 *
 * The owner password is read from the OWNER_PASSWORD environment variable
 * (never from argv, so it does not end up in shell history).
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { db, pool } from "@/db/client";
import { ensureReferenceData, upsertUser } from "@/server/system/bootstrap";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  execSync("npx drizzle-kit migrate", { stdio: "inherit" });
  await db.transaction((tx) => ensureReferenceData(tx));
  console.log("Reference data ensured.");
  const email = arg("owner-email");
  if (email) {
    const password = process.env.OWNER_PASSWORD;
    if (!password || password.length < 10) throw new Error("Set OWNER_PASSWORD (min 10 chars) in the environment.");
    await db.transaction((tx) => upsertUser(tx, { email, name: arg("owner-name") ?? email, password, roleKeys: ["owner"] }));
    console.log(`Owner account ready: ${email}`);
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
