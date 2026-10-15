import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  bankAccounts,
  bills,
  changeRequests,
  contracts,
  customerPayments,
  deliverables,
  departments,
  engagementMembers,
  engagements,
  eventAttendees,
  events,
  exchangeRates,
  expenses,
  importBatches,
  integrationSyncRuns,
  integrations,
  invoices,
  jobRuns,
  leads,
  leaveRequests,
  offers,
  opportunities,
  opportunityServices,
  organizationSettings,
  people,
  pipelineStages,
  proposalVersions,
  proposals,
  services,
  taxRates,
  tasks,
  timeEntries,
  user,
} from "@/db/schema";
import { addDaysISO, daysBetween, weekStartISO } from "@/lib/dates";
import { d, Decimal } from "@/lib/money";
import { can, canAll, type Actor } from "../auth/actor";
import { taskVisibility } from "../auth/scope";
import { agencyToday, getSettings } from "../system/settings";
import { outstandingSql } from "../finance/invoices";
import { billOutstandingSql } from "../finance/payables";
import { getRate } from "../finance/ledger";
import { profitAndLoss, cashFlowStatement } from "../finance/reports";
import { engagementProfitability, rollUp } from "../finance/profitability";
import { cashForecast } from "../finance/forecast";
import { OPEN_TASK_STATUSES } from "../delivery/tasks";

/* ------------------------------------------------------------------ */
/* My day — the central work queue                                     */
/* ------------------------------------------------------------------ */

export type WorkItem = {
  id: string;
  section: "tasks" | "overdue" | "deliverables" | "sales_followups" | "client_followups" | "meetings" | "approvals" | "collections" | "blocked";
  title: string;
  source: { type: string; label: string; href: string };
  ownerId: string | null;
  ownerName: string | null;
  dueDate: string | null;
  priority: "low" | "medium" | "high" | "urgent";
  status: string;
  nextAction: string;
  accountId: string | null;
  accountName: string | null;
  serviceKey: string | null;
  departmentId: string | null;
  overdue: boolean;
};

export type MyDayFilters = { owner?: string; team?: string; client?: string; service?: string; priority?: string; from?: string; to?: string; q?: string };

const PRIORITY_RANK = { urgent: 0, high: 1, medium: 2, low: 3 } as const;

