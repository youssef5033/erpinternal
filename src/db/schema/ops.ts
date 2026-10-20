import { check, index, integer, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { day, pk, timestamps, ts } from "./_helpers";
import { user } from "./auth";

export type SignalSeverity = "info" | "warning" | "critical";

/**
 * Review signals are recalculated from source records by the signal engine
 * (src/server/ops/signals.ts). At most one *active* signal exists per
 * rule + source record (`fingerprint`). When the source issue disappears the
 * signal is marked resolved automatically; history is kept.
 */
export const signals = pgTable(
  "signals",
  {
    id: pk(),
    ruleKey: text("rule_key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    category: text("category").notNull(),
    severity: text("severity").$type<SignalSeverity>().notNull(),
    title: text("title").notNull(),
    reason: text("reason").notNull(),
    resolutionAction: text("resolution_action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    href: text("href").notNull(),
    ownerId: text("owner_id").references(() => user.id),
    status: text("status").$type<"active" | "resolved" | "snoozed" | "dismissed">().notNull().default("active"),
    resolution: text("resolution").$type<"source_resolved" | "dismissed">(),
    snoozedUntil: ts("snoozed_until"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}),
    firstDetectedAt: ts("first_detected_at").defaultNow().notNull(),
    lastDetectedAt: ts("last_detected_at").defaultNow().notNull(),
    resolvedAt: ts("resolved_at"),
  },
  (t) => [
    uniqueIndex("signals_open_fingerprint_uq").on(t.fingerprint).where(sql`resolved_at is null`),
    index("signals_status_idx").on(t.status, t.severity),
    index("signals_entity_idx").on(t.entityType, t.entityId),
  ],
);

export const signalEvents = pgTable(
  "signal_events",
  {
    id: pk(),
    signalId: uuid("signal_id")
      .notNull()
      .references(() => signals.id, { onDelete: "cascade" }),
    event: text("event").$type<"detected" | "updated" | "resolved" | "snoozed" | "dismissed" | "reopened">().notNull(),
    note: text("note"),
    actorId: text("actor_id").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("signal_events_signal_idx").on(t.signalId)],
);

export type GoalPeriod = "day" | "week";
export type GoalStatus = "open" | "done" | "carried";

/**
 * Personal daily and weekly goals (src/server/ops/goals.ts). Each belongs to
 * one user and one period: a day, or a week starting on Monday. Goals can
 * have a numeric target ("5 discovery calls") tracked by progress. Unfinished
 * goals can be carried into the next period; the original is kept as
 * "carried" and linked, so history shows what slipped.
 */
export const goals = pgTable(
  "goals",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    period: text("period").$type<GoalPeriod>().notNull(),
    periodStart: day("period_start").notNull(),
    title: text("title").notNull(),
    target: integer("target"),
    progress: integer("progress").notNull().default(0),
    status: text("status").$type<GoalStatus>().notNull().default("open"),
    sortOrder: integer("sort_order").notNull().default(0),
    carriedFromId: uuid("carried_from_id"),
    completedAt: ts("completed_at"),
    ...timestamps,
  },
  (t) => [
    index("goals_user_period_idx").on(t.userId, t.period, t.periodStart),
    // A goal can be carried forward only once.
    uniqueIndex("goals_carried_from_uq").on(t.carriedFromId),
    check("goals_period_chk", sql`${t.period} in ('day', 'week')`),
    check("goals_status_chk", sql`${t.status} in ('open', 'done', 'carried')`),
    check("goals_target_chk", sql`${t.target} is null or ${t.target} > 0`),
    check("goals_progress_chk", sql`${t.progress} >= 0`),
  ],
);
