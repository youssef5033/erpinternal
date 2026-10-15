import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { currency, day, decimal4, money, pk, timestamps, ts } from "./_helpers";
import { user } from "./auth";
import { offers, services, type PricingModel } from "./catalog";
import { engagements } from "./delivery";

/* ------------------------------------------------------------------ */
/* Accounts & contacts — the single shared customer identity.          */
/* ------------------------------------------------------------------ */

export type AccountLifecycle = "prospect" | "onboarding" | "active" | "former" | "partner";

export const accounts = pgTable(
  "accounts",
  {
    id: pk(),
    name: text("name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    domain: text("domain"),
    industry: text("industry"),
    country: text("country"),
    region: text("region"),
    city: text("city"),
    sizeBand: text("size_band"),
    description: text("description"),
    lifecycleStatus: text("lifecycle_status").$type<AccountLifecycle>().notNull().default("prospect"),
    ownerId: text("owner_id").references(() => user.id),
    phone: text("phone"),
    // Billing details
    billingEmail: text("billing_email"),
    billingAddress: text("billing_address"),
    billingContactName: text("billing_contact_name"),
    taxIdentifier: text("tax_identifier"),
    paymentTermsDays: integer("payment_terms_days"),
    defaultCurrency: currency("default_currency"),
    // First-touch acquisition attribution (preserved; "unknown" stays null)
    acquisitionChannel: text("acquisition_channel"),
    acquisitionCampaignId: uuid("acquisition_campaign_id"),
    acquisitionDetail: text("acquisition_detail"),
    acquiredAt: day("acquired_at"),
    sourceLeadId: uuid("source_lead_id"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: ts("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("accounts_normalized_name_idx").on(t.normalizedName),
    index("accounts_domain_idx").on(t.domain),
    index("accounts_owner_idx").on(t.ownerId),
    index("accounts_lifecycle_idx").on(t.lifecycleStatus),
  ],
);

/** Manual overrides of account health are logged, never silent. */
export const accountHealthOverrides = pgTable("account_health_overrides", {
  id: pk(),
  accountId: uuid("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" }),
  score: integer("score").notNull(),
  reason: text("reason").notNull(),
  expiresAt: day("expires_at"),
  createdBy: text("created_by").references(() => user.id),
  createdAt: ts("created_at").defaultNow().notNull(),
  revokedAt: ts("revoked_at"),
});

export const contacts = pgTable(
  "contacts",
  {
    id: pk(),
    primaryAccountId: uuid("primary_account_id").references(() => accounts.id),
    firstName: text("first_name"),
    lastName: text("last_name"),
    fullName: text("full_name").notNull(),
    email: text("email"),
    normalizedEmail: text("normalized_email"),
    phone: text("phone"),
    jobTitle: text("job_title"),
    linkedinUrl: text("linkedin_url"),
    sourceUrl: text("source_url"),
    preferredChannel: text("preferred_channel").$type<"email" | "phone" | "linkedin" | "in_person" | "other">(),
    buyingRoles: text("buying_roles").array().notNull().default(sql`'{}'::text[]`),
    relationshipNotes: text("relationship_notes"),
    ownerId: text("owner_id").references(() => user.id),
    timeZone: text("time_zone"),
    // Opt-out and restrictions (authoritative suppression lives in `suppressions`)
    doNotContact: boolean("do_not_contact").notNull().default(false),
    optedOutAt: ts("opted_out_at"),
    contactRestrictions: text("contact_restrictions"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    sourceLeadId: uuid("source_lead_id"),
    archivedAt: ts("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("contacts_account_idx").on(t.primaryAccountId),
    index("contacts_email_idx").on(t.normalizedEmail),
  ],
);

/** Additional account relationships for a contact (e.g. advisor at a second company). */
export const contactAccountLinks = pgTable(
  "contact_account_links",
  {
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    relationship: text("relationship"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.contactId, t.accountId] })],
);

/**
 * Outreach suppression. A suppression on an email/domain/contact blocks every
 * outreach channel listed. Records are never deleted (lifted with `liftedAt`).
 */
export const suppressions = pgTable(
  "suppressions",
  {
    id: pk(),
    contactId: uuid("contact_id").references(() => contacts.id),
    leadContactId: uuid("lead_contact_id"),
    normalizedEmail: text("normalized_email"),
    domain: text("domain"),
    channel: text("channel").notNull().default("all"),
    reason: text("reason").$type<"opt_out" | "bounce" | "complaint" | "manual" | "legal">().notNull(),
    note: text("note"),
    source: text("source").$type<"manual" | "reply" | "import" | "integration">().notNull().default("manual"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
    liftedAt: ts("lifted_at"),
    liftedBy: text("lifted_by").references(() => user.id),
  },
  (t) => [
    index("suppressions_email_idx").on(t.normalizedEmail),
    index("suppressions_contact_idx").on(t.contactId),
  ],
);

/* ------------------------------------------------------------------ */
/* Leads — prospect research and qualification.                        */
/* ------------------------------------------------------------------ */

export type LeadStatus = "new" | "researching" | "qualified" | "nurture" | "disqualified" | "converted" | "merged";

export const leads = pgTable(
  "leads",
  {
    id: pk(),
    companyName: text("company_name").notNull(),
    normalizedName: text("normalized_name").notNull(),
    website: text("website"),
    domain: text("domain"),
    industry: text("industry"),
    country: text("country"),
    region: text("region"),
    sizeBand: text("size_band"),
    acquisitionChannel: text("acquisition_channel"),
    acquisitionDetail: text("acquisition_detail"),
    campaignId: uuid("campaign_id"),
    dateAdded: day("date_added").notNull(),
    researchNotes: text("research_notes"),
    observedNeeds: text("observed_needs"),
    status: text("status").$type<LeadStatus>().notNull().default("new"),
    disqualifyReason: text("disqualify_reason"),
    ownerId: text("owner_id").references(() => user.id),
    nextAction: text("next_action"),
    nextActionDate: day("next_action_date"),
    estimatedValue: money("estimated_value"),
    currency: currency(),
    lastInteractionAt: ts("last_interaction_at"),
    followUpDate: day("follow_up_date"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    convertedAt: ts("converted_at"),
    convertedAccountId: uuid("converted_account_id").references(() => accounts.id),
    convertedOpportunityId: uuid("converted_opportunity_id"),
    mergedIntoId: uuid("merged_into_id").references((): AnyPgColumn => leads.id),
    importBatchId: uuid("import_batch_id"),
    archivedAt: ts("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("leads_status_idx").on(t.status),
    index("leads_owner_idx").on(t.ownerId),
    index("leads_domain_idx").on(t.domain),
    index("leads_normalized_name_idx").on(t.normalizedName),
  ],
);

export const leadContacts = pgTable(
  "lead_contacts",
  {
    id: pk(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    jobTitle: text("job_title"),
    email: text("email"),
    normalizedEmail: text("normalized_email"),
    phone: text("phone"),
    linkedinUrl: text("linkedin_url"),
    sourceUrl: text("source_url"),
    isPrimary: boolean("is_primary").notNull().default(false),
    convertedContactId: uuid("converted_contact_id").references(() => contacts.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("lead_contacts_lead_idx").on(t.leadId), index("lead_contacts_email_idx").on(t.normalizedEmail)],
);

/** Services/offers a lead may fit (a lead can fit several streams). */
export const leadServiceFits = pgTable(
  "lead_service_fits",
  {
    id: pk(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    offerId: uuid("offer_id").references(() => offers.id),
    rationale: text("rationale"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("lead_service_fit_uq").on(t.leadId, t.serviceId)],
);

/** Research notes and supporting evidence with source URLs. Preserved on conversion. */
export const leadEvidence = pgTable(
  "lead_evidence",
  {
    id: pk(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    kind: text("kind").$type<"note" | "source" | "need" | "signal">().notNull(),
    content: text("content").notNull(),
    url: text("url"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("lead_evidence_lead_idx").on(t.leadId)],
);

export const leadStatusHistory = pgTable(
  "lead_status_history",
  {
    id: pk(),
    leadId: uuid("lead_id")
      .notNull()
      .references(() => leads.id, { onDelete: "cascade" }),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    note: text("note"),
    changedBy: text("changed_by").references(() => user.id),
    changedAt: ts("changed_at").defaultNow().notNull(),
  },
  (t) => [index("lead_status_history_lead_idx").on(t.leadId)],
);

/** Reviewable merge log: what was merged into what, with a snapshot of the source. */
export const recordMerges = pgTable("record_merges", {
  id: pk(),
  entityType: text("entity_type").$type<"lead" | "account" | "contact">().notNull(),
  sourceId: uuid("source_id").notNull(),
  targetId: uuid("target_id").notNull(),
  sourceSnapshot: jsonb("source_snapshot").$type<Record<string, unknown>>().notNull(),
  fieldChoices: jsonb("field_choices").$type<Record<string, "source" | "target">>(),
  movedRecords: jsonb("moved_records").$type<Record<string, number>>(),
  mergedBy: text("merged_by").references(() => user.id),
  mergedAt: ts("merged_at").defaultNow().notNull(),
});

/* ------------------------------------------------------------------ */
/* Campaigns & outreach.                                               */
/* ------------------------------------------------------------------ */

export const campaigns = pgTable("campaigns", {
  id: pk(),
  name: text("name").notNull(),
  channel: text("channel").notNull(),
  targetSegment: text("target_segment"),
  serviceId: uuid("service_id").references(() => services.id),
  offerId: uuid("offer_id").references(() => offers.id),
  ownerId: text("owner_id").references(() => user.id),
  startDate: day("start_date"),
  endDate: day("end_date"),
  cost: money("cost"),
  currency: currency(),
  status: text("status").$type<"planned" | "active" | "paused" | "completed" | "cancelled">().notNull().default("planned"),
  goal: text("goal"),
  outcomeNotes: text("outcome_notes"),
  ...timestamps,
});

export const campaignMembers = pgTable(
  "campaign_members",
  {
    id: pk(),
    campaignId: uuid("campaign_id")
      .notNull()
      .references(() => campaigns.id, { onDelete: "cascade" }),
    leadId: uuid("lead_id").references(() => leads.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    status: text("status").$type<"targeted" | "contacted" | "responded" | "meeting" | "opportunity" | "excluded">().notNull().default("targeted"),
    addedAt: ts("added_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("campaign_member_lead_uq").on(t.campaignId, t.leadId),
    uniqueIndex("campaign_member_contact_uq").on(t.campaignId, t.contactId),
  ],
);

export const outreachTemplates = pgTable("outreach_templates", {
  id: pk(),
  name: text("name").notNull(),
  serviceId: uuid("service_id").references(() => services.id),
  segment: text("segment"),
  channel: text("channel").notNull(),
  subject: text("subject"),
  body: text("body").notNull(),
  active: boolean("active").notNull().default(true),
  createdBy: text("created_by").references(() => user.id),
  ...timestamps,
});

export const sequences = pgTable("sequences", {
  id: pk(),
  name: text("name").notNull(),
  serviceId: uuid("service_id").references(() => services.id),
  segment: text("segment"),
  status: text("status").$type<"active" | "paused" | "archived">().notNull().default("active"),
  ownerId: text("owner_id").references(() => user.id),
  description: text("description"),
  ...timestamps,
});

export const sequenceSteps = pgTable(
  "sequence_steps",
  {
    id: pk(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id, { onDelete: "cascade" }),
    stepNumber: integer("step_number").notNull(),
    dayOffset: integer("day_offset").notNull().default(0),
    channel: text("channel").notNull(),
    templateId: uuid("template_id").references(() => outreachTemplates.id),
    instructions: text("instructions"),
  },
  (t) => [uniqueIndex("sequence_step_uq").on(t.sequenceId, t.stepNumber)],
);

export const sequenceEnrollments = pgTable(
  "sequence_enrollments",
  {
    id: pk(),
    sequenceId: uuid("sequence_id")
      .notNull()
      .references(() => sequences.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    leadId: uuid("lead_id").references(() => leads.id),
    leadContactId: uuid("lead_contact_id").references(() => leadContacts.id),
    status: text("status").$type<"active" | "paused" | "stopped" | "completed">().notNull().default("active"),
    currentStep: integer("current_step").notNull().default(1),
    nextDueAt: ts("next_due_at"),
    stoppedReason: text("stopped_reason").$type<"replied" | "opted_out" | "manual" | "bounced" | "converted" | "suppressed">(),
    enrolledBy: text("enrolled_by").references(() => user.id),
    enrolledAt: ts("enrolled_at").defaultNow().notNull(),
    stoppedAt: ts("stopped_at"),
    ...timestamps,
  },
  (t) => [
    index("enrollments_status_idx").on(t.status, t.nextDueAt),
    uniqueIndex("enrollment_active_contact_uq")
      .on(t.sequenceId, t.contactId)
      .where(sql`status in ('active','paused') and contact_id is not null`),
    uniqueIndex("enrollment_active_lead_contact_uq")
      .on(t.sequenceId, t.leadContactId)
      .where(sql`status in ('active','paused') and lead_contact_id is not null`),
  ],
);

/**
 * Outreach messages. Without a verified provider, messages are drafts that a
 * person sends manually and then logs ("sent_manually"). `dedupeKey` prevents
 * duplicate drafts/sends for the same enrollment step.
 */
export const outreachMessages = pgTable(
  "outreach_messages",
  {
    id: pk(),
    enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id),
    stepId: uuid("step_id").references(() => sequenceSteps.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    leadId: uuid("lead_id").references(() => leads.id),
    leadContactId: uuid("lead_contact_id").references(() => leadContacts.id),
    channel: text("channel").notNull(),
    toAddress: text("to_address"),
    subject: text("subject"),
    body: text("body").notNull(),
    status: text("status")
      .$type<"draft" | "approved" | "sent_manually" | "sent" | "cancelled" | "blocked">()
      .notNull()
      .default("draft"),
    blockedReason: text("blocked_reason"),
    dedupeKey: text("dedupe_key").unique(),
    aiAssisted: boolean("ai_assisted").notNull().default(false),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: ts("approved_at"),
    sentAt: ts("sent_at"),
    activityId: uuid("activity_id"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [index("outreach_messages_status_idx").on(t.status)],
);

/* ------------------------------------------------------------------ */
/* Pipelines & opportunities.                                          */
/* ------------------------------------------------------------------ */

export const pipelines = pgTable("pipelines", {
  id: pk(),
  name: text("name").notNull(),
  isDefault: boolean("is_default").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const pipelineStages = pgTable(
  "pipeline_stages",
  {
    id: pk(),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull(),
    probability: integer("probability").notNull(),
    kind: text("kind").$type<"open" | "won" | "lost">().notNull().default("open"),
    staleAfterDays: integer("stale_after_days"),
  },
  (t) => [uniqueIndex("pipeline_stage_key_uq").on(t.pipelineId, t.key)],
);

export type OpportunityStatus = "open" | "won" | "lost";

export const opportunities = pgTable(
  "opportunities",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    name: text("name").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id),
    pipelineId: uuid("pipeline_id")
      .notNull()
      .references(() => pipelines.id),
    stageId: uuid("stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    stageEnteredAt: ts("stage_entered_at").defaultNow().notNull(),
    status: text("status").$type<OpportunityStatus>().notNull().default("open"),
    kind: text("kind").$type<"new_business" | "renewal" | "expansion">().notNull().default("new_business"),
    ownerId: text("owner_id").references(() => user.id),
    businessProblem: text("business_problem"),
    desiredOutcome: text("desired_outcome"),
    scopeSummary: text("scope_summary"),
    discoveryNotes: text("discovery_notes"),
    value: money("value").notNull().default("0"),
    currency: currency().notNull(),
    pricingModel: text("pricing_model").$type<PricingModel>().notNull().default("fixed"),
    probabilityOverride: integer("probability_override"),
    expectedCloseDate: day("expected_close_date"),
    acquisitionChannel: text("acquisition_channel"),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    sourceLeadId: uuid("source_lead_id").references(() => leads.id),
    nextAction: text("next_action"),
    nextActionDate: day("next_action_date"),
    objections: text("objections"),
    competitors: text("competitors"),
    lostReason: text("lost_reason"),
    lostNotes: text("lost_notes"),
    wonAt: ts("won_at"),
    lostAt: ts("lost_at"),
    closedValue: money("closed_value"),
    parentEngagementId: uuid("parent_engagement_id").references((): AnyPgColumn => engagements.id),
    acceptedProposalVersionId: uuid("accepted_proposal_version_id"),
    customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
    archivedAt: ts("archived_at"),
    ...timestamps,
  },
  (t) => [
    index("opps_account_idx").on(t.accountId),
    index("opps_stage_idx").on(t.stageId),
    index("opps_status_idx").on(t.status),
    index("opps_owner_idx").on(t.ownerId),
  ],
);

export const opportunityServices = pgTable(
  "opportunity_services",
  {
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    offerId: uuid("offer_id").references(() => offers.id),
    value: money("value"),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.serviceId] })],
);

export const opportunityContacts = pgTable(
  "opportunity_contacts",
  {
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    contactId: uuid("contact_id")
      .notNull()
      .references(() => contacts.id),
    role: text("role"),
  },
  (t) => [primaryKey({ columns: [t.opportunityId, t.contactId] })],
);

export const opportunityStageHistory = pgTable(
  "opportunity_stage_history",
  {
    id: pk(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id, { onDelete: "cascade" }),
    fromStageId: uuid("from_stage_id").references(() => pipelineStages.id),
    toStageId: uuid("to_stage_id")
      .notNull()
      .references(() => pipelineStages.id),
    secondsInPreviousStage: integer("seconds_in_previous_stage"),
    changedBy: text("changed_by").references(() => user.id),
    changedAt: ts("changed_at").defaultNow().notNull(),
    note: text("note"),
  },
  (t) => [index("opp_stage_history_opp_idx").on(t.opportunityId, t.changedAt)],
);

/* ------------------------------------------------------------------ */
/* Proposals.                                                          */
/* ------------------------------------------------------------------ */

export const proposalTemplates = pgTable("proposal_templates", {
  id: pk(),
  name: text("name").notNull(),
  serviceId: uuid("service_id").references(() => services.id),
  offerId: uuid("offer_id").references(() => offers.id),
  introduction: text("introduction"),
  scope: text("scope"),
  deliverables: jsonb("deliverables").$type<ProposalDeliverable[]>().default([]),
  exclusions: text("exclusions"),
  assumptions: text("assumptions"),
  timeline: text("timeline"),
  terms: text("terms"),
  pricingModel: text("pricing_model").$type<PricingModel>(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export type ProposalDeliverable = { name: string; description?: string; dueOffsetDays?: number; milestone?: string };
export type ProposalLine = {
  description: string;
  quantity: string;
  unitPrice: string;
  serviceId?: string | null;
  offerId?: string | null;
};
export type PaymentScheduleItem = {
  label: string;
  /** Either a percentage of total or a fixed amount. */
  percent?: string | null;
  amount?: string | null;
  /** Days after acceptance/start, or tie to a milestone label. */
  dueAfterDays?: number | null;
  milestone?: string | null;
  recurring?: "monthly" | null;
};

export type ProposalStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "sent"
  | "accepted"
  | "rejected"
  | "expired"
  | "withdrawn";

export const proposals = pgTable(
  "proposals",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    opportunityId: uuid("opportunity_id")
      .notNull()
      .references(() => opportunities.id),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    templateId: uuid("template_id").references(() => proposalTemplates.id),
    title: text("title").notNull(),
    status: text("status").$type<ProposalStatus>().notNull().default("draft"),
    currentVersionId: uuid("current_version_id"),
    acceptedVersionId: uuid("accepted_version_id"),
    ownerId: text("owner_id").references(() => user.id),
    validUntil: day("valid_until"),
    sentAt: ts("sent_at"),
    decidedAt: ts("decided_at"),
    rejectionReason: text("rejection_reason"),
    ...timestamps,
  },
  (t) => [index("proposals_opp_idx").on(t.opportunityId)],
);

/** Immutable once submitted for approval / sent. Revisions create a new version. */
export const proposalVersions = pgTable(
  "proposal_versions",
  {
    id: pk(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    introduction: text("introduction"),
    scope: text("scope"),
    deliverables: jsonb("deliverables").$type<ProposalDeliverable[]>().notNull().default([]),
    exclusions: text("exclusions"),
    assumptions: text("assumptions"),
    timeline: text("timeline"),
    terms: text("terms"),
    startDate: day("start_date"),
    endDate: day("end_date"),
    pricingModel: text("pricing_model").$type<PricingModel>().notNull(),
    currency: currency().notNull(),
    lines: jsonb("lines").$type<ProposalLine[]>().notNull().default([]),
    discountPercent: decimal4("discount_percent").notNull().default("0"),
    taxRateId: uuid("tax_rate_id"),
    taxRatePercent: decimal4("tax_rate_percent").notNull().default("0"),
    subtotal: money("subtotal").notNull().default("0"),
    discountAmount: money("discount_amount").notNull().default("0"),
    taxAmount: money("tax_amount").notNull().default("0"),
    total: money("total").notNull().default("0"),
    hourlyRate: money("hourly_rate"),
    estimatedHours: decimal4("estimated_hours"),
    retainerMonths: integer("retainer_months"),
    paymentSchedule: jsonb("payment_schedule").$type<PaymentScheduleItem[]>().notNull().default([]),
    changeSummary: text("change_summary"),
    locked: boolean("locked").notNull().default(false),
    approvalStatus: text("approval_status")
      .$type<"not_requested" | "pending" | "approved" | "rejected">()
      .notNull()
      .default("not_requested"),
    approvalRequestedBy: text("approval_requested_by").references(() => user.id),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: ts("approved_at"),
    approvalNote: text("approval_note"),
    pdfDocumentId: uuid("pdf_document_id"),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("proposal_version_uq").on(t.proposalId, t.versionNumber)],
);

/**
 * Acceptance evidence. `method` distinguishes a manually recorded acceptance
 * from evidence types; "verified_esignature" is only possible via a verified
 * e-signature integration, which is not connected in this release.
 */
export const proposalAcceptances = pgTable(
  "proposal_acceptances",
  {
    id: pk(),
    proposalId: uuid("proposal_id")
      .notNull()
      .references(() => proposals.id),
    versionId: uuid("version_id")
      .notNull()
      .references(() => proposalVersions.id),
    acceptedAt: day("accepted_at").notNull(),
    acceptedByName: text("accepted_by_name").notNull(),
    acceptedByContactId: uuid("accepted_by_contact_id").references(() => contacts.id),
    method: text("method")
      .$type<"manual_record" | "email_confirmation" | "signed_document" | "verified_esignature">()
      .notNull(),
    evidenceNote: text("evidence_note"),
    evidenceDocumentId: uuid("evidence_document_id"),
    recordedBy: text("recorded_by").references(() => user.id),
    recordedAt: ts("recorded_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("proposal_acceptance_uq").on(t.proposalId)],
);

/* ------------------------------------------------------------------ */
/* Unified activity timeline — one row, linked to many records.        */
/* ------------------------------------------------------------------ */

export type ActivityType =
  | "email"
  | "message"
  | "linkedin"
  | "call"
  | "meeting"
  | "note"
  | "task"
  | "stage_change"
  | "status_change"
  | "proposal"
  | "contract"
  | "handover"
  | "renewal"
  | "deliverable"
  | "invoice"
  | "payment"
  | "system";

export const activities = pgTable(
  "activities",
  {
    id: pk(),
    type: text("type").$type<ActivityType>().notNull(),
    direction: text("direction").$type<"inbound" | "outbound" | "internal">(),
    channel: text("channel"),
    subject: text("subject").notNull(),
    body: text("body"),
    outcome: text("outcome"),
    occurredAt: ts("occurred_at").defaultNow().notNull(),
    /** manual = logged by a person; imported = from an integration; system = generated by a workflow. */
    source: text("source").$type<"manual" | "imported" | "system">().notNull().default("manual"),
    externalId: text("external_id"),
    actorId: text("actor_id").references(() => user.id),
    accountId: uuid("account_id").references(() => accounts.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    leadId: uuid("lead_id").references(() => leads.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    engagementId: uuid("engagement_id").references((): AnyPgColumn => engagements.id),
    campaignId: uuid("campaign_id").references(() => campaigns.id),
    enrollmentId: uuid("enrollment_id").references(() => sequenceEnrollments.id),
    relatedType: text("related_type"),
    relatedId: text("related_id"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("activities_account_idx").on(t.accountId, t.occurredAt),
    index("activities_contact_idx").on(t.contactId, t.occurredAt),
    index("activities_lead_idx").on(t.leadId, t.occurredAt),
    index("activities_opp_idx").on(t.opportunityId, t.occurredAt),
    index("activities_engagement_idx").on(t.engagementId, t.occurredAt),
    uniqueIndex("activities_external_uq").on(t.source, t.externalId),
  ],
);
