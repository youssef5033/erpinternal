import { and, eq, ilike, isNull, ne, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accountHealthOverrides, accounts, contactAccountLinks, contacts, type AccountLifecycle } from "@/db/schema";
import { normalizeCompanyName, normalizeDomain, normalizeEmail, normalizeWebsite, splitName, isFreeEmailDomain } from "@/lib/normalize";
import type { Actor } from "../auth/actor";
import { assertCrmWrite } from "../auth/scope";
import { audit, diff } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { logActivity } from "./activities";

export type AccountInput = {
  name: string;
  website?: string | null;
  industry?: string | null;
  country?: string | null;
  region?: string | null;
  city?: string | null;
  sizeBand?: string | null;
  description?: string | null;
  lifecycleStatus?: AccountLifecycle;
  ownerId?: string | null;
  phone?: string | null;
  billingEmail?: string | null;
  billingAddress?: string | null;
  billingContactName?: string | null;
  taxIdentifier?: string | null;
  paymentTermsDays?: number | null;
  defaultCurrency?: string | null;
  acquisitionChannel?: string | null;
  acquisitionCampaignId?: string | null;
  acquisitionDetail?: string | null;
  tags?: string[];
  customFields?: Record<string, unknown>;
};

export type DuplicateCandidate = { type: "account" | "lead" | "contact"; id: string; label: string; reason: string };

/** Accounts that look like the same company (normalized name or domain). */
export async function findAccountDuplicates(tx: Tx, name: string, website?: string | null, excludeId?: string): Promise<DuplicateCandidate[]> {
  const n = normalizeCompanyName(name);
  const dom = normalizeDomain(website);
  const conds = [eq(accounts.normalizedName, n)];
  if (dom) conds.push(eq(accounts.domain, dom));
  const rows = await tx
    .select({ id: accounts.id, name: accounts.name, domain: accounts.domain, normalizedName: accounts.normalizedName })
    .from(accounts)
    .where(and(or(...conds), excludeId ? ne(accounts.id, excludeId) : undefined));
  return rows.map((r) => ({
    type: "account" as const,
    id: r.id,
    label: r.name,
    reason: dom && r.domain === dom ? `Same domain (${dom})` : "Same normalized company name",
  }));
}

function accountValues(input: AccountInput) {
  return {
    name: input.name.trim(),
    normalizedName: normalizeCompanyName(input.name),
    website: normalizeWebsite(input.website),
    domain: normalizeDomain(input.website),
    industry: input.industry || null,
    country: input.country || null,
    region: input.region || null,
    city: input.city || null,
    sizeBand: input.sizeBand || null,
    description: input.description || null,
    ownerId: input.ownerId || null,
    phone: input.phone || null,
    billingEmail: input.billingEmail || null,
    billingAddress: input.billingAddress || null,
    billingContactName: input.billingContactName || null,
    taxIdentifier: input.taxIdentifier || null,
    paymentTermsDays: input.paymentTermsDays ?? null,
    defaultCurrency: input.defaultCurrency ? input.defaultCurrency.toUpperCase() : null,
    tags: input.tags ?? [],
    customFields: input.customFields ?? {},
  };
}

export async function createAccount(tx: Tx, actor: Actor, input: AccountInput, opts: { allowDuplicate?: boolean; sourceLeadId?: string | null } = {}) {
  assertCrmWrite(actor, input.ownerId ?? actor.userId);
  if (!input.name?.trim()) throw new ValidationError("Company name is required.", { name: "Required" });
  if (!opts.allowDuplicate) {
    const dups = await findAccountDuplicates(tx, input.name, input.website);
    if (dups.length) throw new ConflictError(`An account that looks like this already exists: ${dups.map((d) => `${d.label} (${d.reason})`).join(", ")}.`);
  }
  const [row] = await tx
    .insert(accounts)
    .values({
      ...accountValues(input),
      ownerId: input.ownerId || actor.userId || null,
      lifecycleStatus: input.lifecycleStatus ?? "prospect",
      acquisitionChannel: input.acquisitionChannel || null,
      acquisitionCampaignId: input.acquisitionCampaignId || null,
      acquisitionDetail: input.acquisitionDetail || null,
      sourceLeadId: opts.sourceLeadId ?? null,
    })
    .returning();
  await audit(tx, actor, { action: "account.created", entityType: "account", entityId: row.id, summary: `Created account ${row.name}` });
  return row;
}

