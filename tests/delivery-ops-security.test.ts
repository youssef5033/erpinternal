import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, makeActors, resetDb, type TestActors } from "./helpers/db";
import {
  accounts,
  billingScheduleItems,
  changeRequests,
  contacts,
  deliverables,
  documents,
  engagements,
  invoices,
  jobRuns,
  opportunities,
  outreachMessages,
  scopeVersions,
  sequenceEnrollments,
  servicePeriods,
  services,
  signals,
  suppressions,
  tasks,
} from "@/db/schema";
import {
  approveChangeRequest,
  createChangeRequest,
  createDeliverable,
  createEngagement,
  defineScope,
  recordDeliverableReview,
  renewRetainer,
  submitDeliverableVersion,
} from "@/server/delivery/engagements";
import { changeTaskStatus, createTask, addTaskDependency } from "@/server/delivery/tasks";
import { createOpportunity } from "@/server/crm/opportunities";
import { enroll, generateDueDrafts, logReply, markMessageSent, recordOptOut, saveSequence, saveTemplate, suppressionFor } from "@/server/crm/outreach";
import { saveRecurringSchedule, runRecurringSchedules } from "@/server/finance/recurring";
import { generateDueBillingInvoices } from "@/server/finance/invoices";
import { refreshSignals } from "@/server/ops/signals";
import { runJob } from "@/server/jobs/registry";
import { authorizeDocumentDownload, grantDocumentAccess, uploadDocument } from "@/server/documents";
import { engagementVisibility } from "@/server/auth/scope";
import { can, SYSTEM_ACTOR } from "@/server/auth/actor";
import { DEFAULT_ROLES, MUTATING_PERMISSIONS } from "@/server/auth/permissions";
import { createLead } from "@/server/crm/leads";
import { ConflictError, ForbiddenError, ValidationError } from "@/server/errors";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO } from "@/lib/dates";

let A: TestActors;
let accountId: string;
let creativeId: string;
let execId: string;

const PDF = Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF");

beforeAll(async () => {
  await resetDb();
  A = await makeActors();
  const svc = await db.select().from(services);
  creativeId = svc.find((s) => s.key === "creative")!.id;
  execId = svc.find((s) => s.key === "executive")!.id;
  const [acc] = await db.insert(accounts).values({ name: "Solace Health", normalizedName: "solace health", ownerId: A.account_manager.userId, lifecycleStatus: "active", billingEmail: "ap@solace.example" }).returning();
  accountId = acc.id;
});

