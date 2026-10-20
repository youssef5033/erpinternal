import { and, asc, count, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { goals, type GoalPeriod } from "@/db/schema";
import { addDaysISO, isISODate, weekStartISO } from "@/lib/dates";
import type { Actor } from "../auth/actor";
import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";

/**
 * Personal daily and weekly goals. Every goal belongs to the signed-in user;
 * nobody else can see or change it. A weekly goal's period starts on Monday.
 */
export const MAX_GOALS_PER_PERIOD = 30;
export type Goal = typeof goals.$inferSelect;

/** Normalise any date to the start of its period (the day itself, or that week's Monday). */
export function periodStartFor(period: GoalPeriod, date: string) {
  if (!isISODate(date)) throw new ValidationError("Invalid date.");
  return period === "week" ? weekStartISO(date) : date;
}

/** The period immediately before `start` (yesterday, or last week's Monday). */
export function previousPeriodStart(period: GoalPeriod, start: string) {
  return addDaysISO(start, period === "week" ? -7 : -1);
}

export async function listGoals(tx: Tx, actor: Actor, period: GoalPeriod, start: string) {
  return tx
    .select()
    .from(goals)
    .where(and(eq(goals.userId, actor.userId), eq(goals.period, period), eq(goals.periodStart, periodStartFor(period, start))))
    .orderBy(sql`case ${goals.status} when 'open' then 0 when 'done' then 1 else 2 end`, asc(goals.sortOrder), asc(goals.createdAt));
}

async function ownGoal(tx: Tx, actor: Actor, id: string) {
  const [g] = await tx.select().from(goals).where(and(eq(goals.id, id), eq(goals.userId, actor.userId))).for("update");
  // Someone else's goal looks exactly like a missing one: goals are private.
  if (!g) throw new NotFoundError("Goal");
  return g;
}

export async function addGoal(tx: Tx, actor: Actor, input: { period: GoalPeriod; date: string; title: string; target?: number | null }) {
  const title = input.title.trim();
  if (!title) throw new ValidationError("Write the goal.", { title: "Required" });
  if (title.length > 200) throw new ValidationError("Keep the goal under 200 characters.", { title: "Too long" });
  const target = input.target ?? null;
  if (target !== null && (!Number.isInteger(target) || target < 1 || target > 100000)) throw new ValidationError("The target must be a whole number from 1 to 100,000.", { target: "Invalid" });
  const start = periodStartFor(input.period, input.date);
  const [{ n }] = await tx.select({ n: count() }).from(goals).where(and(eq(goals.userId, actor.userId), eq(goals.period, input.period), eq(goals.periodStart, start)));
  if (n >= MAX_GOALS_PER_PERIOD) throw new ValidationError(`You already have ${MAX_GOALS_PER_PERIOD} goals for this ${input.period}. Finish or remove some first.`);
  const [g] = await tx.insert(goals).values({ userId: actor.userId, period: input.period, periodStart: start, title, target, sortOrder: n }).returning();
  await audit(tx, actor, { action: "goal.created", entityType: "goal", entityId: g.id, summary: `${input.period === "day" ? "Daily" : "Weekly"} goal added for ${start}: ${title}` });
  return g;
}

/** Tick a goal off, or reopen it. Ticking a goal with a target fills its progress. */
export async function setGoalDone(tx: Tx, actor: Actor, id: string, done: boolean) {
  const g = await ownGoal(tx, actor, id);
  if (g.status === "carried") throw new ValidationError("This goal was carried forward; update it in the later period.");
  await tx
    .update(goals)
    .set(done ? { status: "done", completedAt: new Date(), progress: g.target ? Math.max(g.progress, g.target) : g.progress } : { status: "open", completedAt: null, progress: g.target && g.progress >= g.target ? g.target - 1 : g.progress })
    .where(eq(goals.id, id));
  await audit(tx, actor, { action: done ? "goal.completed" : "goal.reopened", entityType: "goal", entityId: id, summary: `Goal ${done ? "completed" : "reopened"}: ${g.title}` });
}

/** Move progress towards a numeric target by `delta` (±1). Reaching the target completes the goal. */
export async function stepGoalProgress(tx: Tx, actor: Actor, id: string, delta: 1 | -1) {
  const g = await ownGoal(tx, actor, id);
  if (!g.target) throw new ValidationError("This goal has no numeric target.");
  if (g.status === "carried") throw new ValidationError("This goal was carried forward; update it in the later period.");
  const progress = Math.min(g.target, Math.max(0, g.progress + delta));
  const done = progress >= g.target;
  await tx.update(goals).set({ progress, status: done ? "done" : "open", completedAt: done ? (g.completedAt ?? new Date()) : null }).where(eq(goals.id, id));
  await audit(tx, actor, { action: "goal.progress", entityType: "goal", entityId: id, summary: `Goal progress ${progress}/${g.target}: ${g.title}` });
}

export async function deleteGoal(tx: Tx, actor: Actor, id: string) {
  const g = await ownGoal(tx, actor, id);
  // Keep the link from a carried copy consistent: un-carry the original if its copy is removed.
  if (g.carriedFromId) await tx.update(goals).set({ status: "open" }).where(and(eq(goals.id, g.carriedFromId), eq(goals.userId, actor.userId)));
  await tx.delete(goals).where(eq(goals.id, id));
  await audit(tx, actor, { action: "goal.deleted", entityType: "goal", entityId: id, summary: `Goal removed: ${g.title}` });
}

/**
 * Carry the previous period's unfinished goals into `start`. The originals are
 * kept (marked "carried") for history; each can be carried only once, so
 * pressing the button twice never duplicates anything.
 */
export async function carryOverGoals(tx: Tx, actor: Actor, period: GoalPeriod, date: string) {
  const start = periodStartFor(period, date);
  const prev = previousPeriodStart(period, start);
  const open = await tx
    .select()
    .from(goals)
    .where(and(eq(goals.userId, actor.userId), eq(goals.period, period), eq(goals.periodStart, prev), eq(goals.status, "open")))
    .orderBy(asc(goals.sortOrder))
    .for("update");
  if (!open.length) return 0;
  const [{ n }] = await tx.select({ n: count() }).from(goals).where(and(eq(goals.userId, actor.userId), eq(goals.period, period), eq(goals.periodStart, start)));
  if (n + open.length > MAX_GOALS_PER_PERIOD) throw new ValidationError(`Carrying ${open.length} goals would exceed ${MAX_GOALS_PER_PERIOD} for this ${period}.`);
  const inserted = await tx
    .insert(goals)
    .values(open.map((g, i) => ({ userId: actor.userId, period, periodStart: start, title: g.title, target: g.target, progress: g.progress, sortOrder: n + i, carriedFromId: g.id })))
    .onConflictDoNothing({ target: goals.carriedFromId })
    .returning({ from: goals.carriedFromId });
  const carried = inserted.map((r) => r.from!).filter(Boolean);
  if (carried.length) await tx.update(goals).set({ status: "carried" }).where(inArray(goals.id, carried));
  await audit(tx, actor, { action: "goal.carried_over", entityType: "goal", summary: `${carried.length} unfinished ${period === "day" ? "daily" : "weekly"} goal(s) carried from ${prev} to ${start}` });
  return carried.length;
}

/** Unfinished goals left in the previous period (for the "carry over" prompt). */
export async function openInPreviousPeriod(tx: Tx, actor: Actor, period: GoalPeriod, date: string) {
  const prev = previousPeriodStart(period, periodStartFor(period, date));
  const [{ n }] = await tx.select({ n: count() }).from(goals).where(and(eq(goals.userId, actor.userId), eq(goals.period, period), eq(goals.periodStart, prev), eq(goals.status, "open")));
  return n;
}

/** Completion per period for the last `periods` days or weeks ending at `date` (carried goals count as not done). */
export async function goalHistory(tx: Tx, actor: Actor, period: GoalPeriod, date: string, periods: number) {
  const end = periodStartFor(period, date);
  const startFrom = addDaysISO(end, -(periods - 1) * (period === "week" ? 7 : 1));
  const rows = await tx
    .select({ start: goals.periodStart, total: count(), done: sql<number>`count(*) filter (where ${goals.status} = 'done')::int` })
    .from(goals)
    .where(and(eq(goals.userId, actor.userId), eq(goals.period, period), gte(goals.periodStart, startFrom), lte(goals.periodStart, end)))
    .groupBy(goals.periodStart);
  const out: { start: string; total: number; done: number }[] = [];
  for (let i = 0; i < periods; i++) {
    const s = addDaysISO(startFrom, i * (period === "week" ? 7 : 1));
    const r = rows.find((x) => x.start === s);
    out.push({ start: s, total: Number(r?.total ?? 0), done: Number(r?.done ?? 0) });
  }
  return out;
}
