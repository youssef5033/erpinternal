import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db/client";
import { engagements, events, jobRuns, notifications, opportunities, servicePeriods, tasks } from "@/db/schema";
import { addDaysISO } from "@/lib/dates";
import { SYSTEM_ACTOR } from "../auth/actor";
import { agencyToday, getSettings } from "../system/settings";
import { refreshSignals } from "../ops/signals";
import { runRecurringSchedules } from "../finance/recurring";
import { generateDueBillingInvoices } from "../finance/invoices";
import { runRevenueRecognition } from "../finance/revenue";
import { generateDueDrafts } from "../crm/outreach";
import { expireProposals } from "../crm/proposals";
import { createTask } from "../delivery/tasks";
import { purgeOldSubmissionKeys } from "../idempotency";

/**
 * Background jobs. Each run is recorded in job_runs under a unique
 * idempotency key (job + time bucket). A key that already succeeded is
 * skipped; a failed key is retried (attempts++). The work itself is also
 * idempotent (generation keys), so even an overlapping run cannot duplicate.
 */
export type JobDef = { name: string; label: string; cron: string; bucket: (now: Date) => string; run: (tx: Tx, now: Date) => Promise<Record<string, unknown>> };

const day = (now: Date) => now.toISOString().slice(0, 10);
const hour = (now: Date) => now.toISOString().slice(0, 13);
const quarterHour = (now: Date) => `${now.toISOString().slice(0, 14)}${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, "0")}`;

export const JOBS: JobDef[] = [
  {
    name: "refresh-signals",
    label: "Recalculate review signals",
    cron: "*/15 * * * *",
    bucket: quarterHour,
    run: async (tx) => ({ ...(await refreshSignals(tx)) }),
  },
  {
    name: "recurring-invoices",
    label: "Generate recurring and scheduled invoices",
    cron: "15 6 * * *",
    bucket: day,
    run: async (tx) => {
      const today = await agencyToday(tx);
      const recurring = await runRecurringSchedules(tx, SYSTEM_ACTOR, today);
      const scheduled = await generateDueBillingInvoices(tx, SYSTEM_ACTOR, today);
      return { recurringDrafts: recurring, billingScheduleDrafts: scheduled };
    },
  },
  {
    name: "revenue-recognition",
    label: "Post revenue recognition",
    cron: "30 6 * * *",
    bucket: day,
    run: async (tx) => ({ posted: await runRevenueRecognition(tx, SYSTEM_ACTOR, await agencyToday(tx)) }),
  },
  {
    name: "outreach-drafts",
    label: "Prepare due outreach drafts (manual send)",
    cron: "5 * * * *",
    bucket: hour,
    run: async (tx, now) => ({ drafts: await generateDueDrafts(tx, SYSTEM_ACTOR, now) }),
  },
  {
    name: "renewal-tasks",
    label: "Create renewal tasks and update service periods",
    cron: "45 6 * * *",
    bucket: day,
    run: async (tx) => {
      const today = await agencyToday(tx);
      const s = await getSettings(tx);
      const window = addDaysISO(today, s.renewalLeadDays);
      const rets = await tx.select().from(engagements).where(and(eq(engagements.billingModel, "retainer"), inArray(engagements.status, ["onboarding", "active"]), lte(engagements.endDate, window)));
      let created = 0;
      for (const e of rets) {
        const [renewal] = await tx.select({ id: opportunities.id }).from(opportunities).where(and(eq(opportunities.parentEngagementId, e.id), eq(opportunities.kind, "renewal")));
        if (renewal) continue;
        const t = await createTask(tx, SYSTEM_ACTOR, {
          title: `Renewal conversation: ${e.name} (ends ${e.endDate})`,
          kind: "renewal",
          module: "crm",
          priority: "high",
          ownerId: e.ownerId,
          dueDate: e.noticePeriodDays ? addDaysISO(e.endDate!, -e.noticePeriodDays) : addDaysISO(e.endDate!, -14),
          engagementId: e.id,
          accountId: e.accountId,
          generationKey: `renewal-task:${e.id}:${e.endDate}`,
        });
        if (t.createdAt.getTime() > Date.now() - 60000) created++;
      }
      await tx.update(servicePeriods).set({ status: "active" }).where(and(eq(servicePeriods.status, "upcoming"), lte(servicePeriods.startDate, today)));
      await tx.update(servicePeriods).set({ status: "completed" }).where(and(eq(servicePeriods.status, "active"), sql`${servicePeriods.endDate} < ${today}`));
      return { renewalTasks: created };
    },
  },
  {
    name: "expire-proposals",
    label: "Expire proposals past their validity",
    cron: "0 7 * * *",
    bucket: day,
    run: async (tx) => ({ expired: await expireProposals(tx, SYSTEM_ACTOR) }),
  },
  {
    name: "reminders",
    label: "Task and meeting reminders",
    cron: "*/15 * * * *",
    bucket: quarterHour,
    run: async (tx, now) => {
      let n = 0;
      const due = await tx.select().from(tasks).where(and(lte(tasks.reminderAt, now), inArray(tasks.status, ["backlog", "ready", "in_progress", "blocked", "internal_review", "client_review"])));
      for (const t of due) {
        if (!t.ownerId) continue;
        const r = await tx.insert(notifications).values({ userId: t.ownerId, kind: "task_reminder", title: `Reminder: ${t.title}`, body: t.dueDate ? `Due ${t.dueDate}` : null, href: `/people/tasks/${t.id}`, dedupeKey: `task:${t.id}:${t.reminderAt!.toISOString()}` }).onConflictDoNothing().returning();
        n += r.length;
      }
      const soon = await tx.select().from(events).where(and(eq(events.status, "scheduled"), lte(events.startsAt, new Date(now.getTime() + 60 * 60000)), sql`${events.startsAt} > ${now}`));
      for (const ev of soon) {
        if (!ev.organizerId) continue;
        if (ev.startsAt.getTime() - now.getTime() > (ev.reminderMinutes ?? 15) * 60000) continue;
        const r = await tx.insert(notifications).values({ userId: ev.organizerId, kind: "meeting_reminder", title: `Starting soon: ${ev.title}`, href: `/operations/calendar/events/${ev.id}`, dedupeKey: `event:${ev.id}` }).onConflictDoNothing().returning();
        n += r.length;
      }
      return { notifications: n };
    },
  },
  {
    name: "housekeeping",
    label: "Purge expired submission keys",
    cron: "0 3 * * *",
    bucket: day,
    run: async (tx) => {
      await purgeOldSubmissionKeys(tx, 7);
      return {};
    },
  },
];

