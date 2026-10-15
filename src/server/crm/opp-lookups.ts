import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, engagements } from "@/db/schema";
import { getDefaultPipeline } from "../system/settings";

export async function opportunityFormLookups(accountId?: string | null) {
  const accs = await db.select({ id: accounts.id, name: accounts.name, currency: accounts.defaultCurrency }).from(accounts).where(isNull(accounts.archivedAt)).orderBy(asc(accounts.name));
  const cts = accountId ? await db.select({ id: contacts.id, name: contacts.fullName }).from(contacts).where(and(eq(contacts.primaryAccountId, accountId), isNull(contacts.archivedAt))) : [];
  const engs = accountId ? await db.select({ id: engagements.id, number: engagements.number, name: engagements.name }).from(engagements).where(eq(engagements.accountId, accountId)) : [];
  const { stages } = await getDefaultPipeline(db);
  return {
    accounts: accs.map((a) => ({ value: a.id, label: a.name })),
    accountCurrency: accs.find((a) => a.id === accountId)?.currency ?? undefined,
    contacts: cts.map((c) => ({ value: c.id, label: c.name })),
    engagements: engs.map((e) => ({ value: e.id, label: `${e.number} ${e.name}` })),
    stages: stages.filter((s) => s.kind === "open").map((s) => ({ value: s.id, label: s.name })),
  };
}
