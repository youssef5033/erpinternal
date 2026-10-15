import { NextResponse } from "next/server";
import { and, eq, ne, sql } from "drizzle-orm";
import Papa from "papaparse";
import { db } from "@/db/client";
import { accounts, bills, contacts, invoices, journalEntries, journalLines, leads, ledgerAccounts, opportunities, pipelineStages, suppliers, timeEntries, people, user } from "@/db/schema";
import { getActor } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility, invoiceVisibility, leadVisibility, opportunityVisibility } from "@/server/auth/scope";
import { LEAD_IMPORT_FIELDS } from "@/server/crm/lead-import";
import { outstandingSql } from "@/server/finance/invoices";
import { billOutstandingSql } from "@/server/finance/payables";
import { audit } from "@/server/audit";

/** CSV exports. Each entity enforces its own permission and record scope. */
export async function GET(req: Request, ctx: { params: Promise<{ entity: string }> }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const { entity } = await ctx.params;
  let rows: Record<string, unknown>[] = [];
  const deny = () => NextResponse.json({ error: "You do not have permission to export this data." }, { status: 403 });
  switch (entity) {
    case "lead-template":
      return csv("lead-import-template.csv", [Object.fromEntries(LEAD_IMPORT_FIELDS.map((f) => [f.label.replace(/ \(.*\)/, ""), ""]))]);
    case "leads":
      if (!can(actor, "crm.export")) return deny();
      rows = await db.select({ company: leads.companyName, website: leads.website, status: leads.status, channel: leads.acquisitionChannel, industry: leads.industry, country: leads.country, owner: user.name, nextAction: leads.nextAction, nextActionDate: leads.nextActionDate, estimatedValue: leads.estimatedValue, currency: leads.currency, dateAdded: leads.dateAdded, tags: sql<string>`array_to_string(${leads.tags}, ',')` }).from(leads).leftJoin(user, eq(user.id, leads.ownerId)).where(and(leadVisibility(actor), ne(leads.status, "merged")));
      break;
    case "accounts":
      if (!can(actor, "crm.export")) return deny();
      rows = await db.select({ name: accounts.name, website: accounts.website, lifecycle: accounts.lifecycleStatus, industry: accounts.industry, country: accounts.country, owner: user.name, billingEmail: accounts.billingEmail, paymentTermsDays: accounts.paymentTermsDays, currency: accounts.defaultCurrency, acquisitionChannel: accounts.acquisitionChannel }).from(accounts).leftJoin(user, eq(user.id, accounts.ownerId)).where(accountVisibility(actor));
      break;
    case "contacts":
      if (!can(actor, "crm.export")) return deny();
      rows = await db.select({ name: contacts.fullName, title: contacts.jobTitle, email: contacts.email, phone: contacts.phone, account: accounts.name, doNotContact: contacts.doNotContact, roles: sql<string>`array_to_string(${contacts.buyingRoles}, ',')` }).from(contacts).leftJoin(accounts, eq(accounts.id, contacts.primaryAccountId)).where(accountVisibility(actor));
      break;
    case "opportunities":
      if (!can(actor, "crm.export")) return deny();
      rows = await db.select({ number: opportunities.number, name: opportunities.name, account: accounts.name, stage: pipelineStages.name, status: opportunities.status, kind: opportunities.kind, value: opportunities.value, currency: opportunities.currency, probability: sql<number>`coalesce(${opportunities.probabilityOverride}, ${pipelineStages.probability})`, expectedClose: opportunities.expectedCloseDate, owner: user.name, channel: opportunities.acquisitionChannel }).from(opportunities).innerJoin(accounts, eq(accounts.id, opportunities.accountId)).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).leftJoin(user, eq(user.id, opportunities.ownerId)).where(opportunityVisibility(actor));
      break;
    case "invoices":
      if (!can(actor, "finance.export") && !can(actor, "finance.read")) return deny();
      rows = await db.select({ number: invoices.number, account: accounts.name, status: invoices.status, issueDate: invoices.issueDate, dueDate: invoices.dueDate, currency: invoices.currency, subtotal: invoices.subtotal, tax: invoices.taxTotal, total: invoices.total, outstanding: outstandingSql, exchangeRate: invoices.exchangeRate }).from(invoices).innerJoin(accounts, eq(accounts.id, invoices.accountId)).where(invoiceVisibility(actor));
      break;
    case "bills":
      if (!can(actor, "finance.export")) return deny();
      rows = await db.select({ number: bills.number, supplier: suppliers.name, reference: bills.supplierReference, status: bills.status, billDate: bills.billDate, dueDate: bills.dueDate, currency: bills.currency, total: bills.total, outstanding: billOutstandingSql }).from(bills).innerJoin(suppliers, eq(suppliers.id, bills.supplierId));
      break;
    case "time":
      if (!can(actor, "time.approve")) return deny();
      rows = await db
        .select({ person: people.fullName, date: timeEntries.workDate, hours: timeEntries.hours, billable: timeEntries.billable, status: timeEntries.status, description: timeEntries.description, ...(can(actor, "costrates.read") ? { costRate: timeEntries.costRate, costAmount: timeEntries.costAmount, costCurrency: timeEntries.costCurrency } : {}) })
        .from(timeEntries)
        .innerJoin(people, eq(people.id, timeEntries.personId));
      break;
    case "journal":
      if (!can(actor, "finance.export")) return deny();
      rows = await db.select({ entry: journalEntries.number, date: journalEntries.entryDate, memo: journalEntries.memo, source: journalEntries.sourceType, account: sql<string>`${ledgerAccounts.code} || ' ' || ${ledgerAccounts.name}`, debit: journalLines.debit, credit: journalLines.credit, currency: journalLines.txnCurrency, txnAmount: journalLines.txnAmount, rate: journalLines.exchangeRate }).from(journalLines).innerJoin(journalEntries, eq(journalEntries.id, journalLines.entryId)).innerJoin(ledgerAccounts, eq(ledgerAccounts.id, journalLines.ledgerAccountId)).orderBy(journalEntries.entryDate, journalEntries.number);
      break;
    default:
      return NextResponse.json({ error: "Unknown export" }, { status: 404 });
  }
  void req;
  await audit(db, actor, { action: "data.exported", entityType: entity, summary: `Exported ${rows.length} ${entity} rows (CSV)` });
  return csv(`${entity}-${new Date().toISOString().slice(0, 10)}.csv`, rows);
}

function csv(name: string, rows: Record<string, unknown>[]) {
  // Prevent CSV formula injection when opened in spreadsheets.
  const safe = rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : v])));
  return new NextResponse("﻿" + Papa.unparse(safe), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "private, no-store" } });
}