export function findJob(name: string) {
  return JOBS.find((j) => j.name === name);
}

/**
 * Execute a job exactly once per idempotency key. Runs in its own transaction;
 * failures are recorded with the error and re-thrown for the queue to retry.
 */
export async function runJob(db: DB, name: string, opts: { now?: Date; key?: string; triggeredBy?: string } = {}) {
  const job = findJob(name);
  if (!job) throw new Error(`Unknown job ${name}`);
  const now = opts.now ?? new Date();
  const key = opts.key ?? `${job.name}:${job.bucket(now)}`;
  const [existing] = await db.select().from(jobRuns).where(eq(jobRuns.idempotencyKey, key));
  if (existing?.status === "succeeded") return { status: "skipped" as const, key, result: existing.result };
  if (existing?.status === "running" && existing.startedAt > new Date(Date.now() - 10 * 60000)) return { status: "skipped" as const, key, result: null };
  if (existing) await db.update(jobRuns).set({ status: "running", attempts: existing.attempts + 1, startedAt: new Date(), error: null, triggeredBy: opts.triggeredBy ?? "scheduler" }).where(eq(jobRuns.id, existing.id));
  else await db.insert(jobRuns).values({ jobName: job.name, idempotencyKey: key, status: "running", triggeredBy: opts.triggeredBy ?? "scheduler" }).onConflictDoNothing();
  try {
    const result = await db.transaction(async (tx) => job.run(tx, now));
    await db.update(jobRuns).set({ status: "succeeded", finishedAt: new Date(), result }).where(eq(jobRuns.idempotencyKey, key));
    return { status: "succeeded" as const, key, result };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(jobRuns).set({ status: "failed", finishedAt: new Date(), error: message.slice(0, 2000) }).where(eq(jobRuns.idempotencyKey, key));
    throw err;
  }
}

export async function lastSignalRefresh(db: DB) {
  const [r] = await db.select({ at: jobRuns.finishedAt }).from(jobRuns).where(and(eq(jobRuns.jobName, "refresh-signals"), eq(jobRuns.status, "succeeded"))).orderBy(sql`${jobRuns.finishedAt} desc`).limit(1);
  return r?.at ?? null;
}

