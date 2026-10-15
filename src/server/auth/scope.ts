import { and, eq, exists, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  documentAccess,
  documents,
  engagementMembers,
  engagements,
  invoices,
  leads,
  opportunities,
  tasks,
} from "@/db/schema";
import { ForbiddenError, NotFoundError } from "../errors";
import { can, canAll, scopeOf, type Actor } from "./actor";
import type { Permission } from "./permissions";

/**
 * Record-level visibility. Each helper returns a SQL condition to AND into a
 * query (undefined = unrestricted), or a FALSE condition when the actor has no
 * grant at all. Used by list queries, search, exports and detail loaders.
 */
const NONE = sql`false`;

export function engagementVisibility(actor: Actor, perm: Permission = "delivery.read"): SQL | undefined {
  const scope = scopeOf(actor, perm);
  if (scope === "all") return undefined;
  if (!scope) return NONE;
  return or(
    eq(engagements.ownerId, actor.userId),
    exists(
      sql`(select 1 from ${engagementMembers} em where em.engagement_id = ${engagements.id} and em.user_id = ${actor.userId})`,
    ),
  );
}

/** Engagement ids visible to an "assigned"-scoped actor (subquery fragment). */
function assignedEngagementIdsSql(userId: string) {
  return sql`(select e.id from engagements e where e.owner_id = ${userId}
    union select em.engagement_id from engagement_members em where em.user_id = ${userId})`;
}

export function accountVisibility(actor: Actor, perm: Permission = "crm.read"): SQL | undefined {
  // Delivery-only users (e.g. team members) can see accounts they deliver for.
  const scope = scopeOf(actor, perm) ?? (scopeOf(actor, "delivery.read") ? "assigned" : null);
  if (scope === "all") return undefined;
  if (!scope) return NONE;
  return or(
    eq(accounts.ownerId, actor.userId),
    sql`${accounts.id} in (select e.account_id from engagements e where e.id in ${assignedEngagementIdsSql(actor.userId)})`,
  );
}

export function leadVisibility(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "crm.read");
  if (scope === "all") return undefined;
  if (!scope) return NONE;
  return eq(leads.ownerId, actor.userId);
}

export function opportunityVisibility(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "crm.read");
  if (scope === "all") return undefined;
  if (!scope) return NONE;
  return or(eq(opportunities.ownerId, actor.userId), sql`${opportunities.accountId} in (select e.account_id from engagements e where e.id in ${assignedEngagementIdsSql(actor.userId)})`);
}

export function taskVisibility(actor: Actor): SQL | undefined {
  if (canAll(actor, "delivery.read") && canAll(actor, "crm.read")) return undefined;
  const conditions: (SQL | undefined)[] = [eq(tasks.ownerId, actor.userId), eq(tasks.createdBy, actor.userId)];
  if (canAll(actor, "delivery.read")) conditions.push(sql`${tasks.engagementId} is not null`);
  else if (can(actor, "delivery.read")) conditions.push(sql`${tasks.engagementId} in ${assignedEngagementIdsSql(actor.userId)}`);
  if (canAll(actor, "crm.read")) conditions.push(sql`(${tasks.engagementId} is null and ${tasks.module} = 'crm')`);
  if (canAll(actor, "finance.read")) conditions.push(sql`${tasks.module} = 'finance'`);
  if (canAll(actor, "people.write")) conditions.push(sql`${tasks.module} = 'people'`);
  if (canAll(actor, "operations.view") && canAll(actor, "delivery.read")) conditions.push(sql`${tasks.module} = 'operations'`);
  return or(...conditions);
}

export function invoiceVisibility(actor: Actor): SQL | undefined {
  const scope = scopeOf(actor, "finance.read");
  if (scope === "all") return undefined;
  if (!scope) return NONE;
  return or(
    sql`${invoices.accountId} in (select a.id from accounts a where a.owner_id = ${actor.userId})`,
    sql`${invoices.engagementId} in ${assignedEngagementIdsSql(actor.userId)}`,
  );
}

/**
 * Documents: explicit grants always apply. Otherwise the visibility class
 * decides which permission is needed, and "assigned" scope limits to
 * documents on assigned engagements / owned accounts.
 */
export function documentVisibility(actor: Actor): SQL | undefined {
  const granted = exists(sql`(select 1 from ${documentAccess} da where da.document_id = ${documents.id} and da.user_id = ${actor.userId})`);
  const own = or(eq(documents.uploadedBy, actor.userId), eq(documents.ownerId, actor.userId));
  const scope = scopeOf(actor, "documents.read");
  const classes: SQL[] = [];
  if (scope) {
    const base = scope === "all"
      ? sql`true`
      : or(
          sql`${documents.engagementId} in ${assignedEngagementIdsSql(actor.userId)}`,
          sql`${documents.accountId} in (select a.id from accounts a where a.owner_id = ${actor.userId})`,
        )!;
    classes.push(and(eq(documents.visibility, "internal"), base)!);
    if (can(actor, "finance.read")) classes.push(and(eq(documents.visibility, "finance"), scopeOf(actor, "finance.read") === "all" ? sql`true` : base)!);
    if (can(actor, "people.private")) classes.push(eq(documents.visibility, "hr_private"));
    if (canAll(actor, "users.manage")) classes.push(eq(documents.visibility, "restricted"));
  }
  return or(granted, own, ...classes);
}

/** Throw unless the engagement is visible for the permission. */
export async function assertEngagementAccess(tx: Tx, actor: Actor, engagementId: string, perm: Permission) {
  if (!can(actor, perm)) throw new ForbiddenError();
  const cond = engagementVisibility(actor, perm);
  const [row] = await tx.select({ id: engagements.id }).from(engagements).where(and(eq(engagements.id, engagementId), cond)).limit(1);
  if (!row) {
    const [exists_] = await tx.select({ id: engagements.id }).from(engagements).where(eq(engagements.id, engagementId)).limit(1);
    if (!exists_) throw new NotFoundError("Engagement");
    throw new ForbiddenError("This engagement is not assigned to you.");
  }
}

export async function assertAccountAccess(tx: Tx, actor: Actor, accountId: string, perm: Permission = "crm.read") {
  const cond = accountVisibility(actor, perm);
  const [row] = await tx.select({ id: accounts.id }).from(accounts).where(and(eq(accounts.id, accountId), cond)).limit(1);
  if (!row) {
    const [e] = await tx.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).limit(1);
    if (!e) throw new NotFoundError("Account");
    throw new ForbiddenError("This account is not assigned to you.");
  }
}

/** Write access to a CRM record: crm.write and (all scope or owner). */
export function assertCrmWrite(actor: Actor, ownerId: string | null | undefined) {
  const scope = scopeOf(actor, "crm.write");
  if (!scope) throw new ForbiddenError();
  if (scope === "assigned" && ownerId !== actor.userId) throw new ForbiddenError("You can only change records you own.");
}
