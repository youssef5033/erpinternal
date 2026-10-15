import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  account,
  channels,
  contactRoleDefinitions,
  expenseCategories,
  forecastScenarios,
  integrations,
  ledgerAccounts,
  lookupValues,
  organizationSettings,
  pipelineStages,
  pipelines,
  rolePermissions,
  roles,
  services,
  user,
  userRoles,
} from "@/db/schema";
import { hashPassword } from "better-auth/crypto";
import { DEFAULT_ROLES, type RoleKey } from "../auth/permissions";
import { DEFAULT_COA, DEFAULT_EXPENSE_CATEGORIES } from "../finance/coa";

export const DEFAULT_SERVICES = [
  { key: "creative", name: "Creative Direction", shortName: "Creative", templateKind: "creative" as const, color: "#8a5a44", description: "Branding, creative strategy, marketing, campaigns, websites and content.", sortOrder: 1 },
  { key: "advisory", name: "Strategy, Financial & Operational Advisory", shortName: "Advisory", templateKind: "advisory" as const, color: "#2f5d62", description: "Strategy, financial models, operational improvement, research and implementation.", sortOrder: 2 },
  { key: "executive", name: "Executive Communication", shortName: "Executive", templateKind: "executive" as const, color: "#5b5f97", description: "Personal branding, executive positioning, thought leadership, presentations, speeches and communications.", sortOrder: 3 },
];

export const DEFAULT_STAGES = [
  { key: "qualified", name: "Qualified", probability: 10, kind: "open" as const, staleAfterDays: 14 },
  { key: "discovery_scheduled", name: "Discovery scheduled", probability: 20, kind: "open" as const, staleAfterDays: 14 },
  { key: "discovery_completed", name: "Discovery completed", probability: 35, kind: "open" as const, staleAfterDays: 14 },
  { key: "proposal_preparing", name: "Proposal preparing", probability: 50, kind: "open" as const, staleAfterDays: 10 },
  { key: "proposal_sent", name: "Proposal sent", probability: 60, kind: "open" as const, staleAfterDays: 14 },
  { key: "negotiation", name: "Negotiation", probability: 80, kind: "open" as const, staleAfterDays: 14 },
  { key: "won", name: "Won", probability: 100, kind: "won" as const, staleAfterDays: null },
  { key: "lost", name: "Lost", probability: 0, kind: "lost" as const, staleAfterDays: null },
];

const CHANNELS = [
  ["linkedin", "LinkedIn", true],
  ["cold_email", "Cold email", true],
  ["referral", "Referral", false],
  ["inbound", "Inbound enquiry", false],
  ["partnership", "Partnership", false],
  ["call", "Call", true],
  ["event", "Event", false],
  ["content", "Content / thought leadership", false],
  ["other", "Other", false],
] as const;

const CONTACT_ROLES = [
  ["decision_maker", "Decision-maker"],
  ["budget_holder", "Budget-holder"],
  ["influencer", "Influencer"],
  ["champion", "Champion"],
  ["user", "End user"],
  ["procurement", "Procurement"],
  ["blocker", "Blocker"],
];

const LOOKUPS: Record<string, string[]> = {
  lost_reason: ["Price", "Timing", "Chose competitor", "No budget", "No decision", "Scope mismatch", "Went in-house", "Other"],
  industry: ["Financial services", "Real estate", "Hospitality", "Healthcare", "Technology", "Professional services", "Consumer & retail", "Education", "Energy", "Public sector", "Non-profit", "Manufacturing", "Other"],
  size_band: ["1–10", "11–50", "51–200", "201–1,000", "1,000+"],
};

const INTEGRATIONS = [
  { kind: "email" as const, provider: "smtp_or_api", displayName: "Email sending & sync" },
  { kind: "calendar" as const, provider: "calendar", displayName: "Calendar sync" },
  { kind: "accounting" as const, provider: "accounting", displayName: "External accounting system" },
  { kind: "banking" as const, provider: "bank_feed", displayName: "Bank feed" },
  { kind: "automation" as const, provider: "webhook", displayName: "Automation webhooks" },
  { kind: "ai" as const, provider: "anthropic", displayName: "AI assistance (Anthropic)" },
];

/**
 * Idempotent reference data required by every environment (production and
 * demo): settings, roles/permissions, service streams, channels, pipeline,
 * chart of accounts, expense categories, forecast scenarios and integration
 * slots (all "not configured"). Safe to run on every deploy.
 */
