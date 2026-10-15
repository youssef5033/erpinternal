import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { currency, day, decimal4, fxRate, money, pk, timestamps, ts } from "./_helpers";
import { user } from "./auth";
import { offers, services } from "./catalog";
import { accounts, contacts, proposalVersions } from "./crm";
import { engagements, milestones, projects, servicePeriods } from "./delivery";
import { people } from "./people";
import { importBatches } from "./system";

/* ------------------------------------------------------------------ */
/* Chart of accounts & journals                                         */
/* ------------------------------------------------------------------ */

export type LedgerType = "asset" | "liability" | "equity" | "income" | "expense";

export const ledgerAccounts = pgTable(
  "ledger_accounts",
  {
    id: pk(),
    code: text("code").notNull().unique(),
    name: text("name").notNull(),
    type: text("type").$type<LedgerType>().notNull(),
    /** e.g. bank, receivable, payable, tax, deferred_revenue, revenue, direct_cost, overhead, equity */
    subtype: text("subtype").notNull(),
    /** Stable key used by posting rules (e.g. "accounts_receivable"). */
    systemKey: text("system_key").unique(),
    /** Expense accounts: direct cost (counts in gross margin) vs overhead. */
    isDirectCost: boolean("is_direct_cost").notNull().default(false),
    serviceId: uuid("service_id").references(() => services.id),
    parentId: uuid("parent_id").references((): AnyPgColumn => ledgerAccounts.id),
    description: text("description"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("ledger_accounts_type_idx").on(t.type)],
);

export const accountingPeriods = pgTable(
  "accounting_periods",
  {
    id: pk(),
    periodStart: day("period_start").notNull(),
    periodEnd: day("period_end").notNull(),
    status: text("status").$type<"open" | "locked">().notNull().default("open"),
    lockedBy: text("locked_by").references(() => user.id),
    lockedAt: ts("locked_at"),
    note: text("note"),
  },
  (t) => [uniqueIndex("accounting_period_start_uq").on(t.periodStart)],
);

export type JournalSource =
  | "invoice"
  | "credit_note"
  | "customer_payment"
  | "payment_allocation"
  | "bill"
  | "supplier_payment"
  | "expense"
  | "expense_reimbursement"
  | "bank_transfer"
  | "bank_transaction"
  | "revenue_recognition"
  | "opening_balance"
  | "manual"
  | "reversal";

/**
 * Posted journal entries only — drafts never create entries.
 * - `postingKey` is unique: the same source event can never post twice.
 * - Database triggers (drizzle/0001_ledger_guards.sql) reject UPDATE/DELETE of
 *   posted lines and require debits = credits per entry at commit time.
 * - Corrections are linked reversals (`reversalOfId`).
 */
export const journalEntries = pgTable(
  "journal_entries",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    entryDate: day("entry_date").notNull(),
    memo: text("memo").notNull(),
    sourceType: text("source_type").$type<JournalSource>().notNull(),
    sourceId: text("source_id"),
    postingKey: text("posting_key").notNull().unique(),
    reversalOfId: uuid("reversal_of_id").references((): AnyPgColumn => journalEntries.id),
    reversedById: uuid("reversed_by_id"),
    baseCurrency: currency("base_currency").notNull(),
    createdBy: text("created_by").references(() => user.id),
    postedAt: ts("posted_at").defaultNow().notNull(),
  },
  (t) => [
    index("journal_entries_date_idx").on(t.entryDate),
    index("journal_entries_source_idx").on(t.sourceType, t.sourceId),
  ],
);

export const journalLines = pgTable(
  "journal_lines",
  {
    id: pk(),
    entryId: uuid("entry_id")
      .notNull()
      .references(() => journalEntries.id),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    /** Base-currency amounts. Exactly one of debit/credit is non-zero. */
    debit: money("debit").notNull().default("0"),
    credit: money("credit").notNull().default("0"),
    /** Original transaction currency and signed amount (+debit / −credit). */
    txnCurrency: currency("txn_currency").notNull(),
    txnAmount: money("txn_amount").notNull(),
    exchangeRate: fxRate("exchange_rate"),
    description: text("description"),
    accountId: uuid("account_id").references(() => accounts.id),
    supplierId: uuid("supplier_id"),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    serviceId: uuid("service_id").references(() => services.id),
    lineOrder: integer("line_order").notNull().default(0),
  },
  (t) => [
    index("journal_lines_entry_idx").on(t.entryId),
    index("journal_lines_account_idx").on(t.ledgerAccountId),
    index("journal_lines_engagement_idx").on(t.engagementId),
  ],
);

