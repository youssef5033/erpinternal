import Link from "next/link";
import { and, asc, eq, ilike, inArray, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, engagements, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { engagementVisibility } from "@/server/auth/scope";
import { agencyToday } from "@/server/system/settings";
import { qs } from "@/lib/utils";
import { Badge, Card, EmptyState, LinkButton, PageHeader, ServiceBadge, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money, Pagination } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { BILLING_MODELS } from "@/components/delivery/engagement-form";

export const metadata = { title: "Engagements" };

export default async function EngagementsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("delivery.read");
  const sp = await searchParams;
  const today = await agencyToday(db);
  const status = sp.status ?? "current";
  const conds: (SQL | undefined)[] = [engagementVisibility(actor), status === "all" ? undefined : status === "current" ? inArray(engagements.status, ["onboarding", "active", "on_hold"]) : eq(engagements.status, status as "active")];
  if (sp.q) conds.push(or(ilike(engagements.name, `%${sp.q}%`), ilike(engagements.number, `%${sp.q}%`), ilike(accounts.name, `%${sp.q}%`)));
  if (sp.service) conds.push(eq(engagements.serviceId, sp.service));
  if (sp.owner) conds.push(eq(engagements.ownerId, sp.owner));
  if (sp.account) conds.push(eq(engagements.accountId, sp.account));
  if (sp.billing) conds.push(eq(engagements.billingModel, sp.billing as "fixed"));
  if (sp.renewing === "1") conds.push(sql`coalesce(${engagements.renewalDate}, ${engagements.endDate}) <= (${today}::date + 90)`);
  const where = and(...conds);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(engagements).innerJoin(accounts, eq(accounts.id, engagements.accountId)).where(where);
  const rows = await db
    .select({
      e: engagements,
      accountName: accounts.name,
      serviceName: services.name,
      serviceKey: services.key,
      ownerName: user.name,
      lateDeliverables: sql<number>`(select count(*) from deliverables dl where dl.engagement_id = "engagements"."id" and dl.due_date < ${today} and dl.approval_status not in ('approved','rejected'))`,
      openTasks: sql<number>`(select count(*) from tasks t where t.engagement_id = "engagements"."id" and t.status not in ('completed','cancelled'))`,
      pendingCrs: sql<number>`(select count(*) from change_requests cr where cr.engagement_id = "engagements"."id" and cr.status = 'submitted')`,
      hours: sql<string>`(select coalesce(sum(te.hours),0) from time_entries te where te.engagement_id = "engagements"."id" and te.status = 'approved')`,
    })
    .from(engagements)
    .innerJoin(accounts, eq(accounts.id, engagements.accountId))
    .innerJoin(services, eq(services.id, engagements.serviceId))
    .leftJoin(user, eq(user.id, engagements.ownerId))
    .where(where)
    .orderBy(asc(accounts.name), asc(engagements.name))
    .limit(50)
    .offset((page - 1) * 50);
  const [svcs, users, accts] = await Promise.all([
    db.select({ value: services.id, label: services.name }).from(services).orderBy(services.sortOrder),
    db.select({ value: user.id, label: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name),
    db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(sql`${accounts.id} in (select account_id from engagements)`).orderBy(accounts.name),
  ]);
  const showValue = can(actor, "finance.read") || can(actor, "crm.read");
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: "Engagements" }]} title="Engagements" description="Every piece of contracted work, with its scope, budget, deliverables and billing." actions={can(actor, "delivery.write") ? <LinkButton variant="primary" href="/delivery/engagements/new">New engagement</LinkButton> : null} />
      <FilterBar fields={[
        { type: "search", name: "q", label: "Search", placeholder: "Name, number or client" },
        { type: "select", name: "status", label: "Status", allLabel: "Current (onboarding, active, on hold)", options: [{ value: "all", label: "All" }, ...["onboarding", "active", "on_hold", "completed", "cancelled"].map((v) => ({ value: v, label: v.replace("_", " ") }))] },
        { type: "select", name: "service", label: "Service", options: svcs },
        { type: "select", name: "account", label: "Client", options: accts },
        { type: "select", name: "owner", label: "Lead", options: users },
        { type: "select", name: "billing", label: "Billing", options: BILLING_MODELS },
        { type: "select", name: "renewing", label: "Renewal", options: [{ value: "1", label: "Renewing / ending ≤ 90 days" }] },
      ]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Engagement</TH><TH>Client</TH><TH>Service</TH><TH>Billing</TH>{showValue ? <TH align="right">Value</TH> : null}<TH align="right">Hours</TH><TH>Signals</TH><TH>End / renewal</TH><TH>Status</TH></tr></THead>
            <tbody>
              {rows.map(({ e, accountName, serviceName, serviceKey, ownerName, lateDeliverables, openTasks, pendingCrs, hours }) => {
                const pct = e.budgetHours && Number(e.budgetHours) > 0 ? (Number(hours) / Number(e.budgetHours)) * 100 : null;
                const endish = e.renewalDate ?? e.endDate;
                return (
                  <TR key={e.id}>
                    <TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${e.id}`}>{e.name}</Link><div className="text-[12px] text-muted">{e.number} · {ownerName ?? "no lead"}</div></TD>
                    <TD><Link className="hover:underline" href={`/crm/accounts/${e.accountId}`}>{accountName}</Link></TD>
                    <TD><ServiceBadge serviceKey={serviceKey} name={serviceName} /></TD>
                    <TD className="text-[12.5px]">{BILLING_MODELS.find((b) => b.value === e.billingModel)?.label}</TD>
                    {showValue ? <TD align="right"><Money value={e.billingModel === "retainer" && e.retainerAmount ? e.retainerAmount : e.contractValue} currency={e.currency} />{e.billingModel === "retainer" ? <div className="text-[11.5px] text-muted">per period</div> : null}</TD> : null}
                    <TD align="right" className={pct !== null && pct > 100 ? "text-danger" : pct !== null && pct > 85 ? "text-warning" : ""}>{Number(hours).toFixed(1)}{e.budgetHours ? ` / ${Number(e.budgetHours).toFixed(0)}` : ""}</TD>
                    <TD className="space-x-1">{Number(lateDeliverables) ? <Badge tone="danger">{lateDeliverables} late</Badge> : null}{Number(pendingCrs) ? <Badge tone="warning">{pendingCrs} CR pending</Badge> : null}{Number(openTasks) ? <Badge>{openTasks} tasks</Badge> : null}</TD>
                    <TD><DateText value={endish} overdue={!!endish && endish < today && e.status !== "completed"} /></TD>
                    <TD><StatusBadge status={e.status} /></TD>
                  </TR>
                );
              })}
            </tbody>
          </Table>
        ) : <EmptyState title="No engagements match" description="Engagements are created when a won opportunity is handed over, or directly here." />}
        <Pagination page={page} pageSize={50} total={Number(total)} hrefFor={(p) => `/delivery/engagements${qs({ ...sp, page: p })}`} />
      </Card>
    </>
  );
}
