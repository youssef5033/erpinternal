import { index, integer, pgTable, primaryKey, text, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { day, pk, timestamps, ts } from "./_helpers";
import { user } from "./auth";
import { accounts, opportunities, proposals } from "./crm";
import { contracts, deliverables, engagements } from "./delivery";
import { people } from "./people";

export type DocumentType =
  | "proposal"
  | "contract"
  | "sow"
  | "legal"
  | "client_file"
  | "invoice_pdf"
  | "credit_note_pdf"
  | "receipt"
  | "bill"
  | "deliverable"
  | "brand_asset"
  | "employment"
  | "tax"
  | "evidence"
  | "other";

/**
 * Visibility controls who may download a file (enforced server-side on every download):
 *  - internal: anyone with documents.read for the linked record
 *  - finance: requires finance.read
 *  - hr_private: requires people.private (Finance does NOT get this automatically)
 *  - restricted: only owner, admins and explicit grants (`document_access`)
 */
export type DocumentVisibility = "internal" | "finance" | "hr_private" | "restricted";

export const documents = pgTable(
  "documents",
  {
    id: pk(),
    title: text("title").notNull(),
    docType: text("doc_type").$type<DocumentType>().notNull(),
    visibility: text("visibility").$type<DocumentVisibility>().notNull().default("internal"),
    storageKey: text("storage_key").notNull().unique(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    sha256: text("sha256").notNull(),
    versionNumber: integer("version_number").notNull().default(1),
    previousVersionId: uuid("previous_version_id").references((): AnyPgColumn => documents.id),
    isLatest: integer("is_latest").notNull().default(1),
    approvalStatus: text("approval_status").$type<"none" | "pending" | "approved" | "rejected">().notNull().default("none"),
    expiresAt: day("expires_at"),
    accountId: uuid("account_id").references(() => accounts.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    proposalId: uuid("proposal_id").references(() => proposals.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    contractId: uuid("contract_id").references(() => contracts.id),
    deliverableId: uuid("deliverable_id").references(() => deliverables.id),
    personId: uuid("person_id").references(() => people.id),
    invoiceId: uuid("invoice_id"),
    creditNoteId: uuid("credit_note_id"),
    billId: uuid("bill_id"),
    expenseId: uuid("expense_id"),
    paymentId: uuid("payment_id"),
    supplierId: uuid("supplier_id"),
    ownerId: text("owner_id").references(() => user.id),
    uploadedBy: text("uploaded_by").references(() => user.id),
    description: text("description"),
    archivedAt: ts("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("documents_account_idx").on(t.accountId),
    index("documents_engagement_idx").on(t.engagementId),
    index("documents_type_idx").on(t.docType),
    index("documents_person_idx").on(t.personId),
  ],
);

/** Explicit per-user grants (e.g. a contractor given a specific brief). */
export const documentAccess = pgTable(
  "document_access",
  {
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    grantedBy: text("granted_by").references(() => user.id),
    grantedAt: ts("granted_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.documentId, t.userId] })],
);
