import { beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db, makeActors, resetDb, type TestActors } from "./helpers/db";
import {
  accounts,
  activities,
  billingScheduleItems,
  contacts,
  deliverables,
  engagements,
  leadContacts,
  leadEvidence,
  leads,
  milestones,
  opportunities,
  opportunityStageHistory,
  pipelineStages,
  proposals,
  proposalVersions,
  recordMerges,
  scopeVersions,
  services,
  tasks,
} from "@/db/schema";
import { changeLeadStatus, convertLead, createLead, findLeadDuplicates, mergeLeads } from "@/server/crm/leads";
import { commitLeadImport, setImportRowDecision, stageLeadCsv, validateLeadImport } from "@/server/crm/lead-import";
import { markOpportunityLost, markOpportunityWon, moveOpportunityStage } from "@/server/crm/opportunities";
import {
  createProposal,
  decideProposalApproval,
  markProposalSent,
  recordProposalAcceptance,
  reviseProposal,
  submitProposalForApproval,
  updateProposalDraft,
} from "@/server/crm/proposals";
import { executeHandover, previewHandover } from "@/server/crm/handover";
import { importRows } from "@/db/schema";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";

let A: TestActors;
let creativeId: string;
let advisoryId: string;

beforeAll(async () => {
  await resetDb();
  A = await makeActors();
  const svc = await db.select().from(services);
  creativeId = svc.find((s) => s.key === "creative")!.id;
  advisoryId = svc.find((s) => s.key === "advisory")!.id;
});