export async function updateAccount(tx: Tx, actor: Actor, id: string, input: AccountInput) {
  const [before] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update");
  if (!before) throw new NotFoundError("Account");
  assertCrmWrite(actor, before.ownerId);
  const values = accountValues(input);
  if (values.normalizedName !== before.normalizedName || values.domain !== before.domain) {
    const dups = await findAccountDuplicates(tx, input.name, input.website, id);
    if (dups.length) throw new ConflictError(`Another account already uses this name or domain: ${dups.map((d) => d.label).join(", ")}.`);
  }
  const [after] = await tx
    .update(accounts)
    .set({ ...values, lifecycleStatus: input.lifecycleStatus ?? before.lifecycleStatus })
    .where(eq(accounts.id, id))
    .returning();
  const changes = diff(before, after, ["name", "website", "ownerId", "lifecycleStatus", "billingEmail", "billingAddress", "taxIdentifier", "paymentTermsDays", "defaultCurrency", "industry", "country"]);
  if (Object.keys(changes).length) {
    await audit(tx, actor, { action: "account.updated", entityType: "account", entityId: id, summary: `Updated account ${after.name}`, changes });
    if (changes.ownerId) {
      await logActivity(tx, actor, { type: "system", subject: "Relationship owner changed", accountId: id, source: "system" });
    }
    if (changes.lifecycleStatus) {
      await logActivity(tx, actor, {
        type: "status_change",
        subject: `Lifecycle: ${before.lifecycleStatus} → ${after.lifecycleStatus}`,
        accountId: id,
        source: "system",
      });
    }
  }
  return after;
}

export async function setAccountLifecycle(tx: Tx, actor: Actor, id: string, status: AccountLifecycle, reason?: string) {
  const [before] = await tx.select().from(accounts).where(eq(accounts.id, id)).for("update");
  if (!before) throw new NotFoundError("Account");
  if (before.lifecycleStatus === status) return before;
  const [after] = await tx.update(accounts).set({ lifecycleStatus: status }).where(eq(accounts.id, id)).returning();
  await audit(tx, actor, {
    action: "account.lifecycle_changed",
    entityType: "account",
    entityId: id,
    summary: `Lifecycle ${before.lifecycleStatus} → ${status}${reason ? ` (${reason})` : ""}`,
    changes: { lifecycleStatus: { from: before.lifecycleStatus, to: status } },
  });
  await logActivity(tx, actor, { type: "status_change", subject: `Lifecycle: ${before.lifecycleStatus} → ${status}`, body: reason ?? null, accountId: id, source: "system" });
  return after;
}

export async function archiveAccount(tx: Tx, actor: Actor, id: string, archived: boolean) {
  const [before] = await tx.select().from(accounts).where(eq(accounts.id, id));
  if (!before) throw new NotFoundError("Account");
  assertCrmWrite(actor, before.ownerId);
  await tx.update(accounts).set({ archivedAt: archived ? new Date() : null }).where(eq(accounts.id, id));
  await audit(tx, actor, { action: archived ? "account.archived" : "account.restored", entityType: "account", entityId: id, summary: `${archived ? "Archived" : "Restored"} ${before.name}` });
}

export async function overrideAccountHealth(tx: Tx, actor: Actor, accountId: string, score: number, reason: string, expiresAt?: string | null) {
  if (score < 0 || score > 100) throw new ValidationError("Score must be between 0 and 100.");
  if (!reason.trim()) throw new ValidationError("A reason is required for a manual override.");
  await tx.update(accountHealthOverrides).set({ revokedAt: new Date() }).where(and(eq(accountHealthOverrides.accountId, accountId), isNull(accountHealthOverrides.revokedAt)));
  const [row] = await tx.insert(accountHealthOverrides).values({ accountId, score, reason, expiresAt: expiresAt || null, createdBy: actor.userId || null }).returning();
  await audit(tx, actor, { action: "account.health_override", entityType: "account", entityId: accountId, summary: `Health manually set to ${score}: ${reason}`, changes: { score, reason } });
  return row;
}

export async function revokeHealthOverride(tx: Tx, actor: Actor, accountId: string) {
  await tx.update(accountHealthOverrides).set({ revokedAt: new Date() }).where(and(eq(accountHealthOverrides.accountId, accountId), isNull(accountHealthOverrides.revokedAt)));
  await audit(tx, actor, { action: "account.health_override_revoked", entityType: "account", entityId: accountId, summary: "Manual health override removed" });
}

/* ------------------------------------------------------------------ */
/* Contacts                                                            */
/* ------------------------------------------------------------------ */

export type ContactInput = {
  fullName: string;
  primaryAccountId?: string | null;
  email?: string | null;
  phone?: string | null;
  jobTitle?: string | null;
  linkedinUrl?: string | null;
  sourceUrl?: string | null;
  preferredChannel?: "email" | "phone" | "linkedin" | "in_person" | "other" | null;
  buyingRoles?: string[];
  relationshipNotes?: string | null;
  ownerId?: string | null;
  timeZone?: string | null;
  contactRestrictions?: string | null;
  customFields?: Record<string, unknown>;
};

