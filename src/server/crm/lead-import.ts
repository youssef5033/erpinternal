import { and, asc, eq, inArray } from "drizzle-orm";
import Papa from "papaparse";
import type { Tx } from "@/db/client";
import { channels, importBatches, importRows, leadContacts, leadEvidence, leadServiceFits, leads, services, user } from "@/db/schema";
import { isISODate } from "@/lib/dates";
import { normalizeCompanyName, normalizeDomain, normalizeEmail, isValidUrl, isFreeEmailDomain } from "@/lib/normalize";
import { toMoney } from "@/lib/money";
import { assertCan, type Actor } from "../auth/actor";
import { audit } from "../audit";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { createLead, findLeadDuplicates } from "./leads";

export const LEAD_IMPORT_FIELDS: { key: string; label: string; required?: boolean; hints: string[] }[] = [
  { key: "companyName", label: "Company name", required: true, hints: ["company", "company name", "organisation", "organization", "account", "business"] },
  { key: "website", label: "Website", hints: ["website", "url", "domain", "site"] },
  { key: "industry", label: "Industry", hints: ["industry", "sector", "vertical"] },
  { key: "country", label: "Country", hints: ["country", "geography", "location"] },
  { key: "region", label: "Region / city", hints: ["region", "city", "state"] },
  { key: "sizeBand", label: "Company size", hints: ["size", "employees", "company size", "headcount"] },
  { key: "acquisitionChannel", label: "Acquisition channel", hints: ["channel", "source", "lead source", "acquisition"] },
  { key: "acquisitionDetail", label: "Source detail", hints: ["source detail", "referrer", "campaign"] },
  { key: "observedNeeds", label: "Observed needs", hints: ["needs", "problem", "pain", "observed"] },
  { key: "researchNotes", label: "Research notes", hints: ["notes", "research", "comments"] },
  { key: "services", label: "Recommended services", hints: ["services", "service", "fit"] },
  { key: "estimatedValue", label: "Estimated value", hints: ["value", "estimated value", "deal size", "budget"] },
  { key: "currency", label: "Currency", hints: ["currency", "ccy"] },
  { key: "nextAction", label: "Next action", hints: ["next action", "next step"] },
  { key: "nextActionDate", label: "Next action date (yyyy-mm-dd)", hints: ["next action date", "follow up", "follow-up date", "due"] },
  { key: "tags", label: "Tags (comma separated)", hints: ["tags", "labels"] },
  { key: "ownerEmail", label: "Owner email", hints: ["owner", "owner email", "assigned to"] },
  { key: "contactName", label: "Contact name", hints: ["contact", "contact name", "name", "full name"] },
  { key: "contactTitle", label: "Contact role / title", hints: ["title", "job title", "role", "position"] },
  { key: "contactEmail", label: "Contact email (public business)", hints: ["email", "contact email", "e-mail"] },
  { key: "contactPhone", label: "Contact phone (public business)", hints: ["phone", "telephone", "mobile"] },
  { key: "contactLinkedin", label: "Contact LinkedIn URL", hints: ["linkedin"] },
  { key: "sourceUrl", label: "Source URL (evidence)", hints: ["source url", "evidence", "reference url"] },
];

export function suggestMapping(headers: string[]): Record<string, string> {
  const mapping: Record<string, string> = {};
  const used = new Set<string>();
  for (const f of LEAD_IMPORT_FIELDS) {
    const h = headers.find((x) => !used.has(x) && f.hints.includes(x.trim().toLowerCase()));
    if (h) {
      mapping[f.key] = h;
      used.add(h);
    }
  }
  return mapping;
}

export async function stageLeadCsv(tx: Tx, actor: Actor, input: { fileName: string; csv: string }) {
  assertCan(actor, "crm.import");
  const parsed = Papa.parse<Record<string, string>>(input.csv.replace(/^﻿/, ""), { header: true, skipEmptyLines: "greedy", transformHeader: (h) => h.trim() });
  if (!parsed.meta.fields?.length) throw new ValidationError("The file has no header row.");
  if (!parsed.data.length) throw new ValidationError("The file has no data rows.");
  if (parsed.data.length > 5000) throw new ValidationError("Import at most 5,000 rows at a time.");
  const [batch] = await tx
    .insert(importBatches)
    .values({ kind: "leads", fileName: input.fileName, status: "uploaded", headers: parsed.meta.fields, mapping: suggestMapping(parsed.meta.fields), totalRows: parsed.data.length, createdBy: actor.userId || null })
    .returning();
  await tx.insert(importRows).values(parsed.data.map((raw, i) => ({ batchId: batch.id, rowNumber: i + 1, raw })));
  await audit(tx, actor, { action: "lead_import.staged", entityType: "import_batch", entityId: batch.id, summary: `Uploaded ${input.fileName} (${parsed.data.length} rows)` });
  return batch;
}

