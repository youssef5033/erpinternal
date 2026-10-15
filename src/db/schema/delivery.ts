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
import { offers, services, type PricingModel, type ServiceKey } from "./catalog";
import { accounts, contacts, leads, opportunities, proposalVersions, type ProposalDeliverable } from "./crm";
import { people } from "./people";

/* ------------------------------------------------------------------ */
/* Engagements — one per sold piece of work, on the shared account.    */
/* ------------------------------------------------------------------ */

export type EngagementStatus = "onboarding" | "active" | "on_hold" | "completed" | "cancelled";

/**
 * Revenue recognition method per engagement (see docs/ACCOUNTING.md):
 *  - straight_line: retainers — recognised evenly per service period.
 *  - milestone: recognised when a milestone is accepted by the client.
 *  - time_and_materials: hourly — recognised as approved billable time × rate.
 *  - percent_complete: fixed fee — recognised by approved hours / budget hours.
 *  - on_completion: fixed fee — recognised when the engagement is completed.
 */
export type RecognitionMethod = "straight_line" | "milestone" | "time_and_materials" | "percent_complete" | "on_completion";

export const engagements = pgTable(
  "engagements",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    name: text("name").notNull(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    /** Unique: a won opportunity can be handed over to at most one engagement. */
    opportunityId: uuid("opportunity_id").references((): AnyPgColumn => opportunities.id),
    serviceId: uuid("service_id")
      .notNull()
      .references(() => services.id),
    offerId: uuid("offer_id").references(() => offers.id),
    templateKind: text("template_kind").$type<ServiceKey>().notNull(),
    status: text("status").$type<EngagementStatus>().notNull().default("onboarding"),
    billingModel: text("billing_model").$type<PricingModel>().notNull(),
    recognitionMethod: text("recognition_method").$type<RecognitionMethod>().notNull(),
    ownerId: text("owner_id").references(() => user.id),
    primaryContactId: uuid("primary_contact_id").references(() => contacts.id),
    startDate: day("start_date"),
    endDate: day("end_date"),
    currency: currency().notNull(),
    contractValue: money("contract_value").notNull().default("0"),
    hourlyRate: money("hourly_rate"),
    retainerAmount: money("retainer_amount"),
    retainerPeriodMonths: integer("retainer_period_months").default(1),
    budgetHours: decimal4("budget_hours"),
    budgetCost: money("budget_cost"),
    includedRevisions: integer("included_revisions"),
    renewalDate: day("renewal_date"),
    noticePeriodDays: integer("notice_period_days"),
    autoRenew: boolean("auto_renew").notNull().default(false),
    acceptedProposalVersionId: uuid("accepted_proposal_version_id").references(() => proposalVersions.id),
    discoveryNotes: text("discovery_notes"),
    objectives: text("objectives"),
    satisfactionNotes: text("satisfaction_notes"),
    completedAt: ts("completed_at"),
    archivedAt: ts("archived_at"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("engagements_opportunity_uq").on(t.opportunityId).where(sql`opportunity_id is not null`),
    index("engagements_account_idx").on(t.accountId),
    index("engagements_service_idx").on(t.serviceId),
    index("engagements_status_idx").on(t.status),
  ],
);

/** People assigned to an engagement. Contractors only see engagements they are members of. */
export const engagementMembers = pgTable(
  "engagement_members",
  {
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("contributor"),
    allocationHoursPerWeek: decimal4("allocation_hours_per_week"),
    addedAt: ts("added_at").defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.engagementId, t.userId] })],
);

/** Retainer service periods. Unique per engagement + number => renewals never duplicate. */
export const servicePeriods = pgTable(
  "service_periods",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    periodNumber: integer("period_number").notNull(),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    fee: money("fee").notNull(),
    currency: currency().notNull(),
    status: text("status").$type<"upcoming" | "active" | "completed" | "cancelled">().notNull().default("upcoming"),
    renewalOfPeriodId: uuid("renewal_of_period_id").references((): AnyPgColumn => servicePeriods.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("service_period_uq").on(t.engagementId, t.periodNumber)],
);

export const contracts = pgTable(
  "contracts",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    accountId: uuid("account_id")
      .notNull()
      .references(() => accounts.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    title: text("title").notNull(),
    contractType: text("contract_type").$type<"msa" | "sow" | "retainer" | "nda" | "change_order" | "other">().notNull(),
    status: text("status")
      .$type<"draft" | "sent" | "signed" | "active" | "expired" | "terminated">()
      .notNull()
      .default("draft"),
    startDate: day("start_date"),
    endDate: day("end_date"),
    noticePeriodDays: integer("notice_period_days"),
    autoRenew: boolean("auto_renew").notNull().default(false),
    value: money("value"),
    currency: currency(),
    signedAt: day("signed_at"),
    signatureEvidence: text("signature_evidence"),
    signatureMethod: text("signature_method").$type<"manual_record" | "signed_document" | "verified_esignature">(),
    ownerId: text("owner_id").references(() => user.id),
    proposalVersionId: uuid("proposal_version_id").references(() => proposalVersions.id),
    ...timestamps,
  },
  (t) => [index("contracts_account_idx").on(t.accountId), index("contracts_engagement_idx").on(t.engagementId)],
);