describe("delivery: scope → milestones/tasks → time → deliverable → review → approve", () => {
  it("keeps deliverable approval separate from task completion and tracks revision rounds", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.operations_manager, { name: "Brand refresh", accountId, serviceId: creativeId, billingModel: "fixed", currency: "USD", contractValue: "30000", budgetHours: "120", startDate: "2026-09-01", ownerId: A.account_manager.userId }));
    await db.transaction((tx) => defineScope(tx, A.account_manager, eng.id, { inScope: "Logo, palette, guidelines", exclusions: "Website", deliverables: [{ name: "Guidelines" }] }));
    const dl = await db.transaction((tx) => createDeliverable(tx, A.account_manager, eng.id, { name: "Brand guidelines", dueDate: "2026-10-01", includedRevisions: 1 }));
    const t1 = await db.transaction((tx) => createTask(tx, A.account_manager, { title: "Draft guidelines", engagementId: eng.id, deliverableId: dl.id, ownerId: A.account_manager.userId }));
    const t2 = await db.transaction((tx) => createTask(tx, A.account_manager, { title: "Layout guidelines", engagementId: eng.id, deliverableId: dl.id, ownerId: A.account_manager.userId }));
    await db.transaction((tx) => addTaskDependency(tx, A.account_manager, t2.id, t1.id));
    await expect(db.transaction((tx) => addTaskDependency(tx, A.account_manager, t1.id, t2.id))).rejects.toThrow(/cycle/);
    await expect(db.transaction((tx) => changeTaskStatus(tx, A.account_manager, t2.id, "completed"))).rejects.toThrow(/Waiting on/);
    await db.transaction((tx) => changeTaskStatus(tx, A.account_manager, t1.id, "completed"));
    await db.transaction((tx) => changeTaskStatus(tx, A.account_manager, t2.id, "completed"));
    let [d] = await db.select().from(deliverables).where(eq(deliverables.id, dl.id));
    expect(d.approvalStatus).toBe("not_started"); // tasks completed ≠ approved
    await db.transaction((tx) => submitDeliverableVersion(tx, A.account_manager, dl.id, { stage: "internal", notes: "v1" }));
    await expect(db.transaction((tx) => recordDeliverableReview(tx, A.account_manager, dl.id, { decision: "changes_requested" }))).rejects.toThrow(/feedback/);
    await db.transaction((tx) => recordDeliverableReview(tx, A.account_manager, dl.id, { decision: "approved" }));
    [d] = await db.select().from(deliverables).where(eq(deliverables.id, dl.id));
    expect(d.approvalStatus).toBe("awaiting_client");
    // Team member cannot record a client approval (no delivery.approve)
    await expect(db.transaction((tx) => recordDeliverableReview(tx, A.team_member, dl.id, { decision: "approved", evidence: "x" }))).rejects.toThrow(ForbiddenError);
    await expect(db.transaction((tx) => recordDeliverableReview(tx, A.account_manager, dl.id, { decision: "approved" }))).rejects.toThrow(/client approved/);
    await db.transaction((tx) => recordDeliverableReview(tx, A.account_manager, dl.id, { decision: "changes_requested", feedback: "Bolder palette" }));
    await db.transaction((tx) => submitDeliverableVersion(tx, A.account_manager, dl.id, { stage: "client", notes: "v2" }));
    const r = await db.transaction((tx) => recordDeliverableReview(tx, A.account_manager, dl.id, { decision: "changes_requested", feedback: "Again" }));
    expect(r.revisionLimitExceeded).toBe(true);
    await db.transaction((tx) => refreshSignals(tx));
    expect((await db.select().from(signals).where(and(eq(signals.ruleKey, "revision_limit_exceeded"), eq(signals.entityId, dl.id)))).length).toBe(1);
    await db.transaction((tx) => submitDeliverableVersion(tx, A.account_manager, dl.id, { stage: "client", notes: "v3" }));
    await db.transaction((tx) => recordDeliverableReview(tx, A.account_manager, dl.id, { decision: "approved", evidence: "Email from CEO 12 Oct" }));
    [d] = await db.select().from(deliverables).where(eq(deliverables.id, dl.id));
    expect(d.approvalStatus).toBe("approved");
    expect(d.currentVersionNumber).toBe(3);
  });

  it("clears a late-deliverable signal when the deliverable is approved", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.owner, { name: "Speech series", accountId, serviceId: execId, billingModel: "fixed", currency: "USD", contractValue: "9000", startDate: "2026-08-01", ownerId: A.account_manager.userId }));
    await db.update(engagements).set({ status: "active" }).where(eq(engagements.id, eng.id));
    const today = await db.transaction((tx) => agencyToday(tx));
    const dl = await db.transaction((tx) => createDeliverable(tx, A.owner, eng.id, { name: "Keynote draft", dueDate: addDaysISO(today, -3) }));
    await db.transaction((tx) => refreshSignals(tx));
    const find = () => db.select().from(signals).where(and(eq(signals.ruleKey, "deliverable_late"), eq(signals.entityId, dl.id)));
    let [s] = await find();
    expect(s.status).toBe("active");
    expect(s.href).toContain(eng.id);
    await db.transaction((tx) => submitDeliverableVersion(tx, A.owner, dl.id, { stage: "client" }));
    await db.transaction((tx) => recordDeliverableReview(tx, A.owner, dl.id, { decision: "approved", evidence: "Approved on call" }));
    await db.transaction((tx) => refreshSignals(tx));
    [s] = await find();
    expect(s.status).toBe("resolved");
    expect(s.resolution).toBe("source_resolved");
    const events = await db.execute<{ event: string }>(sql`select event from signal_events where signal_id = ${s.id} order by created_at`);
    expect(events.rows.map((e) => e.event)).toEqual(["detected", "resolved"]);
  });

  it("approves a scope change, updates budget and schedule and preserves prior scope", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.owner, { name: "Campaign", accountId, serviceId: creativeId, billingModel: "fixed", currency: "USD", contractValue: "10000", budgetHours: "40", startDate: "2026-09-01", endDate: "2026-11-30", ownerId: A.account_manager.userId }));
    const v1 = await db.transaction((tx) => defineScope(tx, A.owner, eng.id, { inScope: "3 social videos" }));
    const cr = await db.transaction((tx) => createChangeRequest(tx, A.account_manager, eng.id, { title: "Add 2 videos", proposedChanges: "Two additional 30s cut-downs", feeImpact: "4000", hoursImpact: "16", deadlineImpactDays: 14 }));
    await expect(db.transaction((tx) => approveChangeRequest(tx, A.account_manager, cr.id, { clientApprovalEvidence: "" }))).rejects.toThrow(/approval evidence/);
    const v2 = await db.transaction((tx) => approveChangeRequest(tx, A.account_manager, cr.id, { clientApprovalEvidence: "Signed change order CO-1", decisionNote: "ok" }));
    await expect(db.transaction((tx) => approveChangeRequest(tx, A.account_manager, cr.id, { clientApprovalEvidence: "again" }))).rejects.toThrow(ConflictError);
    const [e] = await db.select().from(engagements).where(eq(engagements.id, eng.id));
    expect(e.contractValue).toBe("14000.00");
    expect(e.budgetHours).toBe("56.0000");
    expect(e.endDate).toBe("2026-12-14");
    const scopes = await db.select().from(scopeVersions).where(eq(scopeVersions.engagementId, eng.id));
    expect(scopes).toHaveLength(2);
    expect(scopes.find((s) => s.id === v1.id)!.isCurrent).toBe(false);
    expect(scopes.find((s) => s.id === v1.id)!.inScope).toBe("3 social videos");
    expect(v2.inScope).toContain("Two additional");
    const [crRow] = await db.select().from(changeRequests).where(eq(changeRequests.id, cr.id));
    expect(crRow.priorScopeVersionId).toBe(v1.id);
    const bill = await db.select().from(billingScheduleItems).where(eq(billingScheduleItems.sourceId, cr.id));
    expect(bill).toHaveLength(1);
    expect(bill[0].amount).toBe("4000.00");
  });
});