/* ------------------------------------------------------------------ */
/* Tax (configurable; no jurisdiction assumed)                          */
/* ------------------------------------------------------------------ */

export const taxRates = pgTable("tax_rates", {
  id: pk(),
  name: text("name").notNull(),
  ratePercent: decimal4("rate_percent").notNull(),
  treatment: text("treatment")
    .$type<"standard" | "reduced" | "zero_rated" | "exempt" | "reverse_charge" | "out_of_scope">()
    .notNull(),
  appliesTo: text("applies_to").$type<"sales" | "purchases" | "both">().notNull().default("both"),
  description: text("description"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

/** Internal management records of filing periods — not an official filing integration. */
export const taxFilingPeriods = pgTable("tax_filing_periods", {
  id: pk(),
  name: text("name").notNull(),
  taxType: text("tax_type").notNull(),
  periodStart: day("period_start").notNull(),
  periodEnd: day("period_end").notNull(),
  dueDate: day("due_date").notNull(),
  status: text("status")
    .$type<"open" | "in_preparation" | "filed_externally" | "not_required">()
    .notNull()
    .default("open"),
  filedReference: text("filed_reference"),
  notes: text("notes"),
  ownerId: text("owner_id").references(() => user.id),
  ...timestamps,
});

/* ------------------------------------------------------------------ */
/* Receivables                                                          */
/* ------------------------------------------------------------------ */

/**
 * Lifecycle status is stored (draft/issued/void). Payment status (unpaid,
 * partially paid, paid, overdue) is ALWAYS derived from allocations and
 * credit notes — see src/server/finance/invoices.ts `invoiceBalance`.
 */
export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    number: text("number").unique(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    billingContactId: uuid("billing_contact_id").references(() => contacts.id),
    status: text("status").$type<"draft" | "issued" | "void">().notNull().default("draft"),
    issueDate: day("issue_date"),
    dueDate: day("due_date"),
    paymentTermsDays: integer("payment_terms_days").notNull().default(14),
    currency: currency().notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    subtotal: money("subtotal").notNull().default("0"),
    discountTotal: money("discount_total").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    /** deferred: credit deferred revenue, recognised per engagement method; on_issue: revenue at issue. */
    revenueTreatment: text("revenue_treatment").$type<"deferred" | "on_issue">().notNull().default("deferred"),
    isDeposit: boolean("is_deposit").notNull().default(false),
    milestoneId: uuid("milestone_id").references(() => milestones.id),
    servicePeriodId: uuid("service_period_id").references(() => servicePeriods.id),
    recurringScheduleId: uuid("recurring_schedule_id"),
    /** Idempotency key for generated invoices (recurring runs, billing schedule). */
    generationKey: text("generation_key").unique(),
    reference: text("reference"),
    notes: text("notes"),
    terms: text("terms"),
    issuedAt: ts("issued_at"),
    issuedBy: text("issued_by").references(() => user.id),
    voidedAt: ts("voided_at"),
    voidedBy: text("voided_by").references(() => user.id),
    voidReason: text("void_reason"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    /** Snapshot of issued content: issued invoices are immutable. */
    issuedSnapshot: jsonb("issued_snapshot").$type<Record<string, unknown>>(),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [
    index("invoices_account_idx").on(t.accountId),
    index("invoices_engagement_idx").on(t.engagementId),
    index("invoices_status_due_idx").on(t.status, t.dueDate),
  ],
);

export const invoiceLines = pgTable(
  "invoice_lines",
  {
    id: pk(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    quantity: decimal4("quantity").notNull().default("1"),
    unitPrice: money("unit_price").notNull(),
    discountPercent: decimal4("discount_percent").notNull().default("0"),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    taxRatePercent: decimal4("tax_rate_percent").notNull().default("0"),
    lineSubtotal: money("line_subtotal").notNull(),
    lineDiscount: money("line_discount").notNull().default("0"),
    lineTax: money("line_tax").notNull().default("0"),
    lineTotal: money("line_total").notNull(),
    serviceId: uuid("service_id").references(() => services.id),
    offerId: uuid("offer_id").references(() => offers.id),
    revenueLedgerAccountId: uuid("revenue_ledger_account_id").references(() => ledgerAccounts.id),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("invoice_lines_invoice_idx").on(t.invoiceId)],
);

export const creditNotes = pgTable(
  "credit_notes",
  {
    id: pk(),
    number: text("number").unique(),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    issueDate: day("issue_date"),
    status: text("status").$type<"draft" | "issued" | "void">().notNull().default("draft"),
    currency: currency().notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    subtotal: money("subtotal").notNull(),
    taxTotal: money("tax_total").notNull(),
    total: money("total").notNull(),
    reason: text("reason").notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    issuedBy: text("issued_by").references(() => user.id),
    issuedAt: ts("issued_at"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [index("credit_notes_invoice_idx").on(t.invoiceId)],
);

export type RecurringLine = { description: string; quantity: string; unitPrice: string; taxRateId?: string | null; serviceId?: string | null };

/** Recurring invoice schedules. Each run uses generationKey `<scheduleId>:<periodStart>`. */
export const recurringInvoiceSchedules = pgTable("recurring_invoice_schedules", {
  id: pk(),
  name: text("name").notNull(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id),
  engagementId: uuid("engagement_id").references(() => engagements.id),
  frequency: text("frequency").$type<"monthly" | "quarterly" | "yearly">().notNull().default("monthly"),
  dayOfPeriod: integer("day_of_period").notNull().default(1),
  nextRunDate: day("next_run_date").notNull(),
  endDate: day("end_date"),
  currency: currency().notNull(),
  lines: jsonb("lines").$type<RecurringLine[]>().notNull(),
  paymentTermsDays: integer("payment_terms_days").notNull().default(14),
  autoIssue: boolean("auto_issue").notNull().default(false),
  status: text("status").$type<"active" | "paused" | "ended">().notNull().default("active"),
  lastRunAt: ts("last_run_at"),
  createdBy: text("created_by").references(() => user.id),
  ...timestamps,
});

/** Draft billing schedule produced by handover, change requests and renewals. */
export const billingScheduleItems = pgTable(
  "billing_schedule_items",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    plannedDate: day("planned_date"),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    milestoneId: uuid("milestone_id").references(() => milestones.id),
    servicePeriodId: uuid("service_period_id").references(() => servicePeriods.id),
    status: text("status").$type<"draft" | "planned" | "invoiced" | "cancelled">().notNull().default("draft"),
    invoiceId: uuid("invoice_id").references(() => invoices.id),
    source: text("source").$type<"handover" | "change_request" | "renewal" | "manual">().notNull(),
    sourceId: uuid("source_id"),
    sourceProposalVersionId: uuid("source_proposal_version_id").references(() => proposalVersions.id),
    isDeposit: boolean("is_deposit").notNull().default(false),
    generationKey: text("generation_key").unique(),
    ...timestamps,
  },
  (t) => [index("billing_schedule_engagement_idx").on(t.engagementId)],
);

/* ------------------------------------------------------------------ */
/* Payments & allocations                                               */
/* ------------------------------------------------------------------ */

export const bankAccounts = pgTable("bank_accounts", {
  id: pk(),
  name: text("name").notNull(),
  kind: text("kind").$type<"bank" | "cash" | "card" | "payment_processor">().notNull().default("bank"),
  institution: text("institution"),
  accountNumberLast4: text("account_number_last4"),
  currency: currency().notNull(),
  ledgerAccountId: uuid("ledger_account_id")
    .notNull()
    .unique()
    .references(() => ledgerAccounts.id),
  openingBalance: money("opening_balance"),
  openingBalanceDate: day("opening_balance_date"),
  openingJournalEntryId: uuid("opening_journal_entry_id").references(() => journalEntries.id),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const customerPayments = pgTable(
  "customer_payments",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    paymentDate: day("payment_date").notNull(),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    method: text("method").$type<"bank_transfer" | "card" | "cash" | "cheque" | "processor" | "other">().notNull(),
    reference: text("reference"),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    evidenceNote: text("evidence_note"),
    status: text("status").$type<"recorded" | "reversed">().notNull().default("recorded"),
    reversedAt: ts("reversed_at"),
    reversalReason: text("reversal_reason"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [index("customer_payments_account_idx").on(t.accountId)],
);

/** Unallocated = payment.amount − Σ active allocations (customer credit / overpayment). */
export const paymentAllocations = pgTable(
  "payment_allocations",
  {
    id: pk(),
    paymentId: uuid("payment_id")
      .notNull()
      .references(() => customerPayments.id),
    invoiceId: uuid("invoice_id")
      .notNull()
      .references(() => invoices.id),
    amount: money("amount").notNull(),
    allocationDate: day("allocation_date").notNull(),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    reversedAt: ts("reversed_at"),
    reversalJournalEntryId: uuid("reversal_journal_entry_id").references(() => journalEntries.id),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("allocations_invoice_idx").on(t.invoiceId), index("allocations_payment_idx").on(t.paymentId)],
);

/* ------------------------------------------------------------------ */
/* Suppliers, bills, expenses                                           */
/* ------------------------------------------------------------------ */

export const suppliers = pgTable("suppliers", {
  id: pk(),
  name: text("name").notNull(),
  supplierType: text("supplier_type").$type<"contractor" | "vendor" | "freelancer" | "agency">().notNull(),
  contactName: text("contact_name"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  taxIdentifier: text("tax_identifier"),
  paymentTermsDays: integer("payment_terms_days").notNull().default(30),
  defaultCurrency: currency("default_currency").notNull(),
  defaultExpenseLedgerAccountId: uuid("default_expense_ledger_account_id").references(() => ledgerAccounts.id),
  personId: uuid("person_id").references(() => people.id),
  bankDetails: text("bank_details"),
  notes: text("notes"),
  archivedAt: ts("archived_at"),
  ...timestamps,
});

export const supplierRates = pgTable("supplier_rates", {
  id: pk(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id, { onDelete: "cascade" }),
  description: text("description").notNull(),
  rate: money("rate").notNull(),
  unit: text("unit").$type<"hour" | "day" | "project" | "month" | "item">().notNull(),
  currency: currency().notNull(),
  effectiveFrom: day("effective_from").notNull(),
  ...timestamps,
});

export const bills = pgTable(
  "bills",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    supplierId: uuid("supplier_id")
      .notNull()
      .references(() => suppliers.id),
    supplierReference: text("supplier_reference"),
    billDate: day("bill_date").notNull(),
    dueDate: day("due_date").notNull(),
    currency: currency().notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    subtotal: money("subtotal").notNull().default("0"),
    taxTotal: money("tax_total").notNull().default("0"),
    total: money("total").notNull().default("0"),
    status: text("status").$type<"draft" | "awaiting_approval" | "approved" | "void">().notNull().default("draft"),
    description: text("description"),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    submittedBy: text("submitted_by").references(() => user.id),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: ts("approved_at"),
    voidReason: text("void_reason"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    ...timestamps,
  },
  (t) => [
    index("bills_supplier_idx").on(t.supplierId),
    index("bills_status_due_idx").on(t.status, t.dueDate),
    uniqueIndex("bills_supplier_ref_uq").on(t.supplierId, t.supplierReference).where(sql`supplier_reference is not null and status <> 'void'`),
  ],
);

export const billLines = pgTable(
  "bill_lines",
  {
    id: pk(),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    taxRatePercent: decimal4("tax_rate_percent").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    expenseLedgerAccountId: uuid("expense_ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    projectId: uuid("project_id").references(() => projects.id),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [index("bill_lines_bill_idx").on(t.billId), index("bill_lines_engagement_idx").on(t.engagementId)],
);

export const supplierPayments = pgTable("supplier_payments", {
  id: pk(),
  number: text("number").notNull().unique(),
  supplierId: uuid("supplier_id")
    .notNull()
    .references(() => suppliers.id),
  paymentDate: day("payment_date").notNull(),
  amount: money("amount").notNull(),
  currency: currency().notNull(),
  exchangeRate: fxRate("exchange_rate").notNull().default("1"),
  method: text("method").$type<"bank_transfer" | "card" | "cash" | "cheque" | "other">().notNull(),
  reference: text("reference"),
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  status: text("status").$type<"recorded" | "reversed">().notNull().default("recorded"),
  reversedAt: ts("reversed_at"),
  reversalReason: text("reversal_reason"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: text("created_by").references(() => user.id),
  ...timestamps,
});

export const supplierPaymentAllocations = pgTable(
  "supplier_payment_allocations",
  {
    id: pk(),
    supplierPaymentId: uuid("supplier_payment_id")
      .notNull()
      .references(() => supplierPayments.id),
    billId: uuid("bill_id")
      .notNull()
      .references(() => bills.id),
    amount: money("amount").notNull(),
    reversedAt: ts("reversed_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("supplier_alloc_bill_idx").on(t.billId)],
);

export const expenseCategories = pgTable("expense_categories", {
  id: pk(),
  name: text("name").notNull().unique(),
  ledgerAccountId: uuid("ledger_account_id")
    .notNull()
    .references(() => ledgerAccounts.id),
  approvalThreshold: money("approval_threshold"),
  active: boolean("active").notNull().default(true),
});

export const expenses = pgTable(
  "expenses",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    submittedBy: text("submitted_by").references(() => user.id),
    personId: uuid("person_id").references(() => people.id),
    supplierId: uuid("supplier_id").references(() => suppliers.id),
    expenseDate: day("expense_date").notNull(),
    description: text("description").notNull(),
    categoryId: uuid("category_id")
      .notNull()
      .references(() => expenseCategories.id),
    amount: money("amount").notNull(),
    taxAmount: money("tax_amount").notNull().default("0"),
    taxRateId: uuid("tax_rate_id").references(() => taxRates.id),
    currency: currency().notNull(),
    exchangeRate: fxRate("exchange_rate").notNull().default("1"),
    paidFrom: text("paid_from").$type<"company" | "personal">().notNull(),
    bankAccountId: uuid("bank_account_id").references(() => bankAccounts.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    isDirectCost: boolean("is_direct_cost").notNull().default(false),
    billableToClient: boolean("billable_to_client").notNull().default(false),
    status: text("status")
      .$type<"draft" | "submitted" | "approved" | "rejected" | "reimbursed">()
      .notNull()
      .default("submitted"),
    exceedsThreshold: boolean("exceeds_threshold").notNull().default(false),
    approverId: text("approver_id").references(() => user.id),
    approvedAt: ts("approved_at"),
    rejectionReason: text("rejection_reason"),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    reimbursementJournalEntryId: uuid("reimbursement_journal_entry_id").references(() => journalEntries.id),
    ...timestamps,
  },
  (t) => [index("expenses_status_idx").on(t.status), index("expenses_engagement_idx").on(t.engagementId)],
);

/* ------------------------------------------------------------------ */
/* Banking & reconciliation                                             */
/* ------------------------------------------------------------------ */

export type BankMatchType = "customer_payment" | "supplier_payment" | "expense" | "bank_transfer" | "journal" | "expense_reimbursement";

/**
 * Imported/manual statement lines. Matching links the line to an existing
 * record that already posted to the ledger — matching itself NEVER posts, so
 * nothing is double counted. Unique `fingerprint` blocks duplicate imports.
 */
export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: pk(),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id),
    txnDate: day("txn_date").notNull(),
    description: text("description").notNull(),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    reference: text("reference"),
    counterparty: text("counterparty"),
    fingerprint: text("fingerprint").notNull(),
    source: text("source").$type<"manual" | "csv" | "integration">().notNull(),
    importBatchId: uuid("import_batch_id").references(() => importBatches.id),
    status: text("status").$type<"unreconciled" | "matched" | "reconciled" | "excluded">().notNull().default("unreconciled"),
    matchType: text("match_type").$type<BankMatchType>(),
    matchId: uuid("match_id"),
    matchedBy: text("matched_by").references(() => user.id),
    matchedAt: ts("matched_at"),
    reconciliationId: uuid("reconciliation_id"),
    excludedReason: text("excluded_reason"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("bank_txn_fingerprint_uq").on(t.bankAccountId, t.fingerprint),
    uniqueIndex("bank_txn_match_uq").on(t.matchType, t.matchId).where(sql`match_id is not null`),
    index("bank_txn_status_idx").on(t.bankAccountId, t.status),
  ],
);

export const bankTransfers = pgTable("bank_transfers", {
  id: pk(),
  fromBankAccountId: uuid("from_bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  toBankAccountId: uuid("to_bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  transferDate: day("transfer_date").notNull(),
  amount: money("amount").notNull(),
  currency: currency().notNull(),
  memo: text("memo"),
  journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
  createdBy: text("created_by").references(() => user.id),
  ...timestamps,
});

export const reconciliations = pgTable("reconciliations", {
  id: pk(),
  bankAccountId: uuid("bank_account_id")
    .notNull()
    .references(() => bankAccounts.id),
  statementDate: day("statement_date").notNull(),
  statementBalance: money("statement_balance").notNull(),
  ledgerBalance: money("ledger_balance"),
  difference: money("difference"),
  status: text("status").$type<"in_progress" | "completed">().notNull().default("in_progress"),
  completedBy: text("completed_by").references(() => user.id),
  completedAt: ts("completed_at"),
  ...timestamps,
});

/* ------------------------------------------------------------------ */
/* Revenue recognition, budgets, forecasts                              */
/* ------------------------------------------------------------------ */

/** Auditable recognition postings; unique key per engagement+period/milestone. */
export const revenueRecognitions = pgTable(
  "revenue_recognitions",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id),
    recognitionKey: text("recognition_key").notNull().unique(),
    method: text("method").notNull(),
    periodStart: day("period_start"),
    periodEnd: day("period_end").notNull(),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    basis: text("basis").notNull(),
    milestoneId: uuid("milestone_id").references(() => milestones.id),
    servicePeriodId: uuid("service_period_id").references(() => servicePeriods.id),
    journalEntryId: uuid("journal_entry_id").references(() => journalEntries.id),
    status: text("status").$type<"posted" | "reversed">().notNull().default("posted"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("revrec_engagement_idx").on(t.engagementId)],
);

/** Company budgets by ledger account and month (budget vs actual). */
export const budgetLines = pgTable(
  "budget_lines",
  {
    id: pk(),
    fiscalYear: integer("fiscal_year").notNull(),
    month: integer("month").notNull(),
    ledgerAccountId: uuid("ledger_account_id")
      .notNull()
      .references(() => ledgerAccounts.id),
    amount: money("amount").notNull(),
    currency: currency().notNull(),
    note: text("note"),
    ...timestamps,
  },
  (t) => [uniqueIndex("budget_line_uq").on(t.fiscalYear, t.month, t.ledgerAccountId)],
);

/** Cash forecast scenario assumptions — kept separate from actual transactions. */
export const forecastScenarios = pgTable("forecast_scenarios", {
  id: pk(),
  key: text("key").$type<"base" | "conservative" | "upside">().notNull().unique(),
  name: text("name").notNull(),
  collectionDelayDays: integer("collection_delay_days").notNull().default(0),
  collectionRatePercent: integer("collection_rate_percent").notNull().default(100),
  pipelineInclusionPercent: integer("pipeline_inclusion_percent").notNull().default(0),
  expenseMultiplierPercent: integer("expense_multiplier_percent").notNull().default(100),
  notes: text("notes"),
  ...timestamps,
});

export const forecastAdjustments = pgTable("forecast_adjustments", {
  id: pk(),
  scenarioKey: text("scenario_key").$type<"base" | "conservative" | "upside" | "all">().notNull().default("all"),
  weekStart: day("week_start").notNull(),
  description: text("description").notNull(),
  amount: money("amount").notNull(),
  currency: currency().notNull(),
  direction: text("direction").$type<"inflow" | "outflow">().notNull(),
  recurring: text("recurring").$type<"none" | "weekly" | "monthly">().notNull().default("none"),
  createdBy: text("created_by").references(() => user.id),
  ...timestamps,
});