type Normalized = {
  companyName: string;
  website: string | null;
  industry: string | null;
  country: string | null;
  region: string | null;
  sizeBand: string | null;
  acquisitionChannel: string | null;
  acquisitionDetail: string | null;
  observedNeeds: string | null;
  researchNotes: string | null;
  serviceIds: string[];
  estimatedValue: string | null;
  currency: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  tags: string[];
  ownerId: string | null;
  contact: { fullName: string; jobTitle: string | null; email: string | null; phone: string | null; linkedinUrl: string | null } | null;
  sourceUrl: string | null;
};

/** Apply mapping, validate each row, and detect duplicates (in DB and within the file). */
export async function validateLeadImport(tx: Tx, actor: Actor, batchId: string, mapping: Record<string, string>) {
  assertCan(actor, "crm.import");
  const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId)).for("update");
  if (!batch || batch.kind !== "leads") throw new NotFoundError("Import");
  if (batch.status === "committed") throw new ValidationError("This import was already committed.");
  if (!mapping.companyName) throw new ValidationError("Map the Company name column.");
  const rows = await tx.select().from(importRows).where(eq(importRows.batchId, batchId)).orderBy(asc(importRows.rowNumber));
  const chs = await tx.select().from(channels);
  const svcs = await tx.select().from(services);
  const users = await tx.select({ id: user.id, email: user.email }).from(user);
  const get = (raw: Record<string, string>, key: string) => (mapping[key] ? (raw[mapping[key]] ?? "").trim() : "");
  const seen = { names: new Map<string, number>(), domains: new Map<string, number>(), emails: new Map<string, number>() };
  let valid = 0, errorCount = 0, dupCount = 0;

  for (const r of rows) {
    const errors: string[] = [];
    const companyName = get(r.raw, "companyName");
    if (!companyName) errors.push("Company name is required");
    const websiteRaw = get(r.raw, "website");
    if (websiteRaw && !isValidUrl(websiteRaw)) errors.push(`Website "${websiteRaw}" is not a valid URL or domain`);
    const email = get(r.raw, "contactEmail");
    if (email && !normalizeEmail(email)) errors.push(`Email "${email}" is not valid`);
    const linkedin = get(r.raw, "contactLinkedin");
    if (linkedin && !isValidUrl(linkedin)) errors.push("LinkedIn URL is not valid");
    const sourceUrl = get(r.raw, "sourceUrl");
    if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) errors.push("Source URL must start with http(s)://");
    const valueRaw = get(r.raw, "estimatedValue").replace(/[,\s]/g, "");
    let estimatedValue: string | null = null;
    if (valueRaw) {
      if (!/^\d+(\.\d+)?$/.test(valueRaw)) errors.push(`Estimated value "${valueRaw}" is not a number`);
      else estimatedValue = toMoney(valueRaw);
    }
    const currency = get(r.raw, "currency").toUpperCase() || null;
    if (currency && !/^[A-Z]{3}$/.test(currency)) errors.push(`Currency "${currency}" must be a 3-letter code`);
    if (estimatedValue && !currency) errors.push("Currency is required when a value is given");
    const nextActionDate = get(r.raw, "nextActionDate") || null;
    if (nextActionDate && !isISODate(nextActionDate)) errors.push(`Date "${nextActionDate}" must be yyyy-mm-dd`);
    const channelRaw = get(r.raw, "acquisitionChannel");
    let acquisitionChannel: string | null = null;
    if (channelRaw) {
      const ch = chs.find((c) => c.key === channelRaw.toLowerCase().replace(/\s+/g, "_") || c.label.toLowerCase() === channelRaw.toLowerCase());
      if (!ch) errors.push(`Unknown channel "${channelRaw}" (use: ${chs.map((c) => c.label).join(", ")})`);
      else acquisitionChannel = ch.key;
    }
    const serviceIds: string[] = [];
    for (const sv of get(r.raw, "services").split(/[;,]/).map((x) => x.trim()).filter(Boolean)) {
      const m = svcs.find((s) => [s.key, s.name.toLowerCase(), s.shortName.toLowerCase()].includes(sv.toLowerCase()));
      if (!m) errors.push(`Unknown service "${sv}"`);
      else serviceIds.push(m.id);
    }
    const ownerEmail = get(r.raw, "ownerEmail");
    let ownerId: string | null = null;
    if (ownerEmail) {
      const u = users.find((x) => x.email === ownerEmail.toLowerCase());
      if (!u) errors.push(`Owner "${ownerEmail}" is not a user`);
      else ownerId = u.id;
    }
    const contactName = get(r.raw, "contactName");
    const normalized: Normalized = {
      companyName,
      website: websiteRaw || null,
      industry: get(r.raw, "industry") || null,
      country: get(r.raw, "country") || null,
      region: get(r.raw, "region") || null,
      sizeBand: get(r.raw, "sizeBand") || null,
      acquisitionChannel,
      acquisitionDetail: get(r.raw, "acquisitionDetail") || null,
      observedNeeds: get(r.raw, "observedNeeds") || null,
      researchNotes: get(r.raw, "researchNotes") || null,
      serviceIds,
      estimatedValue,
      currency,
      nextAction: get(r.raw, "nextAction") || null,
      nextActionDate,
      tags: get(r.raw, "tags").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean),
      ownerId,
      contact: contactName || email ? { fullName: contactName || email, jobTitle: get(r.raw, "contactTitle") || null, email: email || null, phone: get(r.raw, "contactPhone") || null, linkedinUrl: linkedin || null } : null,
      sourceUrl: sourceUrl || null,
    };

    let duplicates: { type: string; id: string; label: string; reason: string }[] = [];
    if (!errors.length) {
      duplicates = await findLeadDuplicates(tx, { companyName, website: websiteRaw, emails: [email] });
      const n = normalizeCompanyName(companyName);
      const dom = normalizeDomain(websiteRaw) ?? (email && !isFreeEmailDomain(normalizeDomain(email)) ? normalizeDomain(email) : null);
      const em = normalizeEmail(email);
      const earlier = (n && seen.names.get(n)) || (dom && seen.domains.get(dom)) || (em && seen.emails.get(em));
      if (earlier) duplicates.push({ type: "file_row", id: String(earlier), label: `Row ${earlier}`, reason: "Duplicate of an earlier row in this file" });
      if (n && !seen.names.has(n)) seen.names.set(n, r.rowNumber);
      if (dom && !seen.domains.has(dom)) seen.domains.set(dom, r.rowNumber);
      if (em && !seen.emails.has(em)) seen.emails.set(em, r.rowNumber);
    }
    const hasDup = duplicates.length > 0;
    if (errors.length) errorCount++;
    else if (hasDup) dupCount++;
    else valid++;
    const leadDup = duplicates.find((x) => x.type === "lead");
    await tx
      .update(importRows)
      .set({ normalized: errors.length ? null : normalized, errors, duplicates, decision: errors.length || hasDup ? "skip" : "import", mergeTargetId: leadDup?.id ?? null })
      .where(eq(importRows.id, r.id));
  }
  const [updated] = await tx.update(importBatches).set({ mapping, status: "validated", validRows: valid, errorRows: errorCount, duplicateRows: dupCount }).where(eq(importBatches.id, batchId)).returning();
  return updated;
}

