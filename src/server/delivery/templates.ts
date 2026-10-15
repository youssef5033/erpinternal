import { and, eq, max } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { engagements, workspaceItems } from "@/db/schema";
import type { Actor } from "../auth/actor";
import { assertEngagementAccess } from "../auth/scope";
import { audit } from "../audit";
import { NotFoundError, ValidationError } from "../errors";

/**
 * Service-specific delivery templates. Each engagement's workspace shows the
 * item types of its service stream; records live in `workspace_items` with the
 * typed fields below stored in `data`.
 */
export type FieldDef = { key: string; label: string; type: "text" | "textarea" | "date" | "number" | "url" | "select"; options?: string[]; required?: boolean };
export type ItemTypeDef = { key: string; label: string; plural: string; description: string; statuses: string[]; fields: FieldDef[]; scheduled?: boolean; channel?: boolean; requiresSource?: boolean };

export const TEMPLATES: Record<"creative" | "advisory" | "executive", ItemTypeDef[]> = {
  creative: [
    { key: "creative_brief", label: "Creative brief", plural: "Creative briefs", description: "Objective, audience, message and mandatories agreed before work starts.", statuses: ["draft", "agreed", "superseded"], fields: [ { key: "objective", label: "Objective", type: "textarea", required: true }, { key: "audience", label: "Audience", type: "textarea" }, { key: "keyMessage", label: "Key message", type: "textarea" }, { key: "mandatories", label: "Mandatories", type: "textarea" }, { key: "budget", label: "Production budget", type: "number" } ] },
    { key: "brand_asset", label: "Brand asset", plural: "Brand assets & guidelines", description: "Logos, fonts, guidelines and usage rules (files in Documents).", statuses: ["requested", "received", "approved"], fields: [ { key: "assetType", label: "Asset type", type: "select", options: ["Logo", "Typeface", "Colour palette", "Guidelines", "Photography", "Template", "Other"] }, { key: "usage", label: "Usage notes", type: "textarea" }, { key: "link", label: "Link", type: "url" } ] },
    { key: "campaign_plan", label: "Campaign plan", plural: "Campaign plans", description: "Objectives, channels, timing and budget per campaign.", statuses: ["draft", "approved", "live", "completed"], fields: [ { key: "objective", label: "Objective", type: "textarea", required: true }, { key: "channels", label: "Channels", type: "text" }, { key: "start", label: "Start", type: "date" }, { key: "end", label: "End", type: "date" }, { key: "budget", label: "Media budget", type: "number" } ] },
    { key: "content_item", label: "Content calendar item", plural: "Content calendar", description: "Planned content by channel and date.", statuses: ["planned", "in_production", "client_review", "approved", "scheduled", "published"], scheduled: true, channel: true, fields: [ { key: "format", label: "Format", type: "select", options: ["Post", "Video", "Article", "Email", "Ad", "Landing page"] }, { key: "copy", label: "Copy / notes", type: "textarea" } ] },
    { key: "production_budget", label: "Production budget line", plural: "Production budget", description: "Planned production costs; actuals come from approved bills and expenses.", statuses: ["planned", "committed", "spent"], fields: [ { key: "supplier", label: "Supplier", type: "text" }, { key: "amount", label: "Planned amount", type: "number", required: true }, { key: "notes", label: "Notes", type: "textarea" } ] },
    { key: "campaign_result", label: "Campaign result", plural: "Campaign results", description: "Manually entered or imported results — always with a source.", statuses: ["reported", "verified"], requiresSource: true, fields: [ { key: "metric", label: "Metric", type: "text", required: true }, { key: "value", label: "Value", type: "text", required: true }, { key: "period", label: "Period", type: "text" }, { key: "source", label: "Source (who/what reported it)", type: "text", required: true } ] },
  ],
  advisory: [
    { key: "problem_statement", label: "Problem statement & objectives", plural: "Problem statement & objectives", description: "What we are solving and what success looks like.", statuses: ["draft", "agreed"], fields: [ { key: "problem", label: "Problem", type: "textarea", required: true }, { key: "objectives", label: "Objectives", type: "textarea" }, { key: "constraints", label: "Constraints", type: "textarea" } ] },
    { key: "workstream", label: "Workstream", plural: "Workstreams", description: "Parallel streams of work and their leads.", statuses: ["planned", "active", "completed"], fields: [ { key: "lead", label: "Lead", type: "text" }, { key: "scope", label: "Scope", type: "textarea" } ] },
    { key: "hypothesis", label: "Hypothesis", plural: "Hypotheses", description: "Testable hypotheses and their evidence.", statuses: ["open", "supported", "rejected"], fields: [ { key: "statement", label: "Hypothesis", type: "textarea", required: true }, { key: "evidence", label: "Evidence", type: "textarea" } ] },
    { key: "data_request", label: "Data request", plural: "Data requests", description: "Information requested from the client, with due dates.", statuses: ["requested", "received", "overdue", "not_available"], fields: [ { key: "requestedFrom", label: "Requested from", type: "text" }, { key: "description", label: "Data needed", type: "textarea", required: true } ] },
    { key: "analysis", label: "Research / analysis", plural: "Research & analyses", description: "Analyses produced and their findings.", statuses: ["in_progress", "review", "final"], fields: [ { key: "question", label: "Question", type: "textarea" }, { key: "findings", label: "Findings", type: "textarea" } ] },
    { key: "model_version", label: "Financial model version", plural: "Financial model versions", description: "Versioned models; files stored in Documents.", statuses: ["working", "review", "issued"], fields: [ { key: "version", label: "Version", type: "text", required: true }, { key: "changes", label: "Changes", type: "textarea" }, { key: "link", label: "Link", type: "url" } ] },
    { key: "recommendation", label: "Recommendation", plural: "Recommendations", description: "Recommendations and the client's response.", statuses: ["draft", "presented", "accepted", "declined"], fields: [ { key: "recommendation", label: "Recommendation", type: "textarea", required: true }, { key: "rationale", label: "Rationale", type: "textarea" } ] },
    { key: "decision", label: "Decision", plural: "Decision log", description: "Decisions taken, by whom and when.", statuses: ["recorded"], fields: [ { key: "decision", label: "Decision", type: "textarea", required: true }, { key: "decidedBy", label: "Decided by", type: "text" }, { key: "date", label: "Date", type: "date" } ] },
    { key: "roadmap_item", label: "Implementation roadmap item", plural: "Implementation roadmap", description: "Phased implementation plan.", statuses: ["planned", "in_progress", "done", "at_risk"], fields: [ { key: "phase", label: "Phase", type: "text" }, { key: "start", label: "Start", type: "date" }, { key: "end", label: "End", type: "date" }, { key: "owner", label: "Client owner", type: "text" } ] },
    { key: "raid", label: "Risk / issue / dependency", plural: "Risks, issues & dependencies", description: "RAID log with impact and mitigation.", statuses: ["open", "mitigating", "closed"], fields: [ { key: "kind", label: "Type", type: "select", options: ["Risk", "Issue", "Dependency"], required: true }, { key: "impact", label: "Impact", type: "select", options: ["Low", "Medium", "High"] }, { key: "mitigation", label: "Mitigation", type: "textarea" } ] },
    { key: "kpi", label: "KPI", plural: "KPIs: baseline, target, outcome", description: "Baselines, targets and reported outcomes (with source).", statuses: ["tracking", "achieved", "missed"], requiresSource: true, fields: [ { key: "baseline", label: "Baseline", type: "text" }, { key: "target", label: "Target", type: "text" }, { key: "reported", label: "Reported outcome", type: "text" }, { key: "asOf", label: "As of", type: "date" }, { key: "source", label: "Source", type: "text", required: true } ] },
  ],
  executive: [
    { key: "executive_profile", label: "Executive profile & positioning", plural: "Executive profile & positioning", description: "Who they are, what they stand for, tone of voice.", statuses: ["draft", "approved"], fields: [ { key: "executive", label: "Executive", type: "text", required: true }, { key: "positioning", label: "Positioning statement", type: "textarea" }, { key: "tone", label: "Tone of voice", type: "textarea" } ] },
    { key: "audience", label: "Audience", plural: "Audiences", description: "Target audiences and what they need to hear.", statuses: ["active", "retired"], fields: [ { key: "description", label: "Who", type: "textarea", required: true }, { key: "needs", label: "What they need", type: "textarea" } ] },
    { key: "pillar", label: "Messaging pillar", plural: "Messaging pillars", description: "Core themes with proof points.", statuses: ["draft", "approved"], fields: [ { key: "theme", label: "Theme", type: "text", required: true }, { key: "proofPoints", label: "Proof points", type: "textarea" } ] },
    { key: "editorial_item", label: "Editorial item", plural: "Editorial calendar", description: "Posts, articles, speeches and presentations through drafting and approval. Publishing is recorded manually — nothing is published externally.", statuses: ["idea", "drafting", "internal_review", "executive_review", "approved", "scheduled", "published_manually"], scheduled: true, channel: true, fields: [ { key: "format", label: "Format", type: "select", options: ["LinkedIn post", "Article", "Op-ed", "Speech", "Presentation", "Newsletter", "Interview"], required: true }, { key: "pillar", label: "Pillar", type: "text" }, { key: "draft", label: "Draft / notes", type: "textarea" }, { key: "publishedUrl", label: "Published URL (manual)", type: "url" } ] },
    { key: "performance", label: "Reported performance", plural: "Reported performance", description: "Performance by channel as reported by the client or platform export — with source.", statuses: ["reported"], requiresSource: true, channel: true, fields: [ { key: "metric", label: "Metric", type: "text", required: true }, { key: "value", label: "Value", type: "text", required: true }, { key: "period", label: "Period", type: "text" }, { key: "source", label: "Source", type: "text", required: true } ] },
  ],
};

