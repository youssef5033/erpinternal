import { and, eq, inArray, ne, sql } from "drizzle-orm";
import { hashPassword } from "better-auth/crypto";
import type { Tx } from "@/db/client";
import { account, channels, contactRoleDefinitions, proposalTemplates, customFieldDefinitions, integrations, lookupValues, offers, organizationSettings, pipelineStages, rolePermissions, roles, services, session, user, userRoles } from "@/db/schema";
import { toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { ALL_PERMISSIONS, type Permission, type Scope } from "../auth/permissions";
import { audit, diff } from "../audit";
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { pingProvider } from "../ai/assist";
import { credentialsKeyConfigured, decryptSecret, encryptSecret, secretHint } from "../crypto";

/* ------------------------------------------------------------------ */
/* Agency settings                                                     */
/* ------------------------------------------------------------------ */

export type SettingsInput = Partial<typeof organizationSettings.$inferInsert>;

export async function saveSettings(tx: Tx, actor: Actor, input: SettingsInput) {
  assertCan(actor, "system.settings");
  if (input.timeZone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timeZone });
    } catch {
      throw new ValidationError(`Unknown time zone "${input.timeZone}".`, { timeZone: "Use an IANA name" });
    }
  }
  if (input.fiscalYearStartMonth !== undefined && (input.fiscalYearStartMonth < 1 || input.fiscalYearStartMonth > 12)) throw new ValidationError("Fiscal year start month must be 1–12.");
  const [before] = await tx.select().from(organizationSettings).where(eq(organizationSettings.id, 1));
  if (before && input.baseCurrency && input.baseCurrency !== before.baseCurrency) {
    const [{ n }] = await tx.execute<{ n: number }>(sql`select count(*)::int as n from journal_entries`).then((r) => r.rows);
    if (n > 0) throw new ValidationError("The base currency cannot change after entries have been posted to the ledger.");
  }
  const [row] = await tx.insert(organizationSettings).values({ id: 1, ...input }).onConflictDoUpdate({ target: organizationSettings.id, set: { ...input, updatedAt: new Date() } }).returning();
  await audit(tx, actor, { action: "settings.updated", entityType: "settings", entityId: "1", summary: "Agency settings updated", changes: diff(before ?? {}, row, Object.keys(input) as (keyof typeof row)[]) });
  return row;
}

/* ------------------------------------------------------------------ */
/* Catalog: services, offers, channels, lookups, roles, custom fields  */
/* ------------------------------------------------------------------ */