describe("lead import → validate → duplicates → qualify → opportunity", () => {
  it("imports a CSV with mapping, row-level errors and duplicate review", async () => {
    // Existing lead the file will duplicate (same domain).
    const existing = await db.transaction((tx) =>
      createLead(tx, A.sales, { companyName: "Harbor Analytics", website: "https://www.harbor-analytics.com", contacts: [{ fullName: "Mia Ross", email: "mia@harbor-analytics.com" }] }),
    );
    const csv = [
      "Company,Website,Contact,Email,Channel,Services,Value,Currency,Next action date",
      "Northwind Foods,northwind.example,Ana Diaz,ana@northwind.example,LinkedIn,creative,25000,USD,2026-11-01",
      "Harbor Analytics Ltd,harbor-analytics.com,Ben Ng,ben@harbor-analytics.com,Referral,advisory,,,",
      ",nobody.example,No Name,bad-email,Cold email,,abc,,2026-13-40",
      "Northwind Foods Inc.,https://northwind.example,Ana Diaz,ana@northwind.example,LinkedIn,,,,",
    ].join("\n");
    const batch = await db.transaction((tx) => stageLeadCsv(tx, A.sales, { fileName: "leads.csv", csv }));
    expect(batch.totalRows).toBe(4);
    const mapping = { companyName: "Company", website: "Website", contactName: "Contact", contactEmail: "Email", acquisitionChannel: "Channel", services: "Services", estimatedValue: "Value", currency: "Currency", nextActionDate: "Next action date" };
    const v = await db.transaction((tx) => validateLeadImport(tx, A.sales, batch.id, mapping));
    expect(v.validRows).toBe(1);
    expect(v.errorRows).toBe(1);
    expect(v.duplicateRows).toBe(2);
    const rows = await db.select().from(importRows).where(eq(importRows.batchId, batch.id));
    const bad = rows.find((r) => r.rowNumber === 3)!;
    expect(bad.errors!.join(" ")).toMatch(/Company name is required/);
    expect(bad.errors!.join(" ")).toMatch(/Email "bad-email" is not valid/);
    expect(bad.errors!.join(" ")).toMatch(/not a number/);
    const harbor = rows.find((r) => r.rowNumber === 2)!;
    expect(harbor.duplicates!.some((d) => d.type === "lead" && d.id === existing.id)).toBe(true);
    expect(harbor.decision).toBe("skip");
    const repeat = rows.find((r) => r.rowNumber === 4)!;
    expect(repeat.duplicates!.some((d) => d.type === "file_row")).toBe(true);
    // Rows with errors cannot be imported
    await expect(db.transaction((tx) => setImportRowDecision(tx, A.sales, bad.id, "import"))).rejects.toThrow(ValidationError);
    // Reviewer merges the Harbor row into the existing lead
    await db.transaction((tx) => setImportRowDecision(tx, A.sales, harbor.id, "merge", existing.id));
    const res = await db.transaction((tx) => commitLeadImport(tx, A.sales, batch.id));
    expect(res).toEqual({ created: 1, merged: 1 });
    // committing twice is rejected
    await expect(db.transaction((tx) => commitLeadImport(tx, A.sales, batch.id))).rejects.toThrow(ConflictError);
    const harborContacts = await db.select().from(leadContacts).where(eq(leadContacts.leadId, existing.id));
    expect(harborContacts.map((c) => c.fullName).sort()).toEqual(["Ben Ng", "Mia Ross"]);
    const [nw] = await db.select().from(leads).where(eq(leads.normalizedName, "northwind foods"));
    expect(nw.domain).toBe("northwind.example");
    expect(nw.acquisitionChannel).toBe("linkedin");
  });

  it("detects duplicates by normalized domain, email and company name", async () => {
    const byName = await db.transaction((tx) => findLeadDuplicates(tx, { companyName: "The Northwind Foods, LLC" }));
    expect(byName.some((d) => d.type === "lead")).toBe(true);
    const byEmail = await db.transaction((tx) => findLeadDuplicates(tx, { companyName: "Totally Different", emails: ["MIA@harbor-analytics.com "] }));
    expect(byEmail.some((d) => d.reason.includes("email") || d.reason.includes("domain"))).toBe(true);
    // free-mail domains don't create domain duplicates
    const free = await db.transaction((tx) => findLeadDuplicates(tx, { companyName: "Solo Co", emails: ["someone@gmail.com"] }));
    expect(free).toHaveLength(0);
    await expect(db.transaction((tx) => createLead(tx, A.sales, { companyName: "Northwind Foods Ltd" }))).rejects.toThrow(ConflictError);
  });

  it("merges duplicate leads preserving linked records and history", async () => {
    const a = await db.transaction((tx) => createLead(tx, A.sales, { companyName: "Cedar Labs", website: "cedarlabs.io", researchNotes: "Expanding to EU", contacts: [{ fullName: "Jo Park", email: "jo@cedarlabs.io" }] }));
    const b = await db.transaction((tx) => createLead(tx, A.sales, { companyName: "Cedar Laboratories", researchNotes: "Hiring CFO", contacts: [{ fullName: "Al Kim", email: "al@cedarlabs.io" }] }, { allowDuplicate: true }));
    await db.transaction((tx) => changeLeadStatus(tx, A.sales, b.id, "researching", "Looking at site"));
    await db.insert(activities).values({ type: "note", subject: "Call notes", leadId: b.id, source: "manual" });
    const merge = await db.transaction((tx) => mergeLeads(tx, A.sales, b.id, a.id, {}));
    expect(merge.movedRecords!.contacts).toBe(1);
    expect(merge.movedRecords!.evidence).toBe(1);
    expect(merge.movedRecords!.activities).toBe(2); // manual note + status-change entry
    const [src] = await db.select().from(leads).where(eq(leads.id, b.id));
    expect(src.status).toBe("merged");
    expect(src.mergedIntoId).toBe(a.id);
    const ev = await db.select().from(leadEvidence).where(eq(leadEvidence.leadId, a.id));
    expect(ev.map((e) => e.content).sort()).toEqual(["Expanding to EU", "Hiring CFO"]);
    const [log] = await db.select().from(recordMerges).where(eq(recordMerges.sourceId, b.id));
    expect((log.sourceSnapshot as { companyName: string }).companyName).toBe("Cedar Laboratories");
    await expect(db.transaction((tx) => mergeLeads(tx, A.sales, b.id, a.id))).rejects.toThrow(ValidationError);
  });

  it("enforces explicit qualification transitions", async () => {
    const l = await db.transaction((tx) => createLead(tx, A.sales, { companyName: "Quartz Partners" }));
    await expect(db.transaction((tx) => changeLeadStatus(tx, A.sales, l.id, "disqualified"))).rejects.toThrow(/reason/);
    await db.transaction((tx) => changeLeadStatus(tx, A.sales, l.id, "qualified"));
    await expect(db.transaction((tx) => changeLeadStatus(tx, A.sales, l.id, "converted"))).rejects.toThrow(ValidationError);
  });
});