export async function findContactByEmail(tx: Tx, email: string | null | undefined) {
  const n = normalizeEmail(email);
  if (!n) return null;
  const [row] = await tx.select().from(contacts).where(eq(contacts.normalizedEmail, n)).limit(1);
  return row ?? null;
}

function contactValues(input: ContactInput) {
  const name = input.fullName.trim();
  const { firstName, lastName } = splitName(name);
  const email = input.email?.trim() || null;
  if (email && !normalizeEmail(email)) throw new ValidationError("Email address is not valid.", { email: "Invalid email" });
  return {
    fullName: name,
    firstName,
    lastName,
    email,
    normalizedEmail: normalizeEmail(email),
    phone: input.phone || null,
    jobTitle: input.jobTitle || null,
    linkedinUrl: input.linkedinUrl || null,
    sourceUrl: input.sourceUrl || null,
    preferredChannel: input.preferredChannel ?? null,
    buyingRoles: input.buyingRoles ?? [],
    relationshipNotes: input.relationshipNotes || null,
    ownerId: input.ownerId || null,
    timeZone: input.timeZone || null,
    contactRestrictions: input.contactRestrictions || null,
    customFields: input.customFields ?? {},
    primaryAccountId: input.primaryAccountId || null,
  };
}

export async function createContact(tx: Tx, actor: Actor, input: ContactInput, opts: { sourceLeadId?: string | null; allowDuplicate?: boolean } = {}) {
  assertCrmWrite(actor, input.ownerId ?? actor.userId);
  if (!input.fullName?.trim()) throw new ValidationError("Name is required.", { fullName: "Required" });
  const values = contactValues(input);
  if (values.normalizedEmail && !opts.allowDuplicate) {
    const existing = await findContactByEmail(tx, values.normalizedEmail);
    if (existing) throw new ConflictError(`A contact with this email already exists: ${existing.fullName}.`);
  }
  const [row] = await tx.insert(contacts).values({ ...values, ownerId: values.ownerId ?? (actor.userId || null), sourceLeadId: opts.sourceLeadId ?? null }).returning();
  await audit(tx, actor, { action: "contact.created", entityType: "contact", entityId: row.id, summary: `Created contact ${row.fullName}` });
  return row;
}

export async function updateContact(tx: Tx, actor: Actor, id: string, input: ContactInput) {
  const [before] = await tx.select().from(contacts).where(eq(contacts.id, id)).for("update");
  if (!before) throw new NotFoundError("Contact");
  assertCrmWrite(actor, before.ownerId ?? actor.userId);
  const values = contactValues(input);
  if (values.normalizedEmail && values.normalizedEmail !== before.normalizedEmail) {
    const existing = await findContactByEmail(tx, values.normalizedEmail);
    if (existing && existing.id !== id) throw new ConflictError(`Another contact already uses this email: ${existing.fullName}.`);
  }
  const [after] = await tx.update(contacts).set(values).where(eq(contacts.id, id)).returning();
  const changes = diff(before, after, ["fullName", "email", "jobTitle", "primaryAccountId", "buyingRoles", "ownerId", "preferredChannel", "contactRestrictions"]);
  if (Object.keys(changes).length) await audit(tx, actor, { action: "contact.updated", entityType: "contact", entityId: id, summary: `Updated contact ${after.fullName}`, changes });
  return after;
}

export async function linkContactToAccount(tx: Tx, actor: Actor, contactId: string, accountId: string, relationship?: string | null) {
  await tx.insert(contactAccountLinks).values({ contactId, accountId, relationship: relationship || null }).onConflictDoNothing();
  await audit(tx, actor, { action: "contact.linked", entityType: "contact", entityId: contactId, summary: `Linked contact to additional account`, changes: { accountId } });
}

export async function archiveContact(tx: Tx, actor: Actor, id: string, archived: boolean) {
  const [before] = await tx.select().from(contacts).where(eq(contacts.id, id));
  if (!before) throw new NotFoundError("Contact");
  assertCrmWrite(actor, before.ownerId ?? actor.userId);
  await tx.update(contacts).set({ archivedAt: archived ? new Date() : null }).where(eq(contacts.id, id));
  await audit(tx, actor, { action: archived ? "contact.archived" : "contact.restored", entityType: "contact", entityId: id, summary: `${archived ? "Archived" : "Restored"} ${before.fullName}` });
}

/** Quick lookup for comboboxes. */
export async function searchAccounts(tx: Tx, q: string, limit = 20) {
  const term = `%${q.trim()}%`;
  return tx
    .select({ id: accounts.id, name: accounts.name, lifecycleStatus: accounts.lifecycleStatus })
    .from(accounts)
    .where(and(isNull(accounts.archivedAt), or(ilike(accounts.name, term), ilike(sql`coalesce(${accounts.domain}, '')`, term))))
    .limit(limit);
}

export { isFreeEmailDomain };