export async function saveService(tx: Tx, actor: Actor, id: string, input: { name: string; shortName: string; description?: string | null; color: string; active: boolean }) {
  assertCan(actor, "system.settings");
  if (!/^#[0-9a-f]{6}$/i.test(input.color)) throw new ValidationError("Colour must be a hex value like #2f5d62.");
  const [row] = await tx.update(services).set({ name: input.name.trim(), shortName: input.shortName.trim(), description: input.description || null, color: input.color, active: input.active }).where(eq(services.id, id)).returning();
  if (!row) throw new NotFoundError("Service");
  await audit(tx, actor, { action: "service.updated", entityType: "service", entityId: id, summary: `Service ${row.name}` });
}

export async function saveOffer(tx: Tx, actor: Actor, input: { id?: string | null; serviceId: string; name: string; description?: string | null; pricingModel: "fixed" | "retainer" | "milestone" | "hourly"; defaultPrice?: string | null; currency?: string | null; defaultDurationWeeks?: number | null; includedRevisions?: number | null; deliverables?: string[]; active: boolean }) {
  assertCan(actor, "system.settings");
  if (!input.name.trim()) throw new ValidationError("Name is required.");
  if (input.defaultPrice && !input.currency) throw new ValidationError("Choose a currency for the default price.");
  const values = { serviceId: input.serviceId, name: input.name.trim(), description: input.description || null, pricingModel: input.pricingModel, defaultPrice: input.defaultPrice ? toMoney(input.defaultPrice) : null, currency: input.currency || null, defaultDurationWeeks: input.defaultDurationWeeks ?? null, includedRevisions: input.includedRevisions ?? null, deliverableTemplate: (input.deliverables ?? []).map((name) => ({ name })), active: input.active };
  const [row] = input.id ? await tx.update(offers).set(values).where(eq(offers.id, input.id)).returning() : await tx.insert(offers).values(values).returning();
  await audit(tx, actor, { action: input.id ? "offer.updated" : "offer.created", entityType: "offer", entityId: row.id, summary: `Offer ${row.name}` });
  return row;
}

export async function saveListItem(tx: Tx, actor: Actor, input: { list: "channel" | "contact_role" | "lookup"; id?: string | null; listKey?: string | null; key?: string | null; label: string; active: boolean; sortOrder?: number | null }) {
  assertCan(actor, "system.settings");
  const label = input.label.trim();
  if (!label) throw new ValidationError("Label is required.");
  const slug = (input.key || label).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  if (input.list === "channel") {
    if (input.id) await tx.update(channels).set({ label, active: input.active, sortOrder: input.sortOrder ?? 0 }).where(eq(channels.id, input.id));
    else await tx.insert(channels).values({ key: slug, label, active: true, sortOrder: input.sortOrder ?? 99 }).onConflictDoNothing();
  } else if (input.list === "contact_role") {
    if (input.id) await tx.update(contactRoleDefinitions).set({ label, active: input.active, sortOrder: input.sortOrder ?? 0 }).where(eq(contactRoleDefinitions.id, input.id));
    else await tx.insert(contactRoleDefinitions).values({ key: slug, label, active: true, sortOrder: input.sortOrder ?? 99 }).onConflictDoNothing();
  } else {
    if (!input.listKey) throw new ValidationError("Missing list.");
    if (input.id) await tx.update(lookupValues).set({ value: label, active: input.active, sortOrder: input.sortOrder ?? 0 }).where(eq(lookupValues.id, input.id));
    else await tx.insert(lookupValues).values({ listKey: input.listKey, value: label, active: true, sortOrder: input.sortOrder ?? 99 });
  }
  await audit(tx, actor, { action: "catalog.list_item", entityType: input.list, entityId: input.id ?? null, summary: `${input.id ? "Updated" : "Added"} ${input.list.replace("_", " ")} "${label}"${input.active ? "" : " (inactive)"}` });
}

export async function saveCustomField(tx: Tx, actor: Actor, input: { id?: string | null; entityType: "lead" | "account" | "contact" | "opportunity" | "engagement"; label: string; fieldType: "text" | "number" | "date" | "select" | "boolean" | "url"; options?: string[]; required: boolean; active: boolean }) {
  assertCan(actor, "system.settings");
  if (!input.label.trim()) throw new ValidationError("Label is required.");
  if (input.fieldType === "select" && !input.options?.length) throw new ValidationError("Select fields need at least one option.");
  const key = input.label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
  const values = { label: input.label.trim(), fieldType: input.fieldType, options: input.fieldType === "select" ? input.options ?? [] : null, required: input.required, active: input.active };
  if (input.id) await tx.update(customFieldDefinitions).set(values).where(eq(customFieldDefinitions.id, input.id));
  else {
    const res = await tx.insert(customFieldDefinitions).values({ ...values, entityType: input.entityType, key }).onConflictDoNothing().returning();
    if (!res.length) throw new ConflictError("A field with this name already exists for that record type.");
  }
  await audit(tx, actor, { action: "custom_field.saved", entityType: "custom_field", entityId: input.id ?? null, summary: `${input.entityType}: ${input.label}` });
}

export async function saveStage(tx: Tx, actor: Actor, id: string, input: { name: string; probability: number; staleAfterDays?: number | null; sortOrder: number }) {
  assertCan(actor, "system.settings");
  const [st] = await tx.select().from(pipelineStages).where(eq(pipelineStages.id, id));
  if (!st) throw new NotFoundError("Stage");
  if (input.probability < 0 || input.probability > 100) throw new ValidationError("Probability must be 0–100.");
  if (st.kind === "won" && input.probability !== 100) throw new ValidationError("The won stage must stay at 100%.");
  if (st.kind === "lost" && input.probability !== 0) throw new ValidationError("The lost stage must stay at 0%.");
  await tx.update(pipelineStages).set({ name: input.name.trim(), probability: input.probability, staleAfterDays: input.staleAfterDays ?? null, sortOrder: input.sortOrder }).where(eq(pipelineStages.id, id));
  await audit(tx, actor, { action: "pipeline.stage_updated", entityType: "pipeline_stage", entityId: id, summary: `${st.name} → ${input.name} (${input.probability}%)` });
}

/* ------------------------------------------------------------------ */
/* Users & roles                                                       */
/* ------------------------------------------------------------------ */

function checkPassword(pw: string) {
  if (pw.length < 12) throw new ValidationError("Use at least 12 characters.", { password: "Too short" });
  if (!/[a-z]/i.test(pw) || !/\d/.test(pw)) throw new ValidationError("Include letters and numbers.", { password: "Too weak" });
}

async function ownersRemaining(tx: Tx, excludeUserId: string) {
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)` })
    .from(userRoles)
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .innerJoin(user, eq(user.id, userRoles.userId))
    .where(and(eq(roles.key, "owner"), ne(userRoles.userId, excludeUserId), eq(user.status, "active")));
  return Number(n);
}

export async function createUser(tx: Tx, actor: Actor, input: { name: string; email: string; password: string; roleIds: string[]; title?: string | null; timeZone?: string | null }) {
  assertCan(actor, "users.manage");
  const email = input.email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new ValidationError("Enter a valid email.", { email: "Invalid" });
  checkPassword(input.password);
  const [exists] = await tx.select({ id: user.id }).from(user).where(eq(user.email, email));
  if (exists) throw new ConflictError("A user with this email already exists.");
  if (!input.roleIds.length) throw new ValidationError("Assign at least one role.");
  const [u] = await tx.insert(user).values({ id: crypto.randomUUID(), email, name: input.name.trim(), emailVerified: true, title: input.title || null, timeZone: input.timeZone || null }).returning();
  await tx.insert(account).values({ id: crypto.randomUUID(), accountId: u.id, providerId: "credential", userId: u.id, password: await hashPassword(input.password) });
  for (const roleId of input.roleIds) await tx.insert(userRoles).values({ userId: u.id, roleId, grantedBy: actor.userId || null }).onConflictDoNothing();
  await audit(tx, actor, { action: "user.created", entityType: "user", entityId: u.id, summary: `Created ${email}` });
  return u;
}

export async function setUserRoles(tx: Tx, actor: Actor, userId: string, roleIds: string[]) {
  assertCan(actor, "users.manage");
  if (!roleIds.length) throw new ValidationError("Assign at least one role (or disable the user instead).");
  const rs = await tx.select().from(roles).where(inArray(roles.id, roleIds));
  if (rs.length !== roleIds.length) throw new ValidationError("Unknown role.");
  const current = await tx.select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId));
  const losingOwner = current.some((r) => r.key === "owner") && !rs.some((r) => r.key === "owner");
  if (losingOwner && (await ownersRemaining(tx, userId)) === 0) throw new ValidationError("At least one active Owner must remain.");
  if (userId === actor.userId && losingOwner) throw new ForbiddenError("You cannot remove your own Owner role.");
  await tx.delete(userRoles).where(eq(userRoles.userId, userId));
  for (const r of rs) await tx.insert(userRoles).values({ userId, roleId: r.id, grantedBy: actor.userId || null });
  await tx.delete(session).where(eq(session.userId, userId));
  await audit(tx, actor, { action: "user.roles_changed", entityType: "user", entityId: userId, summary: `Roles: ${rs.map((r) => r.name).join(", ")} (sessions ended so changes apply immediately)` });
}

export async function setUserStatus(tx: Tx, actor: Actor, userId: string, status: "active" | "disabled") {
  assertCan(actor, "users.manage");
  if (userId === actor.userId) throw new ForbiddenError("You cannot disable yourself.");
  if (status === "disabled") {
    const isOwner = (await tx.select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, userId))).some((r) => r.key === "owner");
    if (isOwner && (await ownersRemaining(tx, userId)) === 0) throw new ValidationError("At least one active Owner must remain.");
  }
  await tx.update(user).set({ status, updatedAt: new Date() }).where(eq(user.id, userId));
  if (status === "disabled") await tx.delete(session).where(eq(session.userId, userId));
  await audit(tx, actor, { action: `user.${status}`, entityType: "user", entityId: userId, summary: status === "disabled" ? "User disabled and signed out" : "User re-enabled" });
}

export async function resetUserPassword(tx: Tx, actor: Actor, userId: string, password: string) {
  assertCan(actor, "users.manage");
  checkPassword(password);
  const hash = await hashPassword(password);
  const res = await tx.update(account).set({ password: hash, updatedAt: new Date() }).where(and(eq(account.userId, userId), eq(account.providerId, "credential"))).returning({ id: account.id });
  if (!res.length) await tx.insert(account).values({ id: crypto.randomUUID(), accountId: userId, providerId: "credential", userId, password: hash });
  await tx.delete(session).where(eq(session.userId, userId));
  await audit(tx, actor, { action: "user.password_reset", entityType: "user", entityId: userId, summary: "Password reset by administrator (value not recorded); sessions ended" });
}

export async function saveRole(tx: Tx, actor: Actor, input: { id?: string | null; name: string; description?: string | null; grants: Partial<Record<Permission, Scope>> }) {
  assertCan(actor, "users.manage");
  if (!input.name.trim()) throw new ValidationError("Name is required.");
  for (const p of Object.keys(input.grants)) if (!ALL_PERMISSIONS.includes(p as Permission)) throw new ValidationError(`Unknown permission ${p}.`);
  let roleId = input.id;
  if (roleId) {
    const [r] = await tx.select().from(roles).where(eq(roles.id, roleId));
    if (!r) throw new NotFoundError("Role");
    if (r.key === "owner") throw new ForbiddenError("The Owner role always has every permission and cannot be edited.");
    await tx.update(roles).set({ name: input.name.trim(), description: input.description || null }).where(eq(roles.id, roleId));
  } else {
    const key = `custom_${input.name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
    const res = await tx.insert(roles).values({ key, name: input.name.trim(), description: input.description || null, isSystem: false }).onConflictDoNothing().returning();
    if (!res.length) throw new ConflictError("A role with this name already exists.");
    roleId = res[0].id;
  }
  await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, roleId!));
  const entries = Object.entries(input.grants).filter(([, s]) => s);
  if (entries.length) await tx.insert(rolePermissions).values(entries.map(([permission, scope]) => ({ roleId: roleId!, permission, scope: scope as Scope })));
  const affected = await tx.select({ userId: userRoles.userId }).from(userRoles).where(eq(userRoles.roleId, roleId!));
  if (affected.length) await tx.delete(session).where(inArray(session.userId, affected.map((a) => a.userId)));
  await audit(tx, actor, { action: input.id ? "role.updated" : "role.created", entityType: "role", entityId: roleId!, summary: `${input.name}: ${entries.length} permission(s); ${affected.length} user(s) signed out to apply changes`, changes: { grants: input.grants } });
  return roleId!;
}

