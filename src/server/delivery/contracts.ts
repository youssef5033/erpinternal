import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { contracts, engagements } from "@/db/schema";
import { toMoney } from "@/lib/money";
import { can, type Actor } from "../auth/actor";
import { assertAccountAccess, assertEngagementAccess } from "../auth/scope";
import { audit, diff } from "../audit";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { nextNumber } from "../numbering";

export type ContractInput = {
  title: string;
  accountId: string;
  engagementId?: string | null;
  opportunityId?: string | null;
  contractType: "msa" | "sow" | "retainer" | "nda" | "change_order" | "other";
  startDate?: string | null;
  endDate?: string | null;
  noticePeriodDays?: number | null;
  autoRenew?: boolean;
  value?: string | null;
  currency?: string | null;
  ownerId?: string | null;
};

async function assertContractWrite(tx: Tx, actor: Actor, accountId: string, engagementId?: string | null) {
  if (!can(actor, "crm.write") && !can(actor, "delivery.write")) throw new ForbiddenError();
  if (engagementId && can(actor, "delivery.write")) await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  else await assertAccountAccess(tx, actor, accountId, can(actor, "crm.write") ? "crm.write" : "crm.read");
}

function values(input: ContractInput) {
  if (!input.title.trim()) throw new ValidationError("Title is required.");
  if (input.startDate && input.endDate && input.endDate < input.startDate) throw new ValidationError("End date is before start date.");
  if (input.value && !input.currency) throw new ValidationError("Choose the contract currency.", { currency: "Required" });
  return {
    title: input.title.trim(),
    accountId: input.accountId,
    engagementId: input.engagementId || null,
    opportunityId: input.opportunityId || null,
    contractType: input.contractType,
    startDate: input.startDate || null,
    endDate: input.endDate || null,
    noticePeriodDays: input.noticePeriodDays ?? null,
    autoRenew: input.autoRenew ?? false,
    value: input.value ? toMoney(input.value) : null,
    currency: input.currency?.toUpperCase() || null,
    ownerId: input.ownerId || null,
  };
}

export async function saveContract(tx: Tx, actor: Actor, input: ContractInput & { id?: string | null }) {
  if (input.engagementId) {
    const [eng] = await tx.select({ accountId: engagements.accountId }).from(engagements).where(eq(engagements.id, input.engagementId));
    if (!eng) throw new NotFoundError("Engagement");
    if (eng.accountId !== input.accountId) throw new ValidationError("The engagement belongs to a different account.");
  }
  await assertContractWrite(tx, actor, input.accountId, input.engagementId);
  const v = values(input);
  if (input.id) {
    const [before] = await tx.select().from(contracts).where(eq(contracts.id, input.id)).for("update");
    if (!before) throw new NotFoundError("Contract");
    if (["signed", "active"].includes(before.status) && (before.value !== v.value || before.startDate !== v.startDate || before.endDate !== v.endDate)) {
      throw new ValidationError("A signed contract's value and term cannot be edited. Record a change order or amendment instead.");
    }
    const [row] = await tx.update(contracts).set(v).where(eq(contracts.id, input.id)).returning();
    await audit(tx, actor, { action: "contract.updated", entityType: "contract", entityId: row.id, summary: `Updated ${row.number}`, changes: diff(before, row) });
    return row;
  }
  const number = await nextNumber(tx, "contract");
  const [row] = await tx.insert(contracts).values({ ...v, number, status: "draft" }).returning();
  await audit(tx, actor, { action: "contract.created", entityType: "contract", entityId: row.id, summary: `${row.number} ${row.title}` });
  return row;
}

/**
 * Status changes. "Signed" requires recorded evidence; without a verified
 * e-signature integration the method is a signed document or a manual record.
 */
export async function setContractStatus(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { status: "sent" | "signed" | "active" | "expired" | "terminated"; signedAt?: string | null; signatureMethod?: "manual_record" | "signed_document" | null; signatureEvidence?: string | null; note?: string | null },
) {
  const [c] = await tx.select().from(contracts).where(eq(contracts.id, id)).for("update");
  if (!c) throw new NotFoundError("Contract");
  await assertContractWrite(tx, actor, c.accountId, c.engagementId);
  const allowed: Record<string, string[]> = { draft: ["sent", "signed"], sent: ["signed", "terminated"], signed: ["active", "expired", "terminated"], active: ["expired", "terminated"], expired: [], terminated: [] };
  if (!allowed[c.status]?.includes(input.status)) throw new ValidationError(`A ${c.status} contract cannot move to ${input.status}.`);
  const patch: Partial<typeof contracts.$inferInsert> = { status: input.status };
  if (input.status === "signed") {
    if (!input.signedAt) throw new ValidationError("Enter the signature date.", { signedAt: "Required" });
    if (!input.signatureEvidence?.trim()) throw new ValidationError("Record the signature evidence (e.g. countersigned PDF uploaded, email from …).", { signatureEvidence: "Required" });
    patch.signedAt = input.signedAt;
    patch.signatureMethod = input.signatureMethod ?? "manual_record";
    patch.signatureEvidence = input.signatureEvidence.trim();
  }
  await tx.update(contracts).set(patch).where(eq(contracts.id, id));
  await audit(tx, actor, { action: `contract.${input.status}`, entityType: "contract", entityId: id, summary: `${c.number} → ${input.status}${input.note ? ` (${input.note})` : ""}` });
}
