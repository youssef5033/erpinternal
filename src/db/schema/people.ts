import { boolean, index, jsonb, pgTable, text, uniqueIndex, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";
import { currency, day, decimal4, money, pk, timestamps, ts } from "./_helpers";
import { user } from "./auth";

export const departments = pgTable("departments", {
  id: pk(),
  name: text("name").notNull().unique(),
  ...timestamps,
});

/** Employees and contractors. A person may (or may not) have a login user. */
export const people = pgTable(
  "people",
  {
    id: pk(),
    userId: text("user_id").references(() => user.id),
    type: text("type").$type<"employee" | "contractor">().notNull(),
    fullName: text("full_name").notNull(),
    email: text("email"),
    phone: text("phone"),
    jobTitle: text("job_title"),
    departmentId: uuid("department_id").references(() => departments.id),
    managerId: uuid("manager_id").references((): AnyPgColumn => people.id),
    startDate: day("start_date"),
    endDate: day("end_date"),
    timeZone: text("time_zone").notNull().default("UTC"),
    weeklyCapacityHours: decimal4("weekly_capacity_hours").notNull().default("40"),
    workingDays: jsonb("working_days").$type<number[]>().notNull().default([1, 2, 3, 4, 5]),
    status: text("status").$type<"active" | "onboarding" | "offboarding" | "inactive">().notNull().default("active"),
    supplierId: uuid("supplier_id"),
    notes: text("notes"),
    ...timestamps,
  },
  (t) => [uniqueIndex("people_user_uq").on(t.userId)],
);

/**
 * Restricted internal cost rates with effective dates. Approved time entries
 * snapshot the rate in force on the work date, so history never changes.
 */
export const costRates = pgTable(
  "cost_rates",
  {
    id: pk(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    effectiveFrom: day("effective_from").notNull(),
    hourlyCost: money("hourly_cost").notNull(),
    currency: currency().notNull(),
    note: text("note"),
    createdBy: text("created_by").references(() => user.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("cost_rates_person_from_uq").on(t.personId, t.effectiveFrom)],
);

export const leaveRequests = pgTable(
  "leave_requests",
  {
    id: pk(),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    leaveType: text("leave_type").$type<"annual" | "sick" | "unpaid" | "parental" | "other">().notNull(),
    startDate: day("start_date").notNull(),
    endDate: day("end_date").notNull(),
    hours: decimal4("hours"),
    status: text("status").$type<"requested" | "approved" | "rejected" | "cancelled">().notNull().default("requested"),
    reason: text("reason"),
    approverId: text("approver_id").references(() => user.id),
    decidedAt: ts("decided_at"),
    decisionNote: text("decision_note"),
    ...timestamps,
  },
  (t) => [index("leave_person_idx").on(t.personId, t.startDate)],
);

/** Onboarding/offboarding checklists for people. */
export const personChecklists = pgTable("person_checklists", {
  id: pk(),
  personId: uuid("person_id")
    .notNull()
    .references(() => people.id, { onDelete: "cascade" }),
  kind: text("kind").$type<"onboarding" | "offboarding">().notNull(),
  title: text("title").notNull(),
  completedAt: ts("completed_at"),
  ...timestamps,
});

/** Generic checklist items (tasks and person checklists). */
export const checklistItems = pgTable(
  "checklist_items",
  {
    id: pk(),
    parentType: text("parent_type").$type<"task" | "person_checklist">().notNull(),
    parentId: uuid("parent_id").notNull(),
    label: text("label").notNull(),
    done: boolean("done").notNull().default(false),
    doneAt: ts("done_at"),
    doneBy: text("done_by").references(() => user.id),
    sortOrder: decimal4("sort_order").notNull().default("0"),
    createdAt: ts("created_at").defaultNow().notNull(),
  },
  (t) => [index("checklist_parent_idx").on(t.parentType, t.parentId)],
);