export async function ensureReferenceData(tx: Tx, opts: { resetRolePermissions?: boolean } = {}) {
  await tx.insert(organizationSettings).values({ id: 1 }).onConflictDoNothing();

  for (const [key, def] of Object.entries(DEFAULT_ROLES) as [RoleKey, (typeof DEFAULT_ROLES)[RoleKey]][]) {
    const [existing] = await tx.select().from(roles).where(eq(roles.key, key));
    const role = existing ?? (await tx.insert(roles).values({ key, name: def.name, description: def.description, isSystem: true }).returning())[0];
    const current = await tx.select().from(rolePermissions).where(eq(rolePermissions.roleId, role.id));
    if (!current.length || opts.resetRolePermissions || key === "owner") {
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
      const grants = Object.entries(def.grants);
      if (grants.length) await tx.insert(rolePermissions).values(grants.map(([permission, scope]) => ({ roleId: role.id, permission, scope: scope! })));
    }
  }

  for (const s of DEFAULT_SERVICES) await tx.insert(services).values(s).onConflictDoNothing({ target: services.key });
  for (const [i, [key, label, isOutreach]] of CHANNELS.entries()) await tx.insert(channels).values({ key, label, isOutreach, sortOrder: i }).onConflictDoNothing({ target: channels.key });
  for (const [i, [key, label]] of CONTACT_ROLES.entries()) await tx.insert(contactRoleDefinitions).values({ key, label, sortOrder: i }).onConflictDoNothing({ target: contactRoleDefinitions.key });
  for (const [listKey, values] of Object.entries(LOOKUPS)) {
    const existing = await tx.select().from(lookupValues).where(eq(lookupValues.listKey, listKey));
    if (!existing.length) await tx.insert(lookupValues).values(values.map((value, i) => ({ listKey, value, sortOrder: i })));
  }

  let [pipeline] = await tx.select().from(pipelines).where(eq(pipelines.isDefault, true));
  if (!pipeline) [pipeline] = await tx.insert(pipelines).values({ name: "New business", isDefault: true }).returning();
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id));
  if (!stages.length) await tx.insert(pipelineStages).values(DEFAULT_STAGES.map((s, i) => ({ ...s, pipelineId: pipeline.id, sortOrder: i + 1 })));

  const svc = await tx.select().from(services);
  for (const a of DEFAULT_COA) {
    await tx
      .insert(ledgerAccounts)
      .values({ code: a.code, name: a.name, type: a.type, subtype: a.subtype, systemKey: a.systemKey ?? null, isDirectCost: !!a.isDirectCost, description: a.description ?? null, serviceId: a.serviceKey ? svc.find((s) => s.key === a.serviceKey)?.id ?? null : null })
      .onConflictDoNothing({ target: ledgerAccounts.code });
  }
  const accs = await tx.select().from(ledgerAccounts);
  for (const c of DEFAULT_EXPENSE_CATEGORIES) {
    const la = accs.find((a) => a.code === c.code);
    if (la) await tx.insert(expenseCategories).values({ name: c.name, ledgerAccountId: la.id }).onConflictDoNothing({ target: expenseCategories.name });
  }
  for (const sc of [
    { key: "base" as const, name: "Base", collectionDelayDays: 0, collectionRatePercent: 100, pipelineInclusionPercent: 0, expenseMultiplierPercent: 100, notes: "Invoices collected on due date; no unsigned pipeline." },
    { key: "conservative" as const, name: "Conservative", collectionDelayDays: 21, collectionRatePercent: 90, pipelineInclusionPercent: 0, expenseMultiplierPercent: 110, notes: "Late, partial collections and 10% higher costs." },
    { key: "upside" as const, name: "Upside", collectionDelayDays: 0, collectionRatePercent: 100, pipelineInclusionPercent: 50, expenseMultiplierPercent: 100, notes: "Adds half of the weighted pipeline." },
  ]) {
    await tx.insert(forecastScenarios).values(sc).onConflictDoNothing({ target: forecastScenarios.key });
  }
  for (const i of INTEGRATIONS) await tx.insert(integrations).values({ ...i, status: "not_configured" }).onConflictDoNothing();
}

/** Create (or update the password of) a user with roles. Used by setup and seeds. */
export async function upsertUser(tx: Tx, input: { email: string; name: string; password: string; roleKeys: RoleKey[]; title?: string | null; timeZone?: string | null }) {
  const email = input.email.toLowerCase().trim();
  let [u] = await tx.select().from(user).where(eq(user.email, email));
  if (!u) {
    [u] = await tx.insert(user).values({ id: crypto.randomUUID(), email, name: input.name, emailVerified: true, title: input.title ?? null, timeZone: input.timeZone ?? null }).returning();
  }
  const hash = await hashPassword(input.password);
  const [acct] = await tx.select().from(account).where(and(eq(account.userId, u.id), eq(account.providerId, "credential")));
  if (acct) await tx.update(account).set({ password: hash, updatedAt: new Date() }).where(eq(account.id, acct.id));
  else await tx.insert(account).values({ id: crypto.randomUUID(), accountId: u.id, providerId: "credential", userId: u.id, password: hash });
  const rs = await tx.select().from(roles).where(inArray(roles.key, input.roleKeys));
  await tx.delete(userRoles).where(and(eq(userRoles.userId, u.id), rs.length ? notInArray(userRoles.roleId, rs.map((r) => r.id)) : undefined));
  for (const r of rs) await tx.insert(userRoles).values({ userId: u.id, roleId: r.id }).onConflictDoNothing();
  return u;
}
