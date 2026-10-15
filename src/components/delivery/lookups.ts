import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, offers, services, user } from "@/db/schema";
import type { Actor } from "@/server/auth/actor";
import { accountVisibility } from "@/server/auth/scope";

export async function engagementFormLookups(actor: Actor, accountId?: string | null) {
  const [a, s, o, u, c] = await Promise.all([
    db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(and(isNull(accounts.archivedAt), accountVisibility(actor, "delivery.read"))).orderBy(asc(accounts.name)),
    db.select({ value: services.id, label: services.name }).from(services).where(eq(services.active, true)).orderBy(asc(services.sortOrder)),
    db.select({ value: offers.id, label: offers.name }).from(offers).where(eq(offers.active, true)).orderBy(asc(offers.name)),
    db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name),
    accountId ? db.select({ value: contacts.id, label: contacts.fullName }).from(contacts).where(and(eq(contacts.primaryAccountId, accountId), isNull(contacts.archivedAt))).orderBy(contacts.fullName) : Promise.resolve([]),
  ]);
  return { accounts: a, services: s, offers: o, users: u, contacts: c };
}
