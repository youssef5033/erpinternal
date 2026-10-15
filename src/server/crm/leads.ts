import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  accounts,
  activities,
  campaignMembers,
  contacts,
  events,
  leadContacts,
  leadEvidence,
  leadServiceFits,
  leadStatusHistory,
  leads,
  outreachMessages,
  recordMerges,
  sequenceEnrollments,
  tasks,
  type LeadStatus,
} from "@/db/schema";
import type { PricingModel } from "@/db/schema";
import { normalizeCompanyName, normalizeDomain, normalizeEmail, normalizeWebsite, isFreeEmailDomain } from "@/lib/normalize";
import { toMoney } from "@/lib/money";
import type { Actor } from "../auth/actor";
import { assertCrmWrite } from "../auth/scope";
import { audit, diff } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { agencyToday } from "../system/settings";
import { logActivity } from "./activities";
import { createAccount, createContact, findContactByEmail, setAccountLifecycle, type DuplicateCandidate } from "./accounts";
import { createOpportunity } from "./opportunities";

export const LEAD_STATUSES: LeadStatus[] = ["new", "researching", "qualified", "nurture", "disqualified"];

/** Explicit qualification transitions. converted/merged are terminal. */
export const LEAD_TRANSITIONS: Record<LeadStatus, LeadStatus[]> = {
  new: ["researching", "qualified", "nurture", "disqualified"],
  researching: ["new", "qualified", "nurture", "disqualified"],
  qualified: ["researching", "nurture", "disqualified"],
  nurture: ["researching", "qualified", "disqualified"],
  disqualified: ["researching", "nurture"],
  converted: [],
  merged: [],
};

export type LeadContactInput = {
  fullName: string;
  jobTitle?: string | null;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  sourceUrl?: string | null;
  isPrimary?: boolean;
};

export type LeadInput = {
  companyName: string;
  website?: string | null;
  industry?: string | null;
  country?: string | null;
  region?: string | null;
  sizeBand?: string | null;
  acquisitionChannel?: string | null;
  acquisitionDetail?: string | null;
  campaignId?: string | null;
  dateAdded?: string | null;
  researchNotes?: string | null;
  observedNeeds?: string | null;
  ownerId?: string | null;
  nextAction?: string | null;
  nextActionDate?: string | null;
  estimatedValue?: string | null;
  currency?: string | null;
  followUpDate?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
  serviceIds?: string[];
  contacts?: LeadContactInput[];
};

function leadValues(input: LeadInput) {
  if (input.estimatedValue && !input.currency) throw new ValidationError("A currency is required when an estimated value is given.", { currency: "Required with value" });
  return {
    companyName: input.companyName.trim(),
    normalizedName: normalizeCompanyName(input.companyName),
    website: normalizeWebsite(input.website),
    domain: normalizeDomain(input.website),
    industry: input.industry || null,
    country: input.country || null,
    region: input.region || null,
    sizeBand: input.sizeBand || null,
    acquisitionChannel: input.acquisitionChannel || null,
    acquisitionDetail: input.acquisitionDetail || null,
    campaignId: input.campaignId || null,
    researchNotes: input.researchNotes || null,
    observedNeeds: input.observedNeeds || null,
    ownerId: input.ownerId || null,
    nextAction: input.nextAction || null,
    nextActionDate: input.nextActionDate || null,
    estimatedValue: input.estimatedValue ? toMoney(input.estimatedValue) : null,
    currency: input.currency ? input.currency.toUpperCase() : null,
    followUpDate: input.followUpDate || null,
    tags: input.tags ?? [],
    customFields: input.customFields ?? {},
  };
}

/**
 * Duplicate detection across leads, accounts and contacts using normalized
 * domains, emails and company names. Free-mail domains are ignored for domain
 * matching.
 */
