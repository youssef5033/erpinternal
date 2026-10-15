import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { documentAccess, documents, type DocumentType, type DocumentVisibility } from "@/db/schema";
import { can, type Actor } from "./auth/actor";
import { documentVisibility } from "./auth/scope";
import { audit } from "./audit";
import { ForbiddenError, NotFoundError, ValidationError } from "./errors";
import { newStorageKey, storage, validateUpload } from "./storage";

export type DocumentLinks = {
  accountId?: string | null;
  opportunityId?: string | null;
  proposalId?: string | null;
  engagementId?: string | null;
  contractId?: string | null;
  deliverableId?: string | null;
  personId?: string | null;
  invoiceId?: string | null;
  creditNoteId?: string | null;
  billId?: string | null;
  expenseId?: string | null;
  paymentId?: string | null;
  supplierId?: string | null;
};

export type UploadInput = DocumentLinks & {
  title: string;
  docType: DocumentType;
  visibility?: DocumentVisibility;
  fileName: string;
  declaredType: string;
  buffer: Buffer;
  expiresAt?: string | null;
  description?: string | null;
  approvalStatus?: "none" | "pending" | "approved" | "rejected";
  /** Upload as a new version of an existing document. */
  previousVersionId?: string | null;
};

function assertVisibilityAllowed(actor: Actor, visibility: DocumentVisibility) {
  if (visibility === "hr_private" && !can(actor, "people.private")) throw new ForbiddenError("Only HR administrators can store private employment documents.");
  if (visibility === "finance" && !can(actor, "finance.read")) throw new ForbiddenError("You cannot create finance-restricted documents.");
}

/**
 * Store a validated file in private storage and register it. The file is
 * written before the DB row; if the transaction fails the orphaned object is
 * removed.
 */
export async function uploadDocument(tx: Tx, actor: Actor, input: UploadInput, opts: { skipPermission?: boolean } = {}) {
  if (!opts.skipPermission && !can(actor, "documents.write") && !can(actor, "delivery.write") && !can(actor, "finance.write") && !can(actor, "people.write")) {
    throw new ForbiddenError();
  }
  if (!input.title.trim()) throw new ValidationError("Title is required.");
  const visibility = input.visibility ?? defaultVisibility(input.docType);
  if (!opts.skipPermission) assertVisibilityAllowed(actor, visibility);
  const file = validateUpload(input.fileName, input.declaredType, input.buffer);
  let versionNumber = 1;
  let prev: typeof documents.$inferSelect | undefined;
  if (input.previousVersionId) {
    [prev] = await tx.select().from(documents).where(eq(documents.id, input.previousVersionId)).for("update");
    if (!prev) throw new NotFoundError("Document");
    versionNumber = prev.versionNumber + 1;
  }
  const key = newStorageKey(input.docType, file.fileName);
  await storage().put(key, file.buffer, file.mimeType);
  try {
    if (prev) await tx.update(documents).set({ isLatest: 0 }).where(eq(documents.id, prev.id));
    const links = prev
      ? {
          accountId: prev.accountId, opportunityId: prev.opportunityId, proposalId: prev.proposalId, engagementId: prev.engagementId,
          contractId: prev.contractId, deliverableId: prev.deliverableId, personId: prev.personId, invoiceId: prev.invoiceId,
          creditNoteId: prev.creditNoteId, billId: prev.billId, expenseId: prev.expenseId, paymentId: prev.paymentId, supplierId: prev.supplierId,
        }
      : pickLinks(input);
    const [row] = await tx
      .insert(documents)
      .values({
        title: input.title.trim(),
        docType: prev?.docType ?? input.docType,
        visibility: prev?.visibility ?? visibility,
        storageKey: key,
        fileName: file.fileName,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        versionNumber,
        previousVersionId: prev?.id ?? null,
        isLatest: 1,
        approvalStatus: input.approvalStatus ?? "none",
        expiresAt: input.expiresAt || null,
        description: input.description || null,
        ownerId: actor.userId || null,
        uploadedBy: actor.userId || null,
        ...links,
      })
      .returning();
    await audit(tx, actor, { action: prev ? "document.versioned" : "document.uploaded", entityType: "document", entityId: row.id, summary: `${row.title} v${row.versionNumber} (${row.fileName})` });
    return row;
  } catch (err) {
    await storage().remove(key);
    throw err;
  }
}

