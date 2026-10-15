import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { loadActor, type Actor } from "@/server/auth/actor";
import { ensureReferenceData, upsertUser } from "@/server/system/bootstrap";
import type { RoleKey } from "@/server/auth/permissions";
import { organizationSettings, people } from "@/db/schema";

export { db };

/** Truncate every application table and recreate reference data. */
export async function resetDb() {
  const res = await db.execute<{ tablename: string }>(sql`select tablename from pg_tables where schemaname = 'public'`);
  const names = res.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
  await db.transaction(async (tx) => {
    await ensureReferenceData(tx);
    await tx.update(organizationSettings).set({ baseCurrency: "USD", timeZone: "UTC", legalName: "Test Agency LLC", address: "1 Test St" });
  });
}

export type TestActors = Record<RoleKey, Actor>;

export async function makeActors(): Promise<TestActors> {
  const keys: RoleKey[] = ["owner", "operations_manager", "account_manager", "sales", "finance", "team_member", "contractor", "read_only"];
  const out = {} as TestActors;
  for (const k of keys) {
    const u = await db.transaction((tx) => upsertUser(tx, { email: `${k}@test.local`, name: k.replace("_", " "), password: "test-password-123", roleKeys: [k] }));
    await db.insert(people).values({ userId: u.id, type: k === "contractor" ? "contractor" : "employee", fullName: u.name, email: u.email, weeklyCapacityHours: "40" }).onConflictDoNothing();
    out[k] = (await loadActor(db, u.id))!;
  }
  return out;
}

export async function tx<T>(fn: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) {
  return db.transaction(fn);
}