export async function findLeadDuplicates(
  tx: Tx,
  candidate: { companyName: string; website?: string | null; emails?: (string | null | undefined)[] },
  excludeLeadId?: string,
): Promise<DuplicateCandidate[]> {
  const n = normalizeCompanyName(candidate.companyName);
  const dom = normalizeDomain(candidate.website);
  const emails = (candidate.emails ?? []).map(normalizeEmail).filter((e): e is string => !!e);
  const emailDomains = emails.map((e) => e.split("@")[1]).filter((x) => !isFreeEmailDomain(x));
  const domains = Array.from(new Set([dom, ...emailDomains].filter((x): x is string => !!x)));
  const out: DuplicateCandidate[] = [];

  const leadConds = [n ? eq(leads.normalizedName, n) : undefined, domains.length ? inArray(leads.domain, domains) : undefined].filter(Boolean);
  if (leadConds.length) {
    const rows = await tx
      .select({ id: leads.id, name: leads.companyName, domain: leads.domain, normalizedName: leads.normalizedName, status: leads.status })
      .from(leads)
      .where(and(or(...leadConds), ne(leads.status, "merged"), excludeLeadId ? ne(leads.id, excludeLeadId) : undefined));
    for (const r of rows) {
      out.push({ type: "lead", id: r.id, label: `${r.name} (${r.status})`, reason: r.domain && domains.includes(r.domain) ? `Same domain (${r.domain})` : "Same normalized company name" });
    }
  }
  if (emails.length) {
    const rows = await tx
      .select({ id: leadContacts.id, leadId: leadContacts.leadId, name: leadContacts.fullName, email: leadContacts.normalizedEmail })
      .from(leadContacts)
      .innerJoin(leads, eq(leads.id, leadContacts.leadId))
      .where(and(inArray(leadContacts.normalizedEmail, emails), ne(leads.status, "merged"), excludeLeadId ? ne(leadContacts.leadId, excludeLeadId) : undefined));
    for (const r of rows) {
      if (!out.some((o) => o.type === "lead" && o.id === r.leadId)) out.push({ type: "lead", id: r.leadId, label: r.name, reason: `Same contact email (${r.email})` });
    }
    const cs = await tx.select({ id: contacts.id, name: contacts.fullName, email: contacts.normalizedEmail }).from(contacts).where(inArray(contacts.normalizedEmail, emails));
    for (const c of cs) out.push({ type: "contact", id: c.id, label: c.name, reason: `Existing contact with email ${c.email}` });
  }
  const accConds = [n ? eq(accounts.normalizedName, n) : undefined, domains.length ? inArray(accounts.domain, domains) : undefined].filter(Boolean);
  if (accConds.length) {
    const rows = await tx.select({ id: accounts.id, name: accounts.name, domain: accounts.domain }).from(accounts).where(or(...accConds));
    for (const r of rows) out.push({ type: "account", id: r.id, label: r.name, reason: r.domain && domains.includes(r.domain) ? `Existing account with domain ${r.domain}` : "Existing account with same name" });
  }
  return out;
}

async function writeLeadContacts(tx: Tx, leadId: string, list: LeadContactInput[]) {
  const rows = list
    .filter((c) => c.fullName?.trim())
    .map((c, i) => {
      if (c.email && !normalizeEmail(c.email)) throw new ValidationError(`Contact email "${c.email}" is not valid.`);
      return {
        leadId,
        fullName: c.fullName.trim(),
        jobTitle: c.jobTitle || null,
        email: c.email?.trim() || null,
        normalizedEmail: normalizeEmail(c.email),
        phone: c.phone || null,
        linkedinUrl: c.linkedinUrl || null,
        sourceUrl: c.sourceUrl || null,
        isPrimary: c.isPrimary ?? i === 0,
      };
    });
  if (rows.length) await tx.insert(leadContacts).values(rows);
}

export async function createLead(tx: Tx, actor: Actor, input: LeadInput, opts: { allowDuplicate?: boolean; importBatchId?: string | null } = {}) {
  assertCrmWrite(actor, input.ownerId ?? actor.userId);
  if (!input.companyName?.trim()) throw new ValidationError("Company name is required.", { companyName: "Required" });
  if (!opts.allowDuplicate) {
    const dups = await findLeadDuplicates(tx, { companyName: input.companyName, website: input.website, emails: input.contacts?.map((c) => c.email) });
    if (dups.length) {
      throw new ConflictError(`Possible duplicate: ${dups.slice(0, 3).map((d) => `${d.type} "${d.label}" — ${d.reason}`).join("; ")}. Review it or save anyway.`);
    }
  }
  const today = await agencyToday(tx);
  const [lead] = await tx
    .insert(leads)
    .values({ ...leadValues(input), ownerId: input.ownerId || actor.userId || null, dateAdded: input.dateAdded || today, importBatchId: opts.importBatchId ?? null })
    .returning();
  await writeLeadContacts(tx, lead.id, input.contacts ?? []);
  if (input.serviceIds?.length) {
    await tx.insert(leadServiceFits).values(input.serviceIds.map((serviceId) => ({ leadId: lead.id, serviceId }))).onConflictDoNothing();
  }
  if (input.researchNotes) {
    await tx.insert(leadEvidence).values({ leadId: lead.id, kind: "note", content: input.researchNotes, createdBy: actor.userId || null });
  }
  await tx.insert(leadStatusHistory).values({ leadId: lead.id, fromStatus: null, toStatus: "new", changedBy: actor.userId || null, note: opts.importBatchId ? "Imported" : "Created" });
  await audit(tx, actor, { action: "lead.created", entityType: "lead", entityId: lead.id, summary: `Created lead ${lead.companyName}` });
  return lead;
}

