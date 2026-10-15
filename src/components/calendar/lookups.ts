import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, user } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { accountVisibility, engagementVisibility } from "@/server/auth/scope";

/** Option lists for event forms, limited to records the actor can see. */
export async function eventLookups(actor: Actor) {
  const [users, accts, engs] = await Promise.all([
    db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name),
    can(actor, "crm.read") ? db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(and(isNull(accounts.archivedAt), accountVisibility(actor))).orderBy(asc(accounts.name)) : Promise.resolve([]),
    can(actor, "delivery.read") ? db.select({ value: engagements.id, label: engagements.name }).from(engagements).where(and(inArray(engagements.status, ["onboarding", "active", "on_hold"]), engagementVisibility(actor))).orderBy(asc(engagements.name)) : Promise.resolve([]),
  ]);
  return { users, accounts: accts, engagements: engs };
}
