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
import { count, eq } from "drizzle-orm";
import { user } from "@/db/schema";

// Loaded inside main() so connection-setting errors get the plain-language explanation below.
let db: typeof import("@/db/client").db;
let pool: typeof import("@/db/client").pool | undefined;

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
  ({ db, pool } = await import("@/db/client"));
  const { runMigrations } = await import("@/db/migrate");
  const { ensureReferenceData, upsertUser } = await import("@/server/system/bootstrap");
  const { seedDemo } = await import("@/server/system/demo-seed");
  await runMigrations(db);

  if (process.env.CLEAR_DEMO_DATA === "true") await clearDemoData();

  const [{ n }] = await db.select({ n: count() }).from(user);
  if (process.argv.includes("--seed-demo-if-empty") && process.env.APP_ENV === "demo" && n === 0) {
    console.log("Empty demo database: loading demo data…");
    try {
      await seedDemo(db);
    } catch (e) {
      // The database was empty when we started: clear the partial seed so the next deploy retries cleanly.
      const { rows } = await pool!.query(`select tablename from pg_tables where schemaname = 'public'`);
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
  await pool!.end();
}

/**
 * CLEAR_DEMO_DATA=true with APP_ENV=production: empties a database that holds
 * only the demo data set, so the same database can start clean for real use.
 * It refuses as soon as any account outside @demo.agency exists, so real data
 * is never touched, and leaving the variable set afterwards is harmless (once
 * the demo accounts are gone there is nothing to clear).
 */
async function clearDemoData() {
  if (process.env.APP_ENV !== "production") throw new Error("CLEAR_DEMO_DATA needs APP_ENV=production (otherwise the demo would just be loaded again).");
  const { rows } = await pool!.query<{ demo: number; other: number }>(
    `select count(*) filter (where email like '%@demo.agency')::int as demo, count(*) filter (where email not like '%@demo.agency')::int as other from "user"`,
  );
  const { demo, other } = rows[0];
  if (demo === 0) {
    console.log("CLEAR_DEMO_DATA: no demo data found; nothing cleared. You can remove the CLEAR_DEMO_DATA setting.");
    return;
  }
  if (other > 0) {
    throw new Error(`CLEAR_DEMO_DATA refused: the database has ${other} account(s) outside @demo.agency, so it may contain real data. Nothing was deleted.`);
  }
  const tables = await pool!.query<{ tablename: string }>(`select tablename from pg_tables where schemaname = 'public'`);
  await pool!.query(`truncate ${tables.rows.map((r) => `"${r.tablename}"`).join(", ")} restart identity cascade`);
  await pool!.query(`drop schema if exists pgboss cascade`);
  console.log(`CLEAR_DEMO_DATA: removed the demo data (${demo} demo accounts and all their records). The database is now empty.`);
}

/** Plain-language hint for the connection problems people hit when hosting (never prints secrets). */
function explain(e: unknown): string | null {
  // Database libraries wrap the original error (e.g. "Failed query: …", cause: the real error).
  let err = e as { code?: string; message?: string; cause?: unknown };
  while (err?.cause && !err.code) err = err.cause as typeof err;
  const msg = String(err?.message ?? e);
  const code = err?.code ?? "";
  if (/without TLS/.test(msg)) return "DATABASE_CA_CERT is empty. Paste the full certificate text from Supabase (Project Settings → Database → SSL Configuration → Download certificate).";
  if (/self[- ]signed|unable to (get|verify)|certificate/i.test(msg) || code.startsWith("SELF_SIGNED") || code.startsWith("UNABLE_TO") || code === "CERT_HAS_EXPIRED")
    return "The database certificate could not be verified. Check that DATABASE_CA_CERT contains the complete certificate text, from -----BEGIN CERTIFICATE----- to -----END CERTIFICATE-----, copied from the downloaded .crt file in a plain-text editor.";
  if (code === "28P01" || /password authentication failed/i.test(msg)) return "Wrong database password in DATABASE_URL. Replace [YOUR-PASSWORD] (including the brackets) with your Supabase database password, or reset it in Project Settings → Database.";
  if (/tenant or user not found/i.test(msg)) return "Supabase does not recognise the user in DATABASE_URL. Copy the Session pooler string again: the user must look like postgres.<project-id>.";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "The database host name in DATABASE_URL was not found. Copy the Session pooler string again from Supabase → Connect.";
  if (code === "ECONNREFUSED" || code === "ETIMEDOUT" || code === "ENETUNREACH" || /timeout/i.test(msg))
    return "Could not reach the database. Use the Session pooler string (host ...pooler.supabase.com, port 5432), not the Direct connection, and check the Supabase project is not paused.";
  if (code === "ERR_INVALID_URL" || /Invalid URL/i.test(msg)) return "DATABASE_URL is not a valid address. If your password contains characters like @ # / ? %, reset it in Supabase to one with only letters and numbers.";
  if (/DATABASE_URL is not set/.test(msg)) return "DATABASE_URL is missing in Render → Environment.";
  if (/OWNER_PASSWORD|CLEAR_DEMO_DATA/.test(msg)) return msg;
  return null;
}

main().catch(async (e) => {
  console.error(e);
  const hint = explain(e);
  console.error(`\n[setup] FAILED${hint ? `: ${hint}` : " (see the error above)."}\n`);
  await pool?.end().catch(() => undefined);
  process.exit(1);
});