/* ------------------------------------------------------------------ */
/* Scope versions & change requests.                                    */
/* ------------------------------------------------------------------ */

/** Each scope change creates a new version; prior versions are preserved. */
export const scopeVersions = pgTable(
  "scope_versions",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    summary: text("summary"),
    inScope: text("in_scope"),
    deliverables: jsonb("deliverables").$type<ProposalDeliverable[]>().notNull().default([]),
    exclusions: text("exclusions"),
    assumptions: text("assumptions"),
    feeAmount: money("fee_amount"),
    budgetHours: decimal4("budget_hours"),
    budgetCost: money("budget_cost"),
    endDate: day("end_date"),
    currency: currency(),
    sourceType: text("source_type").$type<"proposal" | "change_request" | "manual">().notNull(),
    sourceId: uuid("source_id"),
    isCurrent: boolean("is_current").notNull().default(true),
    createdBy: text("created_by").references(() => user.id),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("scope_version_uq").on(t.engagementId, t.versionNumber),
    uniqueIndex("scope_current_uq").on(t.engagementId).where(sql`is_current`),
  ],
);

export const changeRequests = pgTable(
  "change_requests",
  {
    id: pk(),
    number: text("number").notNull().unique(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id),
    title: text("title").notNull(),
    description: text("description"),
    proposedChanges: text("proposed_changes").notNull(),
    feeImpact: money("fee_impact").notNull().default("0"),
    currency: currency().notNull(),
    hoursImpact: decimal4("hours_impact").notNull().default("0"),
    costImpact: money("cost_impact").notNull().default("0"),
    deadlineImpactDays: integer("deadline_impact_days").notNull().default(0),
    newEndDate: day("new_end_date"),
    status: text("status")
      .$type<"draft" | "submitted" | "approved" | "rejected" | "withdrawn">()
      .notNull()
      .default("draft"),
    requestedBy: text("requested_by").references(() => user.id),
    requestedByContactId: uuid("requested_by_contact_id").references(() => contacts.id),
    clientApprovalEvidence: text("client_approval_evidence"),
    clientApprovedByContactId: uuid("client_approved_by_contact_id").references(() => contacts.id),
    decidedBy: text("decided_by").references(() => user.id),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    priorScopeVersionId: uuid("prior_scope_version_id").references(() => scopeVersions.id),
    resultingScopeVersionId: uuid("resulting_scope_version_id").references(() => scopeVersions.id),
    ...timestamps,
  },
  (t) => [index("change_requests_engagement_idx").on(t.engagementId, t.status)],
);

/* ------------------------------------------------------------------ */
/* Projects, milestones, deliverables.                                  */
/* ------------------------------------------------------------------ */

export const projects = pgTable("projects", {
  id: pk(),
  engagementId: uuid("engagement_id")
    .notNull()
    .references(() => engagements.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  status: text("status").$type<"planned" | "active" | "completed" | "on_hold" | "cancelled">().notNull().default("planned"),
  ownerId: text("owner_id").references(() => user.id),
  startDate: day("start_date"),
  endDate: day("end_date"),
  budgetHours: decimal4("budget_hours"),
  budgetCost: money("budget_cost"),
  ...timestamps,
});

export const milestones = pgTable(
  "milestones",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id),
    name: text("name").notNull(),
    description: text("description"),
    dueDate: day("due_date"),
    status: text("status")
      .$type<"planned" | "in_progress" | "submitted" | "accepted" | "cancelled">()
      .notNull()
      .default("planned"),
    billable: boolean("billable").notNull().default(false),
    billingAmount: money("billing_amount"),
    currency: currency(),
    acceptedAt: day("accepted_at"),
    acceptanceEvidence: text("acceptance_evidence"),
    acceptedByContactId: uuid("accepted_by_contact_id").references(() => contacts.id),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("milestones_engagement_idx").on(t.engagementId)],
);

/**
 * Deliverable approval status is independent of task execution status:
 * completing the tasks never marks a deliverable approved.
 */
export type DeliverableApproval =
  | "not_started"
  | "in_progress"
  | "internal_review"
  | "awaiting_client"
  | "changes_requested"
  | "approved"
  | "rejected";

