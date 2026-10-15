import Link from "next/link";
import { and, asc, eq, ilike, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { suppliers } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { Badge, Card, EmptyState, LinkButton, PageHeader, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Suppliers & contractors" };

export default async function SuppliersPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("finance.read");
  const sp = await searchParams;
  const rows = await db
    .select({
      s: suppliers,
      openBills: sql<number>`(select count(*) from bills b where b.supplier_id = "suppliers"."id" and b.status = 'approved' and b.total > coalesce((select sum(a.amount) from supplier_payment_allocations a where a.bill_id = b.id and a.reversed_at is null),0))`,
      unpaid: sql<string>`(select coalesce(sum(b.total - coalesce((select sum(a.amount) from supplier_payment_allocations a where a.bill_id = b.id and a.reversed_at is null),0)),0) from bills b where b.supplier_id = "suppliers"."id" and b.status = 'approved')`,
      spendYtd: sql<string>`(select coalesce(sum(b.subtotal),0) from bills b where b.supplier_id = "suppliers"."id" and b.status = 'approved' and b.bill_date >= date_trunc('year', now()))`,
      awaiting: sql<number>`(select count(*) from bills b where b.supplier_id = "suppliers"."id" and b.status = 'awaiting_approval')`,
    })
    .from(suppliers)
    .where(and(isNull(suppliers.archivedAt), sp.q ? ilike(suppliers.name, `%${sp.q}%`) : undefined, sp.type ? eq(suppliers.supplierType, sp.type as "vendor") : undefined))
    .orderBy(asc(suppliers.name));
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Suppliers & contractors" }]} title="Suppliers & contractors" description="Vendors, freelancers and partner agencies. Contractor costs on engagements come from their approved bills." actions={can(actor, "finance.write") ? <LinkButton variant="primary" href="/finance/suppliers/new">New supplier</LinkButton> : null} />
      <FilterBar fields={[{ type: "search", name: "q", label: "Search", placeholder: "Name" }, { type: "select", name: "type", label: "Type", options: ["contractor", "freelancer", "agency", "vendor"].map((v) => ({ value: v, label: v })) }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Supplier</TH><TH>Type</TH><TH>Contact</TH><TH align="right">Terms</TH><TH align="right">Spend this year (net)</TH><TH align="right">Unpaid</TH><TH>Flags</TH></tr></THead>
            <tbody>
              {rows.map(({ s, openBills, unpaid, spendYtd, awaiting }) => (
                <TR key={s.id}>
                  <TD><Link className="font-medium hover:underline" href={`/finance/suppliers/${s.id}`}>{s.name}</Link></TD>
                  <TD className="capitalize">{s.supplierType}</TD>
                  <TD className="text-[12.5px]">{s.contactName}{s.email ? <div className="text-muted">{s.email}</div> : null}</TD>
                  <TD align="right">{s.paymentTermsDays}d</TD>
                  <TD align="right" className="num">{Number(spendYtd).toLocaleString("en", { minimumFractionDigits: 2 })} {s.defaultCurrency}</TD>
                  <TD align="right" className="num">{Number(unpaid) ? `${Number(unpaid).toLocaleString("en", { minimumFractionDigits: 2 })}` : "—"}{Number(openBills) ? <div className="text-[11.5px] text-muted">{openBills} bill(s)</div> : null}</TD>
                  <TD>{Number(awaiting) ? <Badge tone="warning">{awaiting} awaiting approval</Badge> : null}{!s.taxIdentifier && s.supplierType !== "vendor" ? <Badge className="ml-1">no tax ID</Badge> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No suppliers" />}
        <p className="border-t border-line px-4 py-2 text-[12px] text-muted">Spend and unpaid amounts are in each bill's own currency summed per supplier; suppliers billing in several currencies should be checked on their page.</p>
      </Card>
    </>
  );
}
