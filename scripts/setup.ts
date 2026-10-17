/**
 * Production/first-run setup: applies migrations, creates reference data and
 * (optionally) the first Owner account. Safe to run on every deploy.
 *
 *   npm run db:setup -- --owner-email you@agency.com --owner-name "Your Name"
 *       Creates the Owner, or resets their password and Owner role if they exist.
 *
 *   OWNER_EMAIL / OWNER_NAME environment variables (hosted deploys)
 *       Creates the Owner only if no user with that email exists yet, so a
 *       password changed in the app is never overwritten by a redeploy.
 *
 *   --seed-demo-if-empty
 *       With APP_ENV=demo and no users at all, loads the demo data set.
 *       Never touches a database that already has users.
 *
 * The owner password is read from OWNER_PASSWORD (never from argv, so it does
 * not end up in shell history).
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { count, eq } from "drizzle-orm";
import { db, pool } from "@/db/client";
import { user } from "@/db/schema";
import { ensureReferenceData, upsertUser } from "@/server/system/bootstrap";
import { seedDemo } from "@/server/system/demo-seed";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

function ownerPassword() {
  const password = process.env.OWNER_PASSWORD;
  if (!password || password.length < 10) throw new Error("Set OWNER_PASSWORD (min 10 chars) in the environment.");
  return password;
}

async function main() {
  execSync("npx drizzle-kit migrate", { stdio: "inherit" });

  const [{ n }] = await db.select({ n: count() }).from(user);
  if (process.argv.includes("--seed-demo-if-empty") && process.env.APP_ENV === "demo" && n === 0) {
    console.log("Empty demo database: loading demo data…");
    try {
      await seedDemo(db);
    } catch (e) {
      // The database was empty when we started: clear the partial seed so the next deploy retries cleanly.
      const { rows } = await pool.query(`select tablename from pg_tables where schemaname = 'public'`);
      await pool.query(`truncate ${rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
      throw e;
    }
    console.log("Demo data loaded.");
  }

  await db.transaction((tx) => ensureReferenceData(tx));
  console.log("Reference data ensured.");

  const cliEmail = arg("owner-email");
  if (cliEmail) {
    await db.transaction((tx) => upsertUser(tx, { email: cliEmail, name: arg("owner-name") ?? cliEmail, password: ownerPassword(), roleKeys: ["owner"] }));
    console.log(`Owner account ready: ${cliEmail}`);
  } else if (process.env.OWNER_EMAIL) {
    const email = process.env.OWNER_EMAIL.toLowerCase().trim();
    const [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, email));
    if (existing) {
      console.log(`Owner ${email} already exists; left unchanged.`);
    } else {
      await db.transaction((tx) => upsertUser(tx, { email, name: process.env.OWNER_NAME || email, password: ownerPassword(), roleKeys: ["owner"] }));
      console.log(`Owner account created: ${email}`);
    }
  }
  await pool.end();
}

main().catch(async (e) => {
  console.error(e);
  await pool.end();
  process.exit(1);
});