export async function updateLead(tx: Tx, actor: Actor, id: string, input: LeadInput) {
  const [before] = await tx.select().from(leads).where(eq(leads.id, id)).for("update");
  if (!before) throw new NotFoundError("Lead");
  assertCrmWrite(actor, before.ownerId);
  if (before.status === "merged") throw new ValidationError("Merged leads cannot be edited.");
  const [after] = await tx.update(leads).set(leadValues(input)).where(eq(leads.id, id)).returning();
  if (input.serviceIds) await setLeadServiceFits(tx, actor, id, input.serviceIds.map((serviceId) => ({ serviceId })));
  const changes = diff(before, after, ["companyName", "website", "ownerId", "nextAction", "nextActionDate", "estimatedValue", "currency", "followUpDate", "acquisitionChannel"]);
  if (Object.keys(changes).length) await audit(tx, actor, { action: "lead.updated", entityType: "lead", entityId: id, summary: `Updated lead ${after.companyName}`, changes });
  return after;
}

export async function changeLeadStatus(tx: Tx, actor: Actor, id: string, to: LeadStatus, note?: string | null) {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, id)).for("update");
  if (!lead) throw new NotFoundError("Lead");
  assertCrmWrite(actor, lead.ownerId);
  if (lead.status === to) return lead;
  if (!LEAD_TRANSITIONS[lead.status].includes(to)) throw new ValidationError(`A ${lead.status} lead cannot move to ${to}.`);
  if (to === "disqualified" && !note?.trim()) throw new ValidationError("Give a reason when disqualifying a lead.", { note: "Required" });
  const [after] = await tx
    .update(leads)
    .set({ status: to, disqualifyReason: to === "disqualified" ? note ?? null : lead.disqualifyReason })
    .where(eq(leads.id, id))
    .returning();
  await tx.insert(leadStatusHistory).values({ leadId: id, fromStatus: lead.status, toStatus: to, note: note || null, changedBy: actor.userId || null });
  await logActivity(tx, actor, { type: "status_change", subject: `Qualification: ${lead.status} → ${to}`, body: note ?? null, leadId: id, source: "system" });
  await audit(tx, actor, { action: "lead.status_changed", entityType: "lead", entityId: id, summary: `${lead.companyName}: ${lead.status} → ${to}`, changes: { status: { from: lead.status, to } } });
  return after;
}

export async function addLeadEvidence(tx: Tx, actor: Actor, leadId: string, input: { kind: "note" | "source" | "need" | "signal"; content: string; url?: string | null }) {
  if (!input.content.trim()) throw new ValidationError("Content is required.");
  if (input.url && !/^https?:\/\//i.test(input.url)) throw new ValidationError("Source URL must start with http(s)://");
  const [row] = await tx.insert(leadEvidence).values({ leadId, kind: input.kind, content: input.content.trim(), url: input.url || null, createdBy: actor.userId || null }).returning();
  await audit(tx, actor, { action: "lead.evidence_added", entityType: "lead", entityId: leadId, summary: `Added ${input.kind}: ${input.content.slice(0, 80)}` });
  return row;
}

export async function addLeadContact(tx: Tx, actor: Actor, leadId: string, input: LeadContactInput) {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId));
  if (!lead) throw new NotFoundError("Lead");
  assertCrmWrite(actor, lead.ownerId);
  await writeLeadContacts(tx, leadId, [{ ...input, isPrimary: input.isPrimary ?? false }]);
  await audit(tx, actor, { action: "lead.contact_added", entityType: "lead", entityId: leadId, summary: `Added contact ${input.fullName}` });
}

