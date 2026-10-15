import { and, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { rolePermissions, roles, user, userRoles, people } from "@/db/schema";
import { ForbiddenError } from "../errors";
import type { Permission, Scope } from "./permissions";

export type Actor = {
  userId: string;
  name: string;
  email: string;
  personId: string | null;
  timeZone: string | null;
  roleKeys: string[];
  roleNames: string[];
  grants: Map<Permission, Scope>;
};

/** A system actor for background jobs (logged as "System"). */
export const SYSTEM_ACTOR: Actor = {
  userId: "",
  name: "System",
  email: "system@localhost",
  personId: null,
  timeZone: null,
  roleKeys: ["system"],
  roleNames: ["System"],
  grants: new Map(),
};
export const isSystem = (a: Actor) => a.roleKeys.includes("system");

export function can(actor: Actor, permission: Permission): boolean {
  return isSystem(actor) || actor.grants.has(permission);
}

/** True only when the grant covers every record (not just assigned ones). */
export function canAll(actor: Actor, permission: Permission): boolean {
  return isSystem(actor) || actor.grants.get(permission) === "all";
}

export function scopeOf(actor: Actor, permission: Permission): Scope | null {
  if (isSystem(actor)) return "all";
  return actor.grants.get(permission) ?? null;
}

export function assertCan(actor: Actor, permission: Permission, message?: string) {
  if (!can(actor, permission)) throw new ForbiddenError(message);
}

export async function loadActor(db: Tx, userId: string): Promise<Actor | null> {
  const [u] = await db.select().from(user).where(eq(user.id, userId)).limit(1);
  if (!u || u.status !== "active") return null;
  const rs = await db
    .select({ key: roles.key, name: roles.name, id: roles.id })
    .from(userRoles)
    .innerJoin(roles, eq(userRoles.roleId, roles.id))
    .where(eq(userRoles.userId, userId));
  const grants = new Map<Permission, Scope>();
  if (rs.length) {
    const perms = await db
      .select()
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, rs.map((r) => r.id)));
    for (const p of perms) {
      const current = grants.get(p.permission as Permission);
      // The broadest scope across roles wins.
      if (current !== "all") grants.set(p.permission as Permission, p.scope);
    }
  }
  const [person] = await db.select({ id: people.id }).from(people).where(and(eq(people.userId, userId))).limit(1);
  return {
    userId: u.id,
    name: u.name,
    email: u.email,
    personId: person?.id ?? null,
    timeZone: u.timeZone,
    roleKeys: rs.map((r) => r.key),
    roleNames: rs.map((r) => r.name),
    grants,
  };
}
