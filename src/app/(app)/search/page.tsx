import Link from "next/link";
import { and, desc, ilike, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, documents, engagements, invoices, leads, opportunities, people, proposals, suppliers, tasks } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility, documentVisibility, engagementVisibility, invoiceVisibility, leadVisibility, opportunityVisibility, taskVisibility } from "@/server/auth/scope";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";

export const metadata = { title: "Search" };

type Hit = { href: string; title: string; sub?: string | null };

/** Global search. Each source applies the same record-level visibility as its own list page. */
export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard();
  const sp = await searchParams;
  const q = (sp.q ?? "").trim().slice(0, 100);
  const groups: { label: string; hits: Hit[] }[] = [];
  if (q.length >= 2) {
    const like = `%${q}%`;
    const L = 8;
    if (can(actor, "crm.read")) {
      groups.push({ label: "Accounts", hits: (await db.select({ id: accounts.id, name: accounts.name, domain: accounts.domain }).from(accounts).where(and(accountVisibility(actor), or(ilike(accounts.name, like), ilike(sql`coalesce(${accounts.domain},'')`, like)))).limit(L)).map((r) => ({ href: `/crm/accounts/${r.id}`, title: r.name, sub: r.domain })) });
      groups.push({ label: "Contacts", hits: (await db.select({ id: contacts.id, name: contacts.fullName, email: contacts.email, title: contacts.jobTitle }).from(contacts).where(and(or(accountVisibility(actor), sql`${contacts.primaryAccountId} is null`), or(ilike(contacts.fullName, like), ilike(sql`coalesce(${contacts.email},'')`, like)))).limit(L)).map((r) => ({ href: `/crm/contacts/${r.id}`, title: r.name, sub: [r.title, r.email].filter(Boolean).join(" · ") })) });
      groups.push({ label: "Leads", hits: (await db.select({ id: leads.id, name: leads.companyName, status: leads.status }).from(leads).where(and(leadVisibility(actor), or(ilike(leads.companyName, like), ilike(sql`coalesce(${leads.domain},'')`, like)))).limit(L)).map((r) => ({ href: `/crm/leads/${r.id}`, title: r.name, sub: r.status })) });
      groups.push({ label: "Opportunities", hits: (await db.select({ id: opportunities.id, name: opportunities.name, number: opportunities.number, status: opportunities.status }).from(opportunities).where(and(opportunityVisibility(actor), or(ilike(opportunities.name, like), ilike(opportunities.number, like)))).limit(L)).map((r) => ({ href: `/crm/opportunities/${r.id}`, title: r.name, sub: `${r.number} · ${r.status}` })) });
      groups.push({ label: "Proposals", hits: (await db.select({ id: proposals.id, title: proposals.title, number: proposals.number }).from(proposals).innerJoin(accounts, sql`${accounts.id} = ${proposals.accountId}`).where(and(accountVisibility(actor), or(ilike(proposals.title, like), ilike(proposals.number, like)))).limit(L)).map((r) => ({ href: `/crm/proposals/${r.id}`, title: r.title, sub: r.number })) });
    }
    if (can(actor, "delivery.read")) groups.push({ label: "Engagements", hits: (await db.select({ id: engagements.id, name: engagements.name, number: engagements.number }).from(engagements).where(and(engagementVisibility(actor), or(ilike(engagements.name, like), ilike(engagements.number, like)))).limit(L)).map((r) => ({ href: `/delivery/engagements/${r.id}`, title: r.name, sub: r.number })) });
    groups.push({ label: "Tasks", hits: (await db.select({ id: tasks.id, title: tasks.title, status: tasks.status }).from(tasks).where(and(taskVisibility(actor), ilike(tasks.title, like))).orderBy(desc(tasks.createdAt)).limit(L)).map((r) => ({ href: `/people/tasks/${r.id}`, title: r.title, sub: r.status })) });
    if (can(actor, "finance.read")) {
      groups.push({ label: "Invoices", hits: (await db.select({ id: invoices.id, number: invoices.number, ref: invoices.reference, status: invoices.status }).from(invoices).where(and(invoiceVisibility(actor), or(ilike(sql`coalesce(${invoices.number},'')`, like), ilike(sql`coalesce(${invoices.reference},'')`, like)))).limit(L)).map((r) => ({ href: `/finance/invoices/${r.id}`, title: r.number ?? "Draft invoice", sub: [r.ref, r.status].filter(Boolean).join(" · ") })) });
      groups.push({ label: "Suppliers", hits: (await db.select({ id: suppliers.id, name: suppliers.name }).from(suppliers).where(ilike(suppliers.name, like)).limit(L)).map((r) => ({ href: `/finance/suppliers/${r.id}`, title: r.name })) });
    }
    if (can(actor, "people.read")) groups.push({ label: "People", hits: (await db.select({ id: people.id, name: people.fullName, title: people.jobTitle }).from(people).where(ilike(people.fullName, like)).limit(L)).map((r) => ({ href: `/people/${r.id}`, title: r.name, sub: r.title })) });
    if (can(actor, "documents.read")) groups.push({ label: "Documents", hits: (await db.select({ id: documents.id, title: documents.title, type: documents.docType }).from(documents).where(and(documentVisibility(actor), sql`${documents.archivedAt} is null`, ilike(documents.title, like))).limit(L)).map((r) => ({ href: `/api/documents/${r.id}/download`, title: r.title, sub: r.type.replace(/_/g, " ") })) });
  }
  const found = groups.filter((g) => g.hits.length);
  return (
    <>
      <PageHeader title={q ? `Search: “${q}”` : "Search"} description="Results only include records you are allowed to see." />
      <form action="/search" className="mb-4 flex max-w-xl gap-2"><input name="q" defaultValue={q} aria-label="Search" className="h-9 flex-1 rounded-md border border-line-strong bg-surface px-3 text-sm" placeholder="Accounts, contacts, deals, invoices…" /><button className="h-9 rounded-md bg-accent px-3.5 text-sm text-white">Search</button></form>
      {q.length < 2 ? <Card><EmptyState title="Type at least two characters" /></Card> : found.length ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {found.map((g) => (
            <Card key={g.label}>
              <CardHeader title={g.label} />
              <ul className="divide-y divide-line">{g.hits.map((h) => <li key={h.href} className="px-4 py-2"><Link className="text-[13.5px] font-medium hover:underline" href={h.href}>{h.title}</Link>{h.sub ? <p className="text-[12px] text-muted">{h.sub}</p> : null}</li>)}</ul>
            </Card>
          ))}
        </div>
      ) : <Card><EmptyState title="Nothing found" description="Try a company name, person, deal number or invoice number." /></Card>}
    </>
  );
}