export async function setLeadServiceFits(tx: Tx, actor: Actor, leadId: string, fits: { serviceId: string; offerId?: string | null; rationale?: string | null }[]) {
  await tx.delete(leadServiceFits).where(eq(leadServiceFits.leadId, leadId));
  if (fits.length) {
    await tx.insert(leadServiceFits).values(fits.map((f) => ({ leadId, serviceId: f.serviceId, offerId: f.offerId || null, rationale: f.rationale || null }))).onConflictDoNothing();
  }
  await audit(tx, actor, { action: "lead.service_fit_updated", entityType: "lead", entityId: leadId, summary: `Recommended services updated (${fits.length})` });
}

/* ------------------------------------------------------------------ */
/* Bulk actions                                                        */
/* ------------------------------------------------------------------ */

export async function bulkAssignLeads(tx: Tx, actor: Actor, ids: string[], ownerId: string) {
  assertCrmWrite(actor, null);
  if (!ids.length) return 0;
  const rows = await tx.update(leads).set({ ownerId }).where(inArray(leads.id, ids)).returning({ id: leads.id });
  await audit(tx, actor, { action: "lead.bulk_assigned", entityType: "lead", summary: `Assigned ${rows.length} leads`, changes: { ids, ownerId } });
  return rows.length;
}

export async function bulkTagLeads(tx: Tx, actor: Actor, ids: string[], tag: string, remove = false) {
  assertCrmWrite(actor, null);
  const t = tag.trim().toLowerCase();
  if (!t || !ids.length) return 0;
  const expr = remove ? sql`array_remove(${leads.tags}, ${t})` : sql`(select array(select distinct unnest(${leads.tags} || array[${t}]::text[])))`;
  const rows = await tx.update(leads).set({ tags: expr }).where(inArray(leads.id, ids)).returning({ id: leads.id });
  await audit(tx, actor, { action: remove ? "lead.bulk_untagged" : "lead.bulk_tagged", entityType: "lead", summary: `${remove ? "Removed" : "Added"} tag "${t}" on ${rows.length} leads`, changes: { ids } });
  return rows.length;
}

export async function bulkCreateLeadTasks(tx: Tx, actor: Actor, ids: string[], input: { title: string; dueDate?: string | null; ownerId?: string | null; priority?: "low" | "medium" | "high" | "urgent" }) {
  if (!input.title.trim()) throw new ValidationError("Task title is required.");
  const ls = await tx.select({ id: leads.id, ownerId: leads.ownerId, companyName: leads.companyName }).from(leads).where(inArray(leads.id, ids));
  if (!ls.length) return 0;
  await tx.insert(tasks).values(
    ls.map((l) => ({
      title: `${input.title} — ${l.companyName}`,
      kind: "follow_up" as const,
      module: "crm" as const,
      status: "ready" as const,
      priority: input.priority ?? "medium",
      ownerId: input.ownerId || l.ownerId || actor.userId || null,
      dueDate: input.dueDate || null,
      leadId: l.id,
      createdBy: actor.userId || null,
    })),
  );
  await audit(tx, actor, { action: "lead.bulk_tasks", entityType: "lead", summary: `Created ${ls.length} tasks: ${input.title}` });
  return ls.length;
}

/* ------------------------------------------------------------------ */
/* Merge (reviewable; preserves linked records and history)            */
/* ------------------------------------------------------------------ */

const MERGEABLE_FIELDS = [
  "companyName", "website", "industry", "country", "region", "sizeBand", "acquisitionChannel", "acquisitionDetail",
  "researchNotes", "observedNeeds", "ownerId", "nextAction", "nextActionDate", "estimatedValue", "currency", "followUpDate",
] as const;
export type LeadMergeField = (typeof MERGEABLE_FIELDS)[number];

export async function previewLeadMerge(tx: Tx, sourceId: string, targetId: string) {
  const [source] = await tx.select().from(leads).where(eq(leads.id, sourceId));
  const [target] = await tx.select().from(leads).where(eq(leads.id, targetId));
  if (!source || !target) throw new NotFoundError("Lead");
  const fields = MERGEABLE_FIELDS.map((f) => ({ field: f, source: source[f], target: target[f], differs: String(source[f] ?? "") !== String(target[f] ?? "") }));
  const counts = await linkedCounts(tx, sourceId);
  return { source, target, fields, counts };
}

