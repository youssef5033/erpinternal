import { boolean, integer, jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";
import { currency, money, pk, timestamps } from "./_helpers";

export type ServiceKey = "creative" | "advisory" | "executive";
export type PricingModel = "fixed" | "retainer" | "milestone" | "hourly";

/** The agency's three service streams (configurable, but keys are stable). */
export const services = pgTable("services", {
  id: pk(),
  key: text("key").notNull().unique(),
  name: text("name").notNull(),
  shortName: text("short_name").notNull(),
  description: text("description"),
  color: text("color").notNull().default("#475569"),
  templateKind: text("template_kind").$type<ServiceKey>().notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

/** Offer catalog: packaged services under a stream. */
export const offers = pgTable("offers", {
  id: pk(),
  serviceId: uuid("service_id")
    .notNull()
    .references(() => services.id),
  name: text("name").notNull(),
  description: text("description"),
  pricingModel: text("pricing_model").$type<PricingModel>().notNull(),
  defaultPrice: money("default_price"),
  currency: currency(),
  defaultDurationWeeks: integer("default_duration_weeks"),
  includedRevisions: integer("included_revisions"),
  deliverableTemplate: jsonb("deliverable_template").$type<{ name: string; offsetDays?: number }[]>().default([]),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

/** Acquisition / outreach channels (LinkedIn, cold email, referral…). */
export const channels = pgTable("channels", {
  id: pk(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  isOutreach: boolean("is_outreach").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

/** Configurable buying roles (decision-maker, budget-holder, influencer…). */
export const contactRoleDefinitions = pgTable("contact_role_definitions", {
  id: pk(),
  key: text("key").notNull().unique(),
  label: text("label").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});

/** Configurable lists, e.g. lost reasons, industries, size bands. */
export const lookupValues = pgTable("lookup_values", {
  id: pk(),
  listKey: text("list_key").notNull(),
  value: text("value").notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
});
