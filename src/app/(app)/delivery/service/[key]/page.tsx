import Link from "next/link";
import { notFound } from "next/navigation";
import { and, asc, eq, inArray, lte, notInArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, deliverables, engagements, services, user, workspaceItems } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { engagementVisibility } from "@/server/auth/scope";
import { findItemType } from "@/server/delivery/templates";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO } from "@/lib/dates";
import { Badge, Card, CardHeader, EmptyState, LinkButton, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, MetricCard } from "@/components/ui/display";

export const metadata = { title: "Service stream" };

const DONE = ["approved", "completed", "published_manually", "final", "issued", "done", "closed", "agreed", "received", "verified", "reported", "recorded", "achieved", "superseded", "retired", "declined", "accepted", "rejected", "supported", "not_available"];

export default async function ServicePage({ params }: { params: Promise<{ key: string }> }) {
  const actor = await guard("delivery.read");
  const { key } = await params;
  const [svc] = await db.select().from(services).where(eq(services.key, key));
  if (!svc) notFound();
  const today = await agencyToday(db);
  const horizon = addDaysISO(today, 14);
  const engs = await db
    .select({ e: engagements, accountName: accounts.name, ownerName: user.name, late: sql<number>`(select count(*) from deliverables dl where dl.engagement_id = "engagements"."id" and dl.due_date < ${today} and dl.approval_status not in ('approved','rejected'))`, review: sql<number>`(select count(*) from deliverables dl where dl.engagement_id = "engagements"."id" and dl.approval_status in ('internal_review','awaiting_client'))` })
    .from(engagements)
    .innerJoin(accounts, eq(accounts.id, engagements.accountId))
    .leftJoin(user, eq(user.id, engagements.ownerId))
    .where(and(eq(engagements.serviceId, svc.id), inArray(engagements.status, ["onboarding", "active", "on_hold"]), engagementVisibility(actor)))
    .orderBy(asc(accounts.name));
  const ids = engs.map((x) => x.e.id);
  const due = ids.length
    ? await db.select({ d: deliverables, engName: engagements.name }).from(deliverables).innerJoin(engagements, eq(engagements.id, deliverables.engagementId)).where(and(inArray(deliverables.engagementId, ids), lte(deliverables.dueDate, horizon), notInArray(deliverables.approvalStatus, ["approved", "rejected"]))).orderBy(asc(deliverables.dueDate))
    : [];
  const items = ids.length
    ? await db.select({ i: workspaceItems, engName: engagements.name }).from(workspaceItems).innerJoin(engagements, eq(engagements.id, workspaceItems.engagementId)).where(and(inArray(workspaceItems.engagementId, ids), notInArray(workspaceItems.status, DONE), sql`coalesce(${workspaceItems.scheduledDate}, ${workspaceItems.dueDate}) <= ${horizon}`)).orderBy(sql`coalesce(${workspaceItems.scheduledDate}, ${workspaceItems.dueDate})`)
    : [];
  const late = engs.reduce((a, x) => a + Number(x.late), 0);
  const review = engs.reduce((a, x) => a + Number(x.review), 0);
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: svc.name }]} title={svc.name} description={svc.description ?? undefined} actions={can(actor, "delivery.write") ? <LinkButton variant="primary" href={`/delivery/engagements/new?service=${svc.id}`}>New engagement</LinkButton> : null} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard label="Current engagements" value={String(engs.length)} currency={null} href={`/delivery/engagements?service=${svc.id}`} basis="Onboarding, active or on-hold engagements in this stream that you can see." range={`As of ${today}`} />
        <MetricCard label="Late deliverables" value={String(late)} currency={null} href={`/delivery/engagements?service=${svc.id}`} basis="Deliverables past due and not approved." range={`As of ${today}`} />
        <MetricCard label="Awaiting review" value={String(review)} currency={null} href={`/delivery/engagements?service=${svc.id}`} basis="Deliverables in internal review or awaiting client feedback." range={`As of ${today}`} />
        <MetricCard label="Due in next 14 days" value={String(due.length + items.length)} currency={null} href={`/operations/calendar?view=agenda`} basis="Open deliverables and workspace items due or scheduled by the horizon (includes overdue)." range={`${today} → ${horizon}`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Deliverables due (next 14 days and overdue)" />
          {due.length ? (
            <Table>
              <THead><tr><TH>Deliverable</TH><TH>Due</TH><TH>Status</TH></tr></THead>
              <tbody>{due.map(({ d, engName }) => <TR key={d.id}><TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${d.engagementId}?tab=deliverables`}>{d.name}</Link><div className="text-[12px] text-muted">{engName}</div></TD><TD><DateText value={d.dueDate} overdue={!!d.dueDate && d.dueDate < today} /></TD><TD><StatusBadge status={d.approvalStatus} /></TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="Nothing due" />}
        </Card>
        <Card>
          <CardHeader title={key === "creative" ? "Content calendar & briefs" : key === "executive" ? "Editorial calendar" : "Data requests, analyses & roadmap"} description="Open workspace items due or scheduled soon." />
          {items.length ? (
            <Table>
              <THead><tr><TH>Item</TH><TH>When</TH><TH>Status</TH></tr></THead>
              <tbody>{items.map(({ i, engName }) => <TR key={i.id}><TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${i.engagementId}?tab=workspace`}>{i.title}</Link><div className="text-[12px] text-muted">{findItemType(svc.templateKind, i.itemType)?.label ?? i.itemType} · {engName}{i.channel ? ` · ${i.channel}` : ""}</div></TD><TD><DateText value={i.scheduledDate ?? i.dueDate} overdue={(i.scheduledDate ?? i.dueDate ?? "9999") < today} /></TD><TD><StatusBadge status={i.status} label={i.status.replace(/_/g, " ")} /></TD></TR>)}</tbody>
            </Table>
          ) : <EmptyState title="Nothing scheduled" />}
        </Card>
      </div>
      <Card className="mt-4">
        <CardHeader title="Engagements" />
        {engs.length ? (
          <Table>
            <THead><tr><TH>Engagement</TH><TH>Client</TH><TH>Lead</TH><TH>End</TH><TH>Signals</TH><TH>Status</TH></tr></THead>
            <tbody>{engs.map(({ e, accountName, ownerName, late: l, review: r }) => <TR key={e.id}><TD><Link className="font-medium hover:underline" href={`/delivery/engagements/${e.id}`}>{e.name}</Link></TD><TD>{accountName}</TD><TD>{ownerName ?? "—"}</TD><TD><DateText value={e.endDate} /></TD><TD className="space-x-1">{Number(l) ? <Badge tone="danger">{l} late</Badge> : null}{Number(r) ? <Badge tone="warning">{r} in review</Badge> : null}</TD><TD><StatusBadge status={e.status} /></TD></TR>)}</tbody>
          </Table>
        ) : <EmptyState title="No current engagements in this stream" />}
      </Card>
    </>
  );
}
