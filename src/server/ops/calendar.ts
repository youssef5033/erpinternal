import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import type { DB } from "@/db/client";
import { accounts, deliverables, engagements, events, invoices, leaveRequests, milestones, people, proposals, tasks, user } from "@/db/schema";
import { can, type Actor } from "../auth/actor";
import { accountVisibility, engagementVisibility, eventVisibility, invoiceVisibility, taskVisibility } from "../auth/scope";
import { OPEN_TASK_STATUSES } from "../delivery/tasks";
import { outstandingSql } from "../finance/invoices";

export type CalendarKind = "event" | "task" | "deliverable" | "milestone" | "invoice" | "leave" | "renewal" | "proposal";

export type CalendarItem = {
  id: string;
  kind: CalendarKind;
  /** ISO date (all-day items) */
  date: string;
  /** Last date for multi-day items (leave). */
  endDate?: string;
  start?: Date;
  end?: Date;
  title: string;
  subtitle?: string | null;
  href: string;
  status?: string | null;
  ownerId?: string | null;
};

export const KIND_LABEL: Record<CalendarKind, string> = {
  event: "Meetings",
  task: "Task due dates",
  deliverable: "Deliverables",
  milestone: "Milestones",
  invoice: "Invoice due dates",
  leave: "Leave",
  renewal: "Renewals",
  proposal: "Proposal expiry",
};

/**
 * Agency calendar: one read model over the records that carry dates. Every
 * source is filtered with the same record-level visibility as its own list.
 */
