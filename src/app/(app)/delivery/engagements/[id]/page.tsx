import Link from "next/link";
import { notFound } from "next/navigation";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts, engagements, offers, opportunities, services, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { engagementVisibility } from "@/server/auth/scope";
import { ENGAGEMENT_TRANSITIONS } from "@/server/delivery/engagements";
import { agencyToday } from "@/server/system/settings";
import { engagementStatusAction } from "@/server/actions/delivery";
import { Badge, Card, CardBody, CardHeader, DefinitionList, LinkButton, PageHeader, ServiceBadge, StatusBadge } from "@/components/ui/primitives";
import { DateText, MetricCard, Money, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Input } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel, TasksPanel, TimelinePanel, listUsers } from "@/components/records/panels";
import { BILLING_MODELS, RECOGNITION } from "@/components/delivery/engagement-form";
import { ScopeTab } from "@/components/delivery/tab-scope";
import { DeliverablesTab } from "@/components/delivery/tab-deliverables";
import { BudgetTab, TeamCard, TimeTab } from "@/components/delivery/tab-time";
import { BillingTab, ContractsTab, RenewalTab } from "@/components/delivery/tab-billing";
import { WorkspaceTab } from "@/components/delivery/tab-workspace";

export const metadata = { title: "Engagement" };

const TABS = [
  { key: "overview", label: "Overview" },
  { key: "workspace", label: "Workspace" },
  { key: "scope", label: "Scope & changes" },
  { key: "deliverables", label: "Deliverables" },
  { key: "tasks", label: "Tasks" },
  { key: "time", label: "Time" },
  { key: "budget", label: "Budget & margin" },
  { key: "billing", label: "Billing" },
  { key: "contracts", label: "Contracts" },
  { key: "renewal", label: "Renewal" },
  { key: "documents", label: "Documents" },
  { key: "activity", label: "Activity" },
];