/* ------------------------------------------------------------------ */
/* Integrations                                                        */
/* ------------------------------------------------------------------ */

/**
 * Connectors available in this build. Only the AI provider has a working
 * verification call; every other category is listed as not available, so
 * nothing can be shown as "connected" without a real successful check.
 */
export const INTEGRATION_CATALOG = [
  { kind: "ai" as const, provider: "anthropic", name: "Anthropic Claude (optional AI assistance)", available: true, note: "Drafts are labelled suggestions; nothing is sent automatically." },
  { kind: "email" as const, provider: "email", name: "Email sending (SMTP / provider)", available: false, note: "Not built in this version. Outreach runs in manual draft mode." },
  { kind: "calendar" as const, provider: "calendar", name: "Calendar sync (Google / Microsoft)", available: false, note: "Not built in this version. Meetings live in the agency calendar." },
  { kind: "banking" as const, provider: "bank_feed", name: "Bank feeds", available: false, note: "Not built in this version. Import statements as CSV." },
  { kind: "accounting" as const, provider: "accounting", name: "External accounting software", available: false, note: "Not built in this version. Export journal lines as CSV." },
  { kind: "automation" as const, provider: "webhooks", name: "Automation / webhooks", available: false, note: "Not built in this version." },
];

export async function saveAiCredential(tx: Tx, actor: Actor, apiKey: string) {
  assertCan(actor, "integrations.manage");
  if (!credentialsKeyConfigured()) throw new ValidationError("CREDENTIALS_ENCRYPTION_KEY is not set on the server, so credentials cannot be stored securely. Set it, or provide ANTHROPIC_API_KEY as a server environment variable instead.");
  const key = apiKey.trim();
  if (key.length < 20) throw new ValidationError("That does not look like an API key.");
  const values = { kind: "ai" as const, provider: "anthropic", displayName: "Anthropic Claude", status: "pending_verification" as const, encryptedCredentials: encryptSecret(key), credentialHint: secretHint(key), configuredBy: actor.userId || null, lastError: null, verifiedAt: null };
  await tx.insert(integrations).values(values).onConflictDoUpdate({ target: [integrations.kind, integrations.provider], set: { ...values, updatedAt: new Date() } });
  await audit(tx, actor, { action: "integration.credentials_saved", entityType: "integration", entityId: "ai:anthropic", summary: `AI credential stored (${secretHint(key)}); pending verification` });
}