/** Reviewer choice for a row: import as new, skip, or merge into an existing lead. */
export async function setImportRowDecision(tx: Tx, actor: Actor, rowId: string, decision: "import" | "skip" | "merge", mergeTargetId?: string | null) {
  assertCan(actor, "crm.import");
  const [row] = await tx.select().from(importRows).where(eq(importRows.id, rowId));
  if (!row) throw new NotFoundError("Row");
  if ((row.errors ?? []).length && decision !== "skip") throw new ValidationError("Rows with errors can only be skipped. Fix the file and re-upload.");
  if (decision === "merge") {
    const target = mergeTargetId ?? row.mergeTargetId;
    if (!target) throw new ValidationError("Choose the lead to merge into.");
    const [l] = await tx.select().from(leads).where(eq(leads.id, target));
    if (!l || l.status === "merged") throw new ValidationError("That lead cannot receive a merge.");
    await tx.update(importRows).set({ decision, mergeTargetId: target }).where(eq(importRows.id, rowId));
  } else {
    await tx.update(importRows).set({ decision }).where(eq(importRows.id, rowId));
  }
}

/** Commit: create leads for "import" rows; enrich target leads for "merge" rows. */
export async function commitLeadImport(tx: Tx, actor: Actor, batchId: string) {
  assertCan(actor, "crm.import");
  const [batch] = await tx.select().from(importBatches).where(eq(importBatches.id, batchId)).for("update");
  if (!batch) throw new NotFoundError("Import");
  if (batch.status === "committed") throw new ConflictError("This import was already committed.");
  if (batch.status !== "validated") throw new ValidationError("Validate the mapping first.");
  const rows = await tx.select().from(importRows).where(and(eq(importRows.batchId, batchId), inArray(importRows.decision, ["import", "merge"]))).orderBy(asc(importRows.rowNumber));
  let created = 0, merged = 0;
  for (const r of rows) {
    const n = r.normalized as Normalized | null;
    if (!n) continue;
    if (r.decision === "import") {
      const lead = await createLead(
        tx,
        actor,
        {
          companyName: n.companyName,
          website: n.website,
          industry: n.industry,
          country: n.country,
          region: n.region,
          sizeBand: n.sizeBand,
          acquisitionChannel: n.acquisitionChannel,
          acquisitionDetail: n.acquisitionDetail ?? `Imported from ${batch.fileName}`,
          researchNotes: n.researchNotes,
          observedNeeds: n.observedNeeds,
          estimatedValue: n.estimatedValue,
          currency: n.currency,
          nextAction: n.nextAction,
          nextActionDate: n.nextActionDate,
          tags: n.tags,
          ownerId: n.ownerId,
          serviceIds: n.serviceIds,
          contacts: n.contact ? [{ ...n.contact, sourceUrl: n.sourceUrl }] : [],
        },
        { allowDuplicate: true, importBatchId: batchId },
      );
      if (n.sourceUrl) await tx.insert(leadEvidence).values({ leadId: lead.id, kind: "source", content: `Source for imported record (${batch.fileName} row ${r.rowNumber})`, url: n.sourceUrl, createdBy: actor.userId || null });
      await tx.update(importRows).set({ resultEntityId: lead.id }).where(eq(importRows.id, r.id));
      created++;
    } else if (r.decision === "merge" && r.mergeTargetId) {
      const [target] = await tx.select().from(leads).where(eq(leads.id, r.mergeTargetId)).for("update");
      const patch: Partial<typeof leads.$inferInsert> = {};
      const fill = <K extends keyof typeof patch>(k: K, v: (typeof patch)[K] | null) => {
        if (v !== null && v !== undefined && (target[k as keyof typeof target] === null || target[k as keyof typeof target] === "")) patch[k] = v as (typeof patch)[K];
      };
      fill("website", n.website);
      if (n.website && !target.domain) patch.domain = normalizeDomain(n.website);
      fill("industry", n.industry);
      fill("country", n.country);
      fill("region", n.region);
      fill("sizeBand", n.sizeBand);
      fill("observedNeeds", n.observedNeeds);
      fill("nextAction", n.nextAction);
      fill("nextActionDate", n.nextActionDate);
      if (n.estimatedValue && !target.estimatedValue) {
        patch.estimatedValue = n.estimatedValue;
        patch.currency = n.currency;
      }
      if (n.tags.length) patch.tags = Array.from(new Set([...(target.tags ?? []), ...n.tags]));
      if (Object.keys(patch).length) await tx.update(leads).set(patch).where(eq(leads.id, target.id));
      if (n.contact) {
        const em = normalizeEmail(n.contact.email);
        const exists = em ? (await tx.select().from(leadContacts).where(and(eq(leadContacts.leadId, target.id), eq(leadContacts.normalizedEmail, em)))).length > 0 : false;
        if (!exists) await tx.insert(leadContacts).values({ leadId: target.id, fullName: n.contact.fullName, jobTitle: n.contact.jobTitle, email: n.contact.email, normalizedEmail: em, phone: n.contact.phone, linkedinUrl: n.contact.linkedinUrl, sourceUrl: n.sourceUrl });
      }
      if (n.researchNotes || n.sourceUrl) await tx.insert(leadEvidence).values({ leadId: target.id, kind: n.sourceUrl ? "source" : "note", content: n.researchNotes ?? `Merged from import ${batch.fileName} row ${r.rowNumber}`, url: n.sourceUrl, createdBy: actor.userId || null });
      if (n.serviceIds.length) await tx.insert(leadServiceFits).values(n.serviceIds.map((serviceId) => ({ leadId: target.id, serviceId }))).onConflictDoNothing();
      await audit(tx, actor, { action: "lead.import_merged", entityType: "lead", entityId: target.id, summary: `Merged import row ${r.rowNumber} of ${batch.fileName}`, changes: patch as Record<string, unknown> });
      await tx.update(importRows).set({ resultEntityId: target.id }).where(eq(importRows.id, r.id));
      merged++;
    }
  }
  await tx.update(importBatches).set({ status: "committed", importedRows: created + merged, committedAt: new Date() }).where(eq(importBatches.id, batchId));
  await audit(tx, actor, { action: "lead_import.committed", entityType: "import_batch", entityId: batchId, summary: `${batch.fileName}: ${created} created, ${merged} merged` });
  return { created, merged };
}

