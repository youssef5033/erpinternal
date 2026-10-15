import Link from "next/link";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility, engagementVisibility } from "@/server/auth/scope";
import { accountHealth } from "@/server/ops/health";
import { getRate } from "@/server/finance/ledger";
import { agencyToday, getSettings } from "@/server/system/settings";
import { d, Decimal } from "@/lib/money";
import { Badge, Card, EmptyState, Notice, PageHeader, ServiceBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "All clients" };

export default async function AllClientsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("delivery.read");
  const sp = await searchParams;
  const today = await agencyToday(db);
  const s = await getSettings(db);
  const showMoney = can(actor, "finance.read");
  const engs = await db
    .select({ e: engagements, serviceKey: services.key, serviceName: services.name })
    .from(engagements)
    .innerJoin(services, eq(services.id, engagements.serviceId))
    .where(and(engagementVisibility(actor), sp.service ? eq(engagements.serviceId, sp.service) : undefined, sp.status === "past" ? inArray(engagements.status, ["completed", "cancelled"]) : inArray(engagements.status, ["onboarding", "active", "on_hold"])));
  const accountIds = Array.from(new Set(engs.map((x) => x.e.accountId)));
  const accts = accountIds.length
    ? await db
        .select({
          a: accounts,
          ownerName: user.name,
          lastContact: sql<Date | null>`(select max(occurred_at) from activities ac where ac.account_id = "accounts"."id" and ac.direction in ('inbound','outbound'))`,
        })
        .from(accounts)
        .leftJoin(user, eq(user.id, accounts.ownerId))
        .where(and(inArray(accounts.id, accountIds), isNull(accounts.archivedAt), accountVisibility(actor, "delivery.read")))
        .orderBy(asc(accounts.name))
    : [];
  const ar = showMoney && accountIds.length
    ? (await db.execute<{ account_id: string; currency: string; outstanding: string; overdue: string }>(sql`
        select i.account_id, i.currency,
          sum(i.total - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id and pa.reversed_at is null),0) - coalesce((select sum(cn.total) from credit_notes cn where cn.invoice_id = i.id and cn.status = 'issued'),0)) as outstanding,
          sum(case when i.due_date < ${today} then i.total - coalesce((select sum(pa.amount) from payment_allocations pa where pa.invoice_id = i.id and pa.reversed_at is null),0) - coalesce((select sum(cn.total) from credit_notes cn where cn.invoice_id = i.id and cn.status = 'issued'),0) else 0 end) as overdue
        from invoices i where i.status = 'issued' and i.account_id in (${sql.join(accountIds.map((x) => sql`${x}`), sql`, `)}) group by i.account_id, i.currency`)).rows
    : [];
  const missing = new Set<string>();
  const toBase = async (amt: string, cur: string) => {
    try {
      return d(amt).times((await getRate(db, cur, s.baseCurrency, today)).rate);
    } catch {
      missing.add(cur);
      return new Decimal(0);
    }
  };
  const rows = [];
  for (const { a, ownerName, lastContact } of accts) {
    const mine = engs.filter((x) => x.e.accountId === a.id);
    const h = await accountHealth(db, a.id, { includeBudget: can(actor, "costrates.read") });
    let outstanding = new Decimal(0), overdue = new Decimal(0);
    for (const r of ar.filter((x) => x.account_id === a.id)) {
      outstanding = outstanding.plus(await toBase(r.outstanding, r.currency));
      overdue = overdue.plus(await toBase(r.overdue, r.currency));
    }
    const nextRenewal = mine.map((x) => x.e.renewalDate ?? x.e.endDate).filter((x): x is string => !!x).sort()[0] ?? null;
    rows.push({ a, ownerName, lastContact, mine, h, outstanding, overdue, nextRenewal });
  }
  if (sp.band) rows.splice(0, rows.length, ...rows.filter((r) => r.h.band === sp.band));
  const svcs = await db.select({ value: services.id, label: services.name }).from(services).orderBy(services.sortOrder);
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery" }]} title="All clients" description="Clients with current engagements across all three service streams — one account record per company." />
      <FilterBar fields={[{ type: "select", name: "service", label: "Service", options: svcs }, { type: "select", name: "status", label: "Engagements", allLabel: "Current", options: [{ value: "past", label: "Past only" }] }, { type: "select", name: "band", label: "Health", options: [{ value: "healthy", label: "Healthy" }, { value: "watch", label: "Watch" }, { value: "at_risk", label: "At risk" }] }]} />
      {missing.size ? <Notice tone="warning" className="mb-3">Receivables in {Array.from(missing).join(", ")} are excluded from base-currency totals (missing exchange rate).</Notice> : null}
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Client</TH><TH>Services</TH><TH align="right">Engagements</TH><TH>Health</TH>{showMoney ? <><TH align="right">Outstanding ({s.baseCurrency})</TH><TH align="right">Overdue</TH></> : null}<TH>Next renewal / end</TH><TH>Last client contact</TH></tr></THead>
            <tbody>
              {rows.map(({ a, ownerName, lastContact, mine, h, outstanding, overdue, nextRenewal }) => (
                <TR key={a.id}>
                  <TD><Link className="font-medium hover:underline" href={`/crm/accounts/${a.id}?tab=engagements`}>{a.name}</Link><div className="text-[12px] text-muted">{ownerName ?? "no owner"}</div></TD>
                  <TD><div className="flex flex-wrap gap-1">{Array.from(new Map(mine.map((x) => [x.serviceKey, x.serviceName])).entries()).map(([k, n]) => <ServiceBadge key={k} serviceKey={k} name={n} />)}</div></TD>
                  <TD align="right"><Link className="hover:underline" href={`/delivery/engagements?account=${a.id}`}>{mine.length}</Link></TD>
                  <TD><Link href={`/crm/accounts/${a.id}?tab=health`} title={h.factors.map((f) => `${f.label} (${f.impact})`).join("; ") || "No negative factors"}><Badge tone={h.band === "healthy" ? "success" : h.band === "watch" ? "warning" : "danger"}>{h.score} · {h.band.replace("_", " ")}</Badge></Link></TD>
                  {showMoney ? <><TD align="right"><Money value={outstanding.toFixed(2)} currency={s.baseCurrency} /></TD><TD align="right"><Money value={overdue.toFixed(2)} currency={s.baseCurrency} className={overdue.greaterThan(0) ? "text-danger" : ""} /></TD></> : null}
                  <TD><DateText value={nextRenewal} overdue={!!nextRenewal && nextRenewal < today} /></TD>
                  <TD>{lastContact ? <DateText value={new Date(lastContact).toISOString().slice(0, 10)} /> : <span className="text-warning">none logged</span>}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No clients with engagements match" />}
      </Card>
    </>
  );
}
