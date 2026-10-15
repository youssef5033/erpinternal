import { index, jsonb, pgTable, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, ts } from "./_helpers";
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
