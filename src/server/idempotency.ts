import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { idempotencyKeys } from "@/db/schema";
import { ConflictError } from "./errors";

/**
 * Duplicate-submission protection. Forms include a one-time `submissionKey`;
 * the first submission claims it inside the transaction. A repeated submission
 * (double click, retry) is rejected or returns the original result reference.
 */
export async function claimSubmission(tx: Tx, key: string | null | undefined, userId: string | null, action: string): Promise<{ duplicate: false } | { duplicate: true; resultRef: string | null }> {
  if (!key) return { duplicate: false };
  const inserted = await tx
    .insert(idempotencyKeys)
    .values({ key, userId: userId || null, action })
    .onConflictDoNothing()
    .returning({ key: idempotencyKeys.key });
  if (inserted.length) return { duplicate: false };
  const [existing] = await tx.select().from(idempotencyKeys).where(eq(idempotencyKeys.key, key));
  if (existing && existing.action !== action) throw new ConflictError("Submission key reused for a different action.");
  return { duplicate: true, resultRef: existing?.resultRef ?? null };
}

export async function recordSubmissionResult(tx: Tx, key: string | null | undefined, resultRef: string) {
  if (!key) return;
  await tx.update(idempotencyKeys).set({ resultRef }).where(eq(idempotencyKeys.key, key));
}

export async function purgeOldSubmissionKeys(tx: Tx, days = 7) {
  await tx.execute(sql`delete from idempotency_keys where created_at < now() - make_interval(days => ${days})`);
}