export async function myDay(tx: Tx, actor: Actor, f: MyDayFilters) {
  const today = await agencyToday(tx);
  const horizon = f.to ?? addDaysISO(today, 7);
  const ownerId = f.owner === "all" ? null : f.owner || actor.userId;
  const items: WorkItem[] = [];
  const users = await tx.select({ id: user.id, name: user.name }).from(user);
  const userName = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
  const personDept = new Map((await tx.select({ userId: people.userId, dep: people.departmentId }).from(people)).map((p) => [p.userId, p.dep]));
  const svc = await tx.select().from(services);
  const svcKey = (id: string | null) => svc.find((s) => s.id === id)?.key ?? null;

  // Tasks (shared system across modules)
  const taskRows = await tx
    .select({ t: tasks, accountName: accounts.name, engServiceId: engagements.serviceId, engNumber: engagements.number, oppNumber: opportunities.number, leadName: leads.companyName })
    .from(tasks)
    .leftJoin(accounts, eq(accounts.id, tasks.accountId))
    .leftJoin(engagements, eq(engagements.id, tasks.engagementId))
    .leftJoin(opportunities, eq(opportunities.id, tasks.opportunityId))
    .leftJoin(leads, eq(leads.id, tasks.leadId))
    .where(and(inArray(tasks.status, OPEN_TASK_STATUSES), ownerId ? eq(tasks.ownerId, ownerId) : undefined, taskVisibility(actor), or(isNull(tasks.dueDate), lte(tasks.dueDate, horizon))));
  for (const { t, accountName, engServiceId, engNumber, oppNumber, leadName } of taskRows) {
    const overdue = !!t.dueDate && t.dueDate < today;
    const source = t.engagementId
      ? { type: "engagement", label: engNumber ?? "Engagement", href: `/delivery/engagements/${t.engagementId}?tab=tasks` }
      : t.opportunityId
        ? { type: "opportunity", label: oppNumber ?? "Opportunity", href: `/crm/opportunities/${t.opportunityId}` }
        : t.leadId
          ? { type: "lead", label: leadName ?? "Lead", href: `/crm/leads/${t.leadId}` }
          : t.accountId
            ? { type: "account", label: accountName ?? "Account", href: `/crm/accounts/${t.accountId}` }
            : t.invoiceId
              ? { type: "invoice", label: "Invoice", href: `/finance/invoices/${t.invoiceId}` }
              : { type: "task", label: t.module, href: `/people/tasks/${t.id}` };
    const section: WorkItem["section"] = t.status === "blocked" ? "blocked" : overdue ? "overdue" : t.kind === "follow_up" && (t.opportunityId || t.leadId) ? "sales_followups" : t.kind === "follow_up" && t.accountId ? "client_followups" : t.kind === "collection" ? "collections" : "tasks";
    items.push({
      id: `task:${t.id}`,
      section,
      title: t.title,
      source,
      ownerId: t.ownerId,
      ownerName: userName(t.ownerId),
      dueDate: t.dueDate,
      priority: t.priority,
      status: t.status.replace(/_/g, " "),
      nextAction: t.status === "blocked" ? `Unblock: ${t.blockedReason ?? "see task"}` : t.nextAction ?? "Complete the task",
      accountId: t.accountId,
      accountName,
      serviceKey: svcKey(engServiceId),
      departmentId: personDept.get(t.ownerId) ?? null,
      overdue,
    });
  }

  // Deliverables due soon / late
  const dl = await tx
    .select({ dl: deliverables, e: engagements, accountName: accounts.name })
    .from(deliverables)
    .innerJoin(engagements, eq(engagements.id, deliverables.engagementId))
    .innerJoin(accounts, eq(accounts.id, engagements.accountId))
    .where(and(sql`${deliverables.approvalStatus} not in ('approved','rejected')`, lte(deliverables.dueDate, horizon), ownerId ? or(eq(deliverables.ownerId, ownerId), and(isNull(deliverables.ownerId), eq(engagements.ownerId, ownerId))) : undefined, inArray(engagements.status, ["onboarding", "active", "on_hold"])));
  for (const { dl: x, e, accountName } of dl) {
    if (!can(actor, "delivery.read")) break;
    items.push({
      id: `deliverable:${x.id}`,
      section: "deliverables",
      title: x.name,
      source: { type: "deliverable", label: `${e.number} · deliverable`, href: `/delivery/engagements/${e.id}?tab=deliverables#${x.id}` },
      ownerId: x.ownerId ?? e.ownerId,
      ownerName: userName(x.ownerId ?? e.ownerId),
      dueDate: x.dueDate,
      priority: x.dueDate && x.dueDate < today ? "urgent" : "high",
      status: x.approvalStatus.replace(/_/g, " "),
      nextAction: x.approvalStatus === "awaiting_client" ? "Chase the client decision and record it" : x.approvalStatus === "internal_review" ? "Complete the internal review" : x.approvalStatus === "changes_requested" ? "Address feedback and submit a new version" : "Submit for review",
      accountId: e.accountId,
      accountName,
      serviceKey: svcKey(e.serviceId),
      departmentId: personDept.get(x.ownerId ?? e.ownerId) ?? null,
      overdue: !!x.dueDate && x.dueDate < today,
    });
  }

  // Sales follow-ups (opportunity & lead next actions)
  if (can(actor, "crm.read")) {
    const opps = await tx
      .select({ o: opportunities, accountName: accounts.name, stage: pipelineStages.name })
      .from(opportunities)
      .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
      .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(and(eq(opportunities.status, "open"), lte(opportunities.nextActionDate, horizon), ownerId ? eq(opportunities.ownerId, ownerId) : undefined));
    for (const { o, accountName, stage } of opps) {
      items.push({
        id: `opportunity:${o.id}`,
        section: "sales_followups",
        title: `${o.nextAction ?? "Follow up"} — ${o.name}`,
        source: { type: "opportunity", label: `${o.number} · ${stage}`, href: `/crm/opportunities/${o.id}` },
        ownerId: o.ownerId,
        ownerName: userName(o.ownerId),
        dueDate: o.nextActionDate,
        priority: o.nextActionDate! < today ? "high" : "medium",
        status: stage,
        nextAction: o.nextAction ?? "Set the next action",
        accountId: o.accountId,
        accountName,
        serviceKey: null,
        departmentId: personDept.get(o.ownerId) ?? null,
        overdue: o.nextActionDate! < today,
      });
    }
    const ls = await tx
      .select()
      .from(leads)
      .where(and(inArray(leads.status, ["new", "researching", "qualified", "nurture"]), sql`coalesce(${leads.nextActionDate}, ${leads.followUpDate}) <= ${horizon}`, ownerId ? eq(leads.ownerId, ownerId) : undefined));
    for (const l of ls) {
      const due = l.nextActionDate ?? l.followUpDate;
      items.push({
        id: `lead:${l.id}`,
        section: "sales_followups",
        title: `${l.nextAction ?? "Follow up"} — ${l.companyName}`,
        source: { type: "lead", label: `Lead · ${l.status}`, href: `/crm/leads/${l.id}` },
        ownerId: l.ownerId,
        ownerName: userName(l.ownerId),
        dueDate: due,
        priority: due && due < today ? "high" : "medium",
        status: l.status,
        nextAction: l.nextAction ?? "Contact the lead",
        accountId: null,
        accountName: l.companyName,
        serviceKey: null,
        departmentId: personDept.get(l.ownerId) ?? null,
        overdue: !!due && due < today,
      });
    }
  }

  // Meetings and appointments (today → horizon)
  const evs = await tx
    .select({ ev: events, accountName: accounts.name })
    .from(events)
    .leftJoin(accounts, eq(accounts.id, events.accountId))
    .where(and(eq(events.status, "scheduled"), gte(events.startsAt, new Date(`${today}T00:00:00Z`)), lt(events.startsAt, new Date(`${addDaysISO(horizon, 1)}T00:00:00Z`)), ownerId ? or(eq(events.organizerId, ownerId), sql`exists (select 1 from ${eventAttendees} ea where ea.event_id = "events"."id" and ea.user_id = ${ownerId})`) : undefined));
  for (const { ev, accountName } of evs) {
    items.push({
      id: `event:${ev.id}`,
      section: "meetings",
      title: ev.title,
      source: { type: "event", label: `${ev.kind.replace("_", " ")} · ${ev.startsAt.toISOString().slice(11, 16)} UTC`, href: `/operations/calendar/events/${ev.id}` },
      ownerId: ev.organizerId,
      ownerName: userName(ev.organizerId),
      dueDate: ev.startsAt.toISOString().slice(0, 10),
      priority: ev.kind === "discovery" ? "high" : "medium",
      status: ev.status,
      nextAction: ev.agenda ? "Review agenda" : "Prepare the agenda",
      accountId: ev.accountId,
      accountName,
      serviceKey: null,
      departmentId: personDept.get(ev.organizerId) ?? null,
      overdue: false,
    });
  }

  // Approvals awaiting action (by permission)
  const approval = (id: string, title: string, src: WorkItem["source"], ownerIdA: string | null, due: string | null, next: string, accountName: string | null = null): WorkItem => ({
    id, section: "approvals", title, source: src, ownerId: ownerIdA, ownerName: userName(ownerIdA), dueDate: due, priority: "high", status: "awaiting approval", nextAction: next, accountId: null, accountName, serviceKey: null, departmentId: null, overdue: !!due && due < today,
  });
  if (can(actor, "proposals.approve")) {
    const ps = await tx.select({ p: proposals, v: proposalVersions, accountName: accounts.name }).from(proposals).innerJoin(proposalVersions, eq(proposalVersions.id, proposals.currentVersionId)).innerJoin(accounts, eq(accounts.id, proposals.accountId)).where(eq(proposalVersions.approvalStatus, "pending"));
    for (const { p, v, accountName } of ps) items.push(approval(`proposal:${p.id}`, `Approve ${p.number} v${v.versionNumber}: ${p.title}`, { type: "proposal", label: `${p.number} · ${v.currency} ${v.total}`, href: `/crm/proposals/${p.id}` }, p.ownerId, null, "Review pricing and scope, approve or return", accountName));
  }
  if (can(actor, "finance.post")) {
    const bs = await tx.select().from(bills).where(eq(bills.status, "awaiting_approval"));
    for (const b of bs) items.push(approval(`bill:${b.id}`, `Approve bill ${b.number} (${b.currency} ${b.total})`, { type: "bill", label: b.number, href: `/finance/bills/${b.id}` }, null, b.dueDate, "Check the bill and approve or return"));
    const es = await tx.select().from(expenses).where(eq(expenses.status, "submitted"));
    for (const e of es) items.push(approval(`expense:${e.id}`, `Approve expense ${e.number}: ${e.description}`, { type: "expense", label: `${e.number}${e.exceedsThreshold ? " · over threshold" : ""}`, href: `/finance/expenses/${e.id}` }, e.submittedBy, null, "Approve or reject"));
  }
  if (can(actor, "time.approve")) {
    const pending = await tx.select({ n: sql<number>`count(*)`, h: sql<string>`sum(${timeEntries.hours})` }).from(timeEntries).where(eq(timeEntries.status, "submitted"));
    if (Number(pending[0].n) > 0) items.push(approval("time:pending", `Review ${pending[0].n} submitted time entries (${d(pending[0].h).toFixed(1)}h)`, { type: "timesheet", label: "Timesheets", href: "/people/timesheets?status=submitted" }, null, null, "Approve or reject timesheets"));
  }
  if (can(actor, "delivery.approve")) {
    const crs = await tx.select({ c: changeRequests, e: engagements }).from(changeRequests).innerJoin(engagements, eq(engagements.id, changeRequests.engagementId)).where(and(eq(changeRequests.status, "submitted"), ownerId ? eq(engagements.ownerId, ownerId) : undefined));
    for (const { c, e } of crs) items.push(approval(`cr:${c.id}`, `Scope change ${c.number}: ${c.title}`, { type: "change_request", label: `${e.number} · ${c.currency} ${c.feeImpact}`, href: `/delivery/engagements/${e.id}?tab=scope` }, e.ownerId, null, "Get client approval evidence and approve, or reject"));
  }
  if (can(actor, "people.write")) {
    const lv = await tx.select({ l: leaveRequests, name: people.fullName }).from(leaveRequests).innerJoin(people, eq(people.id, leaveRequests.personId)).where(eq(leaveRequests.status, "requested"));
    for (const { l, name } of lv) items.push(approval(`leave:${l.id}`, `Leave request: ${name} ${l.startDate} – ${l.endDate}`, { type: "leave", label: l.leaveType, href: `/people/leave` }, null, l.startDate, "Approve or decline"));
  }

  // Collections
  if (can(actor, "finance.read")) {
    const overdue = await tx
      .select({ i: invoices, accountName: accounts.name, ownerId: accounts.ownerId, outstanding: outstandingSql })
      .from(invoices)
      .innerJoin(accounts, eq(accounts.id, invoices.accountId))
      .where(and(eq(invoices.status, "issued"), lt(invoices.dueDate, today), ownerId && !canAll(actor, "finance.read") ? eq(accounts.ownerId, ownerId) : undefined));
    for (const r of overdue) {
      if (d(r.outstanding).lessThanOrEqualTo(0)) continue;
      items.push({
        id: `invoice:${r.i.id}`,
        section: "collections",
        title: `Collect ${r.i.number} — ${r.accountName}`,
        source: { type: "invoice", label: `${r.i.currency} ${d(r.outstanding).toFixed(2)} outstanding`, href: `/finance/invoices/${r.i.id}` },
        ownerId: r.ownerId,
        ownerName: userName(r.ownerId),
        dueDate: r.i.dueDate,
        priority: daysBetween(r.i.dueDate!, today) > 30 ? "urgent" : "high",
        status: `${daysBetween(r.i.dueDate!, today)} days overdue`,
        nextAction: "Send a reminder and log the follow-up",
        accountId: r.i.accountId,
        accountName: r.accountName,
        serviceKey: null,
        departmentId: null,
        overdue: true,
      });
    }
  }

  // Filters
  const q = f.q?.toLowerCase().trim();
  const filtered = items.filter((it) => {
    if (f.team && it.departmentId !== f.team) return false;
    if (f.client && it.accountId !== f.client) return false;
    if (f.service && it.serviceKey !== f.service) return false;
    if (f.priority && it.priority !== f.priority) return false;
    if (f.from && it.dueDate && it.dueDate < f.from && !it.overdue) return false;
    if (q && !`${it.title} ${it.accountName ?? ""} ${it.source.label}`.toLowerCase().includes(q)) return false;
    return true;
  });
  filtered.sort((a, b) => Number(b.overdue) - Number(a.overdue) || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999"));
  return { today, horizon, items: filtered, users, departments: await tx.select().from(departments).orderBy(asc(departments.name)), services: svc };
}

/* ------------------------------------------------------------------ */
/* Numbers & evidence                                                  */
/* ------------------------------------------------------------------ */

export type Metric = { key: string; label: string; value: string | null; currency: string | null; basis: string; range: string; href: string; detail?: { label: string; value: string; currency?: string; href?: string }[]; unavailableReason?: string };

export async function numbersAndEvidence(tx: Tx, actor: Actor, range: { from: string; to: string; label: string }) {
  const s = await getSettings(tx);
  const base = s.baseCurrency;
  const today = await agencyToday(tx);
  const metrics: Metric[] = [];
  const rangeLabel = `${range.from} → ${range.to}`;
  const q = `from=${range.from}&to=${range.to}`;

  if (can(actor, "reports.read")) {
    const pl = await profitAndLoss(tx, range.from, range.to);
    const expensesTotal = d(pl.totalDirectCosts).plus(d(pl.totalOverhead));
    metrics.push({ key: "revenue", label: "Recognised revenue", value: pl.totalRevenue, currency: base, basis: "Posted revenue-account credits less debits dated in the period (accrual). Excludes invoiced-but-unearned amounts held in deferred revenue.", range: rangeLabel, href: `/finance/reports/pnl?${q}`, detail: pl.revenue.map((l) => ({ label: l.account.name, value: l.amount, currency: base, href: `/finance/reports/ledger?account=${l.account.id}&${q}` })) });
    metrics.push({ key: "expenses", label: "Expenses", value: expensesTotal.toFixed(2), currency: base, basis: "Approved bills and expenses posted to expense accounts in the period (direct costs + overhead).", range: rangeLabel, href: `/finance/reports/pnl?${q}`, detail: [{ label: "Direct costs", value: pl.totalDirectCosts, currency: base }, { label: "Overhead", value: pl.totalOverhead, currency: base }] });
    metrics.push({ key: "net_profit", label: "Management P&L — net profit", value: pl.netProfit, currency: base, basis: `Revenue − direct costs − overhead + other income. Gross margin ${pl.grossMarginPct ?? "n/a"}%.`, range: rangeLabel, href: `/finance/reports/pnl?${q}` });
    const cf = await cashFlowStatement(tx, range.from, range.to);
    const op = cf.sections.find((x) => x.section === "operating");
    const receipts = op?.items.find((i) => i.label.startsWith("Receipts"))?.amount ?? "0.00";
    const paid = (op?.items ?? []).filter((i) => !i.label.startsWith("Receipts")).reduce((a, i) => a.plus(d(i.amount)), new Decimal(0));
    metrics.push({ key: "cash_received", label: "Cash received", value: receipts, currency: base, basis: "Customer receipts posted to bank/cash accounts in the period (date of receipt).", range: rangeLabel, href: `/finance/payments?${q}` });
    metrics.push({ key: "cash_paid", label: "Cash paid", value: paid.abs().toFixed(2), currency: base, basis: "Supplier payments, company-paid expenses, reimbursements and categorised bank outflows in the period.", range: rangeLabel, href: `/finance/reports/cash-flow?${q}` });
  } else {
    metrics.push({ key: "revenue", label: "Recognised revenue", value: null, currency: base, basis: "", range: rangeLabel, href: "#", unavailableReason: "Requires the reports.read permission." });
  }

  if (can(actor, "finance.read")) {
    const ar = await tx.select({ currency: invoices.currency, dueDate: invoices.dueDate, outstanding: outstandingSql }).from(invoices).where(eq(invoices.status, "issued"));
    const byCur = new Map<string, { out: Decimal; overdue: Decimal }>();
    for (const r of ar) {
      if (d(r.outstanding).lessThanOrEqualTo(0)) continue;
      const g = byCur.get(r.currency) ?? { out: new Decimal(0), overdue: new Decimal(0) };
      g.out = g.out.plus(d(r.outstanding));
      if (r.dueDate! < today) g.overdue = g.overdue.plus(d(r.outstanding));
      byCur.set(r.currency, g);
    }
    const curList = Array.from(byCur.entries());
    const single = curList.length <= 1;
    metrics.push({ key: "ar_outstanding", label: "Outstanding receivables", value: single ? (curList[0]?.[1].out ?? new Decimal(0)).toFixed(2) : null, currency: single ? curList[0]?.[0] ?? base : null, basis: "Issued invoices: total − allocated payments − credit notes, as of today. Shown per currency (no implicit conversion).", range: `As of ${today}`, href: "/finance/collections", detail: curList.map(([c, g]) => ({ label: `${c} outstanding`, value: g.out.toFixed(2), currency: c })) });
    metrics.push({ key: "ar_overdue", label: "Overdue receivables", value: single ? (curList[0]?.[1].overdue ?? new Decimal(0)).toFixed(2) : null, currency: single ? curList[0]?.[0] ?? base : null, basis: "Outstanding balance on issued invoices past their due date.", range: `As of ${today}`, href: "/finance/invoices?status=overdue", detail: curList.map(([c, g]) => ({ label: `${c} overdue`, value: g.overdue.toFixed(2), currency: c })) });
    const upcoming = await tx.select({ currency: bills.currency, outstanding: billOutstandingSql, dueDate: bills.dueDate }).from(bills).where(and(eq(bills.status, "approved"), lte(bills.dueDate, addDaysISO(today, 14))));
    const up = new Map<string, Decimal>();
    for (const b of upcoming) if (d(b.outstanding).greaterThan(0)) up.set(b.currency, (up.get(b.currency) ?? new Decimal(0)).plus(d(b.outstanding)));
    const upList = Array.from(up.entries());
    metrics.push({ key: "upcoming_payments", label: "Payments due in 14 days", value: upList.length <= 1 ? (upList[0]?.[1] ?? new Decimal(0)).toFixed(2) : null, currency: upList.length <= 1 ? upList[0]?.[0] ?? base : null, basis: "Approved supplier bills with an outstanding balance due on or before today + 14 days (includes overdue).", range: `${today} → ${addDaysISO(today, 14)}`, href: "/finance/bills?due=14", detail: upList.map(([c, v]) => ({ label: c, value: v.toFixed(2), currency: c })) });
  }

  if (can(actor, "finance.read") && can(actor, "reports.read")) {
    const prof = await engagementProfitability(tx, { from: range.from, to: range.to });
    const clients = rollUp(prof.rows, "accountId").filter((r) => !d(r.revenue).isZero());
    const total = clients.reduce((a, r) => ({ rev: a.rev.plus(d(r.revenue)), gm: a.gm.plus(d(r.grossMargin)) }), { rev: new Decimal(0), gm: new Decimal(0) });
    metrics.push({ key: "margins", label: "Client & project gross margin", value: total.gm.toFixed(2), currency: base, basis: "Recognised revenue − approved labour cost (historical cost-rate snapshots) − direct supplier and expense costs, per engagement. Overhead not allocated.", range: rangeLabel, href: `/finance/margins?${q}`, detail: clients.slice(0, 5).map((c) => ({ label: `${c.name} (${c.marginPct ?? "–"}%)`, value: c.grossMargin, currency: base, href: `/crm/accounts/${c.id}?tab=financials` })) });
  }

  if (can(actor, "crm.read")) {
    const p = await pipelineTotals(tx, base, today);
    metrics.push({ key: "pipeline", label: "Open pipeline", value: p.missingRates.length ? null : p.unweighted.toFixed(2), currency: base, basis: `Σ value of open opportunities, converted to ${base} at the latest rate on or before ${today}. Weighted uses stage probability (or override).`, range: `As of ${today}`, href: "/crm/opportunities?view=forecast", detail: [{ label: "Weighted forecast", value: p.weighted.toFixed(2), currency: base }, ...p.missingRates.map((c) => ({ label: `Missing ${c}→${base} rate`, value: "—" }))], unavailableReason: p.missingRates.length ? `Add exchange rates for ${p.missingRates.join(", ")}.` : undefined });
  }

  if (can(actor, "people.read")) {
    const u = await utilization(tx, range.from, range.to);
    metrics.push({ key: "utilization", label: "Utilisation", value: u.capacity.isZero() ? null : u.billable.div(u.capacity).times(100).toFixed(1), currency: null, basis: `Billable logged hours ÷ available capacity (weekly capacity × working days, minus approved leave) for ${u.people} active people.`, range: rangeLabel, href: `/people/capacity?${q}`, detail: [{ label: "Capacity (h)", value: u.capacity.toFixed(1) }, { label: "Logged (h)", value: u.logged.toFixed(1) }, { label: "Billable (h)", value: u.billable.toFixed(1) }], unavailableReason: u.capacity.isZero() ? "No capacity defined for people in this range." : undefined });
  }

  if (can(actor, "finance.read")) {
    try {
      const fc = await cashForecast(tx, "base");
      metrics.push({ key: "forecast_cash", label: "Lowest forecast cash (13 weeks)", value: fc.lowest.closing, currency: base, basis: fc.basis, range: `${fc.weeks[0].week} → ${fc.weeks[12].week}`, href: "/finance/cash" });
    } catch (err) {
      metrics.push({ key: "forecast_cash", label: "Lowest forecast cash (13 weeks)", value: null, currency: base, basis: "", range: "", href: "/finance/cash", unavailableReason: (err as Error).message });
    }
  }
  return { metrics, base, range };
}

export async function pipelineTotals(tx: Tx, base: string, today: string) {
  const opps = await tx.select({ value: opportunities.value, currency: opportunities.currency, prob: pipelineStages.probability, override: opportunities.probabilityOverride }).from(opportunities).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).where(eq(opportunities.status, "open"));
  let unweighted = new Decimal(0), weighted = new Decimal(0);
  const missing = new Set<string>();
  for (const o of opps) {
    let rate = "1";
    try {
      rate = (await getRate(tx, o.currency, base, today)).rate;
    } catch {
      missing.add(o.currency);
      continue;
    }
    const v = d(o.value).times(d(rate));
    unweighted = unweighted.plus(v);
    weighted = weighted.plus(v.times(o.override ?? o.prob).div(100));
  }
  return { unweighted, weighted, missingRates: Array.from(missing) };
}

