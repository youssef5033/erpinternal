import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, user } from "@/db/schema";
import type { Actor } from "@/server/auth/actor";
import { accountVisibility, engagementVisibility } from "@/server/auth/scope";

export async function taskLookups(actor: Actor) {
  const [u, e, a] = await Promise.all([
    db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name),
    db.select({ value: engagements.id, label: engagements.name }).from(engagements).where(and(inArray(engagements.status, ["onboarding", "active", "on_hold"]), engagementVisibility(actor))).orderBy(asc(engagements.name)),
    db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(and(isNull(accounts.archivedAt), accountVisibility(actor))).orderBy(asc(accounts.name)),
  ]);
  return { users: u, engagements: e, accounts: a };
}