async function linkedCounts(tx: Tx, leadId: string) {
  const c = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  return {
    contacts: await c(tx.select({ n: sql<number>`count(*)` }).from(leadContacts).where(eq(leadContacts.leadId, leadId))),
    evidence: await c(tx.select({ n: sql<number>`count(*)` }).from(leadEvidence).where(eq(leadEvidence.leadId, leadId))),
    activities: await c(tx.select({ n: sql<number>`count(*)` }).from(activities).where(eq(activities.leadId, leadId))),
    tasks: await c(tx.select({ n: sql<number>`count(*)` }).from(tasks).where(eq(tasks.leadId, leadId))),
  };
}

/**
 * Merge `sourceId` into `targetId`. Field values are chosen per field
 * (default: keep target, fill blanks from source). Contacts, evidence,
 * service fits, status history, activities, tasks, meetings, campaign
 * memberships and enrollments move to the target. The source is kept as a
 * "merged" tombstone with a full snapshot in record_merges.
 */
export async function mergeLeads(tx: Tx, actor: Actor, sourceId: string, targetId: string, choices: Partial<Record<LeadMergeField, "source" | "target">> = {}) {
  assertCrmWrite(actor, null);
  if (sourceId === targetId) throw new ValidationError("Cannot merge a lead into itself.");
  const [source] = await tx.select().from(leads).where(eq(leads.id, sourceId)).for("update");
  const [target] = await tx.select().from(leads).where(eq(leads.id, targetId)).for("update");
  if (!source || !target) throw new NotFoundError("Lead");
  if (source.status === "merged" || target.status === "merged") throw new ValidationError("One of these leads has already been merged.");
  if (source.status === "converted") throw new ValidationError("A converted lead cannot be merged into another lead.");

  const update: Record<string, unknown> = {};
  for (const f of MERGEABLE_FIELDS) {
    const choice = choices[f] ?? (target[f] === null || target[f] === "" ? "source" : "target");
    if (choice === "source" && source[f] !== null && source[f] !== undefined) update[f] = source[f];
  }
  if (update.companyName) update.normalizedName = normalizeCompanyName(String(update.companyName));
  if (update.website) update.domain = normalizeDomain(String(update.website));
  update.tags = Array.from(new Set([...(target.tags ?? []), ...(source.tags ?? [])]));
  if (Object.keys(update).length) await tx.update(leads).set(update).where(eq(leads.id, targetId));

  const moved: Record<string, number> = {};
  const move = async (name: string, q: Promise<unknown[]>) => {
    moved[name] = (await q).length;
  };
  // Contacts: skip ones whose email already exists on the target.
  const targetEmails = (await tx.select({ e: leadContacts.normalizedEmail }).from(leadContacts).where(eq(leadContacts.leadId, targetId))).map((r) => r.e).filter(Boolean) as string[];
  await move(
    "contacts",
    tx
      .update(leadContacts)
      .set({ leadId: targetId, isPrimary: false })
      .where(and(eq(leadContacts.leadId, sourceId), targetEmails.length ? or(isNull(leadContacts.normalizedEmail), sql`${leadContacts.normalizedEmail} not in (${sql.join(targetEmails.map((e) => sql`${e}`), sql`, `)})`) : undefined))
      .returning({ id: leadContacts.id }),
  );
  await move("evidence", tx.update(leadEvidence).set({ leadId: targetId }).where(eq(leadEvidence.leadId, sourceId)).returning({ id: leadEvidence.id }));
  const targetServices = (await tx.select({ s: leadServiceFits.serviceId }).from(leadServiceFits).where(eq(leadServiceFits.leadId, targetId))).map((r) => r.s);
  await move(
    "serviceFits",
    tx
      .update(leadServiceFits)
      .set({ leadId: targetId })
      .where(and(eq(leadServiceFits.leadId, sourceId), targetServices.length ? sql`${leadServiceFits.serviceId} not in (${sql.join(targetServices.map((e) => sql`${e}`), sql`, `)})` : undefined))
      .returning({ id: leadServiceFits.id }),
  );
  await move("statusHistory", tx.update(leadStatusHistory).set({ leadId: targetId, note: sql`coalesce(${leadStatusHistory.note}, '') || ' (from merged lead)'` }).where(eq(leadStatusHistory.leadId, sourceId)).returning({ id: leadStatusHistory.id }));
  await move("activities", tx.update(activities).set({ leadId: targetId }).where(eq(activities.leadId, sourceId)).returning({ id: activities.id }));
  await move("tasks", tx.update(tasks).set({ leadId: targetId }).where(eq(tasks.leadId, sourceId)).returning({ id: tasks.id }));
  await move("events", tx.update(events).set({ leadId: targetId }).where(eq(events.leadId, sourceId)).returning({ id: events.id }));
  await move("outreachMessages", tx.update(outreachMessages).set({ leadId: targetId }).where(eq(outreachMessages.leadId, sourceId)).returning({ id: outreachMessages.id }));
  await move("enrollments", tx.update(sequenceEnrollments).set({ leadId: targetId }).where(eq(sequenceEnrollments.leadId, sourceId)).returning({ id: sequenceEnrollments.id }));
  const targetCampaigns = (await tx.select({ c: campaignMembers.campaignId }).from(campaignMembers).where(eq(campaignMembers.leadId, targetId))).map((r) => r.c);
  await move(
    "campaignMembers",
    tx
      .update(campaignMembers)
      .set({ leadId: targetId })
      .where(and(eq(campaignMembers.leadId, sourceId), targetCampaigns.length ? sql`${campaignMembers.campaignId} not in (${sql.join(targetCampaigns.map((e) => sql`${e}`), sql`, `)})` : undefined))
      .returning({ id: campaignMembers.id }),
  );

  await tx.update(leads).set({ status: "merged", mergedIntoId: targetId }).where(eq(leads.id, sourceId));
  await tx.insert(leadStatusHistory).values({ leadId: sourceId, fromStatus: source.status, toStatus: "merged", note: `Merged into ${target.companyName}`, changedBy: actor.userId || null });
  const [merge] = await tx
    .insert(recordMerges)
    .values({ entityType: "lead", sourceId, targetId, sourceSnapshot: source as unknown as Record<string, unknown>, fieldChoices: choices, movedRecords: moved, mergedBy: actor.userId || null })
    .returning();
  await logActivity(tx, actor, { type: "system", subject: `Merged duplicate lead "${source.companyName}" into this lead`, leadId: targetId, source: "system", relatedType: "record_merge", relatedId: merge.id });
  await audit(tx, actor, { action: "lead.merged", entityType: "lead", entityId: targetId, summary: `Merged ${source.companyName} into ${target.companyName}`, changes: { sourceId, moved, choices } });
  return merge;
}