/** Capacity in hours between two dates for active people, net of approved leave. */
export async function utilization(tx: Tx, from: string, to: string) {
  const ppl = await tx.select().from(people).where(inArray(people.status, ["active", "onboarding", "offboarding"]));
  let capacity = new Decimal(0);
  for (const p of ppl) capacity = capacity.plus(personCapacity(p, from, to, await approvedLeave(tx, p.id, from, to)));
  const [t] = await tx
    .select({ logged: sql<string>`coalesce(sum(${timeEntries.hours}),0)`, billable: sql<string>`coalesce(sum(case when ${timeEntries.billable} then ${timeEntries.hours} else 0 end),0)` })
    .from(timeEntries)
    .where(and(gte(timeEntries.workDate, from), lte(timeEntries.workDate, to), ne(timeEntries.status, "rejected")));
  return { capacity, logged: d(t.logged), billable: d(t.billable), people: ppl.length };
}

async function approvedLeave(tx: Tx, personId: string, from: string, to: string) {
  return tx.select().from(leaveRequests).where(and(eq(leaveRequests.personId, personId), eq(leaveRequests.status, "approved"), lte(leaveRequests.startDate, to), gte(leaveRequests.endDate, from)));
}

export function personCapacity(p: typeof people.$inferSelect, from: string, to: string, leave: { startDate: string; endDate: string }[]) {
  const wd = (p.workingDays ?? [1, 2, 3, 4, 5]) as number[];
  const perDay = d(p.weeklyCapacityHours).div(wd.length || 5);
  let total = new Decimal(0);
  for (let dt = from; dt <= to; dt = addDaysISO(dt, 1)) {
    if (p.startDate && dt < p.startDate) continue;
    if (p.endDate && dt > p.endDate) continue;
    if (!wd.includes(new Date(`${dt}T00:00:00Z`).getUTCDay())) continue;
    if (leave.some((l) => l.startDate <= dt && l.endDate >= dt)) continue;
    total = total.plus(perDay);
  }
  return total;
}