export const deliverables = pgTable(
  "deliverables",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    projectId: uuid("project_id").references(() => projects.id),
    milestoneId: uuid("milestone_id").references(() => milestones.id),
    name: text("name").notNull(),
    description: text("description"),
    deliverableType: text("deliverable_type"),
    ownerId: text("owner_id").references(() => user.id),
    dueDate: day("due_date"),
    approvalStatus: text("approval_status").$type<DeliverableApproval>().notNull().default("not_started"),
    includedRevisions: integer("included_revisions"),
    revisionsUsed: integer("revisions_used").notNull().default(0),
    currentVersionNumber: integer("current_version_number").notNull().default(0),
    approvedAt: ts("approved_at"),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [index("deliverables_engagement_idx").on(t.engagementId), index("deliverables_due_idx").on(t.dueDate)],
);

export const deliverableVersions = pgTable(
  "deliverable_versions",
  {
    id: pk(),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    notes: text("notes"),
    documentId: uuid("document_id"),
    link: text("link"),
    submittedBy: text("submitted_by").references(() => user.id),
    submittedAt: ts("submitted_at").defaultNow().notNull(),
    stage: text("stage").$type<"internal" | "client">().notNull().default("client"),
    outcome: text("outcome").$type<"pending" | "approved" | "changes_requested" | "rejected">().notNull().default("pending"),
  },
  (t) => [uniqueIndex("deliverable_version_uq").on(t.deliverableId, t.versionNumber)],
);

/** Approval records (internal and client) with evidence. */
export const deliverableReviews = pgTable(
  "deliverable_reviews",
  {
    id: pk(),
    deliverableId: uuid("deliverable_id")
      .notNull()
      .references(() => deliverables.id, { onDelete: "cascade" }),
    versionId: uuid("version_id")
      .notNull()
      .references(() => deliverableVersions.id),
    reviewerType: text("reviewer_type").$type<"internal" | "client">().notNull(),
    reviewerUserId: text("reviewer_user_id").references(() => user.id),
    reviewerContactId: uuid("reviewer_contact_id").references(() => contacts.id),
    reviewerName: text("reviewer_name"),
    decision: text("decision").$type<"approved" | "changes_requested" | "rejected">().notNull(),
    feedback: text("feedback"),
    evidence: text("evidence"),
    countsAsRevision: boolean("counts_as_revision").notNull().default(false),
    recordedBy: text("recorded_by").references(() => user.id),
    decidedAt: ts("decided_at").defaultNow().notNull(),
  },
  (t) => [index("deliverable_reviews_deliverable_idx").on(t.deliverableId)],
);

/* ------------------------------------------------------------------ */
/* Shared task system (CRM, delivery, finance, HR).                    */
/* ------------------------------------------------------------------ */

export type TaskStatus =
  | "backlog"
  | "ready"
  | "in_progress"
  | "internal_review"
  | "client_review"
  | "completed"
  | "blocked"
  | "cancelled";
export type TaskPriority = "low" | "medium" | "high" | "urgent";
export type TaskKind =
  | "task"
  | "follow_up"
  | "onboarding"
  | "renewal"
  | "collection"
  | "approval"
  | "compliance"
  | "outreach"
  | "hr";

