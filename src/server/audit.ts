import type { Tx } from "@/db/client";
import { auditEvents } from "@/db/schema";
import { isSystem, type Actor } from "./auth/actor";

const SECRET_KEY = /pass(word)?|secret|token|credential|api[_-]?key|private[_-]?key/i;

function redact(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEY.test(k) ? "[redacted]" : redact(v)]),
    );
  }
  return value;
}

/** Field-level diff between two snapshots, limited to `fields` when given. */
export function diff<T extends Record<string, unknown>>(before: Partial<T> | null | undefined, after: Partial<T>, fields?: (keyof T)[]) {
  const keys = (fields ?? (Object.keys(after) as (keyof T)[])) as string[];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const k of keys) {
    if (k === "updatedAt" || k === "createdAt") continue;
    const a = before?.[k as keyof T];
    const b = after[k as keyof T];
    const norm = (v: unknown) => (v instanceof Date ? v.toISOString() : v === undefined ? null : JSON.stringify(v));
    if (norm(a) !== norm(b)) changes[k] = { from: a ?? null, to: b ?? null };
  }
  return changes;
}

export type AuditInput = {
  action: string;
  entityType: string;
  entityId?: string | null;
  summary: string;
  changes?: Record<string, unknown> | null;
};

/** Append an audit event inside the caller's transaction. */
export async function audit(tx: Tx, actor: Actor, input: AuditInput) {
  await tx.insert(auditEvents).values({
    actorId: isSystem(actor) || !actor.userId ? null : actor.userId,
    actorLabel: isSystem(actor) ? "System" : `${actor.name} <${actor.email}>`,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    summary: input.summary,
    changes: input.changes ? (redact(input.changes) as Record<string, unknown>) : null,
  });
}
