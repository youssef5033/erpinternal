import "server-only";
import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { z } from "zod";
import { db, type Tx } from "@/db/client";
import { formToObject, zodFieldErrors } from "@/lib/formdata";
import { can, type Actor } from "../auth/actor";
import type { Permission } from "../auth/permissions";
import { requireActor } from "../auth/session";
import { AppError, isUniqueViolation } from "../errors";
import { claimSubmission, recordSubmissionResult } from "../idempotency";

export type ActionState = { ok: boolean; message: string; fieldErrors?: Record<string, string>; ref?: string | null; at?: number } | null;

type RunResult = void | string | { message?: string; redirectTo?: string; ref?: string | null };

/**
 * Standard server-action pipeline:
 *  1. authenticate (session) and authorise (any of `permission`) on the server
 *  2. validate input with zod → field errors
 *  3. run in ONE database transaction, claiming the form's submission key so a
 *     double submit cannot apply twice
 *  4. translate domain errors into user-facing messages (never leak internals)
 *  5. revalidate and optionally redirect
 */
export async function runAction<S extends z.ZodType>(
  fd: FormData,
  opts: {
    permission?: Permission | Permission[];
    schema: S;
    action: string;
    run: (ctx: { actor: Actor; tx: Tx; data: z.infer<S> }) => Promise<RunResult>;
    revalidate?: string[];
    redirectTo?: string;
    successMessage?: string;
  },
): Promise<ActionState> {
  const actor = await requireActor();
  const perms = opts.permission ? (Array.isArray(opts.permission) ? opts.permission : [opts.permission]) : [];
  if (perms.length && !perms.some((p) => can(actor, p))) return { ok: false, message: "You do not have permission to do that.", at: Date.now() };
  const parsed = opts.schema.safeParse(formToObject(fd));
  if (!parsed.success) return { ok: false, message: "Please correct the highlighted fields.", fieldErrors: zodFieldErrors(parsed.error), at: Date.now() };
  const key = (fd.get("_submissionKey") as string | null) || null;
  let result: RunResult;
  let duplicateRef: string | null | undefined;
  try {
    result = await db.transaction(async (tx) => {
      const claim = await claimSubmission(tx, key ? `${actor.userId}:${key}` : null, actor.userId, opts.action);
      if (claim.duplicate) {
        duplicateRef = claim.resultRef;
        return;
      }
      const r = await opts.run({ actor, tx, data: parsed.data });
      const ref = typeof r === "object" && r ? r.ref : null;
      if (key && ref) await recordSubmissionResult(tx, `${actor.userId}:${key}`, ref);
      return r;
    });
  } catch (err) {
    if (err instanceof AppError) return { ok: false, message: err.message, fieldErrors: err.fieldErrors, at: Date.now() };
    if (isUniqueViolation(err)) return { ok: false, message: "This conflicts with an existing record (duplicate). Refresh and check before trying again.", at: Date.now() };
    const pgMsg = (err as { cause?: { message?: string } })?.cause?.message;
    if (pgMsg && /immutable|locked|unbalanced/.test(pgMsg)) return { ok: false, message: pgMsg, at: Date.now() };
    const ref = randomUUID().slice(0, 8);
    console.error(`[action ${opts.action}] error ref=${ref}`, err);
    return { ok: false, message: `Something went wrong. Nothing was saved. (Reference ${ref})`, at: Date.now() };
  }
  // Internal app: refresh all server-rendered data after any successful mutation.
  revalidatePath("/", "layout");
  for (const p of opts.revalidate ?? []) revalidatePath(p);
  if (duplicateRef !== undefined) {
    return { ok: true, message: "Already submitted — your earlier submission was kept.", ref: duplicateRef, at: Date.now() };
  }
  const r = typeof result === "object" && result ? result : null;
  const target = r?.redirectTo ?? opts.redirectTo;
  if (target) redirect(target);
  const message = typeof result === "string" ? result : r?.message ?? opts.successMessage ?? "Saved.";
  return { ok: true, message, ref: r?.ref ?? null, at: Date.now() };
}