describe("retainers, renewals, recurring jobs and expansion", () => {
  it("renews a retainer into the next service period without duplicates", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.owner, { name: "Exec comms retainer", accountId, serviceId: execId, billingModel: "retainer", currency: "USD", retainerAmount: "5000", retainerPeriodMonths: 3, startDate: "2026-08-01", ownerId: A.account_manager.userId }));
    const items1 = await db.select().from(billingScheduleItems).where(eq(billingScheduleItems.engagementId, eng.id));
    expect(items1).toHaveLength(3);
    const r1 = await db.transaction((tx) => renewRetainer(tx, A.account_manager, eng.id, { expectedPeriodNumber: 2 }));
    const r2 = await db.transaction((tx) => renewRetainer(tx, A.account_manager, eng.id, { expectedPeriodNumber: 2 }));
    expect(r1.created).toBe(true);
    expect(r2.created).toBe(false);
    expect(r2.period.id).toBe(r1.period.id);
    const periods = await db.select().from(servicePeriods).where(eq(servicePeriods.engagementId, eng.id));
    expect(periods.map((p) => [p.periodNumber, p.startDate, p.endDate])).toEqual([[1, "2026-08-01", "2026-10-31"], [2, "2026-11-01", "2027-01-31"]]);
    const items2 = await db.select().from(billingScheduleItems).where(eq(billingScheduleItems.engagementId, eng.id));
    expect(items2).toHaveLength(6);
    // Billing-schedule invoicing is idempotent
    const asOf = "2026-10-15";
    const a = await db.transaction((tx) => generateDueBillingInvoices(tx, SYSTEM_ACTOR, asOf));
    const b = await db.transaction((tx) => generateDueBillingInvoices(tx, SYSTEM_ACTOR, asOf));
    expect(a).toBe(3);
    expect(b).toBe(0);
    expect((await db.select().from(invoices).where(eq(invoices.engagementId, eng.id))).length).toBe(3);
  });

  it("generates recurring invoices idempotently, including retried and concurrent runs", async () => {
    const s = await db.transaction((tx) => saveRecurringSchedule(tx, A.finance, { name: "Hosting & care", accountId, frequency: "monthly", nextRunDate: "2026-08-01", currency: "USD", lines: [{ description: "Website care plan", quantity: "1", unitPrice: "450" }] }));
    const first = await db.transaction((tx) => runRecurringSchedules(tx, SYSTEM_ACTOR, "2026-10-15"));
    expect(first).toBe(3); // Aug, Sep, Oct (catch-up)
    // Simulate a retry where nextRunDate was not advanced (crash after invoice creation)
    await db.execute(sql`update recurring_invoice_schedules set next_run_date = '2026-08-01' where id = ${s.id}`);
    const retry = await db.transaction((tx) => runRecurringSchedules(tx, SYSTEM_ACTOR, "2026-10-15"));
    expect(retry).toBe(0);
    await db.execute(sql`update recurring_invoice_schedules set next_run_date = '2026-08-01' where id = ${s.id}`);
    await Promise.allSettled([db.transaction((tx) => runRecurringSchedules(tx, SYSTEM_ACTOR, "2026-10-15")), db.transaction((tx) => runRecurringSchedules(tx, SYSTEM_ACTOR, "2026-10-15"))]);
    const invs = await db.select().from(invoices).where(eq(invoices.recurringScheduleId, s.id));
    expect(invs).toHaveLength(3);
    // The job runner records runs and skips an already-succeeded key
    const run1 = await runJob(db, "recurring-invoices", { key: "recurring-invoices:test" });
    const run2 = await runJob(db, "recurring-invoices", { key: "recurring-invoices:test" });
    expect(run1.status).toBe("succeeded");
    expect(run2.status).toBe("skipped");
    const [jr] = await db.select().from(jobRuns).where(eq(jobRuns.idempotencyKey, "recurring-invoices:test"));
    expect(jr.attempts).toBe(1);
  });

  it("tracks an expansion opportunity on the existing account", async () => {
    const [eng] = await db.select().from(engagements).where(eq(engagements.accountId, accountId)).limit(1);
    const opp = await db.transaction((tx) => createOpportunity(tx, A.account_manager, { name: "Add executive comms", accountId, kind: "expansion", parentEngagementId: eng.id, value: "18000", currency: "USD", pricingModel: "retainer", serviceIds: [execId] }));
    expect(opp.accountId).toBe(accountId);
    expect(opp.kind).toBe("expansion");
    expect((await db.select().from(accounts).where(eq(accounts.normalizedName, "solace health"))).length).toBe(1);
    const [o] = await db.select().from(opportunities).where(eq(opportunities.id, opp.id));
    expect(o.parentEngagementId).toBe(eng.id);
  });
});

