"use server";

import { z } from "zod";
import { f } from "@/lib/formdata";
import { db } from "@/db/client";
import { runAction, type ActionState } from "./run";
import { dismissSignal, refreshSignals, snoozeSignal } from "../ops/signals";
import { findJob, runJob } from "../jobs/registry";
import { requireActor } from "../auth/session";
import { can } from "../auth/actor";

export async function refreshSignalsAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "operations.view", action: "signals.refresh", schema: z.object({}), revalidate: ["/operations"], run: async ({ tx }) => {
    const r = await refreshSignals(tx);
    return `Recalculated: ${r.created} new, ${r.updated} still active, ${r.resolved} resolved.`;
  } });
}

export async function snoozeSignalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "operations.view", action: "signals.snooze", schema: z.object({ id: f.id(), until: f.date(), note: f.optStr() }), revalidate: ["/operations"], run: async ({ actor, tx, data }) => {
    await snoozeSignal(tx, actor, data.id, data.until, data.note);
    return "Snoozed. It will reappear if the issue is still present after that date.";
  } });
}

export async function dismissSignalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "operations.view", action: "signals.dismiss", schema: z.object({ id: f.id(), note: f.str(500) }), revalidate: ["/operations"], run: async ({ actor, tx, data }) => {
    await dismissSignal(tx, actor, data.id, data.note);
    return "Dismissed. It will resolve automatically once the source issue is fixed.";
  } });
}

/** Manually trigger a background job (same idempotent runner as the worker). */
export async function runJobNowAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const actor = await requireActor();
  if (!can(actor, "audit.read")) return { ok: false, message: "You do not have permission to do that." };
  const name = String(fd.get("job") ?? "");
  if (!findJob(name)) return { ok: false, message: "Unknown job." };
  try {
    const r = await runJob(db, name, { key: `${name}:manual:${Date.now()}`, triggeredBy: `manual:${actor.email}` });
    return { ok: true, message: `${name}: ${r.status}. ${JSON.stringify(r.result ?? {})}` };
  } catch (err) {
    return { ok: false, message: `${name} failed: ${(err as Error).message}` };
  }
}