describe("conversion, proposal, won, handover", () => {
  let accountId: string;
  let oppId: string;
  let proposalId: string;

  it("converts a qualified lead reusing an existing account and contact, preserving research", async () => {
    // Existing client account and contact (shared identity)
    const [acc] = await db.insert(accounts).values({ name: "Atlas Hotels Group", normalizedName: "atlas hotels", domain: "atlashotels.com", ownerId: A.sales.userId, lifecycleStatus: "active", billingEmail: "ap@atlashotels.com" }).returning();
    const [ct] = await db.insert(contacts).values({ fullName: "Rania Haddad", email: "rania@atlashotels.com", normalizedEmail: "rania@atlashotels.com", primaryAccountId: acc.id }).returning();
    const lead = await db.transaction((tx) =>
      createLead(tx, A.sales, { companyName: "Atlas Hotels", website: "atlashotels.com", researchNotes: "New CEO wants positioning", contacts: [{ fullName: "Rania Haddad", email: "rania@atlashotels.com" }], serviceIds: [creativeId] }, { allowDuplicate: true }),
    );
    await db.insert(activities).values({ type: "call", subject: "Intro call", leadId: lead.id, source: "manual" });
    await db.transaction((tx) => changeLeadStatus(tx, A.sales, lead.id, "qualified"));
    const res = await db.transaction((tx) =>
      convertLead(tx, A.sales, lead.id, { accountId: acc.id, createOpportunity: true, opportunity: { name: "Atlas rebrand", value: "60000", currency: "USD", pricingModel: "milestone", serviceIds: [creativeId, advisoryId], expectedCloseDate: "2026-12-01" } }),
    );
    accountId = res.accountId;
    oppId = res.opportunityId!;
    expect(res.accountId).toBe(acc.id);
    expect(res.contactIds).toEqual([ct.id]);
    expect((await db.select().from(accounts).where(eq(accounts.normalizedName, "atlas hotels"))).length).toBe(1);
    expect((await db.select().from(contacts).where(eq(contacts.normalizedEmail, "rania@atlashotels.com"))).length).toBe(1);
    const acts = await db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(acts.every((a) => a.accountId === acc.id)).toBe(true);
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    expect(opp.sourceLeadId).toBe(lead.id);
    expect(opp.discoveryNotes).toBe("New CEO wants positioning");
    await expect(db.transaction((tx) => convertLead(tx, A.sales, lead.id, { createOpportunity: false }))).rejects.toThrow(ConflictError);
  });

  it("records stage history with time in stage", async () => {
    const [stage] = await db.select().from(pipelineStages).where(eq(pipelineStages.key, "discovery_completed"));
    await db.transaction((tx) => moveOpportunityStage(tx, A.sales, oppId, stage.id, "Discovery done"));
    const hist = await db.select().from(opportunityStageHistory).where(eq(opportunityStageHistory.opportunityId, oppId));
    expect(hist).toHaveLength(2);
    expect(hist.find((h) => h.toStageId === stage.id)!.secondsInPreviousStage).toBeGreaterThanOrEqual(0);
    const [won] = await db.select().from(pipelineStages).where(eq(pipelineStages.key, "won"));
    await expect(db.transaction((tx) => moveOpportunityStage(tx, A.sales, oppId, won.id))).rejects.toThrow(/Mark won/);
  });

  it("creates, revises, approves, sends and records acceptance of a proposal", async () => {
    const p = await db.transaction((tx) =>
      createProposal(tx, A.sales, {
        opportunityId: oppId,
        title: "Atlas brand repositioning",
        content: {
          pricingModel: "milestone",
          currency: "USD",
          scope: "Brand strategy and identity",
          exclusions: "Printing",
          assumptions: "Two stakeholder workshops",
          deliverables: [
            { name: "Brand strategy deck", dueOffsetDays: 21, milestone: "Strategy" },
            { name: "Identity system", dueOffsetDays: 49, milestone: "Identity" },
          ],
          lines: [{ description: "Brand repositioning", quantity: "1", unitPrice: "55000" }],
          paymentSchedule: [
            { label: "Deposit", percent: "40", dueAfterDays: 0 },
            { label: "Strategy accepted", percent: "30", milestone: "Strategy" },
            { label: "Identity accepted", percent: "30", milestone: "Identity" },
          ],
        },
      }),
    );
    proposalId = p.id;
    await db.transaction((tx) => submitProposalForApproval(tx, A.sales, p.id));
    await expect(db.transaction((tx) => updateProposalDraft(tx, A.sales, p.id, { pricingModel: "milestone", currency: "USD", lines: [] }))).rejects.toThrow(/locked/);
    // Sales cannot approve; owner can return it
    await expect(db.transaction((tx) => decideProposalApproval(tx, A.sales, p.id, "approved"))).rejects.toThrow(ForbiddenError);
    await db.transaction((tx) => decideProposalApproval(tx, A.owner, p.id, "rejected", "Add a discovery phase"));
    const v2 = await db.transaction((tx) => reviseProposal(tx, A.sales, p.id, "Added discovery phase"));
    expect(v2.versionNumber).toBe(2);
    await db.transaction((tx) =>
      updateProposalDraft(tx, A.sales, p.id, {
        pricingModel: "milestone",
        currency: "USD",
        scope: "Discovery, brand strategy and identity",
        exclusions: "Printing",
        deliverables: [
          { name: "Brand strategy deck", dueOffsetDays: 21, milestone: "Strategy" },
          { name: "Identity system", dueOffsetDays: 49, milestone: "Identity" },
        ],
        lines: [
          { description: "Discovery", quantity: "1", unitPrice: "5000" },
          { description: "Brand repositioning", quantity: "1", unitPrice: "55000" },
        ],
        paymentSchedule: [
          { label: "Deposit", percent: "40", dueAfterDays: 0 },
          { label: "Strategy accepted", percent: "30", milestone: "Strategy" },
          { label: "Identity accepted", percent: "30", milestone: "Identity" },
        ],
      }),
    );
    await expect(db.transaction((tx) => markProposalSent(tx, A.sales, p.id))).rejects.toThrow(/approved/);
    await db.transaction((tx) => submitProposalForApproval(tx, A.sales, p.id));
    await db.transaction((tx) => decideProposalApproval(tx, A.owner, p.id, "approved"));
    await db.transaction((tx) => markProposalSent(tx, A.sales, p.id));
    const versions = await db.select().from(proposalVersions).where(eq(proposalVersions.proposalId, p.id));
    expect(versions.map((v) => v.versionNumber).sort()).toEqual([1, 2]);
    expect(versions.find((v) => v.versionNumber === 1)!.total).toBe("55000.00");
    expect(versions.find((v) => v.versionNumber === 2)!.total).toBe("60000.00");
    await expect(db.transaction((tx) => recordProposalAcceptance(tx, A.sales, p.id, { acceptedAt: "2026-10-10", acceptedByName: "Rania Haddad", method: "signed_document" }))).rejects.toThrow(/evidence/);
    await expect(db.transaction((tx) => recordProposalAcceptance(tx, A.sales, p.id, { acceptedAt: "2026-10-10", acceptedByName: "Rania", method: "verified_esignature" as "manual_record" }))).rejects.toThrow(/integration/);
    await db.transaction((tx) => recordProposalAcceptance(tx, A.sales, p.id, { acceptedAt: "2026-10-10", acceptedByName: "Rania Haddad", method: "email_confirmation", evidenceNote: "Email 10 Oct 'we accept v2'" }));
    const [prop] = await db.select().from(proposals).where(eq(proposals.id, p.id));
    expect(prop.status).toBe("accepted");
    const [opp] = await db.select({ o: opportunities, key: pipelineStages.key }).from(opportunities).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).where(eq(opportunities.id, oppId));
    expect(opp.o.acceptedProposalVersionId).toBe(v2.id);
    expect(opp.key).toBe("negotiation");
  });

  it("marks won without creating revenue, then hands over once using the existing account", async () => {
    await db.transaction((tx) => markOpportunityWon(tx, A.sales, oppId));
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, oppId));
    expect(opp.status).toBe("won");
    expect((await db.execute(`select count(*)::int as n from journal_entries`)).rows[0]).toEqual({ n: 0 });
    expect((await db.execute(`select count(*)::int as n from invoices`)).rows[0]).toEqual({ n: 0 });

    const plan = await db.transaction((tx) => previewHandover(tx, oppId));
    expect(plan.account.id).toBe(accountId);
    expect(plan.milestones.map((m) => m.name)).toEqual(["Strategy", "Identity"]);
    expect(plan.billingSchedule.map((b) => b.amount)).toEqual(["24000.00", "18000.00", "18000.00"]);
    expect(plan.warnings.some((w) => w.includes("2 services"))).toBe(true);

    // Team members cannot hand over (no delivery.write on all); account managers can.
    const eng = await db.transaction((tx) => executeHandover(tx, A.operations_manager, oppId, { memberIds: [A.team_member.userId] }));
    expect(eng.accountId).toBe(accountId);
    expect(eng.acceptedProposalVersionId).toBe(opp.acceptedProposalVersionId);
    await expect(db.transaction((tx) => executeHandover(tx, A.operations_manager, oppId))).rejects.toThrow(ConflictError);
    // Concurrent double-submit still yields exactly one engagement
    await Promise.allSettled([db.transaction((tx) => executeHandover(tx, A.owner, oppId)), db.transaction((tx) => executeHandover(tx, A.owner, oppId))]);
    expect((await db.select().from(engagements).where(eq(engagements.opportunityId, oppId))).length).toBe(1);

    const scope = await db.select().from(scopeVersions).where(eq(scopeVersions.engagementId, eng.id));
    expect(scope[0].inScope).toContain("Discovery");
    expect(scope[0].exclusions).toBe("Printing");
    expect((await db.select().from(milestones).where(eq(milestones.engagementId, eng.id))).length).toBe(2);
    expect((await db.select().from(deliverables).where(eq(deliverables.engagementId, eng.id))).length).toBe(2);
    const onboarding = await db.select().from(tasks).where(and(eq(tasks.engagementId, eng.id), eq(tasks.kind, "onboarding")));
    expect(onboarding.length).toBeGreaterThanOrEqual(5);
    const billing = await db.select().from(billingScheduleItems).where(eq(billingScheduleItems.engagementId, eng.id));
    expect(billing.every((b) => b.status === "draft")).toBe(true);
    expect(billing.filter((b) => b.milestoneId).length).toBe(2);
    await expect(db.transaction((tx) => markOpportunityLost(tx, A.sales, oppId, { lostReason: "x" }))).rejects.toThrow(/engagement/);
  });
});
