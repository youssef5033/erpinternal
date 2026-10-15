import Anthropic from "@anthropic-ai/sdk";
import { and, desc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accounts, activities, aiSuggestions, contacts, engagements, opportunities, pipelineStages, proposals } from "@/db/schema";
import { assertCan, type Actor } from "../auth/actor";
import { assertAccountAccess, opportunityVisibility } from "../auth/scope";
import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";
import { aiApiKey } from "../system/admin";

/**
 * Optional AI assistance. Every output is a labelled suggestion stored with the
 * records it was built from; nothing is sent, published or saved onto a record
 * automatically. The model only sees facts recorded in the system and is told
 * not to invent contact details, budgets, replies, claims or commitments.
 */
export const AI_MODEL = process.env.AI_MODEL || "claude-opus-5-5";

const SYSTEM = `You help staff at a professional-services agency draft internal working text.
Rules you must follow:
- Use ONLY the facts provided in the user message. Do not invent names, email addresses, phone numbers, prices, budgets, dates, results, client replies, quotes or commitments.
- Where something needed is not in the facts, write a placeholder in square brackets, e.g. [confirm meeting date].
- Never state that anything has been sent, agreed or approved unless the facts say so.
- Do not promise discounts, deadlines, deliverables or scope changes. A person will review and edit your text before any use.
- Write plainly and concisely. No preamble about being an AI.`;

export type AiKind = "followup_draft" | "account_summary";
type Fact = { type: string; id: string; label: string };

async function factsForOpportunity(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx
    .select({ o: opportunities, stage: pipelineStages.name, accountName: accounts.name, contactName: contacts.fullName, contactTitle: contacts.jobTitle })
    .from(opportunities)
    .innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
    .innerJoin(accounts, eq(accounts.id, opportunities.accountId))
    .leftJoin(contacts, eq(contacts.id, opportunities.primaryContactId))
    .where(and(eq(opportunities.id, id), opportunityVisibility(actor)));
  if (!row) throw new NotFoundError("Opportunity");
  const acts = await tx.select().from(activities).where(eq(activities.opportunityId, id)).orderBy(desc(activities.occurredAt)).limit(8);
  const props = await tx.select().from(proposals).where(eq(proposals.opportunityId, id)).orderBy(desc(proposals.createdAt)).limit(3);
  const lines = [
    `Opportunity: ${row.o.name} (stage: ${row.stage}, status: ${row.o.status})`,
    `Client account: ${row.accountName}`,
    row.contactName ? `Primary contact: ${row.contactName}${row.contactTitle ? `, ${row.contactTitle}` : ""}` : "Primary contact: not recorded",
    row.o.nextAction ? `Recorded next action: ${row.o.nextAction}${row.o.nextActionDate ? ` (due ${row.o.nextActionDate})` : ""}` : "Recorded next action: none",
    row.o.businessProblem ? `Business problem (recorded): ${row.o.businessProblem}` : null,
    row.o.desiredOutcome ? `Desired outcome (recorded): ${row.o.desiredOutcome}` : null,
    row.o.discoveryNotes ? `Discovery notes: ${row.o.discoveryNotes.slice(0, 800)}` : null,
    props.length ? `Proposals: ${props.map((p) => `${p.title} — ${p.status}`).join("; ")}` : "Proposals: none",
    "Recent logged activity (newest first):",
    ...acts.map((a) => `- ${a.occurredAt.toISOString().slice(0, 10)} ${a.type}${a.direction ? ` (${a.direction})` : ""}: ${a.subject}${a.body ? ` — ${a.body.slice(0, 400)}` : ""}`),
  ].filter(Boolean) as string[];
  const refs: Fact[] = [{ type: "opportunity", id, label: row.o.name }, ...acts.map((a) => ({ type: "activity", id: a.id, label: a.subject })), ...props.map((p) => ({ type: "proposal", id: p.id, label: p.title }))];
  return { prompt: `Draft a short follow-up email to the primary contact that moves this opportunity to its next step. Output only the subject line and body.\n\nFACTS:\n${lines.join("\n")}`, refs };
}

