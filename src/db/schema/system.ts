import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { currency, day, money, pk, timestamps, ts } from "./_helpers";
import { user } from "./auth";

/** Single-row agency configuration. */
export const organizationSettings = pgTable("organization_settings", {
  id: smallint("id").primaryKey().default(1),
  agencyName: text("agency_name").notNull().default("Your Agency"),
  legalName: text("legal_name"),
  address: text("address"),
  email: text("email"),
  phone: text("phone"),
  website: text("website"),
  taxIdentifier: text("tax_identifier"),
  taxIdentifierLabel: text("tax_identifier_label").default("Tax ID"),
  baseCurrency: currency("base_currency").notNull().default("USD"),
  fiscalYearStartMonth: smallint("fiscal_year_start_month").notNull().default(1),
  timeZone: text("time_zone").notNull().default("UTC"),
  dateFormat: text("date_format").notNull().default("dd MMM yyyy"),
  brandColor: text("brand_color").default("#1f4b45"),
  invoicePrefix: text("invoice_prefix").notNull().default("INV-"),
  creditNotePrefix: text("credit_note_prefix").notNull().default("CN-"),
  defaultPaymentTermsDays: integer("default_payment_terms_days").notNull().default(14),
  invoiceFooter: text("invoice_footer"),
  bankDetails: text("bank_details"),
  minimumCashThreshold: money("minimum_cash_threshold"),
  expenseApprovalThreshold: money("expense_approval_threshold"),
  staleOpportunityDays: integer("stale_opportunity_days").notNull().default(21),
  renewalLeadDays: integer("renewal_lead_days").notNull().default(45),
  missingTimeLookbackDays: integer("missing_time_lookback_days").notNull().default(5),
  openingBalancesCompletedAt: ts("opening_balances_completed_at"),
  taxSetupCompletedAt: ts("tax_setup_completed_at"),
  notificationSettings: jsonb("notification_settings").$type<Record<string, boolean>>().default({}),
  updatedAt: timestamps.updatedAt,
});

export const roles = pgTable("roles", {
  id: pk(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  isSystem: boolean("is_system").notNull().default(false),
  ...timestamps,
});

/**
 * A permission is `module.action` (see src/server/auth/permissions.ts).
 * Scope "all" grants the action on every record; "assigned" only on records
 * the user owns or is explicitly assigned to.
 */
export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text("permission").notNull(),
    scope: text("scope").$type<"all" | "assigned">().notNull().default("all"),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] })],
);

export const userRoles = pgTable(
  "user_roles",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    roleId: uuid("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    grantedAt: ts("granted_at").defaultNow().notNull(),
    grantedBy: text("granted_by").references(() => user.id),
  },
  (t) => [primaryKey({ columns: [t.userId, t.roleId] })],
);

/** Append-only audit trail of material changes. Never contains secrets. */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: pk(),
    actorId: text("actor_id").references(() => user.id),
    actorLabel: text("actor_label").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    summary: text("summary").notNull(),
    changes: jsonb("changes").$type<Record<string, { from: unknown; to: unknown }> | Record<string, unknown>>(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("audit_entity_idx").on(t.entityType, t.entityId),
    index("audit_created_idx").on(t.createdAt),
    index("audit_actor_idx").on(t.actorId),
  ],
);

export type IntegrationKind = "email" | "calendar" | "accounting" | "banking" | "automation" | "ai";
export type IntegrationStatus = "not_configured" | "pending_verification" | "connected" | "error" | "disabled";

/**
 * Integration status is only "connected" after a verification call succeeds.
 * Credentials are encrypted server-side (AES-256-GCM) and never sent to the browser.
 */
