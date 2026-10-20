import Link from "next/link";
import { after } from "next/server";
import { desc, inArray, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, auditEvents, signals, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { agencyToday, getSettings } from "@/server/system/settings";
import { myDay, numbersAndEvidence, pipelineAndCapacity, setupChecklist, systemHealth, type WorkItem } from "@/server/ops/dashboard";
import { refreshSignals, SIGNAL_RULES } from "@/server/ops/signals";
import { lastSignalRefresh } from "@/server/jobs/registry";
import { addDaysISO, formatDate, formatDateTime, resolvePeriod, nowMs } from "@/lib/dates";
import { qs } from "@/lib/utils";
import { Badge, Card, CardBody, CardHeader, EmptyState, LinkButton, Notice, PageHeader, PriorityBadge, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, MetricCard, Money, Progress, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { dismissSignalAction, refreshSignalsAction, runJobNowAction, snoozeSignalAction } from "@/server/actions/ops";
import { Input } from "@/components/forms/fields";
import { GoalsCard } from "@/components/ops/goals";
import { goalHistory, listGoals, openInPreviousPeriod, periodStartFor } from "@/server/ops/goals";
import { isISODate } from "@/lib/dates";

export const metadata = { title: "Daily dashboard" };

const TABS = [
  { key: "my-day", label: "My day" },
  { key: "goals", label: "Goals" },
  { key: "numbers", label: "Numbers & evidence" },
  { key: "pipeline", label: "Pipeline & capacity" },
  { key: "setup", label: "Complete setup" },
  { key: "signals", label: "Review signals" },
  { key: "health", label: "System health" },
];

const SECTION_LABEL: Record<WorkItem["section"], string> = {
  overdue: "Overdue",
  tasks: "Prioritised tasks",
  deliverables: "Deliverables due soon",
  sales_followups: "Calls & sales follow-ups",
  client_followups: "Client follow-ups",
  meetings: "Meetings & appointments",
  approvals: "Approvals awaiting action",
  collections: "Collection follow-ups",
  blocked: "Blocked work",
};

type SP = Record<string, string | undefined>;

export default async function OperationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const actor = await guard("operations.view");
  const sp = await searchParams;
  const tab = TABS.some((t) => t.key === sp.tab) ? sp.tab! : "my-day";
  const settings = await getSettings(db);
  const today = await agencyToday(db);
  // Signals are recalculated by the job every 15 minutes. If they are older than 5 minutes,
  // refresh them *after* this page has been sent, so the dashboard never waits for it.
  const last = await lastSignalRefresh(db);
  if (!last || nowMs() - last.getTime() > 5 * 60 * 1000) {
    after(() => db.transaction((tx) => refreshSignals(tx)).catch((e) => console.error("[signals] background refresh failed", e)));
  }
  const activeSignals = await db.select({ n: sql<number>`count(*)` }).from(signals).where(sql`${signals.status} = 'active'`);
  const hour = new Date().getUTCHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const href = (t: string) => `/operations${qs({ tab: t === "my-day" ? null : t })}`;

  return (
    <>
      <PageHeader
        title={`${greet}, ${actor.name.split(" ")[0]}`}
        description={`${formatDate(today, "EEEE d MMMM yyyy")} · Everything that needs attention today, with the evidence behind it. Work is drawn from tasks, deliverables, deals, invoices and approvals across the agency.`}
        actions={
          <ActionForm action={refreshSignalsAction} className="flex flex-col items-end">
            <SubmitButton variant="secondary" size="sm">
              Recalculate signals
            </SubmitButton>
          </ActionForm>
        }
      />
      <Tabs tabs={TABS.map((t) => ({ ...t, href: href(t.key), count: t.key === "signals" ? Number(activeSignals[0].n) : null }))} current={tab} />
      {tab === "my-day" ? <MyDay sp={sp} today={today} /> : null}
      {tab === "goals" ? <GoalsTab sp={sp} today={today} /> : null}
      {tab === "numbers" ? <Numbers sp={sp} fiscalStart={settings.fiscalYearStartMonth} today={today} /> : null}
      {tab === "pipeline" ? <Pipeline /> : null}
      {tab === "setup" ? <Setup /> : null}
      {tab === "signals" ? <Signals sp={sp} canAll={can(actor, "audit.read")} /> : null}
      {tab === "health" ? (can(actor, "audit.read") ? <Health /> : <Notice tone="warning" title="System health requires the audit.read permission." />) : null}
    </>
  );
}

/* ---------------------------------------------------------------- */

async function MyDay({ sp, today }: { sp: SP; today: string }) {
  const actor = await guard("operations.view");
  const [dayGoals, weekGoals, dayLeft, weekLeft] = await Promise.all([
    listGoals(db, actor, "day", today),
    listGoals(db, actor, "week", today),
    openInPreviousPeriod(db, actor, "day", today),
    openInPreviousPeriod(db, actor, "week", today),
  ]);
  const weekStart = periodStartFor("week", today);
  const data = await myDay(db, actor, { owner: sp.owner, team: sp.team, client: sp.client, service: sp.service, priority: sp.priority, to: sp.to, q: sp.q });
  const clients = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(inArray(accounts.lifecycleStatus, ["active", "onboarding", "prospect"])).orderBy(accounts.name);
  const order: WorkItem["section"][] = ["overdue", "approvals", "tasks", "deliverables", "collections", "client_followups", "blocked"];
  const side: WorkItem["section"][] = ["meetings", "sales_followups"];
  const recent = await db
    .select({ e: auditEvents })
    .from(auditEvents)
    .where(sql`${auditEvents.action} in ('task.reassigned','account.updated','opportunity.stage_changed','engagement.status_changed','change_request.approved','invoice.issued','payment.recorded','deliverable.approved','lead.status_changed','opportunity.won','opportunity.lost','task.commented') ${data.users.length && sp.owner !== "all" ? sql`and (${auditEvents.actorId} = ${actor.userId} or ${auditEvents.action} like 'task.%')` : sql``}`)
    .orderBy(desc(auditEvents.createdAt))
    .limit(12);
  return (
    <>
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <GoalsCard title="Today's goals" description={formatDate(today, "EEEE d MMMM")} period="day" date={today} goals={dayGoals} openBefore={dayLeft} />
        <GoalsCard title="This week's goals" description={`Week of ${formatDate(weekStart, "d MMMM")}`} period="week" date={today} goals={weekGoals} openBefore={weekLeft} />
      </div>
      <FilterBar
        keep={["tab"]}
        fields={[
          { type: "search", name: "q", label: "Search", placeholder: "Filter work…" },
          { type: "select", name: "owner", label: "Owner", allLabel: "Me", options: [{ value: "all", label: "Everyone" }, ...data.users.filter((u) => u.id !== actor.userId).map((u) => ({ value: u.id, label: u.name }))] },
          { type: "select", name: "team", label: "Team", options: data.departments.map((d) => ({ value: d.id, label: d.name })) },
          { type: "select", name: "client", label: "Client", options: clients.map((c) => ({ value: c.id, label: c.name })) },
          { type: "select", name: "service", label: "Service", options: data.services.map((s) => ({ value: s.key, label: s.shortName })) },
          { type: "select", name: "priority", label: "Priority", options: ["urgent", "high", "medium", "low"].map((p) => ({ value: p, label: p })) },
          { type: "date", name: "to", label: "Due up to" },
        ]}
      />
      <p className="mb-3 text-[12.5px] text-muted">
        {data.items.length} item{data.items.length === 1 ? "" : "s"} for {sp.owner === "all" ? "everyone" : sp.owner ? data.users.find((u) => u.id === sp.owner)?.name : "you"}, due up to {formatDate(data.horizon)}. Overdue first, then priority and due date.
      </p>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="space-y-4">
          {order.map((sec) => {
            const items = data.items.filter((i) => i.section === sec);
            if (!items.length && sec !== "tasks") return null;
            return (
              <Card key={sec}>
                <CardHeader title={SECTION_LABEL[sec]} description={sec === "approvals" ? "Decisions only you (or your role) can make." : undefined} actions={<Badge tone={sec === "overdue" || sec === "blocked" ? "danger" : "neutral"}>{items.length}</Badge>} />
                {items.length ? <WorkTable items={items} /> : <EmptyState title="Nothing here" description="No open tasks match these filters." />}
              </Card>
            );
          })}
        </div>
        <div className="space-y-4">
          {side.map((sec) => {
            const items = data.items.filter((i) => i.section === sec);
            return (
              <Card key={sec}>
                <CardHeader title={SECTION_LABEL[sec]} actions={<Badge>{items.length}</Badge>} />
                {items.length ? (
                  <ul className="divide-y divide-line">
                    {items.slice(0, 12).map((i) => (
                      <li key={i.id} className="px-4 py-2.5">
                        <Link href={i.source.href} className="text-[13px] font-medium text-ink hover:underline">
                          {i.title}
                        </Link>
                        <p className="mt-0.5 flex flex-wrap items-center gap-2 text-[12px] text-muted">
                          <span>{i.source.label}</span>
                          <DateText value={i.dueDate} overdue={i.overdue} />
                          {i.ownerName ? <span>· {i.ownerName}</span> : null}
                        </p>
                        <p className="mt-0.5 text-[12px] text-ink-2">Next: {i.nextAction}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <EmptyState title={sec === "meetings" ? "No meetings scheduled" : "No follow-ups due"} />
                )}
              </Card>
            );
          })}
          <SignalsSummary />
          <Card>
            <CardHeader title="Recent changes" description="Assignments, notes and material changes (audit log)." />
            <ul className="divide-y divide-line">
              {recent.length ? (
                recent.map(({ e }) => (
                  <li key={e.id} className="px-4 py-2 text-[12.5px]">
                    <p className="text-ink">{e.summary}</p>
                    <p className="text-muted">
                      {e.actorLabel.split(" <")[0]} · {formatDateTime(e.createdAt)}
                    </p>
                  </li>
                ))
              ) : (
                <li className="px-4 py-3 text-[12.5px] text-muted">No recent changes.</li>
              )}
            </ul>
          </Card>
        </div>
      </div>
    </>
  );
}

function WorkTable({ items }: { items: WorkItem[] }) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>Item</TH>
          <TH>Source</TH>
          <TH>Owner</TH>
          <TH>Due</TH>
          <TH>Priority</TH>
          <TH>Status</TH>
          <TH>Next action</TH>
        </tr>
      </THead>
      <tbody>
        {items.map((i) => (
          <TR key={i.id}>
            <TD className="min-w-[220px]">
              <Link href={i.source.href} className="font-medium text-ink hover:underline">
                {i.title}
              </Link>
              {i.accountName ? <p className="text-[12px] text-muted">{i.accountName}</p> : null}
            </TD>
            <TD>
              <Link href={i.source.href} className="text-accent hover:underline">
                {i.source.label}
              </Link>
            </TD>
            <TD>{i.ownerName ?? <span className="text-faint">Unassigned</span>}</TD>
            <TD>
              <DateText value={i.dueDate} overdue={i.overdue} />
            </TD>
            <TD>
              <PriorityBadge priority={i.priority} />
            </TD>
            <TD>
              <StatusBadge status={i.overdue ? "overdue" : i.status.replace(/ /g, "_")} label={i.status} />
            </TD>
            <TD className="min-w-[200px] text-[12.5px]">{i.nextAction}</TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

async function SignalsSummary() {
  const rows = await db.select().from(signals).where(sql`${signals.status} = 'active'`).orderBy(sql`case ${signals.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`, desc(signals.lastDetectedAt)).limit(6);
  return (
    <Card>
      <CardHeader title="Signals" description="Linked to source records; clear automatically when resolved." actions={<Link href="/operations?tab=signals" className="text-[12.5px] text-accent hover:underline">All signals</Link>} />
      {rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map((s) => (
            <li key={s.id} className="px-4 py-2.5">
              <div className="flex items-start gap-2">
                <StatusBadge status={s.severity} />
                <Link href={s.href} className="text-[13px] font-medium text-ink hover:underline">
                  {s.title}
                </Link>
              </div>
              <p className="mt-0.5 text-[12px] text-muted">{s.resolutionAction}</p>
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title="No active signals" description="Nothing needs review right now." />
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- */

/** Week-by-week view of personal goals: the week's goals, each day's goals, and recent completion. */
async function GoalsTab({ sp, today }: { sp: SP; today: string }) {
  const actor = await guard("operations.view");
  const thisWeek = periodStartFor("week", today);
  const week = isISODate(sp.week) ? periodStartFor("week", sp.week!) : thisWeek;
  const days = Array.from({ length: 7 }, (_, i) => addDaysISO(week, i));
  const isPast = (d: string) => d < today;
  const [weekGoals, weekLeft, dayLists, weeks] = await Promise.all([
    listGoals(db, actor, "week", week),
    week === thisWeek ? openInPreviousPeriod(db, actor, "week", week) : Promise.resolve(0),
    Promise.all(days.map(async (d) => ({ d, goals: await listGoals(db, actor, "day", d), left: d === today ? await openInPreviousPeriod(db, actor, "day", d) : 0 }))),
    goalHistory(db, actor, "week", today, 8),
  ]);
  const nav = (w: string | null) => `/operations${qs({ tab: "goals", week: w })}`;
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LinkButton size="sm" href={nav(addDaysISO(week, -7))} aria-label="Previous week">←</LinkButton>
        <LinkButton size="sm" href={nav(null)}>This week</LinkButton>
        <LinkButton size="sm" href={nav(addDaysISO(week, 7))} aria-label="Next week">→</LinkButton>
        <h2 className="ml-2 text-[16px] font-semibold">
          Week of {formatDate(week, "d MMMM yyyy")}
          {week === thisWeek ? <span className="ml-2 text-[12.5px] font-normal text-muted">(this week)</span> : null}
        </h2>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">Your goals are private to you. Set a few for the week, then break them into daily goals. Give a goal a number to track progress (e.g. 5 discovery calls). Unfinished goals can be carried into the next day or week.</p>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-4">
          <GoalsCard title="Weekly goals" period="week" date={week} goals={weekGoals} openBefore={weekLeft} readOnly={addDaysISO(week, 6) < today} />
          <div className="grid gap-4 md:grid-cols-2">
            {dayLists.map(({ d, goals, left }) => (
              <GoalsCard
                key={d}
                title={formatDate(d, "EEEE d MMM")}
                description={d === today ? "Today" : undefined}
                period="day"
                date={d}
                goals={goals}
                openBefore={left}
                readOnly={isPast(d)}
                emptyText={d === today ? undefined : "No goals for this day yet."}
                className={d === today ? "ring-1 ring-accent/40" : undefined}
              />
            ))}
          </div>
        </div>
        <Card className="h-fit">
          <CardHeader title="Last 8 weeks" description="Weekly goals completed. Goals carried forward count as not done that week." />
          <ul className="divide-y divide-line">
            {weeks
              .slice()
              .reverse()
              .map((w) => (
                <li key={w.start} className="px-4 py-2">
                  <div className="flex justify-between text-[12.5px]">
                    <Link href={nav(w.start === thisWeek ? null : w.start)} className="text-ink-2 hover:underline">
                      {formatDate(w.start, "d MMM")}
                    </Link>
                    <span className="num text-muted">{w.total ? `${w.done}/${w.total}` : "—"}</span>
                  </div>
                  {w.total ? <Progress value={w.done} max={w.total} /> : null}
                </li>
              ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- */

async function Numbers({ sp, fiscalStart, today }: { sp: SP; fiscalStart: number; today: string }) {
  const actor = await guard("operations.view");
  const range = sp.from && sp.to ? { from: sp.from, to: sp.to, label: "Custom range" } : resolvePeriod(sp.period ?? "month", today, fiscalStart);
  const { metrics, base } = await numbersAndEvidence(db, actor, range);
  return (
    <>
      <FilterBar
        keep={["tab"]}
        fields={[
          { type: "select", name: "period", label: "Period", allLabel: "This month", options: [{ value: "last_month", label: "Last month" }, { value: "quarter", label: "This quarter" }, { value: "last_90", label: "Last 90 days" }, { value: "fiscal_ytd", label: "Fiscal year to date" }, { value: "last_12", label: "Last 12 months" }] },
          { type: "date", name: "from", label: "From" },
          { type: "date", name: "to", label: "To" },
        ]}
      />
      <p className="mb-3 text-[12.5px] text-muted">
        {range.label} ({range.from} → {range.to}). Reporting currency {base}. Pipeline is not revenue; invoicing is not revenue; revenue is not cash — each is shown separately with its own basis.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((m) => (
          <MetricCard {...m} key={m.key} suffix={m.key === "utilization" ? "%" : undefined} />
        ))}
      </div>
    </>
  );
}

/* ---------------------------------------------------------------- */

async function Pipeline() {
  const actor = await guard("operations.view");
  const p = await pipelineAndCapacity(db, actor);
  const maxStage = Math.max(1, ...p.byStage.map((s) => Number(s.value)));
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Pipeline by stage" description={`Open opportunities in ${p.base}; weighted uses stage probability or override.`} actions={<Link className="text-[12.5px] text-accent hover:underline" href="/crm/opportunities?view=board">Board →</Link>} />
        <CardBody className="space-y-2">
          {p.byStage.length ? (
            p.byStage.map((s) => (
              <div key={s.stage}>
                <div className="flex justify-between text-[12.5px]">
                  <span className="text-ink-2">
                    {s.stage} <span className="text-muted">({s.count})</span>
                  </span>
                  <span className="num">
                    <Money value={s.value} currency={p.base} /> <span className="text-muted">· weighted</span> <Money value={s.weighted} currency={p.base} />
                  </span>
                </div>
                <Progress value={Number(s.value)} max={maxStage} />
              </div>
            ))
          ) : (
            <EmptyState title="No open opportunities" />
          )}
          {p.missingRates.length ? <Notice tone="warning">Excluded deals in {p.missingRates.join(", ")} — add an exchange rate to include them.</Notice> : null}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Pipeline by service" description="Multi-service deals are split evenly across their services." />
        <Table>
          <THead>
            <tr>
              <TH>Service</TH>
              <TH align="right">Deals</TH>
              <TH align="right">Value</TH>
              <TH align="right">Weighted</TH>
            </tr>
          </THead>
          <tbody>
            {p.byService.map((s) => (
              <TR key={s.service}>
                <TD>{s.service}</TD>
                <TD align="right">{s.count}</TD>
                <TD align="right"><Money value={s.value} currency={p.base} /></TD>
                <TD align="right"><Money value={s.weighted} currency={p.base} /></TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <OppList title="Opportunities without a next action" rows={p.noNextAction.map((r) => ({ id: r.o.id, title: `${r.o.number} ${r.o.name}`, sub: `${r.accountName} · ${r.stage.name} · ${r.ownerName ?? "No owner"}`, value: r.o.value, currency: r.o.currency }))} empty="Every open opportunity has a next action." />
      <OppList title="Stale opportunities" description="No stage movement beyond the stage's stale threshold." rows={p.stale.map((r) => ({ id: r.o.id, title: `${r.o.number} ${r.o.name}`, sub: `${r.accountName} · in ${r.stage.name} since ${formatDate(r.o.stageEnteredAt.toISOString().slice(0, 10))}`, value: r.o.value, currency: r.o.currency }))} empty="No stale opportunities." />
      <Card>
        <CardHeader title="Proposals awaiting follow-up" description="Sent and not yet accepted, rejected or expired." />
        {p.proposalsAwaiting.length ? (
          <ul className="divide-y divide-line">
            {p.proposalsAwaiting.map(({ p: pr, accountName, v }) => (
              <li key={pr.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                <div>
                  <Link href={`/crm/proposals/${pr.id}`} className="font-medium hover:underline">
                    {pr.number} {pr.title}
                  </Link>
                  <p className="text-[12px] text-muted">
                    {accountName} · sent {pr.sentAt ? formatDate(pr.sentAt) : "—"} · valid until {formatDate(pr.validUntil)}
                  </p>
                </div>
                <Money value={v.total} currency={v.currency} />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No proposals awaiting a decision" />
        )}
      </Card>
      <Card>
        <CardHeader title="Upcoming renewals (90 days)" />
        {p.renewals.length ? (
          <ul className="divide-y divide-line">
            {p.renewals.map(({ e, accountName }) => (
              <li key={e.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
                <div>
                  <Link href={`/delivery/engagements/${e.id}?tab=renewal`} className="font-medium hover:underline">
                    {e.number} {e.name}
                  </Link>
                  <p className="text-[12px] text-muted">
                    {accountName} · {e.billingModel} · ends <DateText value={e.renewalDate ?? e.endDate} />
                  </p>
                </div>
                {e.retainerAmount ? (
                  <span className="text-[12.5px]">
                    <Money value={e.retainerAmount} currency={e.currency} />/mo
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No renewals in the next 90 days" />
        )}
      </Card>
      <Card className="xl:col-span-2">
        <CardHeader title="Team workload & available capacity" description={`Next 4 weeks (${formatDate(p.capacityWindow.from)} – ${formatDate(p.capacityWindow.to)}). Capacity = weekly hours × working days − approved leave. Booked = max(engagement allocations, open task estimates).`} actions={<Link href="/people/capacity" className="text-[12.5px] text-accent hover:underline">Capacity planner →</Link>} />
        <Table>
          <THead>
            <tr>
              <TH>Person</TH>
              <TH>Team</TH>
              <TH align="right">Capacity (h)</TH>
              <TH align="right">Allocated (h)</TH>
              <TH align="right">Open tasks</TH>
              <TH align="right">Available (h)</TH>
              <TH>Load</TH>
            </tr>
          </THead>
          <tbody>
            {p.workload.map((w) => (
              <TR key={w.personId}>
                <TD>
                  <Link href={`/people/${w.personId}`} className="font-medium hover:underline">
                    {w.name}
                  </Link>
                  {w.type === "contractor" ? <Badge className="ml-1">contractor</Badge> : null}
                </TD>
                <TD>{w.department ?? "—"}</TD>
                <TD align="right">{w.capacity}</TD>
                <TD align="right">{w.allocated}</TD>
                <TD align="right">
                  {w.openTasks}
                  {w.overdueTasks ? <span className="text-danger"> ({w.overdueTasks} overdue)</span> : null}
                </TD>
                <TD align="right" className={Number(w.available) < 0 ? "text-danger" : ""}>
                  {w.available}
                </TD>
                <TD className="w-40">{w.loadPct !== null ? <Progress value={Number(w.loadPct)} /> : <span className="text-faint">—</span>}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
    </div>
  );
}

function OppList({ title, description, rows, empty }: { title: string; description?: string; rows: { id: string; title: string; sub: string; value: string; currency: string }[]; empty: string }) {
  return (
    <Card>
      <CardHeader title={title} description={description} actions={<Badge>{rows.length}</Badge>} />
      {rows.length ? (
        <ul className="divide-y divide-line">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center justify-between gap-3 px-4 py-2.5 text-[13px]">
              <div className="min-w-0">
                <Link href={`/crm/opportunities/${r.id}`} className="font-medium hover:underline">
                  {r.title}
                </Link>
                <p className="truncate text-[12px] text-muted">{r.sub}</p>
              </div>
              <Money value={r.value} currency={r.currency} />
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState title={empty} />
      )}
    </Card>
  );
}

/* ---------------------------------------------------------------- */

async function Setup() {
  const { issues, groups } = await setupChecklist(db);
  if (!issues.length) return <EmptyState title="Setup is complete" description="No missing account, contract, budget, billing, tax or opening-balance information was found." />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {groups.map((g) => {
        const list = issues.filter((i) => i.group === g);
        return (
          <Card key={g}>
            <CardHeader title={g} actions={<Badge tone="warning">{list.length}</Badge>} />
            <ul className="divide-y divide-line">
              {list.map((i) => (
                <li key={i.key} className="flex items-start justify-between gap-3 px-4 py-2.5 text-[13px]">
                  <div>
                    <p className="font-medium text-ink">{i.title}</p>
                    <p className="text-[12px] text-muted">{i.detail}</p>
                  </div>
                  <LinkButton href={i.href} size="sm">
                    Fix
                  </LinkButton>
                </li>
              ))}
            </ul>
          </Card>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- */

async function Signals({ sp, canAll }: { sp: SP; canAll: boolean }) {
  void canAll;
  const status = sp.status ?? "active";
  const rows = await db
    .select({ s: signals, ownerName: user.name })
    .from(signals)
    .leftJoin(user, sql`${user.id} = ${signals.ownerId}`)
    .where(sql`${signals.status} = ${status} ${sp.rule ? sql`and ${signals.ruleKey} = ${sp.rule}` : sql``} ${sp.severity ? sql`and ${signals.severity} = ${sp.severity}` : sql``} ${sp.owner ? sql`and ${signals.ownerId} = ${sp.owner}` : sql``}`)
    .orderBy(sql`case ${signals.severity} when 'critical' then 0 when 'warning' then 1 else 2 end`, desc(signals.lastDetectedAt))
    .limit(300);
  const users = await db.select({ id: user.id, name: user.name }).from(user);
  const tomorrow = addDaysISO(await agencyToday(db), 7);
  return (
    <>
      <FilterBar
        keep={["tab"]}
        fields={[
          { type: "select", name: "status", label: "Status", allLabel: "Active", options: [{ value: "snoozed", label: "Snoozed" }, { value: "dismissed", label: "Dismissed (still present)" }, { value: "resolved", label: "Resolved (history)" }] },
          { type: "select", name: "rule", label: "Type", options: SIGNAL_RULES.map((r) => ({ value: r.key, label: r.label })) },
          { type: "select", name: "severity", label: "Severity", options: ["critical", "warning", "info"].map((v) => ({ value: v, label: v })) },
          { type: "select", name: "owner", label: "Owner", options: users.map((u) => ({ value: u.id, label: u.name })) },
        ]}
      />
      <Card>
        <CardHeader title={`${rows.length} ${status} signal${rows.length === 1 ? "" : "s"}`} description="Signals are recalculated from source records; there is at most one open signal per issue. Fix the source record and the signal resolves automatically — history is kept." />
        {rows.length ? (
          <Table>
            <THead>
              <tr>
                <TH>Severity</TH>
                <TH>Signal</TH>
                <TH>Reason</TH>
                <TH>Owner</TH>
                <TH>Resolution</TH>
                <TH>Detected</TH>
                {status !== "resolved" ? <TH>Actions</TH> : null}
              </tr>
            </THead>
            <tbody>
              {rows.map(({ s, ownerName }) => (
                <TR key={s.id}>
                  <TD>
                    <StatusBadge status={s.severity} />
                  </TD>
                  <TD className="min-w-[220px]">
                    <Link href={s.href} className="font-medium text-ink hover:underline">
                      {s.title}
                    </Link>
                    <p className="text-[11.5px] text-muted">{SIGNAL_RULES.find((r) => r.key === s.ruleKey)?.label} · source: {s.entityType.replace("_", " ")}</p>
                  </TD>
                  <TD className="min-w-[220px] text-[12.5px]">{s.reason}</TD>
                  <TD>{ownerName ?? <span className="text-faint">—</span>}</TD>
                  <TD className="min-w-[200px] text-[12.5px]">{s.resolutionAction}</TD>
                  <TD className="text-[12px]">
                    {formatDate(s.firstDetectedAt)}
                    {s.resolvedAt ? <p className="text-success">Resolved {formatDate(s.resolvedAt)}</p> : null}
                  </TD>
                  {status !== "resolved" ? (
                    <TD className="min-w-[230px]">
                      <div className="flex flex-col gap-1.5">
                        <ActionForm action={snoozeSignalAction} className="flex gap-1">
                          <input type="hidden" name="id" value={s.id} />
                          <Input type="date" name="until" defaultValue={tomorrow} aria-label="Snooze until" className="h-7 py-0 text-[12px]" />
                          <SubmitButton size="sm" variant="secondary">
                            Snooze
                          </SubmitButton>
                        </ActionForm>
                        <ActionForm action={dismissSignalAction} className="flex gap-1">
                          <input type="hidden" name="id" value={s.id} />
                          <Input name="note" placeholder="Reason to dismiss" aria-label="Reason to dismiss" className="h-7 py-0 text-[12px]" required />
                          <SubmitButton size="sm" variant="ghost">
                            Dismiss
                          </SubmitButton>
                        </ActionForm>
                      </div>
                    </TD>
                  ) : null}
                </TR>
              ))}
            </tbody>
          </Table>
        ) : (
          <EmptyState title="No signals" description="Nothing matches these filters." />
        )}
      </Card>
      <details className="mt-4 text-[12.5px] text-muted">
        <summary className="cursor-pointer">Signal rules</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {SIGNAL_RULES.map((r) => (
            <li key={r.key}>
              <span className="font-medium text-ink-2">{r.label}:</span> {r.description}
            </li>
          ))}
        </ul>
      </details>
    </>
  );
}

/* ---------------------------------------------------------------- */

async function Health() {
  const h = await systemHealth(db);
  const { JOBS } = await import("@/server/jobs/registry");
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <Card>
        <CardHeader title="Integrations" description="Shown as connected only after successful authentication and verification." actions={<Link href="/system/integrations" className="text-[12.5px] text-accent hover:underline">Manage →</Link>} />
        <Table>
          <THead>
            <tr>
              <TH>Integration</TH>
              <TH>Status</TH>
              <TH>Last success</TH>
              <TH>Last error</TH>
            </tr>
          </THead>
          <tbody>
            {h.integrations.map((i) => (
              <TR key={i.id}>
                <TD>{i.displayName}</TD>
                <TD>
                  <StatusBadge status={i.status} />
                </TD>
                <TD>{i.lastSuccessAt ? formatDateTime(i.lastSuccessAt) : "—"}</TD>
                <TD className="text-[12px] text-danger">{i.lastError ?? ""}</TD>
              </TR>
            ))}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Background jobs" description="Recurring work with retries and idempotency keys. Run now uses the same runner as the worker." />
        <Table>
          <THead>
            <tr>
              <TH>Job</TH>
              <TH>Last status</TH>
              <TH>Last success</TH>
              <TH align="right">Failures (7d)</TH>
              <TH />
            </tr>
          </THead>
          <tbody>
            {JOBS.map((j) => {
              const r = h.jobs.find((x) => x.job_name === j.name);
              return (
                <TR key={j.name}>
                  <TD>
                    <p className="font-medium">{j.label}</p>
                    <p className="text-[11.5px] text-muted">
                      {j.name} · <code>{j.cron}</code> UTC
                    </p>
                    {r?.last_error ? <p className="text-[11.5px] text-danger">{r.last_error}</p> : null}
                  </TD>
                  <TD>{r ? <StatusBadge status={r.last_status} /> : <Badge>never run</Badge>}</TD>
                  <TD className="text-[12px]">{r?.last_success ? formatDateTime(r.last_success) : "—"}</TD>
                  <TD align="right">{r?.failures_7d ?? 0}</TD>
                  <TD>
                    <ActionForm action={runJobNowAction}>
                      <input type="hidden" name="job" value={j.name} />
                      <SubmitButton size="sm" variant="secondary">
                        Run now
                      </SubmitButton>
                    </ActionForm>
                  </TD>
                </TR>
              );
            })}
          </tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader title="Failed imports & syncs" />
        <CardBody>
          {h.failedSyncs.length === 0 && h.imports.length === 0 ? (
            <p className="text-[13px] text-muted">No failed syncs or imports with errors.</p>
          ) : (
            <ul className="space-y-2 text-[13px]">
              {h.failedSyncs.map(({ r, name }) => (
                <li key={r.id}>
                  <span className="font-medium">{name}</span> — {r.operation} failed {formatDateTime(r.startedAt)}: <span className="text-danger">{r.error}</span>
                </li>
              ))}
              {h.imports.map((i) => (
                <li key={i.id}>
                  <Link href={i.kind === "leads" ? `/crm/leads/import/${i.id}` : `/finance/bank/import/${i.id}`} className="font-medium hover:underline">
                    {i.fileName}
                  </Link>{" "}
                  — {i.errorRows} row error(s), status {i.status}
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>
      <Card>
        <CardHeader title="Data quality" />
        <ul className="divide-y divide-line">
          {h.dataQuality.map((d) => (
            <li key={d.key} className="flex items-start justify-between gap-3 px-4 py-2.5 text-[13px]">
              <div>
                <p className="font-medium">{d.label}</p>
                {d.detail ? <p className="text-[12px] text-muted">{d.detail}</p> : null}
              </div>
              {d.count ? (
                <Link href={d.href} className="text-accent hover:underline">
                  <Badge tone="warning">{d.count}</Badge>
                </Link>
              ) : (
                <Badge tone="success">0</Badge>
              )}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

