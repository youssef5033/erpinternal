import { and, eq, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { recurringInvoiceSchedules, type RecurringLine } from "@/db/schema";
import { addMonthsISO } from "@/lib/dates";
import { assertCan, isSystem, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { createInvoiceDraft, issueInvoice } from "./invoices";

export async function saveRecurringSchedule(
  tx: Tx,
  actor: Actor,
  input: { id?: string; name: string; accountId: string; engagementId?: string | null; frequency: "monthly" | "quarterly" | "yearly"; nextRunDate: string; endDate?: string | null; currency: string; lines: RecurringLine[]; paymentTermsDays?: number; autoIssue?: boolean },
) {
  assertCan(actor, "finance.write");
  if (!input.lines.length) throw new ValidationError("Add at least one line.");
  const values = {
    name: input.name.trim(),
    accountId: input.accountId,
    engagementId: input.engagementId || null,
    frequency: input.frequency,
    nextRunDate: input.nextRunDate,
    endDate: input.endDate || null,
    currency: input.currency.toUpperCase(),
    lines: input.lines,
    paymentTermsDays: input.paymentTermsDays ?? 14,
    autoIssue: !!input.autoIssue,
  };
  const [row] = input.id
    ? await tx.update(recurringInvoiceSchedules).set(values).where(eq(recurringInvoiceSchedules.id, input.id)).returning()
    : await tx.insert(recurringInvoiceSchedules).values({ ...values, createdBy: actor.userId || null }).returning();
  await audit(tx, actor, { action: "recurring_invoice.saved", entityType: "recurring_invoice_schedule", entityId: row.id, summary: `Recurring schedule ${row.name} (${row.frequency})` });
  return row;
}

export async function setRecurringStatus(tx: Tx, actor: Actor, id: string, status: "active" | "paused" | "ended") {
  assertCan(actor, "finance.write");
  const [row] = await tx.update(recurringInvoiceSchedules).set({ status }).where(eq(recurringInvoiceSchedules.id, id)).returning();
  if (!row) throw new NotFoundError("Schedule");
  await audit(tx, actor, { action: `recurring_invoice.${status}`, entityType: "recurring_invoice_schedule", entityId: id, summary: `Schedule ${row.name} ${status}` });
}

function step(date: string, frequency: "monthly" | "quarterly" | "yearly") {
  return addMonthsISO(date, frequency === "monthly" ? 1 : frequency === "quarterly" ? 3 : 12);
}

/**
 * Generate invoices for every due period (catching up missed runs). Each
 * period's invoice carries generationKey `recurring:<schedule>:<periodDate>`,
 * so a retried or concurrent job can never create a duplicate.
 */
export async function runRecurringSchedules(tx: Tx, actor: Actor, asOf: string) {
  if (!isSystem(actor)) assertCan(actor, "finance.write");
  const due = await tx
    .select()
    .from(recurringInvoiceSchedules)
    .where(and(eq(recurringInvoiceSchedules.status, "active"), lte(recurringInvoiceSchedules.nextRunDate, asOf)))
    .for("update", { skipLocked: true });
  let created = 0;
  for (const s of due) {
    let next = s.nextRunDate;
    while (next <= asOf && (!s.endDate || next <= s.endDate)) {
      const { invoice, created: isNew } = await createInvoiceDraft(
        tx,
        actor,
        {
          accountId: s.accountId,
          engagementId: s.engagementId,
          currency: s.currency,
          paymentTermsDays: s.paymentTermsDays,
          reference: `${s.name} — ${next}`,
          lines: s.lines.map((l) => ({ description: `${l.description} (${next})`, quantity: l.quantity, unitPrice: l.unitPrice, taxRateId: l.taxRateId ?? null, serviceId: l.serviceId ?? null })),
        },
        { generationKey: `recurring:${s.id}:${next}`, recurringScheduleId: s.id },
      );
      if (isNew) {
        created++;
        if (s.autoIssue && invoice.status === "draft") await issueInvoice(tx, actor, invoice.id, { issueDate: next });
      }
      next = step(next, s.frequency);
    }
    const ended = !!s.endDate && next > s.endDate;
    await tx.update(recurringInvoiceSchedules).set({ nextRunDate: next, lastRunAt: new Date(), status: ended ? "ended" : s.status }).where(eq(recurringInvoiceSchedules.id, s.id));
  }
  return created;
}