export const integrations = pgTable(
  "integrations",
  {
    id: pk(),
    kind: text("kind").$type<IntegrationKind>().notNull(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status").$type<IntegrationStatus>().notNull().default("not_configured"),
    settings: jsonb("settings").$type<Record<string, unknown>>().default({}),
    encryptedCredentials: text("encrypted_credentials"),
    credentialHint: text("credential_hint"),
    sendingAuthorized: boolean("sending_authorized").notNull().default(false),
    sendingAuthorizedBy: text("sending_authorized_by").references(() => user.id),
    verifiedAt: ts("verified_at"),
    lastSuccessAt: ts("last_success_at"),
    lastErrorAt: ts("last_error_at"),
    lastError: text("last_error"),
    configuredBy: text("configured_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("integration_kind_provider_uq").on(t.kind, t.provider)],
);

export const integrationSyncRuns = pgTable(
  "integration_sync_runs",
  {
    id: pk(),
    integrationId: uuid("integration_id")
      .notNull()
      .references(() => integrations.id, { onDelete: "cascade" }),
    operation: text("operation").notNull(),
    status: text("status").$type<"running" | "succeeded" | "failed">().notNull(),
    startedAt: ts("started_at").defaultNow().notNull(),
    finishedAt: ts("finished_at"),
    itemsProcessed: integer("items_processed").default(0),
    error: text("error"),
    triggeredBy: text("triggered_by").references(() => user.id),
  },
  (t) => [index("sync_runs_integration_idx").on(t.integrationId, t.startedAt)],
);

/**
 * Durable record of background job executions. `idempotencyKey` is unique so a
 * retried job for the same logical unit of work cannot run its effect twice.
 */
export const jobRuns = pgTable(
  "job_runs",
  {
    id: pk(),
    jobName: text("job_name").notNull(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    status: text("status").$type<"running" | "succeeded" | "failed" | "skipped">().notNull(),
    attempts: integer("attempts").notNull().default(1),
    startedAt: ts("started_at").defaultNow().notNull(),
    finishedAt: ts("finished_at"),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    triggeredBy: text("triggered_by"),
  },
  (t) => [index("job_runs_name_idx").on(t.jobName, t.startedAt)],
);

export const importBatches = pgTable("import_batches", {
  id: pk(),
  kind: text("kind").$type<"leads" | "bank_transactions" | "contacts">().notNull(),
  fileName: text("file_name").notNull(),
  status: text("status").$type<"uploaded" | "mapped" | "validated" | "committed" | "failed" | "cancelled">().notNull(),
  mapping: jsonb("mapping").$type<Record<string, string>>(),
  headers: jsonb("headers").$type<string[]>(),
  context: jsonb("context").$type<Record<string, unknown>>(),
  totalRows: integer("total_rows").notNull().default(0),
  validRows: integer("valid_rows").notNull().default(0),
  errorRows: integer("error_rows").notNull().default(0),
  duplicateRows: integer("duplicate_rows").notNull().default(0),
  importedRows: integer("imported_rows").notNull().default(0),
  error: text("error"),
  createdBy: text("created_by").references(() => user.id),
  committedAt: ts("committed_at"),
  ...timestamps,
});

export const importRows = pgTable(
  "import_rows",
  {
    id: pk(),
    batchId: uuid("batch_id")
      .notNull()
      .references(() => importBatches.id, { onDelete: "cascade" }),
    rowNumber: integer("row_number").notNull(),
    raw: jsonb("raw").$type<Record<string, string>>().notNull(),
    normalized: jsonb("normalized").$type<Record<string, unknown>>(),
    errors: jsonb("errors").$type<string[]>().default([]),
    duplicates: jsonb("duplicates").$type<{ type: string; id: string; label: string; reason: string }[]>().default([]),
    decision: text("decision").$type<"import" | "skip" | "merge">().notNull().default("import"),
    mergeTargetId: text("merge_target_id"),
    resultEntityId: text("result_entity_id"),
  },
  (t) => [uniqueIndex("import_rows_batch_row_uq").on(t.batchId, t.rowNumber)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    href: text("href"),
    dedupeKey: text("dedupe_key"),
    readAt: ts("read_at"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("notifications_user_idx").on(t.userId, t.readAt),
    uniqueIndex("notifications_dedupe_uq").on(t.userId, t.dedupeKey),
  ],
);

export const savedViews = pgTable("saved_views", {
  id: pk(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  module: text("module").notNull(),
  name: text("name").notNull(),
  query: text("query").notNull(),
  shared: boolean("shared").notNull().default(false),
  ...timestamps,
});

/** Configurable fields; values live in each entity's `customFields` jsonb column. */
export const customFieldDefinitions = pgTable(
  "custom_field_definitions",
  {
    id: pk(),
    entityType: text("entity_type").$type<"lead" | "account" | "contact" | "opportunity" | "engagement">().notNull(),
    key: text("key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type").$type<"text" | "number" | "date" | "select" | "boolean" | "url">().notNull(),
    options: jsonb("options").$type<string[]>(),
    required: boolean("required").notNull().default(false),
    sortOrder: integer("sort_order").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("custom_field_entity_key_uq").on(t.entityType, t.key)],
);

/** Duplicate-submission protection for create/financial actions. */
export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").primaryKey(),
  userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
  action: text("action").notNull(),
  resultRef: text("result_ref"),
  createdAt: ts("created_at").defaultNow().notNull(),
});

/** Number sequences (invoices, credit notes, opportunities…). Incremented under row lock. */
export const numberSequences = pgTable("number_sequences", {
  key: text("key").primaryKey(),
  prefix: text("prefix").notNull().default(""),
  nextValue: integer("next_value").notNull().default(1),
  padding: smallint("padding").notNull().default(4),
});

/** Optional AI suggestion log: every suggestion is labelled, editable and cites sources. */
export const aiSuggestions = pgTable(
  "ai_suggestions",
  {
    id: pk(),
    kind: text("kind").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    provider: text("provider").notNull(),
    model: text("model"),
    prompt: text("prompt"),
    output: text("output").notNull(),
    sourceRefs: jsonb("source_refs").$type<{ type: string; id: string; label: string }[]>().default([]),
    status: text("status").$type<"suggested" | "accepted" | "edited" | "discarded">().notNull().default("suggested"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("ai_suggestions_entity_idx").on(t.entityType, t.entityId)],
);

export const exchangeRates = pgTable(
  "exchange_rates",
  {
    id: pk(),
    rateDate: day("rate_date").notNull(),
    fromCurrency: currency("from_currency").notNull(),
    toCurrency: currency("to_currency").notNull(),
    rate: numeric("rate", { precision: 20, scale: 10 }).notNull(),
    source: text("source").notNull().default("manual"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("fx_date_pair_uq").on(t.rateDate, t.fromCurrency, t.toCurrency)],
);