/* ------------------------------------------------------------------ */
/* Pipeline & capacity                                                  */
/* ------------------------------------------------------------------ */

export async function pipelineAndCapacity(tx: Tx, actor: Actor) {
  const s = await getSettings(tx);
  const today = await agencyToday(tx);
  const base = s.baseCurrency;
  const open = await tx
    .select({ o: opportunities, stage: pipelineStages, accountName: accounts.name, ownerName: user.name })
    .from(opportunities)
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .leftJoin(user, eq(user.id, opportunities.ownerId))
    .where(eq(opportunities.status, "open"))
    .orderBy(asc(pipelineStages.sortOrder));
  const noNextAction = open.filter((r) => !r.o.nextAction || !r.o.nextActionDate);
  const stale = open.filter((r) => {
    const limit = r.stage.staleAfterDays ?? s.staleOpportunityDays;
    return Date.now() - r.o.stageEnteredAt.getTime() > limit * 86400000;
  });
  const proposalsAwaiting = await tx
    .select({ p: proposals, accountName: accounts.name, v: proposalVersions })
    .from(proposals)
    .innerJoin(accounts, eq(accounts.id, proposals.accountId))
    .innerJoin(proposalVersions, eq(proposalVersions.id, proposals.currentVersionId))
    .where(eq(proposals.status, "sent"))
    .orderBy(asc(proposals.sentAt));
  // Pipeline by stage and service (per currency → base)
  const svcRows = await tx.select({ opportunityId: opportunityServices.opportunityId, serviceName: services.name, serviceId: services.id }).from(opportunityServices).innerJoin(services, eq(services.id, opportunityServices.serviceId));
  const byStage = new Map<string, { stage: string; count: number; value: Decimal; weighted: Decimal; sort: number }>();
  const byService = new Map<string, { service: string; count: number; value: Decimal; weighted: Decimal }>();
  const missing = new Set<string>();
  for (const r of open) {
    let rate = "1";
    try {
      rate = (await getRate(tx, r.o.currency, base, today)).rate;
    } catch {
      missing.add(r.o.currency);
      continue;
    }
    const v = d(r.o.value).times(d(rate));
    const w = v.times(r.o.probabilityOverride ?? r.stage.probability).div(100);
    const g = byStage.get(r.stage.id) ?? { stage: r.stage.name, count: 0, value: new Decimal(0), weighted: new Decimal(0), sort: r.stage.sortOrder };
    g.count++; g.value = g.value.plus(v); g.weighted = g.weighted.plus(w);
    byStage.set(r.stage.id, g);
    const svcs = svcRows.filter((x) => x.opportunityId === r.o.id);
    const share = svcs.length ? v.div(svcs.length) : v;
    const wshare = svcs.length ? w.div(svcs.length) : w;
    for (const sv of svcs.length ? svcs : [{ serviceId: "none", serviceName: "Unassigned" }]) {
      const gs = byService.get(sv.serviceId) ?? { service: sv.serviceName, count: 0, value: new Decimal(0), weighted: new Decimal(0) };
      gs.count++; gs.value = gs.value.plus(share); gs.weighted = gs.weighted.plus(wshare);
      byService.set(sv.serviceId, gs);
    }
  }
  // Upcoming renewals (90 days)
  const renewals = await tx
    .select({ e: engagements, accountName: accounts.name })
    .from(engagements)
    .innerJoin(accounts, eq(accounts.id, engagements.accountId))
    .where(and(inArray(engagements.status, ["onboarding", "active"]), or(lte(engagements.renewalDate, addDaysISO(today, 90)), and(isNull(engagements.renewalDate), lte(engagements.endDate, addDaysISO(today, 90))))))
    .orderBy(asc(engagements.endDate));
  // Team workload & capacity (next 4 weeks)
  const from = weekStartISO(today);
  const to = addDaysISO(from, 27);
  const ppl = await tx.select({ p: people, dept: departments.name }).from(people).leftJoin(departments, eq(departments.id, people.departmentId)).where(inArray(people.status, ["active", "onboarding"]));
  const workload = [];
  for (const { p, dept } of ppl) {
    const cap = personCapacity(p, from, to, await approvedLeave(tx, p.id, from, to));
    const [open_] = p.userId
      ? await tx.select({ n: sql<number>`count(*)`, est: sql<string>`coalesce(sum(${tasks.estimateHours}),0)`, overdue: sql<number>`count(*) filter (where ${tasks.dueDate} < ${today})` }).from(tasks).where(and(eq(tasks.ownerId, p.userId), inArray(tasks.status, OPEN_TASK_STATUSES)))
      : [{ n: 0, est: "0", overdue: 0 }];
    const [alloc] = p.userId
      ? await tx.select({ h: sql<string>`coalesce(sum(${engagementMembers.allocationHoursPerWeek}),0)` }).from(engagementMembers).innerJoin(engagements, eq(engagements.id, engagementMembers.engagementId)).where(and(eq(engagementMembers.userId, p.userId), inArray(engagements.status, ["onboarding", "active"])))
      : [{ h: "0" }];
    const allocated = d(alloc.h).times(4);
    const booked = Decimal.max(allocated, d(open_.est));
    workload.push({
      personId: p.id,
      name: p.fullName,
      type: p.type,
      department: dept,
      capacity: cap.toFixed(1),
      allocated: allocated.toFixed(1),
      openTasks: Number(open_.n),
      overdueTasks: Number(open_.overdue),
      estimateHours: d(open_.est).toFixed(1),
      available: cap.minus(booked).toFixed(1),
      loadPct: cap.isZero() ? null : booked.div(cap).times(100).toFixed(0),
    });
  }
  return {
    today,
    base,
    noNextAction,
    stale,
    proposalsAwaiting,
    byStage: Array.from(byStage.values()).sort((a, b) => a.sort - b.sort).map((g) => ({ ...g, value: g.value.toFixed(2), weighted: g.weighted.toFixed(2) })),
    byService: Array.from(byService.values()).map((g) => ({ ...g, value: g.value.toFixed(2), weighted: g.weighted.toFixed(2) })),
    missingRates: Array.from(missing),
    renewals,
    workload,
    capacityWindow: { from, to },
    canSeeFinance: can(actor, "finance.read"),
  };
}