/* ------------------------------------------------------------------ */
/* Conversion: lead → account + contacts (+ opportunity)               */
/* ------------------------------------------------------------------ */

export type ConvertLeadInput = {
  /** Reuse an existing account (e.g. a detected duplicate) or create one. */
  accountId?: string | null;
  leadContactIds?: string[];
  createOpportunity: boolean;
  opportunity?: {
    name: string;
    value: string;
    currency: string;
    pricingModel: PricingModel;
    serviceIds: string[];
    expectedCloseDate?: string | null;
    nextAction?: string | null;
    nextActionDate?: string | null;
  };
};

export async function convertLead(tx: Tx, actor: Actor, leadId: string, input: ConvertLeadInput) {
  const [lead] = await tx.select().from(leads).where(eq(leads.id, leadId)).for("update");
  if (!lead) throw new NotFoundError("Lead");
  assertCrmWrite(actor, lead.ownerId);
  if (lead.status === "converted") throw new ConflictError("This lead has already been converted.");
  if (lead.status === "merged") throw new ValidationError("Merged leads cannot be converted.");
  if (lead.status === "disqualified") throw new ValidationError("Re-open a disqualified lead before converting it.");

  // 1) Account: reuse existing (shared identity) or create from lead data.
  let accountId = input.accountId ?? null;
  if (accountId) {
    const [acc] = await tx.select().from(accounts).where(eq(accounts.id, accountId));
    if (!acc) throw new NotFoundError("Account");
  } else {
    const acc = await createAccount(
      tx,
      actor,
      {
        name: lead.companyName,
        website: lead.website,
        industry: lead.industry,
        country: lead.country,
        region: lead.region,
        sizeBand: lead.sizeBand,
        description: lead.observedNeeds,
        ownerId: lead.ownerId,
        acquisitionChannel: lead.acquisitionChannel,
        acquisitionCampaignId: lead.campaignId,
        acquisitionDetail: lead.acquisitionDetail,
        tags: lead.tags,
        lifecycleStatus: "prospect",
      },
      { sourceLeadId: lead.id },
    );
    accountId = acc.id;
    await tx.update(accounts).set({ acquiredAt: lead.dateAdded }).where(eq(accounts.id, acc.id));
  }

  // 2) Contacts: link existing contacts by email instead of duplicating.
  const lcs = await tx.select().from(leadContacts).where(eq(leadContacts.leadId, leadId));
  const selected = input.leadContactIds ? lcs.filter((c) => input.leadContactIds!.includes(c.id)) : lcs;
  const contactIds: string[] = [];
  for (const lc of selected) {
    const existing = lc.convertedContactId ? { id: lc.convertedContactId } : await findContactByEmail(tx, lc.email);
    let contactId: string;
    if (existing) {
      contactId = existing.id;
    } else {
      const c = await createContact(
        tx,
        actor,
        { fullName: lc.fullName, email: lc.email, phone: lc.phone, jobTitle: lc.jobTitle, linkedinUrl: lc.linkedinUrl, sourceUrl: lc.sourceUrl, primaryAccountId: accountId, ownerId: lead.ownerId },
        { sourceLeadId: lead.id },
      );
      contactId = c.id;
    }
    await tx.update(leadContacts).set({ convertedContactId: contactId }).where(eq(leadContacts.id, lc.id));
    contactIds.push(contactId);
  }

  // 3) Opportunity in the first open stage of the default pipeline.
  let opportunityId: string | null = null;
  if (input.createOpportunity) {
    if (!input.opportunity) throw new ValidationError("Opportunity details are required.");
    const services = input.opportunity.serviceIds.length ? input.opportunity.serviceIds : (await tx.select({ s: leadServiceFits.serviceId }).from(leadServiceFits).where(eq(leadServiceFits.leadId, leadId))).map((r) => r.s);
    const opp = await createOpportunity(tx, actor, {
      name: input.opportunity.name,
      accountId,
      primaryContactId: contactIds[0] ?? null,
      contactIds,
      value: input.opportunity.value,
      currency: input.opportunity.currency,
      pricingModel: input.opportunity.pricingModel,
      serviceIds: services,
      expectedCloseDate: input.opportunity.expectedCloseDate,
      ownerId: lead.ownerId,
      acquisitionChannel: lead.acquisitionChannel,
      campaignId: lead.campaignId,
      sourceLeadId: lead.id,
      businessProblem: lead.observedNeeds,
      discoveryNotes: lead.researchNotes,
      nextAction: input.opportunity.nextAction ?? lead.nextAction,
      nextActionDate: input.opportunity.nextActionDate ?? lead.nextActionDate,
    });
    opportunityId = opp.id;
  }

  // 4) Preserve research history: lead activities are linked to the account
  //    (same rows, no copies); evidence stays on the lead and remains visible.
  await tx.update(activities).set({ accountId }).where(and(eq(activities.leadId, leadId), isNull(activities.accountId)));
  await tx.update(tasks).set({ accountId, opportunityId: opportunityId ?? undefined }).where(and(eq(tasks.leadId, leadId), isNull(tasks.accountId)));
  await tx.update(events).set({ accountId }).where(and(eq(events.leadId, leadId), isNull(events.accountId)));

  await tx
    .update(leads)
    .set({ status: "converted", convertedAt: new Date(), convertedAccountId: accountId, convertedOpportunityId: opportunityId })
    .where(eq(leads.id, leadId));
  await tx.insert(leadStatusHistory).values({ leadId, fromStatus: lead.status, toStatus: "converted", changedBy: actor.userId || null, note: opportunityId ? "Converted with opportunity" : "Converted to account" });
  await logActivity(tx, actor, {
    type: "status_change",
    subject: `Lead converted${opportunityId ? " with opportunity" : ""}`,
    leadId,
    accountId,
    opportunityId,
    source: "system",
  });
  await audit(tx, actor, { action: "lead.converted", entityType: "lead", entityId: leadId, summary: `Converted ${lead.companyName}`, changes: { accountId, opportunityId, contactIds } });
  return { accountId: accountId!, opportunityId, contactIds };
}

export async function ensureProspectLifecycle(tx: Tx, actor: Actor, accountId: string) {
  const [acc] = await tx.select({ s: accounts.lifecycleStatus }).from(accounts).where(eq(accounts.id, accountId));
  if (acc && acc.s === "former") await setAccountLifecycle(tx, actor, accountId, "prospect", "New opportunity");
}