export const tasks = pgTable(
  "tasks",
  {
    id: pk(),
    title: text("title").notNull(),
    description: text("description"),
    kind: text("kind").$type<TaskKind>().notNull().default("task"),
    module: text("module").$type<"crm" | "delivery" | "finance" | "people" | "operations">().notNull().default("operations"),
    status: text("status").$type<TaskStatus>().notNull().default("ready"),
    priority: text("priority").$type<TaskPriority>().notNull().default("medium"),
    ownerId: text("owner_id").references(() => user.id),
    dueDate: day("due_date"),
    startDate: day("start_date"),
    estimateHours: decimal4("estimate_hours"),
    nextAction: text("next_action"),
    blockedReason: text("blocked_reason"),
    accountId: uuid("account_id").references(() => accounts.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    leadId: uuid("lead_id").references(() => leads.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    projectId: uuid("project_id").references(() => projects.id),
    milestoneId: uuid("milestone_id").references(() => milestones.id),
    deliverableId: uuid("deliverable_id").references(() => deliverables.id),
    invoiceId: uuid("invoice_id"),
    billId: uuid("bill_id"),
    personId: uuid("person_id").references(() => people.id),
    eventId: uuid("event_id"),
    recurrence: text("recurrence").$type<"none" | "daily" | "weekly" | "monthly">().notNull().default("none"),
    recurrenceParentId: uuid("recurrence_parent_id").references((): AnyPgColumn => tasks.id),
    /** Idempotency key for generated tasks (recurring, onboarding, renewal…). */
    generationKey: text("generation_key").unique(),
    reminderAt: ts("reminder_at"),
    completedAt: ts("completed_at"),
    completedBy: text("completed_by").references(() => user.id),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [
    index("tasks_owner_status_idx").on(t.ownerId, t.status),
    index("tasks_due_idx").on(t.dueDate),
    index("tasks_engagement_idx").on(t.engagementId),
    index("tasks_opportunity_idx").on(t.opportunityId),
    index("tasks_account_idx").on(t.accountId),
  ],
);

export const taskDependencies = pgTable(
  "task_dependencies",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnTaskId: uuid("depends_on_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnTaskId] })],
);

export const taskComments = pgTable(
  "task_comments",
  {
    id: pk(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    authorId: text("author_id").references(() => user.id),
    body: text("body").notNull(),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("task_comments_task_idx").on(t.taskId)],
);

/**
 * Time entries. On approval the cost rate in force on the work date is
 * snapshotted (`costRate`, `costAmount`) so profitability history is stable.
 */
export const timeEntries = pgTable(
  "time_entries",
  {
    id: pk(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id),
    userId: text("user_id").references(() => user.id),
    workDate: day("work_date").notNull(),
    hours: decimal4("hours").notNull(),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    projectId: uuid("project_id").references(() => projects.id),
    taskId: uuid("task_id").references(() => tasks.id),
    description: text("description"),
    billable: boolean("billable").notNull().default(true),
    status: text("status").$type<"draft" | "submitted" | "approved" | "rejected">().notNull().default("submitted"),
    approvedBy: text("approved_by").references(() => user.id),
    approvedAt: ts("approved_at"),
    rejectionReason: text("rejection_reason"),
    costRate: money("cost_rate"),
    costAmount: money("cost_amount"),
    costCurrency: currency("cost_currency"),
    billRate: money("bill_rate"),
    ...timestamps,
  },
  (t) => [
    index("time_person_date_idx").on(t.personId, t.workDate),
    index("time_engagement_idx").on(t.engagementId, t.status),
  ],
);

/* ------------------------------------------------------------------ */
/* Calendar events (meetings, calls, discovery).                        */
/* ------------------------------------------------------------------ */

export const events = pgTable(
  "events",
  {
    id: pk(),
    kind: text("kind").$type<"meeting" | "call" | "discovery" | "account_review" | "internal" | "workshop">().notNull(),
    title: text("title").notNull(),
    startsAt: ts("starts_at").notNull(),
    endsAt: ts("ends_at").notNull(),
    timeZone: text("time_zone").notNull().default("UTC"),
    location: text("location"),
    agenda: text("agenda"),
    notes: text("notes"),
    decisions: text("decisions"),
    outcome: text("outcome"),
    status: text("status").$type<"scheduled" | "completed" | "cancelled" | "no_show">().notNull().default("scheduled"),
    organizerId: text("organizer_id").references(() => user.id),
    accountId: uuid("account_id").references(() => accounts.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    leadId: uuid("lead_id").references(() => leads.id),
    opportunityId: uuid("opportunity_id").references(() => opportunities.id),
    engagementId: uuid("engagement_id").references(() => engagements.id),
    reminderMinutes: integer("reminder_minutes").default(15),
    externalSource: text("external_source"),
    externalId: text("external_id"),
    syncStatus: text("sync_status").$type<"local_only" | "synced" | "conflict" | "error">().notNull().default("local_only"),
    syncError: text("sync_error"),
    activityId: uuid("activity_id"),
    ...timestamps,
  },
  (t) => [index("events_starts_idx").on(t.startsAt), index("events_opp_idx").on(t.opportunityId)],
);

export const eventAttendees = pgTable(
  "event_attendees",
  {
    id: pk(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: text("user_id").references(() => user.id),
    contactId: uuid("contact_id").references(() => contacts.id),
    email: text("email"),
    response: text("response").$type<"pending" | "accepted" | "declined">().default("pending"),
  },
  (t) => [index("event_attendees_event_idx").on(t.eventId)],
);

/* ------------------------------------------------------------------ */
/* Service-specific workspace records (Creative / Advisory / Executive).*/
/* Item types and their fields are defined in src/server/delivery/templates.ts */
/* ------------------------------------------------------------------ */

export const workspaceItems = pgTable(
  "workspace_items",
  {
    id: pk(),
    engagementId: uuid("engagement_id")
      .notNull()
      .references(() => engagements.id, { onDelete: "cascade" }),
    itemType: text("item_type").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull().default("draft"),
    ownerId: text("owner_id").references(() => user.id),
    dueDate: day("due_date"),
    scheduledDate: day("scheduled_date"),
    channel: text("channel"),
    versionNumber: integer("version_number").notNull().default(1),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    sourceUrl: text("source_url"),
    documentId: uuid("document_id"),
    deliverableId: uuid("deliverable_id").references(() => deliverables.id),
    supersedesId: uuid("supersedes_id").references((): AnyPgColumn => workspaceItems.id),
    sortOrder: integer("sort_order").notNull().default(0),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [index("workspace_items_engagement_idx").on(t.engagementId, t.itemType)],
);