/* ------------------------------------------------------------------ */
/* Complete setup                                                       */
/* ------------------------------------------------------------------ */

export type SetupIssue = { key: string; group: string; title: string; detail: string; href: string };

export async function setupChecklist(tx: Tx) {
  const s = await getSettings(tx);
  const issues: SetupIssue[] = [];
  const [org] = await tx.select().from(organizationSettings);
  if (!org?.legalName || !org.address) issues.push({ key: "agency", group: "Agency", title: "Agency legal name or address missing", detail: "Needed on invoices and proposals.", href: "/system/settings" });

  const accs = await tx.select().from(accounts).where(and(isNull(accounts.archivedAt), inArray(accounts.lifecycleStatus, ["prospect", "onboarding", "active"])));
  for (const a of accs) {
    const missing = [!a.ownerId && "owner", !a.industry && "industry", !a.country && "country", !a.website && "website"].filter(Boolean);
    if (missing.length) issues.push({ key: `acc:${a.id}`, group: "Missing account information", title: a.name, detail: `Missing ${missing.join(", ")}`, href: `/crm/accounts/${a.id}/edit` });
    if (["onboarding", "active"].includes(a.lifecycleStatus)) {
      const b = [!(a.billingEmail || a.billingAddress) && "billing email/address", !a.billingContactName && "billing contact", a.paymentTermsDays == null && "payment terms", !a.defaultCurrency && "currency"].filter(Boolean);
      if (b.length) issues.push({ key: `bill:${a.id}`, group: "Incomplete billing details", title: a.name, detail: `Missing ${b.join(", ")}`, href: `/crm/accounts/${a.id}/edit#billing` });
    }
  }
  const engs = await tx.select({ e: engagements, accountName: accounts.name }).from(engagements).innerJoin(accounts, eq(accounts.id, engagements.accountId)).where(inArray(engagements.status, ["onboarding", "active", "on_hold"]));
  for (const { e, accountName } of engs) {
    const missing = [!e.ownerId && "owner", !e.budgetHours && !e.budgetCost && "budget (hours or cost)", !e.startDate && "start date"].filter(Boolean);
    if (missing.length) issues.push({ key: `eng:${e.id}`, group: "Engagements without budgets or owners", title: `${e.number} ${e.name}`, detail: `${accountName}: missing ${missing.join(", ")}`, href: `/delivery/engagements/${e.id}/edit` });
    const cs = await tx.select().from(contracts).where(eq(contracts.engagementId, e.id));
    if (!cs.length) issues.push({ key: `ctr:${e.id}`, group: "Unsigned or missing contracts", title: `${e.number} ${e.name}`, detail: `${accountName}: no contract recorded`, href: `/delivery/engagements/${e.id}?tab=contracts` });
    else if (!cs.some((c) => c.status === "signed" || c.status === "active")) issues.push({ key: `ctr:${e.id}`, group: "Unsigned or missing contracts", title: `${e.number} ${e.name}`, detail: `${cs.map((c) => `${c.number} (${c.status})`).join(", ")} not signed`, href: `/delivery/engagements/${e.id}?tab=contracts` });
  }
  const rates = await tx.select().from(taxRates).where(eq(taxRates.active, true));
  if (!rates.length || !s.taxSetupCompletedAt) issues.push({ key: "tax", group: "Missing tax or accounting settings", title: "Tax setup not confirmed", detail: `${rates.length} active tax rate(s). Configure the rates and treatments that apply to you, then mark tax setup complete. No jurisdiction is assumed.`, href: "/finance/tax" });
  if (!s.taxIdentifier) issues.push({ key: "taxid", group: "Missing tax or accounting settings", title: "Agency tax identifier not set", detail: "Shown on invoices when configured.", href: "/system/settings" });
  const banks = await tx.select().from(bankAccounts).where(eq(bankAccounts.active, true));
  if (!banks.length) issues.push({ key: "bank", group: "Incomplete financial opening balances", title: "No bank accounts", detail: "Add your bank and cash accounts to record payments and forecast cash.", href: "/finance/bank" });
  for (const b of banks) if (!b.openingJournalEntryId) issues.push({ key: `ob:${b.id}`, group: "Incomplete financial opening balances", title: `${b.name} has no opening balance`, detail: "Post the balance at your go-live date.", href: `/finance/bank/${b.id}` });
  if (!s.openingBalancesCompletedAt) issues.push({ key: "ob", group: "Incomplete financial opening balances", title: "Opening balances not confirmed", detail: "Enter opening receivables, payables and equity as manual opening-balance journals, then confirm.", href: "/finance/accounting?tab=opening" });
  // Currencies in use without a rate to base
  const curs = await tx.execute<{ c: string }>(sql`select distinct currency as c from invoices union select distinct currency from opportunities union select distinct currency from bills union select distinct currency from engagements`);
  for (const { c } of curs.rows) {
    if (c === s.baseCurrency) continue;
    const [r] = await tx.select().from(exchangeRates).where(or(and(eq(exchangeRates.fromCurrency, c), eq(exchangeRates.toCurrency, s.baseCurrency)), and(eq(exchangeRates.fromCurrency, s.baseCurrency), eq(exchangeRates.toCurrency, c)))).limit(1);
    if (!r) issues.push({ key: `fx:${c}`, group: "Missing tax or accounting settings", title: `No ${c}→${s.baseCurrency} exchange rate`, detail: `${c} is used in records; totals cannot be converted without a rate.`, href: "/finance/accounting?tab=fx" });
  }
  return { issues, groups: Array.from(new Set(issues.map((i) => i.group))) };
}

