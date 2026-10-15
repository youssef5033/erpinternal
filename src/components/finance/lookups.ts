import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, bankAccounts, contacts, engagements, expenseCategories, ledgerAccounts, services, suppliers, taxRates } from "@/db/schema";

export async function invoiceLookups(accountId?: string | null) {
  const [a, e, t, s, c] = await Promise.all([
    db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(isNull(accounts.archivedAt)).orderBy(asc(accounts.name)),
    db.select({ value: engagements.id, label: engagements.name, accountId: engagements.accountId }).from(engagements).where(inArray(engagements.status, ["onboarding", "active", "on_hold", "completed"])).orderBy(asc(engagements.name)),
    db.select({ value: taxRates.id, label: taxRates.name, pct: taxRates.ratePercent, appliesTo: taxRates.appliesTo }).from(taxRates).where(eq(taxRates.active, true)).orderBy(taxRates.name),
    db.select({ value: services.id, label: services.name }).from(services).orderBy(services.sortOrder),
    accountId ? db.select({ value: contacts.id, label: contacts.fullName }).from(contacts).where(and(eq(contacts.primaryAccountId, accountId), isNull(contacts.archivedAt))) : Promise.resolve([]),
  ]);
  return { accounts: a, engagements: e, taxRates: t.filter((x) => x.appliesTo !== "purchases").map((x) => ({ value: x.value, label: `${x.label} (${Number(x.pct)}%)` })), purchaseTaxRates: t.filter((x) => x.appliesTo !== "sales").map((x) => ({ value: x.value, label: `${x.label} (${Number(x.pct)}%)` })), services: s, contacts: c };
}

export async function financeLookups() {
  const [banks, sups, cats, ledgers, engs] = await Promise.all([
    db.select().from(bankAccounts).where(eq(bankAccounts.active, true)).orderBy(bankAccounts.name),
    db.select({ value: suppliers.id, label: suppliers.name, currency: suppliers.defaultCurrency }).from(suppliers).orderBy(suppliers.name),
    db.select({ value: expenseCategories.id, label: expenseCategories.name }).from(expenseCategories).where(eq(expenseCategories.active, true)).orderBy(expenseCategories.name),
    db.select().from(ledgerAccounts).where(eq(ledgerAccounts.active, true)).orderBy(ledgerAccounts.code),
    db.select({ value: engagements.id, label: engagements.name }).from(engagements).where(inArray(engagements.status, ["onboarding", "active", "on_hold"])).orderBy(engagements.name),
  ]);
  return {
    banks: banks.map((b) => ({ value: b.id, label: `${b.name} (${b.currency})`, currency: b.currency })),
    suppliers: sups,
    categories: cats,
    ledgers: ledgers.map((l) => ({ value: l.id, label: `${l.code} ${l.name}`, type: l.type })),
    expenseLedgers: ledgers.filter((l) => l.type === "expense" || l.type === "asset").map((l) => ({ value: l.id, label: `${l.code} ${l.name}` })),
    engagements: engs,
  };
}