function pickLinks(input: DocumentLinks) {
  const keys: (keyof DocumentLinks)[] = ["accountId", "opportunityId", "proposalId", "engagementId", "contractId", "deliverableId", "personId", "invoiceId", "creditNoteId", "billId", "expenseId", "paymentId", "supplierId"];
  return Object.fromEntries(keys.map((k) => [k, input[k] || null]));
}

export function defaultVisibility(t: DocumentType): DocumentVisibility {
  if (t === "employment") return "hr_private";
  if (t === "invoice_pdf" || t === "credit_note_pdf" || t === "receipt" || t === "bill" || t === "tax") return "finance";
  return "internal";
}

/** Store a server-generated file (e.g. invoice/proposal PDF) bypassing upload sniffing rules. */
export async function storeGeneratedDocument(tx: Tx, actor: Actor, input: DocumentLinks & { title: string; docType: DocumentType; fileName: string; mimeType: string; buffer: Buffer; visibility?: DocumentVisibility; previousVersionId?: string | null }) {
  return uploadDocument(tx, actor, { ...input, declaredType: input.mimeType }, { skipPermission: true });
}

/** Load a document for download, enforcing visibility/grants. */
export async function authorizeDocumentDownload(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.select().from(documents).where(and(eq(documents.id, id), documentVisibility(actor)));
  if (!row) {
    const [exists] = await tx.select({ id: documents.id }).from(documents).where(eq(documents.id, id));
    if (!exists) throw new NotFoundError("Document");
    throw new ForbiddenError("You do not have access to this file.");
  }
  return row;
}

export async function readDocumentBytes(doc: { storageKey: string }) {
  return storage().get(doc.storageKey);
}

export async function grantDocumentAccess(tx: Tx, actor: Actor, documentId: string, userId: string) {
  const doc = await authorizeDocumentDownload(tx, actor, documentId);
  if (!can(actor, "documents.write")) throw new ForbiddenError();
  await tx.insert(documentAccess).values({ documentId, userId, grantedBy: actor.userId || null }).onConflictDoNothing();
  await audit(tx, actor, { action: "document.access_granted", entityType: "document", entityId: documentId, summary: `Access to ${doc.title} granted`, changes: { userId } });
}

export async function revokeDocumentAccess(tx: Tx, actor: Actor, documentId: string, userId: string) {
  if (!can(actor, "documents.write")) throw new ForbiddenError();
  await tx.delete(documentAccess).where(and(eq(documentAccess.documentId, documentId), eq(documentAccess.userId, userId)));
  await audit(tx, actor, { action: "document.access_revoked", entityType: "document", entityId: documentId, summary: `Access revoked`, changes: { userId } });
}

export async function updateDocumentMeta(tx: Tx, actor: Actor, id: string, input: { title?: string; expiresAt?: string | null; approvalStatus?: "none" | "pending" | "approved" | "rejected"; visibility?: DocumentVisibility }) {
  const doc = await authorizeDocumentDownload(tx, actor, id);
  if (!can(actor, "documents.write")) throw new ForbiddenError();
  if (input.visibility) assertVisibilityAllowed(actor, input.visibility);
  await tx
    .update(documents)
    .set({ title: input.title ?? doc.title, expiresAt: input.expiresAt === undefined ? doc.expiresAt : input.expiresAt, approvalStatus: input.approvalStatus ?? doc.approvalStatus, visibility: input.visibility ?? doc.visibility })
    .where(eq(documents.id, id));
  await audit(tx, actor, { action: "document.updated", entityType: "document", entityId: id, summary: `Updated ${doc.title}`, changes: input });
}

export async function archiveDocument(tx: Tx, actor: Actor, id: string) {
  const doc = await authorizeDocumentDownload(tx, actor, id);
  if (!can(actor, "documents.write")) throw new ForbiddenError();
  if (doc.docType === "invoice_pdf" || doc.docType === "credit_note_pdf") throw new ValidationError("Financial documents cannot be archived.");
  await tx.update(documents).set({ archivedAt: new Date() }).where(eq(documents.id, id));
  await audit(tx, actor, { action: "document.archived", entityType: "document", entityId: id, summary: `Archived ${doc.title}` });
}