export function itemTypesFor(kind: string) {
  return TEMPLATES[kind as keyof typeof TEMPLATES] ?? [];
}

export function findItemType(kind: string, key: string) {
  return itemTypesFor(kind).find((t) => t.key === key) ?? null;
}

export async function saveWorkspaceItem(
  tx: Tx,
  actor: Actor,
  engagementId: string,
  input: { id?: string; itemType: string; title: string; status: string; dueDate?: string | null; scheduledDate?: string | null; channel?: string | null; sourceUrl?: string | null; data: Record<string, unknown>; asNewVersion?: boolean },
) {
  await assertEngagementAccess(tx, actor, engagementId, "delivery.write");
  const [eng] = await tx.select().from(engagements).where(eq(engagements.id, engagementId));
  const def = findItemType(eng.templateKind, input.itemType);
  if (!def) throw new ValidationError("Unknown item type for this service stream.");
  if (!input.title.trim()) throw new ValidationError("Title is required.");
  if (!def.statuses.includes(input.status)) throw new ValidationError("Invalid status.");
  for (const fdef of def.fields) {
    const v = input.data[fdef.key];
    if (fdef.required && (v === undefined || v === null || String(v).trim() === "")) throw new ValidationError(`${fdef.label} is required.`);
    if (fdef.type === "url" && v && !/^https?:\/\//i.test(String(v))) throw new ValidationError(`${fdef.label} must be a URL starting with http(s)://`);
  }
  if (def.requiresSource && !input.data.source) throw new ValidationError("Results must cite their source.");
  const values = { itemType: input.itemType, title: input.title.trim(), status: input.status, dueDate: input.dueDate || null, scheduledDate: input.scheduledDate || null, channel: input.channel || null, sourceUrl: input.sourceUrl || null, data: input.data };
  if (input.id && input.asNewVersion) {
    const [prev] = await tx.select().from(workspaceItems).where(eq(workspaceItems.id, input.id));
    if (!prev) throw new NotFoundError("Item");
    const [row] = await tx.insert(workspaceItems).values({ ...values, engagementId, versionNumber: prev.versionNumber + 1, supersedesId: prev.id, ownerId: prev.ownerId, createdBy: actor.userId || null }).returning();
    await audit(tx, actor, { action: "workspace.versioned", entityType: "workspace_item", entityId: row.id, summary: `${def.label} "${row.title}" v${row.versionNumber}` });
    return row;
  }
  if (input.id) {
    const [row] = await tx.update(workspaceItems).set(values).where(and(eq(workspaceItems.id, input.id), eq(workspaceItems.engagementId, engagementId))).returning();
    if (!row) throw new NotFoundError("Item");
    await audit(tx, actor, { action: "workspace.updated", entityType: "workspace_item", entityId: row.id, summary: `${def.label} "${row.title}" updated (${row.status})` });
    return row;
  }
  const [{ n }] = await tx.select({ n: max(workspaceItems.sortOrder) }).from(workspaceItems).where(eq(workspaceItems.engagementId, engagementId));
  const [row] = await tx.insert(workspaceItems).values({ ...values, engagementId, sortOrder: (n ?? 0) + 1, ownerId: actor.userId || null, createdBy: actor.userId || null }).returning();
  await audit(tx, actor, { action: "workspace.created", entityType: "workspace_item", entityId: row.id, summary: `${def.label} "${row.title}" added` });
  return row;
}