export async function calendarItems(db: DB, actor: Actor, from: string, to: string, opts: { kinds?: CalendarKind[]; owner?: string; timeZone: string }) {
  const want = (k: CalendarKind) => !opts.kinds?.length || opts.kinds.includes(k);
  const items: CalendarItem[] = [];
  const dateOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: opts.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);

  if (want("event") && (can(actor, "crm.read") || can(actor, "delivery.read"))) {
    const rows = await db
      .select({ e: events, accountName: accounts.name })
      .from(events)
      .leftJoin(accounts, eq(accounts.id, events.accountId))
      .where(and(sql`${events.startsAt} < (${to}::date + interval '2 day')`, sql`${events.endsAt} >= (${from}::date - interval '1 day')`, eventVisibility(actor), opts.owner ? or(eq(events.organizerId, opts.owner), sql`exists (select 1 from event_attendees ea where ea.event_id = "events"."id" and ea.user_id = ${opts.owner})`) : undefined));
    for (const { e, accountName } of rows) {
      const date = dateOf(e.startsAt);
      if (date < from || date > to) continue;
      items.push({ id: e.id, kind: "event", date, start: e.startsAt, end: e.endsAt, title: e.title, subtitle: [e.kind.replace("_", " "), accountName].filter(Boolean).join(" · "), href: `/operations/calendar/events/${e.id}`, status: e.status, ownerId: e.organizerId });
    }
  }
  if (want("task")) {
    const rows = await db
      .select({ t: tasks, ownerName: user.name })
      .from(tasks)
      .leftJoin(user, eq(user.id, tasks.ownerId))
      .where(and(gte(tasks.dueDate, from), lte(tasks.dueDate, to), inArray(tasks.status, OPEN_TASK_STATUSES), taskVisibility(actor), opts.owner ? eq(tasks.ownerId, opts.owner) : undefined));
    for (const { t, ownerName } of rows) items.push({ id: t.id, kind: "task", date: t.dueDate!, title: t.title, subtitle: ownerName, href: `/people/tasks/${t.id}`, status: t.status, ownerId: t.ownerId });
  }
  if (can(actor, "delivery.read")) {
    if (want("deliverable")) {
      const rows = await db
        .select({ d: deliverables, engName: engagements.name })
        .from(deliverables)
        .innerJoin(engagements, eq(engagements.id, deliverables.engagementId))
        .where(and(gte(deliverables.dueDate, from), lte(deliverables.dueDate, to), engagementVisibility(actor), opts.owner ? eq(deliverables.ownerId, opts.owner) : undefined));
      for (const { d, engName } of rows) items.push({ id: d.id, kind: "deliverable", date: d.dueDate!, title: d.name, subtitle: engName, href: `/delivery/engagements/${d.engagementId}?tab=deliverables`, status: d.approvalStatus, ownerId: d.ownerId });
    }
    if (want("milestone") && !opts.owner) {
      const rows = await db
        .select({ m: milestones, engName: engagements.name })
        .from(milestones)
        .innerJoin(engagements, eq(engagements.id, milestones.engagementId))
        .where(and(gte(milestones.dueDate, from), lte(milestones.dueDate, to), engagementVisibility(actor)));
      for (const { m, engName } of rows) items.push({ id: m.id, kind: "milestone", date: m.dueDate!, title: m.name, subtitle: engName, href: `/delivery/engagements/${m.engagementId}?tab=scope`, status: m.status });
    }
    if (want("renewal")) {
      const rows = await db
        .select({ e: engagements, accountName: accounts.name })
        .from(engagements)
        .innerJoin(accounts, eq(accounts.id, engagements.accountId))
        .where(and(inArray(engagements.status, ["onboarding", "active", "on_hold"]), sql`coalesce(${engagements.renewalDate}, ${engagements.endDate}) between ${from} and ${to}`, engagementVisibility(actor), opts.owner ? eq(engagements.ownerId, opts.owner) : undefined));
      for (const { e, accountName } of rows) items.push({ id: e.id, kind: "renewal", date: (e.renewalDate ?? e.endDate)!, title: `${e.renewalDate ? "Renewal" : "Ends"}: ${e.name}`, subtitle: accountName, href: `/delivery/engagements/${e.id}?tab=renewal`, ownerId: e.ownerId });
    }
  }
  if (want("proposal") && can(actor, "crm.read")) {
    const rows = await db
      .select({ p: proposals, accountName: accounts.name })
      .from(proposals)
      .innerJoin(accounts, eq(accounts.id, proposals.accountId))
      .where(and(eq(proposals.status, "sent"), gte(proposals.validUntil, from), lte(proposals.validUntil, to), accountVisibility(actor), opts.owner ? eq(proposals.ownerId, opts.owner) : undefined));
    for (const { p, accountName } of rows) items.push({ id: p.id, kind: "proposal", date: p.validUntil!, title: `Proposal expires: ${p.title}`, subtitle: accountName, href: `/crm/proposals/${p.id}`, ownerId: p.ownerId });
  }
  if (want("invoice") && can(actor, "finance.read") && !opts.owner) {
    const rows = await db
      .select({ i: invoices, accountName: accounts.name })
      .from(invoices)
      .innerJoin(accounts, eq(accounts.id, invoices.accountId))
      .where(and(eq(invoices.status, "issued"), gte(invoices.dueDate, from), lte(invoices.dueDate, to), invoiceVisibility(actor), sql`${outstandingSql} > 0`));
    for (const { i, accountName } of rows) items.push({ id: i.id, kind: "invoice", date: i.dueDate!, title: `Invoice ${i.number} due`, subtitle: accountName, href: `/finance/invoices/${i.id}` });
  }
  if (want("leave") && can(actor, "people.read")) {
    const rows = await db
      .select({ l: leaveRequests, name: people.fullName, userId: people.userId })
      .from(leaveRequests)
      .innerJoin(people, eq(people.id, leaveRequests.personId))
      .where(and(inArray(leaveRequests.status, ["approved", "requested"]), lte(leaveRequests.startDate, to), gte(leaveRequests.endDate, from), opts.owner ? eq(people.userId, opts.owner) : undefined));
    // Leave type is private; the calendar shows availability only.
    for (const { l, name, userId } of rows) items.push({ id: l.id, kind: "leave", date: l.startDate, endDate: l.endDate, title: `${name} — away`, subtitle: l.status === "requested" ? "requested (not yet approved)" : null, href: `/people/leave`, status: l.status, ownerId: userId });
  }
  return items.sort((a, b) => a.date.localeCompare(b.date) || (a.start?.getTime() ?? 0) - (b.start?.getTime() ?? 0));
}