/** Resolve the AI key: stored (encrypted) credential first, then server env. Never returned to the browser. */
export async function aiApiKey(tx: Tx): Promise<{ key: string; source: "stored" | "env" } | null> {
  const [row] = await tx.select().from(integrations).where(and(eq(integrations.kind, "ai"), eq(integrations.provider, "anthropic")));
  if (row?.status === "disabled") return null;
  if (row?.encryptedCredentials && credentialsKeyConfigured()) {
    try {
      return { key: decryptSecret(row.encryptedCredentials), source: "stored" };
    } catch {
      /* fall through */
    }
  }
  return process.env.ANTHROPIC_API_KEY ? { key: process.env.ANTHROPIC_API_KEY, source: "env" } : null;
}

/** Real verification: lists models with the key. Status becomes "connected" only on HTTP 200. */
export async function verifyAi(tx: Tx, actor: Actor) {
  assertCan(actor, "integrations.manage");
  const k = await aiApiKey(tx);
  const base = { kind: "ai" as const, provider: "anthropic", displayName: "Anthropic Claude" };
  if (!k) throw new ValidationError("No AI key is configured (stored credential or ANTHROPIC_API_KEY).");
  const { ok, error } = await pingProvider(k.key);
  const now = new Date();
  const set = ok ? { status: "connected" as const, verifiedAt: now, lastSuccessAt: now, lastError: null } : { status: "error" as const, lastErrorAt: now, lastError: error };
  await tx.insert(integrations).values({ ...base, ...set, credentialHint: k.source === "env" ? "from server environment" : undefined }).onConflictDoUpdate({ target: [integrations.kind, integrations.provider], set: { ...set, updatedAt: now } });
  await audit(tx, actor, { action: ok ? "integration.verified" : "integration.verification_failed", entityType: "integration", entityId: "ai:anthropic", summary: ok ? `AI provider verified (key ${k.source})` : `Verification failed: ${error}` });
  return { ok, error };
}