describe("outreach: drafts, manual send, reply, opt-out suppression", () => {
  it("stops sequences on opt-out and blocks future outreach", async () => {
    const [ct] = await db.insert(contacts).values({ fullName: "Omar Saleh", firstName: "Omar", email: "omar@solace.example", normalizedEmail: "omar@solace.example", primaryAccountId: accountId }).returning();
    const [ct2] = await db.insert(contacts).values({ fullName: "Lea Wu", firstName: "Lea", email: "lea@solace.example", normalizedEmail: "lea@solace.example", primaryAccountId: accountId }).returning();
    const tpl = await db.transaction((tx) => saveTemplate(tx, A.sales, { name: "Intro", channel: "email", subject: "Hello {{first_name}}", body: "Hi {{first_name}}, about {{company}} and {{budget}}" }));
    const seqId = await db.transaction((tx) => saveSequence(tx, A.sales, { name: "Exec intro", steps: [{ dayOffset: 0, channel: "email", templateId: tpl.id }, { dayOffset: 3, channel: "linkedin", instructions: "Connect" }] }));
    const e1 = await db.transaction((tx) => enroll(tx, A.sales, seqId, { contactId: ct.id }));
    await db.transaction((tx) => enroll(tx, A.sales, seqId, { contactId: ct2.id }));
    await expect(db.transaction((tx) => enroll(tx, A.sales, seqId, { contactId: ct.id }))).rejects.toThrow(ConflictError);
    const n1 = await db.transaction((tx) => generateDueDrafts(tx, SYSTEM_ACTOR, new Date(Date.now() + 86400000)));
    const n2 = await db.transaction((tx) => generateDueDrafts(tx, SYSTEM_ACTOR, new Date(Date.now() + 86400000)));
    expect(n1).toBe(2);
    expect(n2).toBe(0);
    const [draft] = await db.select().from(outreachMessages).where(eq(outreachMessages.enrollmentId, e1.id));
    expect(draft.subject).toBe("Hello Omar");
    expect(draft.body).toContain("[missing: budget]"); // never invents data
    expect(draft.status).toBe("draft");
    await expect(db.transaction((tx) => markMessageSent(tx, A.read_only, draft.id))).rejects.toThrow(ForbiddenError);
    await db.transaction((tx) => markMessageSent(tx, A.sales, draft.id));
    await expect(db.transaction((tx) => markMessageSent(tx, A.sales, draft.id))).rejects.toThrow(/already/);
    // Lea replies → her enrollment stops
    const rep = await db.transaction((tx) => logReply(tx, A.sales, { contactId: ct2.id, channel: "email", sentiment: "positive", body: "Let's talk" }));
    expect(rep.stoppedEnrollments).toBe(1);
    // Omar opts out → enrollment stopped, drafts cancelled, suppression recorded
    const out = await db.transaction((tx) => recordOptOut(tx, A.sales, { contactId: ct.id, note: "Asked not to be contacted" }));
    expect(out.stoppedEnrollments).toBe(1);
    const [enr] = await db.select().from(sequenceEnrollments).where(eq(sequenceEnrollments.id, e1.id));
    expect(enr.status).toBe("stopped");
    expect(enr.stoppedReason).toBe("opted_out");
    expect(await db.transaction((tx) => suppressionFor(tx, { email: "OMAR@solace.example" }))).toMatch(/Suppressed/);
    await expect(db.transaction((tx) => enroll(tx, A.sales, seqId, { contactId: ct.id }))).rejects.toThrow(/Cannot enroll/);
    // A lead contact with the same email is also suppressed
    const lead = await db.transaction((tx) => createLead(tx, A.sales, { companyName: "Omar Consulting", contacts: [{ fullName: "Omar Saleh", email: "omar@solace.example" }] }, { allowDuplicate: true }));
    const lcId = (await db.execute<{ id: string }>(sql`select id from lead_contacts where lead_id = ${lead.id}`)).rows[0].id;
    await expect(db.transaction((tx) => enroll(tx, A.sales, seqId, { leadContactId: lcId }))).rejects.toThrow(/Suppressed/);
    expect((await db.select().from(suppressions)).length).toBe(1);
  });
});

