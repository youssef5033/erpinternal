import { and, desc, eq, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { activities, user, type ActivityType } from "@/db/schema";
import { isSystem, type Actor } from "../auth/actor";

export type ActivityInput = {
  type: ActivityType;
  subject: string;
  body?: string | null;
  direction?: "inbound" | "outbound" | "internal" | null;
  channel?: string | null;
  outcome?: string | null;
  occurredAt?: Date;
  source?: "manual" | "imported" | "system";
  externalId?: string | null;
  accountId?: string | null;
  contactId?: string | null;
  leadId?: string | null;
  opportunityId?: string | null;
  engagementId?: string | null;
  campaignId?: string | null;
  enrollmentId?: string | null;
  relatedType?: string | null;
  relatedId?: string | null;
};

/**
 * Log ONE activity row linked to every relevant record. Timelines on the
 * account, contact, opportunity and engagement all read this same row, so
 * nothing is duplicated.
 */
export async function logActivity(tx: Tx, actor: Actor, input: ActivityInput) {
  const [row] = await tx
    .insert(activities)
    .values({
      ...input,
      source: input.source ?? (isSystem(actor) ? "system" : "manual"),
      occurredAt: input.occurredAt ?? new Date(),
      actorId: isSystem(actor) || !actor.userId ? null : actor.userId,
    })
    .returning();
  return row;
}

export type TimelineFilter = {
  accountId?: string;
  contactId?: string;
  leadId?: string;
  opportunityId?: string;
  engagementId?: string;
};

export async function timeline(tx: Tx, f: TimelineFilter, limit = 100) {
  const conds: SQL[] = [];
  if (f.accountId) conds.push(eq(activities.accountId, f.accountId));
  if (f.contactId) conds.push(eq(activities.contactId, f.contactId));
  if (f.leadId) conds.push(eq(activities.leadId, f.leadId));
  if (f.opportunityId) conds.push(eq(activities.opportunityId, f.opportunityId));
  if (f.engagementId) conds.push(eq(activities.engagementId, f.engagementId));
  if (!conds.length) return [];
  return tx
    .select({
      activity: activities,
      actorName: user.name,
    })
    .from(activities)
    .leftJoin(user, eq(activities.actorId, user.id))
    .where(or(...conds))
    .orderBy(desc(activities.occurredAt))
    .limit(limit);
}

export async function lastInteraction(tx: Tx, f: { leadId?: string; accountId?: string; opportunityId?: string }) {
  const conds: SQL[] = [sql`${activities.type} in ('email','message','linkedin','call','meeting')`];
  if (f.leadId) conds.push(eq(activities.leadId, f.leadId));
  if (f.accountId) conds.push(eq(activities.accountId, f.accountId));
  if (f.opportunityId) conds.push(eq(activities.opportunityId, f.opportunityId));
  const [row] = await tx.select({ at: activities.occurredAt }).from(activities).where(and(...conds)).orderBy(desc(activities.occurredAt)).limit(1);
  return row?.at ?? null;
}