async function factsForAccount(tx: Tx, actor: Actor, id: string) {
  await assertAccountAccess(tx, actor, id);
  const [a] = await tx.select().from(accounts).where(eq(accounts.id, id));
  if (!a) throw new NotFoundError("Account");
  const acts = await tx.select().from(activities).where(eq(activities.accountId, id)).orderBy(desc(activities.occurredAt)).limit(15);
  const engs = await tx.select().from(engagements).where(eq(engagements.accountId, id));
  const opps = await tx.select().from(opportunities).where(and(eq(opportunities.accountId, id), opportunityVisibility(actor)));
  const lines = [
    `Account: ${a.name} (lifecycle: ${a.lifecycleStatus}${a.industry ? `, industry: ${a.industry}` : ""})`,
    `Engagements: ${engs.map((e) => `${e.name} — ${e.status}${e.endDate ? `, ends ${e.endDate}` : ""}`).join("; ") || "none"}`,
    `Opportunities: ${opps.map((o) => `${o.name} — ${o.status}`).join("; ") || "none"}`,
    "Recent logged activity (newest first):",
    ...acts.map((x) => `- ${x.occurredAt.toISOString().slice(0, 10)} ${x.type}${x.direction ? ` (${x.direction})` : ""}: ${x.subject}${x.body ? ` — ${x.body.slice(0, 300)}` : ""}`),
  ];
  const refs: Fact[] = [{ type: "account", id, label: a.name }, ...acts.map((x) => ({ type: "activity", id: x.id, label: x.subject }))];
  return { prompt: `Summarise the current state of this client relationship for an internal account review: what is active, what happened recently, open questions, and suggested next steps. Use short headed sections. Mark anything you cannot determine from the facts as unknown.\n\nFACTS:\n${lines.join("\n")}`, refs };
}

export async function generateSuggestion(tx: Tx, actor: Actor, kind: AiKind, entityId: string) {
  assertCan(actor, "ai.use");
  const key = await aiApiKey(tx);
  if (!key) throw new ValidationError("AI assistance is not configured. An administrator can add a key under System → Integrations.");
  const { prompt, refs } = kind === "followup_draft" ? await factsForOpportunity(tx, actor, entityId) : await factsForAccount(tx, actor, entityId);
  const client = new Anthropic({ apiKey: key.key, maxRetries: 1, timeout: 60_000 });
  let response: Anthropic.Beta.BetaMessage;
  try {
    response = await client.beta.messages.create({
      model: AI_MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) throw new ValidationError("The AI provider rejected the key. Re-verify it under System → Integrations.");
    if (e instanceof Anthropic.RateLimitError) throw new ValidationError("The AI provider is rate-limiting requests. Try again shortly.");
    if (e instanceof Anthropic.APIError) throw new ValidationError(`The AI provider returned an error (${e.status ?? "network"}). Nothing was saved.`);
    throw new ValidationError("Could not reach the AI provider. Nothing was saved.");
  }
  if (response.stop_reason === "refusal") throw new ValidationError("The AI model declined this request. Nothing was saved.");
  const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n").trim();
  if (!text) throw new ValidationError("The AI model returned no text.");
  const [row] = await tx
    .insert(aiSuggestions)
    .values({ kind, entityType: kind === "followup_draft" ? "opportunity" : "account", entityId, provider: "anthropic", model: response.model, prompt, output: text, sourceRefs: refs, status: "suggested", createdBy: actor.userId || null })
    .returning();
  await audit(tx, actor, { action: "ai.suggestion_created", entityType: row.entityType, entityId, summary: `AI ${kind.replace("_", " ")} generated from ${refs.length} recorded item(s) (not sent)` });
  return row;
}

export async function setSuggestionStatus(tx: Tx, actor: Actor, id: string, status: "accepted" | "edited" | "discarded") {
  assertCan(actor, "ai.use");
  const [s] = await tx.select().from(aiSuggestions).where(eq(aiSuggestions.id, id));
  if (!s) throw new NotFoundError("Suggestion");
  if (s.entityType === "account") await assertAccountAccess(tx, actor, s.entityId);
  await tx.update(aiSuggestions).set({ status }).where(eq(aiSuggestions.id, id));
  await audit(tx, actor, { action: `ai.suggestion_${status}`, entityType: s.entityType, entityId: s.entityId, summary: `AI suggestion marked ${status}` });
}

/** Verification for the integrations page: lists one model with the key (official SDK). */
export async function pingProvider(apiKey: string): Promise<{ ok: boolean; error: string | null }> {
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 10_000 });
  try {
    await client.models.list({ limit: 1 });
    return { ok: true, error: null };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ok: false, error: "Provider rejected the key (401)" };
    if (e instanceof Anthropic.APIError) return { ok: false, error: `Provider returned HTTP ${e.status ?? "error"}` };
    return { ok: false, error: `Could not reach the provider: ${e instanceof Error ? e.message : "network error"}` };
  }
}
