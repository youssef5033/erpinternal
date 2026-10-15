import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { bills, ledgerAccounts, people, supplierPayments, supplierRates, suppliers } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { billOutstandingSql } from "@/server/finance/payables";
import { agencyToday } from "@/server/system/settings";
import { Card, CardBody, CardHeader, DefinitionList, EmptyState, LinkButton, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { AuditPanel, DocumentsPanel } from "@/components/records/panels";
import { SupplierForm } from "@/components/finance/supplier-form";

export const metadata = { title: "Supplier" };

export default async function SupplierPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("finance.read");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [s] = await db.select().from(suppliers).where(eq(suppliers.id, id));
  if (!s) notFound();
  const today = await agencyToday(db);
  const bl = await db.select({ b: bills, outstanding: billOutstandingSql }).from(bills).where(eq(bills.supplierId, id)).orderBy(desc(bills.billDate)).limit(100);
  const pays = await db.select().from(supplierPayments).where(eq(supplierPayments.supplierId, id)).orderBy(desc(supplierPayments.paymentDate)).limit(50);
  const rates = await db.select().from(supplierRates).where(eq(supplierRates.supplierId, id)).orderBy(desc(supplierRates.effectiveFrom));
  const [person] = s.personId ? await db.select().from(people).where(eq(people.id, s.personId)) : [];
  const canWrite = can(actor, "finance.write");
  const ledgers = canWrite ? (await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.type, "expense")).orderBy(asc(ledgerAccounts.code))).map((l) => ({ value: l.id, label: `${l.code} ${l.name}` })) : [];
  const ppl = canWrite ? await db.select({ value: people.id, label: people.fullName }).from(people).where(eq(people.type, "contractor")) : [];
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Suppliers & contractors", href: "/finance/suppliers" }, { label: s.name }]} title={s.name} description={`${s.supplierType} · ${s.defaultCurrency} · ${s.paymentTermsDays}-day terms`} actions={canWrite ? <LinkButton variant="primary" href={`/finance/bills/new?supplier=${id}`}>New bill</LinkButton> : null} />
      <div className="grid gap-4 xl:grid-cols-[1.5fr_1fr]">
        <div className="space-y-4">
          <Card>
            <CardHeader title="Bills" />
            {bl.length ? (
              <Table>
                <THead><tr><TH>Bill</TH><TH>Date</TH><TH>Due</TH><TH align="right">Total</TH><TH align="right">Unpaid</TH><TH>Status</TH></tr></THead>
                <tbody>{bl.map(({ b, outstanding }) => <TR key={b.id}><TD><Link className="font-medium hover:underline" href={`/finance/bills/${b.id}`}>{b.number}</Link>{b.supplierReference ? <div className="text-[12px] text-muted">{b.supplierReference}</div> : null}</TD><TD><DateText value={b.billDate} /></TD><TD><DateText value={b.dueDate} overdue={b.status === "approved" && Number(outstanding) > 0 && b.dueDate < today} /></TD><TD align="right"><Money value={b.total} currency={b.currency} /></TD><TD align="right">{b.status === "approved" ? <Money value={outstanding} currency={b.currency} /> : "—"}</TD><TD><StatusBadge status={b.status === "approved" && Number(outstanding) <= 0 ? "paid" : b.status} /></TD></TR>)}</tbody>
              </Table>
            ) : <EmptyState title="No bills" />}
          </Card>
          <Card>
            <CardHeader title="Payments made" />
            {pays.length ? <Table><tbody>{pays.map((p) => <TR key={p.id}><TD>{p.number}</TD><TD><DateText value={p.paymentDate} /></TD><TD>{p.method.replace("_", " ")}</TD><TD align="right"><Money value={p.amount} currency={p.currency} /></TD><TD><StatusBadge status={p.status} /></TD></TR>)}</tbody></Table> : <EmptyState title="No payments" />}
          </Card>
          {canWrite ? <Card><CardHeader title="Edit supplier" /><CardBody><SupplierForm v={s} ledgers={ledgers} people={ppl} /></CardBody></Card> : null}
        </div>
        <div className="space-y-4">
          <Card>
            <CardHeader title="Details" />
            <CardBody>
              <DefinitionList columns={1} items={[
                { label: "Contact", value: [s.contactName, s.email, s.phone].filter(Boolean).join(" · ") || "—" },
                { label: "Website", value: s.website ?? "—" },
                { label: "Tax identifier", value: s.taxIdentifier ?? "—" },
                { label: "Linked person", value: person ? <Link className="hover:underline" href={`/people/${person.id}`}>{person.fullName}</Link> : "—" },
                ...(canWrite ? [{ label: "Payment details", value: <span className="whitespace-pre-wrap">{s.bankDetails ?? "—"}</span> }] : []),
                { label: "Notes", value: s.notes ?? "—" },
              ]} />
            </CardBody>
          </Card>
          <Card>
            <CardHeader title="Agreed rates" />
            {rates.length ? <ul className="divide-y divide-line text-[13px]">{rates.map((r) => <li key={r.id} className="flex justify-between px-4 py-2"><span>{r.description} <span className="text-muted">from <DateText value={r.effectiveFrom} /></span></span><span><Money value={r.rate} currency={r.currency} /> / {r.unit}</span></li>)}</ul> : <EmptyState title="No rates recorded" />}
          </Card>
          <DocumentsPanel actor={actor} link={{ supplierId: id }} defaultType="contract" title="Contracts & documents" />
          <AuditPanel actor={actor} entityType="supplier" entityId={id} />
        </div>
      </div>
    </>
  );
}