export async function disableIntegration(tx: Tx, actor: Actor, kind: "ai", provider: string) {
  assertCan(actor, "integrations.manage");
  await tx.update(integrations).set({ status: "disabled", encryptedCredentials: null, credentialHint: null, verifiedAt: null }).where(and(eq(integrations.kind, kind), eq(integrations.provider, provider)));
  await audit(tx, actor, { action: "integration.disabled", entityType: "integration", entityId: `${kind}:${provider}`, summary: "Integration disabled and stored credential deleted" });
}

/* ------------------------------------------------------------------ */
/* Proposal templates                                                  */
/* ------------------------------------------------------------------ */

export async function saveProposalTemplate(tx: Tx, actor: Actor, input: { id?: string | null; name: string; serviceId?: string | null; offerId?: string | null; introduction?: string | null; scope?: string | null; deliverables: string[]; exclusions?: string | null; assumptions?: string | null; timeline?: string | null; terms?: string | null; pricingModel?: "fixed" | "retainer" | "milestone" | "hourly" | null; active: boolean }) {
  assertCan(actor, "system.settings");
  if (!input.name.trim()) throw new ValidationError("Name is required.");
  const values = { name: input.name.trim(), serviceId: input.serviceId || null, offerId: input.offerId || null, introduction: input.introduction || null, scope: input.scope || null, deliverables: input.deliverables.map((name) => ({ name })), exclusions: input.exclusions || null, assumptions: input.assumptions || null, timeline: input.timeline || null, terms: input.terms || null, pricingModel: input.pricingModel || null, active: input.active };
  const [row] = input.id ? await tx.update(proposalTemplates).set(values).where(eq(proposalTemplates.id, input.id)).returning() : await tx.insert(proposalTemplates).values(values).returning();
  await audit(tx, actor, { action: input.id ? "proposal_template.updated" : "proposal_template.created", entityType: "proposal_template", entityId: row.id, summary: row.name });
}