/* ------------------------------------------------------------------ */
/* System health                                                        */
/* ------------------------------------------------------------------ */

export async function systemHealth(tx: Tx) {
  const ints = await tx.select().from(integrations).orderBy(asc(integrations.kind));
  const failedSyncs = await tx.select({ r: integrationSyncRuns, name: integrations.displayName }).from(integrationSyncRuns).innerJoin(integrations, eq(integrations.id, integrationSyncRuns.integrationId)).where(eq(integrationSyncRuns.status, "failed")).orderBy(desc(integrationSyncRuns.startedAt)).limit(20);
  const jobs = await tx.execute<{ job_name: string; last_success: Date | null; last_failure: Date | null; last_error: string | null; failures_7d: number; last_status: string }>(sql`
    select job_name,
      max(finished_at) filter (where status = 'succeeded') as last_success,
      max(finished_at) filter (where status = 'failed') as last_failure,
      (array_agg(error order by started_at desc) filter (where status = 'failed'))[1] as last_error,
      count(*) filter (where status = 'failed' and started_at > now() - interval '7 days')::int as failures_7d,
      (array_agg(status order by started_at desc))[1] as last_status
    from job_runs group by job_name order by job_name`);
  const imports = await tx.select().from(importBatches).where(or(eq(importBatches.status, "failed"), gte(importBatches.errorRows, 1))).orderBy(desc(importBatches.createdAt)).limit(10);
  const [missingCost] = await tx.select({ n: sql<number>`count(*)` }).from(timeEntries).where(and(eq(timeEntries.status, "approved"), isNull(timeEntries.costAmount)));
  const [noBilling] = await tx.select({ n: sql<number>`count(*)` }).from(accounts).where(and(eq(accounts.lifecycleStatus, "active"), isNull(accounts.billingEmail), isNull(accounts.billingAddress)));
  const [draftsOld] = await tx.select({ n: sql<number>`count(*)` }).from(invoices).where(and(eq(invoices.status, "draft"), lt(invoices.createdAt, new Date(Date.now() - 14 * 86400000))));
  const [unlinkedPeople] = await tx.select({ n: sql<number>`count(*)` }).from(people).where(and(eq(people.status, "active"), isNull(people.userId)));
  const dataQuality = [
    { key: "missing_cost_rates", label: "Approved time without a cost rate", count: Number(missingCost.n), href: "/people/directory", detail: "Margins exclude these hours until a cost rate covers the work date." },
    { key: "active_no_billing", label: "Active clients without billing contact details", count: Number(noBilling.n), href: "/operations?tab=setup" },
    { key: "stale_drafts", label: "Draft invoices older than 14 days", count: Number(draftsOld.n), href: "/finance/invoices?status=draft" },
    { key: "people_without_login", label: "Active people without a user login", count: Number(unlinkedPeople.n), href: "/people/directory", detail: "They cannot log time or own tasks." },
  ];
  return { integrations: ints, failedSyncs, jobs: jobs.rows, imports, dataQuality };
}