describe("roles, record scope and private documents", () => {
  it("read-only users hold no mutating permission and cannot change records", async () => {
    for (const p of MUTATING_PERMISSIONS) expect(DEFAULT_ROLES.read_only.grants[p]).toBeUndefined();
    await expect(db.transaction((tx) => createLead(tx, A.read_only, { companyName: "Nope Inc" }))).rejects.toThrow(ForbiddenError);
    await expect(db.transaction((tx) => createTask(tx, A.read_only, { title: "x" }))).rejects.toThrow(ForbiddenError);
  });

  it("sales cannot see cost rates or salaries; finance has no private HR access", () => {
    expect(can(A.sales, "costrates.read")).toBe(false);
    expect(can(A.sales, "finance.read")).toBe(false);
    expect(can(A.finance, "people.private")).toBe(false);
    expect(can(A.finance, "finance.post")).toBe(true);
    expect(can(A.contractor, "crm.read")).toBe(false);
  });

  it("contractors only see engagements and files explicitly assigned to them", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.owner, { name: "Video production", accountId, serviceId: creativeId, billingModel: "fixed", currency: "USD", contractValue: "5000" }));
    const visible = async () => (await db.select({ id: engagements.id }).from(engagements).where(engagementVisibility(A.contractor))).map((r) => r.id);
    expect(await visible()).not.toContain(eng.id);
    await db.insert((await import("@/db/schema")).engagementMembers).values({ engagementId: eng.id, userId: A.contractor.userId });
    expect(await visible()).toEqual([eng.id]);

    const brief = await db.transaction((tx) => uploadDocument(tx, A.owner, { title: "Shot list", docType: "client_file", fileName: "shots.pdf", declaredType: "application/pdf", buffer: PDF, engagementId: eng.id }));
    const contract = await db.transaction((tx) => uploadDocument(tx, A.owner, { title: "Client contract", docType: "contract", fileName: "contract.pdf", declaredType: "application/pdf", buffer: PDF, engagementId: eng.id }));
    // Contractor: no documents.read → only explicit grants
    await expect(db.transaction((tx) => authorizeDocumentDownload(tx, A.contractor, brief.id))).rejects.toThrow(ForbiddenError);
    await db.transaction((tx) => grantDocumentAccess(tx, A.owner, brief.id, A.contractor.userId));
    expect((await db.transaction((tx) => authorizeDocumentDownload(tx, A.contractor, brief.id))).id).toBe(brief.id);
    await expect(db.transaction((tx) => authorizeDocumentDownload(tx, A.contractor, contract.id))).rejects.toThrow(ForbiddenError);

    const hr = await db.transaction((tx) => uploadDocument(tx, A.owner, { title: "Employment contract", docType: "employment", fileName: "emp.pdf", declaredType: "application/pdf", buffer: PDF, personId: A.team_member.personId }));
    expect(hr.visibility).toBe("hr_private");
    await expect(db.transaction((tx) => authorizeDocumentDownload(tx, A.finance, hr.id))).rejects.toThrow(ForbiddenError);
    await expect(db.transaction((tx) => authorizeDocumentDownload(tx, A.operations_manager, hr.id))).rejects.toThrow(ForbiddenError);
    expect((await db.transaction((tx) => authorizeDocumentDownload(tx, A.owner, hr.id))).id).toBe(hr.id);
    await expect(db.transaction((tx) => uploadDocument(tx, A.finance, { title: "x", docType: "employment", fileName: "x.pdf", declaredType: "application/pdf", buffer: PDF }))).rejects.toThrow(ForbiddenError);
  });

  it("rejects unsafe uploads", async () => {
    await expect(db.transaction((tx) => uploadDocument(tx, A.owner, { title: "x", docType: "other", fileName: "evil.html", declaredType: "text/html", buffer: Buffer.from("<script>") }))).rejects.toThrow(/not allowed/);
    await expect(db.transaction((tx) => uploadDocument(tx, A.owner, { title: "x", docType: "other", fileName: "fake.pdf", declaredType: "application/pdf", buffer: Buffer.from("MZ executable") }))).rejects.toThrow(/does not match/);
    await expect(db.transaction((tx) => uploadDocument(tx, A.owner, { title: "x", docType: "other", fileName: "../../etc/passwd.txt", declaredType: "text/plain", buffer: Buffer.from("ok") }))).resolves.toMatchObject({ fileName: "passwd.txt" });
    expect((await db.select().from(documents)).every((d) => !d.storageKey.includes(".."))).toBe(true);
  });

  it("team members can only change tasks they own or created", async () => {
    const t = await db.transaction((tx) => createTask(tx, A.owner, { title: "Owner's task", ownerId: A.owner.userId }));
    await expect(db.transaction((tx) => changeTaskStatus(tx, A.team_member, t.id, "in_progress"))).rejects.toThrow(ForbiddenError);
    const mine = await db.transaction((tx) => createTask(tx, A.owner, { title: "Assigned", ownerId: A.team_member.userId }));
    await db.transaction((tx) => changeTaskStatus(tx, A.team_member, mine.id, "in_progress"));
    expect((await db.select().from(tasks).where(eq(tasks.id, mine.id)))[0].status).toBe("in_progress");
    await expect(db.transaction((tx) => changeTaskStatus(tx, A.team_member, mine.id, "blocked"))).rejects.toThrow(ValidationError);
  });
});