export default async function EngagementPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("delivery.read");
  const { id } = await params;
  const sp = await searchParams;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [row] = await db
    .select({ e: engagements, accountName: accounts.name, serviceName: services.name, serviceKey: services.key, offerName: offers.name, ownerName: user.name, contactName: contacts.fullName, oppName: opportunities.name })
    .from(engagements)
    .innerJoin(accounts, eq(accounts.id, engagements.accountId))
    .innerJoin(services, eq(services.id, engagements.serviceId))
    .leftJoin(offers, eq(offers.id, engagements.offerId))
    .leftJoin(user, eq(user.id, engagements.ownerId))
    .leftJoin(contacts, eq(contacts.id, engagements.primaryContactId))
    .leftJoin(opportunities, eq(opportunities.id, engagements.opportunityId))
    .where(and(eq(engagements.id, id), engagementVisibility(actor)));
  if (!row) notFound();
  const e = row.e;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "overview";
  const today = await agencyToday(db);
  const canWrite = can(actor, "delivery.write");
  const [counts] = await db.execute<{ late: number; review: number; tasks: number; overdue_tasks: number; crs: number; hours: string }>(sql`
    select
      (select count(*) from deliverables where engagement_id = ${id} and due_date < ${today} and approval_status not in ('approved','rejected'))::int as late,
      (select count(*) from deliverables where engagement_id = ${id} and approval_status in ('internal_review','awaiting_client'))::int as review,
      (select count(*) from tasks where engagement_id = ${id} and status not in ('completed','cancelled'))::int as tasks,
      (select count(*) from tasks where engagement_id = ${id} and status not in ('completed','cancelled') and due_date < ${today})::int as overdue_tasks,
      (select count(*) from change_requests where engagement_id = ${id} and status = 'submitted')::int as crs,
      (select coalesce(sum(hours),0) from time_entries where engagement_id = ${id} and status = 'approved')::text as hours`).then((r) => r.rows);
  const users = tab === "overview" || tab === "tasks" ? await listUsers() : [];
  const base = `/delivery/engagements/${id}`;

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: "Engagements", href: "/delivery/engagements" }, { label: e.number }]}
        title={e.name}
        meta={<><StatusBadge status={e.status} /><ServiceBadge serviceKey={row.serviceKey} name={row.serviceName} /></>}
        description={<><Link className="hover:underline" href={`/crm/accounts/${e.accountId}`}>{row.accountName}</Link> · {BILLING_MODELS.find((b) => b.value === e.billingModel)?.label} · lead {row.ownerName ?? "unassigned"}</>}
        actions={canWrite ? <LinkButton href={`${base}/edit`}>Edit</LinkButton> : null}
      />
      <Tabs current={tab} tabs={TABS.map((t) => ({ ...t, href: t.key === "overview" ? base : `${base}?tab=${t.key}`, count: t.key === "deliverables" ? counts.late || null : t.key === "scope" ? counts.crs || null : t.key === "tasks" ? counts.tasks || null : null }))} />
      <div className="mt-4">
        {tab === "overview" ? (
          <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <MetricCard label="Late deliverables" value={String(counts.late)} currency={null} href={`${base}?tab=deliverables`} basis="Deliverables past due and not approved." range={`As of ${today}`} detail={[{ label: "In review", value: String(counts.review) }]} />
                <MetricCard label="Open tasks" value={String(counts.tasks)} currency={null} href={`${base}?tab=tasks`} basis="Tasks on this engagement not completed or cancelled." range={`As of ${today}`} detail={[{ label: "Overdue", value: String(counts.overdue_tasks) }]} />
                <MetricCard label="Approved hours" value={Number(counts.hours).toFixed(1)} currency={null} href={`${base}?tab=time`} basis="Approved time entries." range="Engagement to date" detail={e.budgetHours ? [{ label: "Budget", value: Number(e.budgetHours).toFixed(0) }] : []} />
                <MetricCard label="Pending change requests" value={String(counts.crs)} currency={null} href={`${base}?tab=scope`} basis="Submitted change requests awaiting a decision." range={`As of ${today}`} />
              </div>
              <Card>
                <CardHeader title="Engagement details" />
                <CardBody>
                  <DefinitionList
                    columns={3}
                    items={[
                      { label: "Number", value: e.number },
                      { label: "Offer", value: row.offerName ?? "—" },
                      { label: "Client contact", value: e.primaryContactId ? <Link className="hover:underline" href={`/crm/contacts/${e.primaryContactId}`}>{row.contactName}</Link> : "—" },
                      { label: "Start", value: <DateText value={e.startDate} /> },
                      { label: "End", value: <DateText value={e.endDate} overdue={!!e.endDate && e.endDate < today && e.status !== "completed"} /> },
                      { label: "Renewal", value: <DateText value={e.renewalDate} /> },
                      ...(can(actor, "finance.read") || can(actor, "crm.read") ? [{ label: "Contract value", value: <Money value={e.contractValue} currency={e.currency} /> }, { label: e.billingModel === "retainer" ? "Fee per period" : "Hourly rate", value: <Money value={e.billingModel === "retainer" ? e.retainerAmount : e.hourlyRate} currency={e.currency} /> }] : []),
                      { label: "Revenue recognition", value: RECOGNITION.find((r) => r.value === e.recognitionMethod)?.label ?? e.recognitionMethod },
                      { label: "Included revisions", value: e.includedRevisions ?? "—" },
                      { label: "Source", value: e.opportunityId ? <Link className="hover:underline" href={`/crm/opportunities/${e.opportunityId}`}>{row.oppName}</Link> : "Created directly" },
                      { label: "Objectives", value: <span className="whitespace-pre-wrap">{e.objectives ?? "—"}</span>, full: true },
                      { label: "Discovery notes", value: <span className="whitespace-pre-wrap">{e.discoveryNotes ?? "—"}</span>, full: true },
                    ]}
                  />
                </CardBody>
              </Card>
              <TasksPanel actor={actor} link={{ engagementId: id }} users={users} title="Upcoming tasks" />
            </div>
            <div className="space-y-4">
              {canWrite && ENGAGEMENT_TRANSITIONS[e.status].length ? (
                <Card>
                  <CardHeader title="Status" />
                  <CardBody>
                    <ActionForm action={engagementStatusAction} className="space-y-2">
                      <input type="hidden" name="id" value={e.id} />
                      <Input name="note" aria-label="Note" placeholder="Note (optional)" />
                      <div className="flex flex-wrap gap-2">
                        {ENGAGEMENT_TRANSITIONS[e.status].map((s) => <SubmitButton key={s} size="sm" variant={s === "cancelled" ? "danger" : "secondary"} name="status" value={s} confirm={s === "cancelled" ? "Cancel this engagement?" : undefined}>{s === "active" && e.status === "completed" ? "Reopen" : `Mark ${s.replace("_", " ")}`}</SubmitButton>)}
                      </div>
                    </ActionForm>
                  </CardBody>
                </Card>
              ) : null}
              <TeamCard actor={actor} e={e} />
              {e.autoRenew ? <Card><CardBody><Badge>auto-renews</Badge></CardBody></Card> : null}
              <AuditPanel actor={actor} entityType="engagement" entityId={id} />
            </div>
          </div>
        ) : null}
        {tab === "workspace" ? <WorkspaceTab actor={actor} e={e} today={today} /> : null}
        {tab === "scope" ? <ScopeTab actor={actor} e={e} /> : null}
        {tab === "deliverables" ? <DeliverablesTab actor={actor} e={e} today={today} /> : null}
        {tab === "tasks" ? <TasksPanel actor={actor} link={{ engagementId: id }} users={users} /> : null}
        {tab === "time" ? <TimeTab actor={actor} e={e} today={today} /> : null}
        {tab === "budget" ? <BudgetTab actor={actor} e={e} /> : null}
        {tab === "billing" ? <BillingTab actor={actor} e={e} today={today} /> : null}
        {tab === "contracts" ? <ContractsTab actor={actor} e={e} today={today} /> : null}
        {tab === "renewal" ? <RenewalTab actor={actor} e={e} today={today} /> : null}
        {tab === "documents" ? <DocumentsPanel actor={actor} link={{ engagementId: id }} defaultType="deliverable" /> : null}
        {tab === "activity" ? <TimelinePanel actor={actor} filter={{ engagementId: id }} title="Engagement timeline" /> : null}
      </div>
    </>
  );
}
