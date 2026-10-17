import { and, eq, inArray, sql } from "drizzle-orm";
import type { DB, Tx } from "@/db/client";
import {
  accounts,
  billingScheduleItems,
  budgetLines,
  campaignMembers,
  campaigns,
  contacts,
  contracts,
  customFieldDefinitions,
  deliverables,
  departments,
  engagementMembers,
  engagements,
  expenseCategories,
  forecastAdjustments,
  invoices,
  leadContacts,
  leads,
  leaveRequests,
  ledgerAccounts,
  milestones,
  notifications,
  offers,
  opportunities,
  organizationSettings,
  people,
  personChecklists,
  pipelineStages,
  proposalTemplates,
  sequenceEnrollments,
  services,
  taxFilingPeriods,
  taxRates,
  timeEntries,
} from "@/db/schema";
import { addDaysISO, addMonthsISO, monthStartISO } from "@/lib/dates";
import { loadActor, SYSTEM_ACTOR, type Actor } from "../auth/actor";
import { ensureReferenceData, upsertUser } from "./bootstrap";
import { agencyToday } from "./settings";
import { addLeadEvidence, changeLeadStatus, convertLead, createLead } from "../crm/leads";
import { createAccount, createContact, overrideAccountHealth } from "../crm/accounts";
import { createOpportunity, markOpportunityLost, markOpportunityWon, moveOpportunityStage } from "../crm/opportunities";
import { createProposal, decideProposalApproval, markProposalSent, recordProposalAcceptance, submitProposalForApproval, type ProposalContent } from "../crm/proposals";
import { executeHandover } from "../crm/handover";
import { enroll, generateDueDrafts, logReply, recordOptOut, saveSequence, saveTemplate } from "../crm/outreach";
import { logActivity } from "../crm/activities";
import { acceptMilestone, changeEngagementStatus, createChangeRequest, createDeliverable, createEngagement, defineScope, recordDeliverableReview, submitDeliverableVersion } from "../delivery/engagements";
import { createTask, changeTaskStatus } from "../delivery/tasks";
import { approveTimeEntries, setCostRate } from "../delivery/time";
import { completeEvent, scheduleEvent } from "../delivery/events";
import { saveWorkspaceItem } from "../delivery/templates";
import { addExchangeRate } from "../finance/ledger";
import { createBankAccount, stageBankCsv, validateBankImport, commitBankImport, suggestMatches, matchBankTransaction } from "../finance/bank";
import { createInvoiceDraft, invoiceFromBillingItem, issueInvoice } from "../finance/invoices";
import { allocatePayment, recordCustomerPayment } from "../finance/payments";
import { approveBill, approveExpense, createBill, paySupplier, reimburseExpense, saveSupplier, submitExpense } from "../finance/payables";
import { runRevenueRecognition } from "../finance/revenue";
import { saveRecurringSchedule } from "../finance/recurring";
import { storeGeneratedDocument } from "../documents";
import { renderSimpleDocPdf } from "../pdf";
import { refreshSignals } from "../ops/signals";
import { runJob } from "../jobs/registry";
import type { RoleKey } from "../auth/permissions";

/**
 * Fictional, connected demo data across all three service streams. Built
 * through the domain services (so balances, journals and signals are real
 * computations). Refuses to run unless APP_ENV=demo or `force`.
 */
export async function seedDemo(db: DB, opts: { force?: boolean; password?: string } = {}) {
  if (process.env.APP_ENV !== "demo" && !opts.force) throw new Error("Refusing to seed demo data: set APP_ENV=demo and use a separate demo database.");
  const password = opts.password ?? process.env.DEMO_PASSWORD ?? "demo-password-2026";
  const log = (m: string) => console.log(`[seed] ${m}`);

  await db.transaction(async (tx) => {
    await ensureReferenceData(tx, { resetRolePermissions: true });
    await tx
      .update(organizationSettings)
      .set({
        agencyName: "Meridian & Co. (Demo)",
        legalName: "Meridian & Co. Advisory Studio (Demo) Ltd",
        address: "Level 9, 1 Example Square, Demo City",
        email: "accounts@demo.agency",
        website: "https://demo.agency",
        taxIdentifier: null,
        baseCurrency: "USD",
        timeZone: "UTC",
        invoiceFooter: "Thank you for your business. Late payments may incur charges as agreed in your contract.",
        bankDetails: "Demo Bank · Account 0000 0000 · Reference: invoice number",
        minimumCashThreshold: "60000",
        expenseApprovalThreshold: "1000",
      })
      .where(eq(organizationSettings.id, 1));
  });

  const today = await agencyToday(db);
  const T = (n: number) => addDaysISO(today, n);
  const at = (n: number, hour = 10) => new Date(`${T(n)}T${String(hour).padStart(2, "0")}:00:00Z`);

  /* ---------------- People & users ---------------- */
  const team: { key: string; email: string; name: string; title: string; role: RoleKey; dept: string; type: "employee" | "contractor"; rate?: [number, string][] }[] = [
    { key: "owner", email: "owner@demo.agency", name: "Nadia Rahman", title: "Managing Partner", role: "owner", dept: "Leadership", type: "employee", rate: [[-500, "120"]] },
    { key: "ops", email: "ops@demo.agency", name: "Daniel Okafor", title: "Operations Manager", role: "operations_manager", dept: "Operations & Finance", type: "employee", rate: [[-500, "70"]] },
    { key: "pm", email: "pm@demo.agency", name: "Sofia Marquez", title: "Account & Project Director", role: "account_manager", dept: "Client Services", type: "employee", rate: [[-500, "65"]] },
    { key: "sales", email: "sales@demo.agency", name: "Leo Brandt", title: "Business Development Lead", role: "sales", dept: "Business Development", type: "employee", rate: [[-500, "60"]] },
    { key: "finance", email: "finance@demo.agency", name: "Amira Saleh", title: "Finance Manager", role: "finance", dept: "Operations & Finance", type: "employee", rate: [[-500, "60"]] },
    { key: "designer", email: "designer@demo.agency", name: "Jun Park", title: "Senior Designer", role: "team_member", dept: "Creative", type: "employee", rate: [[-500, "45"], [-100, "55"]] },
    { key: "contractor", email: "contractor@demo.agency", name: "Lena Ortiz", title: "Financial Modeller (contractor)", role: "contractor", dept: "Advisory", type: "contractor" },
    { key: "viewer", email: "viewer@demo.agency", name: "Board Observer", title: "Board observer", role: "read_only", dept: "Leadership", type: "employee" },
  ];
  const U: Record<string, Actor> = {};
  await db.transaction(async (tx) => {
    const deptIds = new Map<string, string>();
    for (const d of Array.from(new Set(team.map((t) => t.dept)))) {
      const [row] = await tx.insert(departments).values({ name: d }).onConflictDoUpdate({ target: departments.name, set: { name: d } }).returning();
      deptIds.set(d, row.id);
    }
    for (const t of team) {
      const u = await upsertUser(tx, { email: t.email, name: t.name, password, roleKeys: [t.role], title: t.title, timeZone: "UTC" });
      const [existing] = await tx.select().from(people).where(eq(people.userId, u.id));
      if (!existing) {
        await tx.insert(people).values({ userId: u.id, type: t.type, fullName: t.name, email: t.email, jobTitle: t.title, departmentId: deptIds.get(t.dept), startDate: T(-700), weeklyCapacityHours: t.type === "contractor" ? "20" : t.role === "read_only" ? "0" : "40", timeZone: "UTC" });
      }
    }
    for (const t of team) U[t.key] = (await loadActor(tx, (await tx.select().from(people).where(eq(people.email, t.email)))[0].userId!))!;
    for (const t of team) for (const [offset, rate] of t.rate ?? []) await setCostRate(tx, U.owner, U[t.key].personId!, { effectiveFrom: T(offset), hourlyCost: rate, currency: "USD", note: offset > -200 ? "Annual review" : "Initial rate" });
    const ownerPerson = U.owner.personId!;
    await tx.update(people).set({ managerId: ownerPerson }).where(inArray(people.id, [U.ops.personId!, U.pm.personId!, U.sales.personId!, U.finance.personId!]));
    await tx.update(people).set({ managerId: U.pm.personId! }).where(eq(people.id, U.designer.personId!));
    const [newHire] = await tx.insert(people).values({ type: "employee", fullName: "Maya Chen", email: "maya@demo.agency", jobTitle: "Strategy Analyst", departmentId: deptIds.get("Advisory"), managerId: U.ops.personId!, startDate: T(10), status: "onboarding", weeklyCapacityHours: "40" }).returning();
    const [chk] = await tx.insert(personChecklists).values({ personId: newHire.id, kind: "onboarding", title: "Onboarding — Maya Chen" }).returning();
    const { addChecklistItem, toggleChecklistItem } = await import("../delivery/tasks");
    for (const [i, label] of ["Send offer pack and contract", "Order laptop and accounts", "Create user login and assign role", "Book first-week introductions", "Set cost rate (owner)"].entries()) {
      const item = await addChecklistItem(tx, U.ops, "person_checklist", chk.id, label);
      if (i < 2) await toggleChecklistItem(tx, U.ops, item.id, true);
    }
    await tx.insert(leaveRequests).values([
      { personId: U.designer.personId!, leaveType: "annual", startDate: T(20), endDate: T(24), status: "approved", approverId: U.pm.userId, decidedAt: new Date(), reason: "Family trip" },
      { personId: U.pm.personId!, leaveType: "annual", startDate: T(30), endDate: T(31), status: "requested", reason: "Long weekend" },
    ]);
  });
  log("users and people");

  /* ---------------- Catalog, templates, tax, FX, banks ---------------- */
  const svc = await db.select().from(services);
  const S = Object.fromEntries(svc.map((s) => [s.key, s.id])) as Record<"creative" | "advisory" | "executive", string>;
  const offerDefs = [
    ["creative", "Brand identity sprint", "fixed", "25000", 2],
    ["creative", "Campaign retainer", "retainer", "8000", 2],
    ["creative", "Website build", "milestone", "40000", 2],
    ["advisory", "Financial model build", "fixed", "18000", 1],
    ["advisory", "Operating model review", "milestone", "45000", 1],
    ["advisory", "Hourly advisory", "hourly", "250", null],
    ["executive", "Executive positioning programme", "fixed", "15000", 2],
    ["executive", "Thought leadership retainer", "retainer", "6000", 2],
    ["executive", "Keynote & speech writing", "fixed", "9000", 3],
  ] as const;
  const O: Record<string, string> = {};
  for (const [s, name, model, price, revs] of offerDefs) {
    const [row] = await db.insert(offers).values({ serviceId: S[s], name, pricingModel: model, defaultPrice: price, currency: "USD", includedRevisions: revs }).returning();
    O[name] = row.id;
  }
  await db.insert(proposalTemplates).values([
    { name: "Creative — brand identity", serviceId: S.creative, offerId: O["Brand identity sprint"], introduction: "Thank you for the opportunity to support your brand.", scope: "Discovery, brand strategy and identity system.", deliverables: [{ name: "Brand strategy deck", dueOffsetDays: 21, milestone: "Strategy" }, { name: "Identity system", dueOffsetDays: 49, milestone: "Identity" }], exclusions: "Printing, media buying, photography.", assumptions: "Two rounds of revisions per deliverable; one stakeholder workshop.", timeline: "Approximately 8 weeks from kickoff.", terms: "Invoices payable within 14 days.", pricingModel: "milestone" },
    { name: "Advisory — operating model review", serviceId: S.advisory, offerId: O["Operating model review"], scope: "Diagnostic, options analysis and implementation roadmap.", deliverables: [{ name: "Diagnostic report", dueOffsetDays: 28, milestone: "Diagnostic" }, { name: "Target operating model", dueOffsetDays: 56, milestone: "Design" }], exclusions: "Implementation support beyond the roadmap.", assumptions: "Timely access to data and stakeholders.", pricingModel: "milestone" },
    { name: "Executive — thought leadership retainer", serviceId: S.executive, offerId: O["Thought leadership retainer"], scope: "Monthly editorial programme: 4 posts, 1 article, speech support.", exclusions: "Paid promotion.", assumptions: "Executive available for a monthly 60-minute interview.", pricingModel: "retainer" },
  ]);
  await db.insert(taxRates).values([
    { name: "Standard 5% (demo)", ratePercent: "5", treatment: "standard", description: "Fictional demo rate — configure your real rates." },
    { name: "Zero-rated (demo)", ratePercent: "0", treatment: "zero_rated" },
    { name: "Out of scope", ratePercent: "0", treatment: "out_of_scope" },
  ]);
  await db.insert(customFieldDefinitions).values({ entityType: "lead", key: "decision_timeline", label: "Decision timeline", fieldType: "select", options: ["This quarter", "Next quarter", "This year", "Unknown"], sortOrder: 1 });
  await db.insert(taxFilingPeriods).values({ name: "Quarterly indirect tax return (demo)", taxType: "Indirect tax", periodStart: monthStartISO(addMonthsISO(today, -3)), periodEnd: addDaysISO(monthStartISO(today), -1), dueDate: T(15), status: "in_preparation", ownerId: U.finance.userId, notes: "Internal tracking only — filing happens outside this system." });

  let bankOps = "", bankSav = "", bankEur = "";
  await db.transaction(async (tx) => {
    for (const [d, r] of [[-420, "1.0750"], [-220, "1.0800"], [-120, "1.0900"], [-30, "1.1100"], [-5, "1.1200"]] as const) await addExchangeRate(tx, U.finance, { rateDate: T(d), fromCurrency: "EUR", toCurrency: "USD", rate: r });
    await addExchangeRate(tx, U.finance, { rateDate: T(-420), fromCurrency: "AED", toCurrency: "USD", rate: "0.2723" });
    bankOps = (await createBankAccount(tx, U.owner, { name: "Operating account", kind: "bank", institution: "Demo Bank", accountNumberLast4: "4021", currency: "USD", openingBalance: "85000", openingBalanceDate: T(-240) })).id;
    bankSav = (await createBankAccount(tx, U.owner, { name: "Reserve account", kind: "bank", institution: "Demo Bank", accountNumberLast4: "7788", currency: "USD", openingBalance: "40000", openingBalanceDate: T(-240) })).id;
    bankEur = (await createBankAccount(tx, U.owner, { name: "EUR account", kind: "bank", institution: "Demo Bank", accountNumberLast4: "3310", currency: "EUR", openingBalance: "12000", openingBalanceDate: T(-240) })).id;
  });
  log("catalog, tax, fx, banks");

  /* ---------------- Accounts, contacts ---------------- */
  type AccSeed = { key: string; name: string; website: string; industry: string; country: string; size: string; owner: string; lifecycle: "prospect" | "active" | "former" | "partner" | "onboarding"; channel: string; billing?: boolean; currency?: string };
  const accSeeds: AccSeed[] = [
    { key: "atlas", name: "Atlas Hotels Group", website: "atlashotels.example", industry: "Hospitality", country: "United Arab Emirates", size: "1,000+", owner: "pm", lifecycle: "active", channel: "referral", billing: true },
    { key: "meridian", name: "Meridian Capital Partners", website: "meridiancapital.example", industry: "Financial services", country: "United Kingdom", size: "51–200", owner: "owner", lifecycle: "active", channel: "inbound", billing: true },
    { key: "northwind", name: "Northwind Foods", website: "northwindfoods.example", industry: "Consumer & retail", country: "Saudi Arabia", size: "201–1,000", owner: "pm", lifecycle: "active", channel: "linkedin", billing: true },
    { key: "solace", name: "Solace Health", website: "solacehealth.example", industry: "Healthcare", country: "United States", size: "201–1,000", owner: "owner", lifecycle: "active", channel: "content", billing: true },
    { key: "kestrel", name: "Kestrel Logistics", website: "kestrel-logistics.example", industry: "Technology", country: "Egypt", size: "51–200", owner: "sales", lifecycle: "prospect", channel: "cold_email" },
    { key: "verdant", name: "Verdant Energy", website: "verdant-energy.example", industry: "Energy", country: "Jordan", size: "201–1,000", owner: "sales", lifecycle: "prospect", channel: "event" },
    { key: "orion", name: "Orion Media", website: "orionmedia.example", industry: "Technology", country: "Germany", size: "51–200", owner: "sales", lifecycle: "prospect", channel: "partnership", currency: "EUR" },
    { key: "lumen", name: "Lumen Retail", website: "lumenretail.example", industry: "Consumer & retail", country: "Qatar", size: "1,000+", owner: "sales", lifecycle: "prospect", channel: "cold_email" },
    { key: "bluebird", name: "Bluebird Education", website: "bluebird-edu.example", industry: "Education", country: "Netherlands", size: "201–1,000", owner: "owner", lifecycle: "former", channel: "referral", billing: true, currency: "EUR" },
    { key: "halcyon", name: "Halcyon Partners", website: "halcyonpartners.example", industry: "Professional services", country: "United Kingdom", size: "11–50", owner: "owner", lifecycle: "partner", channel: "partnership" },
  ];
  const A: Record<string, string> = {};
  const C: Record<string, string> = {};
  await db.transaction(async (tx) => {
    for (const a of accSeeds) {
      const row = await createAccount(tx, U.owner, {
        name: a.name, website: a.website, industry: a.industry, country: a.country, sizeBand: a.size, ownerId: U[a.owner].userId, lifecycleStatus: a.lifecycle, acquisitionChannel: a.channel,
        defaultCurrency: a.currency ?? "USD",
        billingEmail: a.billing ? `accounts@${a.website}` : null,
        billingAddress: a.billing ? `${a.name}, Finance Department, ${a.country}` : null,
        billingContactName: a.billing && a.key !== "northwind" ? "Accounts Payable" : null,
        paymentTermsDays: a.billing ? 14 : null,
      });
      A[a.key] = row.id;
      await tx.update(accounts).set({ acquiredAt: T(-300) }).where(eq(accounts.id, row.id));
    }
    const contactSeeds: [string, string, string, string, string[], string?][] = [
      ["rania", "atlas", "Rania Haddad", "Chief Marketing Officer", ["decision_maker"]],
      ["karim", "atlas", "Karim Nassar", "Chief Financial Officer", ["budget_holder"]],
      ["lina", "atlas", "Lina Farouk", "Head of Communications", ["influencer", "champion"]],
      ["james", "meridian", "James Whitfield", "Managing Director", ["decision_maker", "budget_holder"]],
      ["priya", "meridian", "Priya Natarajan", "Head of Finance", ["influencer"]],
      ["fahad", "northwind", "Fahad Al-Otaibi", "Marketing Director", ["decision_maker"]],
      ["noor", "northwind", "Noor Hamdan", "Brand Manager", ["champion"]],
      ["elena", "solace", "Dr. Elena Morris", "Chief Executive Officer", ["decision_maker"]],
      ["marcus", "solace", "Marcus Webb", "VP Communications", ["budget_holder", "champion"]],
      ["hassan", "kestrel", "Hassan Mostafa", "Chief Operating Officer", ["decision_maker"]],
      ["tom", "kestrel", "Tom Becker", "Procurement Lead", ["procurement"]],
      ["yara", "verdant", "Yara Khoury", "Chief Executive Officer", ["decision_maker"]],
      ["felix", "orion", "Felix Wagner", "Brand Director", ["decision_maker"]],
      ["sara", "lumen", "Sara Al-Thani", "Marketing Lead", ["influencer"]],
      ["pieter", "bluebird", "Pieter de Vries", "Director of Strategy", ["decision_maker"]],
      ["grace", "halcyon", "Grace Holloway", "Partner", ["influencer"]],
    ];
    for (const [k, acc, name, title, roles] of contactSeeds) {
      const site = accSeeds.find((a) => a.key === acc)!.website;
      const first = name.replace(/^Dr\. /, "").split(" ")[0].toLowerCase();
      const c = await createContact(tx, U.owner, { fullName: name, email: `${first}@${site}`, jobTitle: title, primaryAccountId: A[acc], buyingRoles: roles, preferredChannel: "email", ownerId: U[accSeeds.find((a) => a.key === acc)!.owner].userId });
      C[k] = c.id;
    }
    await tx.update(contacts).set({ relationshipNotes: "Prefers concise weekly updates; decision maker on brand topics." }).where(eq(contacts.id, C.rania));
    await recordOptOut(tx, U.sales, { contactId: C.tom, note: "Replied asking to be removed from marketing emails", source: "reply" });
  });
  log("accounts and contacts");

  /* ---------------- Leads ---------------- */
  await db.transaction(async (tx) => {
    const leadSeeds: { name: string; site: string; ch: string; status: "new" | "researching" | "qualified" | "nurture" | "disqualified"; svc: (keyof typeof S)[]; need: string; value?: string; contact: [string, string, string]; next?: [string, number]; country: string; industry: string }[] = [
      { name: "Cobalt Fintech", site: "cobaltfintech.example", ch: "linkedin", status: "new", svc: ["executive"], need: "New CEO with low public profile ahead of a funding round.", contact: ["Ahmed Raza", "Chief Executive Officer", "ahmed"], next: ["Research CEO's recent interviews", 2], country: "United Arab Emirates", industry: "Financial services" },
      { name: "Pinewood Clinics", site: "pinewoodclinics.example", ch: "cold_email", status: "new", svc: ["creative"], need: "Dated website and inconsistent clinic branding.", contact: ["Helen Brooks", "Marketing Manager", "helen"], country: "United Kingdom", industry: "Healthcare" },
      { name: "Sahara Ventures", site: "saharaventures.example", ch: "event", status: "new", svc: ["advisory", "executive"], need: "Raising Fund II; needs investor model and partner positioning.", value: "40000", contact: ["Omar Fathy", "Managing Partner", "omar"], country: "Egypt", industry: "Financial services" },
      { name: "Blue Harbor Resorts", site: "blueharbor.example", ch: "referral", status: "researching", svc: ["creative"], need: "Rebrand after acquisition of three properties.", value: "35000", contact: ["Claire Dubois", "Commercial Director", "claire"], next: ["Ask Halcyon for warm intro", 1], country: "France", industry: "Hospitality" },
      { name: "Quanta Robotics", site: "quantarobotics.example", ch: "inbound", status: "researching", svc: ["advisory"], need: "Unit economics unclear; board asked for 3-statement model.", value: "18000", contact: ["Ivan Petrov", "Chief Financial Officer", "ivan"], next: ["Reply to enquiry with discovery slots", -2], country: "Germany", industry: "Technology" },
      { name: "Marlow & Finch", site: "marlowfinch.example", ch: "content", status: "researching", svc: ["executive"], need: "Partners want thought-leadership programme on LinkedIn.", contact: ["Rebecca Marlow", "Senior Partner", "rebecca"], country: "United Kingdom", industry: "Professional services" },
      { name: "Gulfstream Logistics", site: "gulfstreamlog.example", ch: "partnership", status: "qualified", svc: ["advisory", "creative"], need: "Operational bottlenecks and weak brand vs competitors.", value: "60000", contact: ["Tariq Aziz", "Chief Operating Officer", "tariq"], next: ["Book discovery call", 3], country: "Saudi Arabia", industry: "Technology" },
      { name: "Evergreen Schools", site: "evergreenschools.example", ch: "referral", status: "qualified", svc: ["creative"], need: "Admissions campaign for new campus.", value: "22000", contact: ["Laura Kim", "Head of Admissions", "laura"], next: ["Send capabilities deck", 0], country: "Singapore", industry: "Education" },
      { name: "Nimbus Analytics", site: "nimbusanalytics.example", ch: "linkedin", status: "nurture", svc: ["executive"], need: "Founder interested but timing is next year.", contact: ["Diego Alvarez", "Founder", "diego"], next: ["Check in after their Q1 launch", 60], country: "Spain", industry: "Technology" },
      { name: "Crescent Pharma", site: "crescentpharma.example", ch: "event", status: "nurture", svc: ["advisory"], need: "Considering market entry study; budget unconfirmed.", contact: ["Mona Selim", "Strategy Director", "mona"], country: "Egypt", industry: "Healthcare" },
      { name: "Tiny Bakes", site: "tinybakes.example", ch: "cold_email", status: "disqualified", svc: ["creative"], need: "Too small for our minimum engagement.", contact: ["Sam Lee", "Owner", "sam"], country: "Canada", industry: "Consumer & retail" },
      { name: "Kestrel Logistics LLC", site: "kestrel-logistics.example", ch: "cold_email", status: "new", svc: ["creative"], need: "Imported from an old list — likely duplicates the Kestrel account.", contact: ["Hassan Mostafa", "COO", "hassan"], country: "Egypt", industry: "Technology" },
    ];
    for (const l of leadSeeds) {
      const lead = await createLead(
        tx,
        U.sales,
        {
          companyName: l.name, website: l.site, acquisitionChannel: l.ch, dateAdded: T(-Math.floor(5 + Math.random() * 60)), observedNeeds: l.need, researchNotes: `Initial research: ${l.need}`,
          ownerId: l.ch === "partnership" || l.ch === "referral" ? U.owner.userId : U.sales.userId, estimatedValue: l.value ?? null, currency: l.value ? "USD" : null, nextAction: l.next?.[0] ?? null, nextActionDate: l.next ? T(l.next[1]) : null,
          country: l.country, industry: l.industry, serviceIds: l.svc.map((k) => S[k]), tags: l.svc.length > 1 ? ["multi-service"] : [],
          contacts: [{ fullName: l.contact[0], jobTitle: l.contact[1], email: `${l.contact[2]}@${l.site}`, sourceUrl: `https://${l.site}/about` }],
        },
        { allowDuplicate: true },
      );
      await addLeadEvidence(tx, U.sales, lead.id, { kind: "source", content: `Company page reviewed: ${l.need}`, url: `https://${l.site}/about` });
      if (l.status !== "new") {
        if (l.status === "disqualified") await changeLeadStatus(tx, U.sales, lead.id, "disqualified", "Below minimum engagement size");
        else if (l.status === "researching") await changeLeadStatus(tx, U.sales, lead.id, "researching");
        else {
          await changeLeadStatus(tx, U.sales, lead.id, "researching");
          await changeLeadStatus(tx, U.sales, lead.id, l.status, l.status === "nurture" ? "Timing not right" : "Need, budget and decision-maker confirmed");
        }
      }
    }
    // A converted lead (history preserved on the new account)
    const conv = await createLead(tx, U.sales, { companyName: "Harbor Analytics", website: "harbor-analytics.example", acquisitionChannel: "inbound", researchNotes: "Asked about pricing models for an analytics product.", observedNeeds: "Pricing strategy and revenue model.", serviceIds: [S.advisory], contacts: [{ fullName: "Mia Ross", jobTitle: "Chief Executive Officer", email: "mia@harbor-analytics.example" }] });
    await logActivity(tx, U.sales, { type: "call", direction: "outbound", subject: "Intro call with Mia", body: "Interested in pricing review; budget ~USD 18k.", outcome: "positive", leadId: conv.id, occurredAt: at(-48) });
    await changeLeadStatus(tx, U.sales, conv.id, "qualified");
    const res = await convertLead(tx, U.sales, conv.id, { createOpportunity: true, opportunity: { name: "Pricing & revenue model review", value: "18000", currency: "USD", pricingModel: "hourly", serviceIds: [S.advisory], expectedCloseDate: T(20), nextAction: "Send discovery summary", nextActionDate: T(-6) } });
    A.harbor = res.accountId;
    const [stage] = await tx.select().from(pipelineStages).where(eq(pipelineStages.key, "discovery_completed"));
    await moveOpportunityStage(tx, U.sales, res.opportunityId!, stage.id, "Discovery call done");
    await tx.update(opportunities).set({ stageEnteredAt: at(-40) }).where(eq(opportunities.id, res.opportunityId!));
  });
  log("leads");

  /* ---------------- Opportunities, proposals, handovers ---------------- */
  const stageId = async (key: string) => (await db.select().from(pipelineStages).where(eq(pipelineStages.key, key)))[0].id;
  const E: Record<string, string> = {};

  async function wonDeal(o: { key: string; account: string; contact: string; name: string; service: keyof typeof S; offer?: string; owner: string; content: ProposalContent; acceptedDaysAgo: number; acceptedBy: string; memberKeys: string[] }) {
    return db.transaction(async (tx) => {
      const opp = await createOpportunity(tx, U[o.owner], { name: o.name, accountId: A[o.account], primaryContactId: C[o.contact], contactIds: [C[o.contact]], value: o.content.lines.reduce((a, l) => a + Number(l.quantity) * Number(l.unitPrice), 0).toFixed(2), currency: o.content.currency, pricingModel: o.content.pricingModel, serviceIds: [S[o.service]], offerIds: o.offer ? { [S[o.service]]: O[o.offer] } : undefined, expectedCloseDate: T(-o.acceptedDaysAgo), businessProblem: o.content.scope, desiredOutcome: o.content.introduction ?? null });
      await tx.update(opportunities).set({ createdAt: at(-o.acceptedDaysAgo - 30), stageEnteredAt: at(-o.acceptedDaysAgo - 30) }).where(eq(opportunities.id, opp.id));
      const p = await createProposal(tx, U[o.owner], { opportunityId: opp.id, title: o.name, content: o.content, validUntil: T(-o.acceptedDaysAgo + 20) });
      await submitProposalForApproval(tx, U[o.owner], p.id);
      await decideProposalApproval(tx, U.owner, p.id, "approved", "Pricing checked");
      await markProposalSent(tx, U[o.owner], p.id, T(-o.acceptedDaysAgo - 7));
      await recordProposalAcceptance(tx, U[o.owner], p.id, { acceptedAt: T(-o.acceptedDaysAgo), acceptedByName: o.acceptedBy, acceptedByContactId: C[o.contact], method: "email_confirmation", evidenceNote: `Email from ${o.acceptedBy} confirming acceptance of the proposal.` });
      await markOpportunityWon(tx, U[o.owner], opp.id);
      await tx.update(opportunities).set({ wonAt: at(-o.acceptedDaysAgo) }).where(eq(opportunities.id, opp.id));
      const eng = await executeHandover(tx, U.owner, opp.id, { memberIds: o.memberKeys.map((k) => U[k].userId), ownerId: U.pm.userId });
      await tx.update(engagements).set({ status: "active" }).where(eq(engagements.id, eng.id));
      return { oppId: opp.id, proposalId: p.id, engId: eng.id };
    });
  }

  const atlas = await wonDeal({
    key: "atlas", account: "atlas", contact: "rania", name: "Atlas brand repositioning", service: "creative", offer: "Brand identity sprint", owner: "pm", acceptedDaysAgo: 75, acceptedBy: "Rania Haddad", memberKeys: ["designer"],
    content: {
      pricingModel: "milestone", currency: "USD", startDate: T(-72), endDate: T(30),
      introduction: "Reposition Atlas as the region's most considered hospitality group.",
      scope: "Discovery workshops, brand strategy, verbal and visual identity system, rollout guidelines.",
      exclusions: "Printing, signage production, photography, media buying.",
      assumptions: "Two revision rounds per deliverable; Atlas provides stakeholder access within 5 working days.",
      timeline: "Approx. 14 weeks.",
      deliverables: [{ name: "Brand strategy deck", dueOffsetDays: 35, milestone: "Strategy" }, { name: "Identity system", dueOffsetDays: 90, milestone: "Identity" }, { name: "Brand guidelines", dueOffsetDays: 100, milestone: "Identity" }],
      lines: [{ description: "Discovery & brand strategy", quantity: "1", unitPrice: "18000" }, { description: "Identity system & guidelines", quantity: "1", unitPrice: "42000" }],
      paymentSchedule: [{ label: "Deposit on signature", percent: "40", dueAfterDays: 0 }, { label: "Strategy accepted", percent: "30", milestone: "Strategy" }, { label: "Identity accepted", percent: "30", milestone: "Identity" }],
    },
  });
  E.atlas = atlas.engId;
  const meridian = await wonDeal({
    key: "meridian", account: "meridian", contact: "james", name: "Investor-grade financial model", service: "advisory", offer: "Financial model build", owner: "owner", acceptedDaysAgo: 70, acceptedBy: "James Whitfield", memberKeys: ["ops", "contractor"],
    content: {
      pricingModel: "fixed", currency: "USD", startDate: T(-68), endDate: T(10), estimatedHours: "120",
      scope: "Three-statement model with scenarios, board pack and handover training.",
      exclusions: "Audit or assurance; tax advice.", assumptions: "Historical data provided in week 1.",
      deliverables: [{ name: "Three-statement model v1", dueOffsetDays: 40 }, { name: "Board pack", dueOffsetDays: 66 }],
      lines: [{ description: "Financial model build (fixed fee)", quantity: "1", unitPrice: "36000" }],
      paymentSchedule: [{ label: "50% on start", percent: "50", dueAfterDays: 10 }, { label: "50% on delivery", percent: "50", dueAfterDays: 75 }],
    },
  });
  E.meridian = meridian.engId;
  const northwind = await wonDeal({
    key: "northwind", account: "northwind", contact: "fahad", name: "Q4 product launch campaign", service: "creative", offer: "Campaign retainer", owner: "pm", acceptedDaysAgo: 30, acceptedBy: "Fahad Al-Otaibi", memberKeys: ["designer"],
    content: {
      pricingModel: "fixed", currency: "USD", startDate: T(-27), endDate: T(35), estimatedHours: "90",
      scope: "Campaign concept, key visuals, 30s launch video, social cut-downs (3).",
      exclusions: "Media spend; influencer fees.", assumptions: "Product samples available for shoot.",
      deliverables: [{ name: "Campaign key visuals", dueOffsetDays: 26 }, { name: "Launch video (30s)", dueOffsetDays: 40 }],
      lines: [{ description: "Q4 launch campaign", quantity: "1", unitPrice: "28000" }],
      paymentSchedule: [{ label: "Deposit", percent: "50", dueAfterDays: 7 }, { label: "Balance on delivery", percent: "50", dueAfterDays: 60 }],
    },
  });
  E.northwind = northwind.engId;
  const solace = await wonDeal({
    key: "solace", account: "solace", contact: "elena", name: "CEO thought leadership programme", service: "executive", offer: "Thought leadership retainer", owner: "owner", acceptedDaysAgo: 170, acceptedBy: "Dr. Elena Morris", memberKeys: ["pm"],
    content: {
      pricingModel: "retainer", currency: "USD", startDate: T(-163), retainerMonths: 6,
      scope: "Monthly editorial programme: 4 LinkedIn posts, 1 article, speech support.", exclusions: "Paid promotion.", assumptions: "Monthly 60-minute interview with the CEO.",
      lines: [{ description: "Thought leadership retainer (6 months × USD 6,000)", quantity: "6", unitPrice: "6000" }],
      paymentSchedule: [{ label: "Monthly in advance", amount: "6000", recurring: "monthly" }],
    },
  });
  E.solace = solace.engId;
  log("won deals handed over");

  await db.transaction(async (tx) => {
    // Second service for Atlas (multi-service account) — created directly on the account.
    const eng = await createEngagement(tx, U.owner, { name: "CEO positioning programme", accountId: A.atlas, serviceId: S.executive, offerId: O["Executive positioning programme"], billingModel: "fixed", currency: "USD", contractValue: "15000", budgetHours: "60", startDate: T(-20), endDate: T(60), ownerId: U.owner.userId, primaryContactId: C.lina });
    await changeEngagementStatus(tx, U.owner, eng.id, "active");
    await defineScope(tx, U.owner, eng.id, { inScope: "Executive profile, messaging pillars, 3 flagship articles, keynote outline.", exclusions: "Media training." });
    E.atlasExec = eng.id;
    // Former client (completed, EUR)
    const bb = await createEngagement(tx, U.owner, { name: "Strategic plan 2026–2028", accountId: A.bluebird, serviceId: S.advisory, billingModel: "fixed", currency: "EUR", contractValue: "9500", budgetHours: "50", startDate: T(-260), endDate: T(-200), ownerId: U.owner.userId });
    E.bluebird = bb.id;
  });

  // Open pipeline
  await db.transaction(async (tx) => {
    const k = await createOpportunity(tx, U.sales, { name: "Operating model review", accountId: A.kestrel, primaryContactId: C.hassan, contactIds: [C.hassan], value: "45000", currency: "USD", pricingModel: "milestone", serviceIds: [S.advisory], offerIds: { [S.advisory]: O["Operating model review"] }, expectedCloseDate: T(21), nextAction: "Follow up on proposal with Hassan", nextActionDate: T(1), businessProblem: "Fulfilment costs up 18% YoY; unclear accountability.", competitors: "Big-4 consultancy", objections: "Concerned about internal capacity during peak season." });
    const kp = await createProposal(tx, U.sales, { opportunityId: k.id, title: "Kestrel operating model review", templateId: (await tx.select().from(proposalTemplates).where(eq(proposalTemplates.name, "Advisory — operating model review")))[0].id });
    const { updateProposalDraft } = await import("../crm/proposals");
    await updateProposalDraft(tx, U.sales, kp.id, { pricingModel: "milestone", currency: "USD", scope: "Diagnostic, options analysis and implementation roadmap.", deliverables: [{ name: "Diagnostic report", dueOffsetDays: 28, milestone: "Diagnostic" }, { name: "Target operating model", dueOffsetDays: 56, milestone: "Design" }], lines: [{ description: "Operating model review", quantity: "1", unitPrice: "45000" }], paymentSchedule: [{ label: "Deposit", percent: "30", dueAfterDays: 0 }, { label: "Diagnostic accepted", percent: "35", milestone: "Diagnostic" }, { label: "Design accepted", percent: "35", milestone: "Design" }] });
    await submitProposalForApproval(tx, U.sales, kp.id);
    await decideProposalApproval(tx, U.owner, kp.id, "approved");
    await markProposalSent(tx, U.sales, kp.id, T(-9));
    await tx.execute(sql`update proposals set sent_at = ${at(-9)} where id = ${kp.id}`);
    await createEvent(tx, U.sales, { kind: "discovery", title: "Kestrel discovery workshop", startsAt: at(-22, 9), endsAt: at(-22, 10), accountId: A.kestrel, opportunityId: k.id, contactId: C.hassan }, { complete: { notes: "Mapped fulfilment process; three handoffs with no owner.", decisions: "Kestrel to share cost data by Friday.", outcome: "positive" } });

    const v = await createOpportunity(tx, U.sales, { name: "Investor narrative & CEO keynote", accountId: A.verdant, primaryContactId: C.yara, contactIds: [C.yara], value: "22000", currency: "USD", pricingModel: "fixed", serviceIds: [S.executive, S.advisory], expectedCloseDate: T(35), nextAction: "Run discovery call", nextActionDate: T(3) });
    await createEvent(tx, U.sales, { kind: "discovery", title: "Verdant discovery call", startsAt: at(3, 13), endsAt: at(3, 14), accountId: A.verdant, opportunityId: v.id, contactId: C.yara, agenda: "Fundraising timeline; CEO's speaking calendar; success criteria." });

    const exp = await createOpportunity(tx, U.pm, { name: "Revenue strategy advisory", accountId: A.atlas, kind: "expansion", parentEngagementId: E.atlas, primaryContactId: C.karim, contactIds: [C.karim], value: "30000", currency: "USD", pricingModel: "fixed", serviceIds: [S.advisory], expectedCloseDate: T(60), businessProblem: "CFO raised RevPAR pressure during brand workshops." });
    void exp;
    const orion = await createOpportunity(tx, U.sales, { name: "Brand campaign 2027", accountId: A.orion, primaryContactId: C.felix, contactIds: [C.felix], value: "50000", currency: "EUR", pricingModel: "milestone", serviceIds: [S.creative], expectedCloseDate: T(14), nextAction: "Send revised fee options", nextActionDate: T(-3), competitors: "Two local agencies", objections: "Fee 15% above budget" });
    await moveOpportunityStage(tx, U.sales, orion.id, await stageIdTx(tx, "negotiation"), "Verbal interest; negotiating scope");
    const op = await createProposal(tx, U.sales, { opportunityId: orion.id, title: "Orion brand campaign 2027", content: { pricingModel: "milestone", currency: "EUR", scope: "Campaign platform and 3 flights.", lines: [{ description: "Campaign platform", quantity: "1", unitPrice: "20000" }, { description: "Three campaign flights", quantity: "3", unitPrice: "10000" }], discountPercent: "5", paymentSchedule: [] } });
    await submitProposalForApproval(tx, U.sales, op.id);

    const lumen = await createOpportunity(tx, U.sales, { name: "Retail rebrand", accountId: A.lumen, primaryContactId: C.sara, contactIds: [C.sara], value: "38000", currency: "USD", pricingModel: "fixed", serviceIds: [S.creative], expectedCloseDate: T(-10) });
    await markOpportunityLost(tx, U.sales, lumen.id, { lostReason: "Price", lostNotes: "Chose a lower-cost local studio." });
  });
  log("pipeline");

  /* ---------------- Contracts & documents ---------------- */
  await db.transaction(async (tx) => {
    const ctr = async (acc: string, eng: string | null, title: string, type: "msa" | "sow" | "retainer", status: "signed" | "sent" | "active", signedAgo?: number) => {
      const { nextNumber } = await import("../numbering");
      const number = await nextNumber(tx, "contract");
      const [row] = await tx.insert(contracts).values({ number, accountId: A[acc], engagementId: eng, title, contractType: type, status, signedAt: signedAgo ? T(-signedAgo) : null, signatureMethod: signedAgo ? "signed_document" : null, signatureEvidence: signedAgo ? "Countersigned PDF on file" : null, startDate: signedAgo ? T(-signedAgo) : null, ownerId: U.owner.userId }).returning();
      const pdf = await renderSimpleDocPdf(`${title} (${number}) — DEMO`, ["Fictional demo document generated by the seed script.", `Parties: Meridian & Co. (Demo) and ${accSeeds.find((a) => a.key === acc)?.name}.`, status === "sent" ? "Status: sent for signature, not yet signed." : "Status: signed (manual record of a signed PDF, not a verified e-signature)."]);
      await storeGeneratedDocument(tx, U.owner, { title, docType: type === "msa" ? "legal" : type === "sow" ? "sow" : "contract", fileName: `${number}.pdf`, mimeType: "application/pdf", buffer: pdf, accountId: A[acc], engagementId: eng, contractId: row.id });
      await tx.update((await import("@/db/schema")).documents).set({ approvalStatus: status === "sent" ? "pending" : "approved", expiresAt: type === "msa" ? T(300) : null }).where(eq((await import("@/db/schema")).documents.contractId, row.id));
    };
    await ctr("atlas", null, "Master services agreement — Atlas Hotels Group", "msa", "signed", 80);
    await ctr("atlas", E.atlas, "SOW — Atlas brand repositioning", "sow", "signed", 75);
    await ctr("meridian", E.meridian, "SOW — Investor-grade financial model", "sow", "signed", 70);
    await ctr("northwind", E.northwind, "SOW — Q4 product launch campaign", "sow", "sent");
    await ctr("solace", E.solace, "Retainer agreement — CEO thought leadership", "retainer", "signed", 168);
    const brief = await renderSimpleDocPdf("Atlas — creative brief (DEMO)", ["Objective: reposition Atlas as the region's most considered hospitality group.", "Audience: high-value leisure and business travellers."]);
    const doc = await storeGeneratedDocument(tx, U.pm, { title: "Atlas creative brief", docType: "client_file", fileName: "atlas-brief.pdf", mimeType: "application/pdf", buffer: brief, accountId: A.atlas, engagementId: E.atlas });
    const { grantDocumentAccess } = await import("../documents");
    const [lena] = await tx.select().from(people).where(eq(people.email, "contractor@demo.agency"));
    const model = await renderSimpleDocPdf("Meridian data room index (DEMO)", ["Historical P&L FY23–FY25", "Headcount plan", "Pricing assumptions"]);
    const mdoc = await storeGeneratedDocument(tx, U.owner, { title: "Meridian data room index", docType: "client_file", fileName: "meridian-data-room.pdf", mimeType: "application/pdf", buffer: model, accountId: A.meridian, engagementId: E.meridian });
    await grantDocumentAccess(tx, U.owner, mdoc.id, lena.userId!);
    void doc;
    const emp = await renderSimpleDocPdf("Employment contract — Jun Park (DEMO, PRIVATE)", ["Fictional private HR document. Visible only to roles with people.private."]);
    await storeGeneratedDocument(tx, U.owner, { title: "Employment contract — Jun Park", docType: "employment", visibility: "hr_private", fileName: "jun-park-contract.pdf", mimeType: "application/pdf", buffer: emp, personId: U.designer.personId! });
  });
  log("contracts and documents");

  /* ---------------- Delivery state ---------------- */
  await db.transaction(async (tx) => {
    // Atlas: strategy deck approved → milestone accepted (billing item ready)
    const atlasDls = await tx.select().from(deliverables).where(eq(deliverables.engagementId, E.atlas));
    const deck = atlasDls.find((d) => d.name === "Brand strategy deck")!;
    await tx.update(deliverables).set({ dueDate: T(-30) }).where(eq(deliverables.id, deck.id));
    await submitDeliverableVersion(tx, U.pm, deck.id, { stage: "internal", notes: "Strategy deck v1" });
    await recordDeliverableReview(tx, U.pm, deck.id, { decision: "approved" });
    await recordDeliverableReview(tx, U.pm, deck.id, { decision: "changes_requested", feedback: "Sharper competitor framing", reviewerContactId: C.rania });
    await submitDeliverableVersion(tx, U.pm, deck.id, { stage: "client", notes: "v2 with competitor map" });
    await recordDeliverableReview(tx, U.pm, deck.id, { decision: "approved", evidence: "Rania approved v2 in steering meeting (minutes on file)", reviewerContactId: C.rania });
    const [strategy] = await tx.select().from(milestones).where(and(eq(milestones.engagementId, E.atlas), eq(milestones.name, "Strategy")));
    await acceptMilestone(tx, U.pm, strategy.id, { acceptedAt: T(-25), acceptanceEvidence: "Steering committee minutes — strategy accepted", acceptedByContactId: C.rania });
    const identity = atlasDls.find((d) => d.name === "Identity system")!;
    await tx.update(deliverables).set({ approvalStatus: "in_progress", dueDate: T(14) }).where(eq(deliverables.id, identity.id));

    // Northwind: key visuals awaiting client approval (late); scope change awaiting approval
    const nwDls = await tx.select().from(deliverables).where(eq(deliverables.engagementId, E.northwind));
    const kv = nwDls.find((d) => d.name === "Campaign key visuals")!;
    await tx.update(deliverables).set({ dueDate: T(-1), includedRevisions: 2 }).where(eq(deliverables.id, kv.id));
    await submitDeliverableVersion(tx, U.pm, kv.id, { stage: "client", notes: "Three key visual routes", link: "https://example.com/demo/northwind-kv" });
    await createChangeRequest(tx, U.pm, E.northwind, { title: "Add TikTok cut-downs", description: "Client asked for vertical edits for TikTok.", proposedChanges: "Four additional 9:16 cut-downs (6–15s) from the launch film.", feeImpact: "6500", hoursImpact: "24", deadlineImpactDays: 10, requestedByContactId: C.noor });

    // Meridian: model in internal review; board pack late
    const mDls = await tx.select().from(deliverables).where(eq(deliverables.engagementId, E.meridian));
    const model = mDls.find((d) => d.name === "Three-statement model v1")!;
    await submitDeliverableVersion(tx, U.ops, model.id, { stage: "internal", notes: "Model with base/downside scenarios" });
    await tx.update(deliverables).set({ dueDate: T(-2) }).where(eq(deliverables.name, "Board pack"));

    // Atlas exec + Solace deliverables
    await createDeliverable(tx, U.owner, E.atlasExec, { name: "Executive profile & pillars", dueDate: T(5), ownerId: U.owner.userId });
    await createDeliverable(tx, U.owner, E.solace, { name: "October article: 'Healthcare's trust gap'", dueDate: T(4), ownerId: U.pm.userId });

    // Workspace items per service template
    const ws = async (eng: string, a: Actor, items: Parameters<typeof saveWorkspaceItem>[3][]) => {
      for (const i of items) await saveWorkspaceItem(tx, a, eng, i);
    };
    await ws(E.atlas, U.pm, [
      { itemType: "creative_brief", title: "Atlas repositioning brief", status: "agreed", data: { objective: "Reposition Atlas as the region's most considered hospitality group.", audience: "High-value leisure and MICE travellers", keyMessage: "Hospitality, considered." } },
      { itemType: "brand_asset", title: "Legacy logo files", status: "received", data: { assetType: "Logo", usage: "Reference only — being replaced." } },
      { itemType: "content_item", title: "Launch teaser — Instagram", status: "planned", scheduledDate: T(40), channel: "Instagram", data: { format: "Video" } },
      { itemType: "production_budget", title: "Photography day", status: "committed", data: { supplier: "Frame & Light Studio", amount: "3200" } },
    ]);
    await ws(E.northwind, U.pm, [
      { itemType: "campaign_plan", title: "Q4 launch plan", status: "approved", data: { objective: "Drive trial of new product line", channels: "Instagram, TikTok, YouTube", start: T(10), end: T(70), budget: "120000" } },
      { itemType: "campaign_result", title: "Teaser reach (week 1)", status: "reported", data: { metric: "Reach", value: "184,000", period: "Week 1", source: "Client's Meta Ads export, shared by Noor Hamdan" }, sourceUrl: "https://example.com/demo/northwind-report" },
    ]);
    await ws(E.meridian, U.ops, [
      { itemType: "problem_statement", title: "Fund II investor model", status: "agreed", data: { problem: "Board needs an investor-grade model to support Fund II raise.", objectives: "Defensible 5-year forecast with scenarios." } },
      { itemType: "hypothesis", title: "Fee income lags AUM growth by 2 quarters", status: "supported", data: { statement: "Management fees recognised with a 2-quarter lag.", evidence: "FY24 data" } },
      { itemType: "data_request", title: "Historic fund cash flows", status: "overdue", dueDate: T(-6), data: { requestedFrom: "Priya Natarajan", description: "Quarterly cash flows FY21–FY25" } },
      { itemType: "model_version", title: "Model v0.9", status: "issued", data: { version: "0.9", changes: "Initial structure" } },
      { itemType: "model_version", title: "Model v1.0", status: "review", data: { version: "1.0", changes: "Scenario switch, debt schedule" } },
      { itemType: "raid", title: "Late historic data", status: "open", data: { kind: "Risk", impact: "High", mitigation: "Use management accounts as proxy; flag in board pack." } },
      { itemType: "kpi", title: "Forecast accuracy vs actuals", status: "tracking", data: { baseline: "±18%", target: "±5%", reported: "±7%", asOf: T(-10), source: "Meridian finance team" } },
      { itemType: "decision", title: "Use quarterly granularity", status: "recorded", data: { decision: "Model built quarterly to year 3, annual thereafter.", decidedBy: "James Whitfield", date: T(-40) } },
    ]);
    await ws(E.solace, U.pm, [
      { itemType: "executive_profile", title: "Dr. Elena Morris — positioning", status: "approved", data: { executive: "Dr. Elena Morris", positioning: "Clinician-CEO closing healthcare's trust gap.", tone: "Warm, evidence-led, direct" } },
      { itemType: "pillar", title: "Trust through transparency", status: "approved", data: { theme: "Trust through transparency", proofPoints: "Published outcomes data; patient council" } },
      { itemType: "editorial_item", title: "LinkedIn: what patients told us", status: "published_manually", scheduledDate: T(-12), channel: "LinkedIn", data: { format: "LinkedIn post", pillar: "Trust through transparency", publishedUrl: "https://example.com/demo/solace-post" } },
      { itemType: "editorial_item", title: "Article: Healthcare's trust gap", status: "executive_review", scheduledDate: T(6), channel: "LinkedIn", data: { format: "Article", pillar: "Trust through transparency" } },
      { itemType: "performance", title: "September LinkedIn performance", status: "reported", channel: "LinkedIn", data: { metric: "Impressions", value: "52,300", period: "September", source: "LinkedIn analytics export from Marcus Webb" } },
    ]);
  });
  log("delivery state");

  /* ---------------- Time entries (historical cost snapshots) ---------------- */
  await db.transaction(async (tx) => {
    const { logTime } = await import("../delivery/time");
    const plan: [string, string, number, number, number][] = [
      // engagement, personKey, total hours, start offset, end offset
      [E.meridian, "pm", 42, -65, -8], [E.meridian, "ops", 38, -65, -8], [E.meridian, "owner", 34, -60, -8], [E.meridian, "designer", 14, -40, -20],
      [E.atlas, "designer", 72, -70, -5], [E.atlas, "pm", 28, -70, -2],
      [E.northwind, "designer", 34, -26, -5], [E.northwind, "pm", 16, -26, -1],
      [E.solace, "owner", 30, -160, -2], [E.solace, "pm", 36, -160, -1],
      [E.atlasExec, "owner", 12, -18, -1],
    ];
    // Nobody approves their own time: the owner's entries are approved by operations, the rest by the owner.
    const ids: string[] = [];
    const ownerIds: string[] = [];
    for (const [eng, who, total, from, to] of plan) {
      const days: string[] = [];
      for (let d = from; d <= to; d++) {
        const iso = T(d);
        const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
        if (dow !== 0 && dow !== 6) days.push(iso);
      }
      const perDay = Math.max(1, Math.round((total / days.length) * 4) / 4);
      let left = total;
      for (const day of days) {
        if (left <= 0) break;
        const h = Math.min(perDay, left, 8);
        if (who === "designer" && day > T(-6)) continue; // leaves a gap → missing-time signal
        const e = await logTime(tx, U.owner, { personId: U[who].personId!, workDate: day, hours: h.toFixed(2), engagementId: eng, description: "Delivery work" });
        await tx.update(timeEntries).set({ userId: U[who].userId }).where(eq(timeEntries.id, e.id)); // entered by the person themselves
        if (day < T(-3)) (who === "owner" ? ownerIds : ids).push(e.id);
        left -= h;
      }
    }
    // Non-billable internal time
    for (let d = -20; d <= -1; d++) {
      const iso = T(d);
      const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (const who of ["sales", "ops", "finance"]) {
        const e = await logTime(tx, U.owner, { personId: U[who].personId!, workDate: iso, hours: who === "sales" ? "6" : "3", billable: false, description: who === "sales" ? "Business development" : "Internal operations" });
        await tx.update(timeEntries).set({ userId: U[who].userId }).where(eq(timeEntries.id, e.id));
        if (d < -3) ids.push(e.id);
      }
    }
    await approveTimeEntries(tx, U.owner, ids);
    await approveTimeEntries(tx, U.ops, ownerIds);
    await tx.update(engagementMembers).set({ allocationHoursPerWeek: "16" }).where(eq(engagementMembers.engagementId, E.atlas));
  });
  log("time entries");

  /* ---------------- Finance: invoices, payments, bills, expenses ---------------- */
  await db.transaction(async (tx) => {
    const fin = U.finance;
    const items = async (eng: string) => tx.select().from(billingScheduleItems).where(eq(billingScheduleItems.engagementId, eng));
    // Issue invoices in chronological order so numbers follow issue dates.
    type Step = { date: string; run: () => Promise<unknown> };
    const steps: Step[] = [];
    const ai = await items(E.atlas);
    const dep = ai.find((i) => i.isDeposit)!;
    const { invoice: depInv } = await invoiceFromBillingItem(tx, fin, dep.id);
    steps.push({ date: T(-70), run: () => issueInvoice(tx, fin, depInv.id, { issueDate: T(-70) }) });
    steps.push({ date: T(-58), run: () => recordCustomerPayment(tx, fin, { accountId: A.atlas, paymentDate: T(-58), amount: depInv.total, currency: "USD", method: "bank_transfer", reference: "ATLAS-DEP", bankAccountId: bankOps, allocations: [{ invoiceId: depInv.id, amount: depInv.total }] }) });
    const ms = ai.find((i) => i.label.startsWith("Strategy"))!;
    const { invoice: msInv } = await invoiceFromBillingItem(tx, fin, ms.id);
    steps.push({ date: T(-24), run: () => issueInvoice(tx, fin, msInv.id, { issueDate: T(-24) }) });

    // Meridian: first 50% invoice, partially paid, now >30 days overdue
    const mi = await items(E.meridian);
    const first = mi.find((i) => i.label.startsWith("50% on start"))!;
    const { invoice: mInv } = await invoiceFromBillingItem(tx, fin, first.id);
    steps.push({ date: T(-58), run: () => issueInvoice(tx, fin, mInv.id, { issueDate: T(-58) }) });
    steps.push({ date: T(-30), run: () => recordCustomerPayment(tx, fin, { accountId: A.meridian, paymentDate: T(-30), amount: "8000", currency: "USD", method: "bank_transfer", reference: "MCP PART PAYMENT", bankAccountId: bankOps, evidenceNote: "Remittance email: balance to follow after board approval", allocations: [{ invoiceId: mInv.id, amount: "8000" }] }) });

    // Northwind: deposit invoice overdue unpaid
    const ni = await items(E.northwind);
    const nDep = ni.find((i) => i.label === "Deposit")!;
    const { invoice: nInv } = await invoiceFromBillingItem(tx, fin, nDep.id);
    steps.push({ date: T(-20), run: () => issueInvoice(tx, fin, nInv.id, { issueDate: T(-20) }) });

    // Solace retainer: monthly invoices to date, all paid except the latest
    const si = (await items(E.solace)).filter((i) => i.plannedDate! <= today).sort((a, b) => a.plannedDate!.localeCompare(b.plannedDate!));
    for (const [idx, it] of si.entries()) {
      const { invoice } = await invoiceFromBillingItem(tx, fin, it.id);
      steps.push({ date: it.plannedDate!, run: () => issueInvoice(tx, fin, invoice.id, { issueDate: it.plannedDate! }) });
      if (idx < si.length - 1) {
        const payDate = addDaysISO(it.plannedDate!, 12);
        steps.push({ date: payDate, run: () => recordCustomerPayment(tx, fin, { accountId: A.solace, paymentDate: payDate, amount: invoice.total, currency: "USD", method: "bank_transfer", reference: `SOLACE ${it.plannedDate!.slice(0, 7)}`, bankAccountId: bankOps, allocations: [{ invoiceId: invoice.id, amount: invoice.total }] }) });
      }
    }

    // Bluebird (former client, EUR) — paid
    const { invoice: bInv } = await createInvoiceDraft(tx, fin, { accountId: A.bluebird, engagementId: E.bluebird, currency: "EUR", lines: [{ description: "Strategic plan 2026–2028 (fixed fee)", quantity: "1", unitPrice: "9500" }] });
    steps.push({ date: T(-205), run: () => issueInvoice(tx, fin, bInv.id, { issueDate: T(-205) }) });
    steps.push({ date: T(-190), run: () => recordCustomerPayment(tx, fin, { accountId: A.bluebird, paymentDate: T(-190), amount: "9500", currency: "EUR", method: "bank_transfer", reference: "BLUEBIRD", bankAccountId: bankEur, allocations: [{ invoiceId: bInv.id, amount: "9500" }] }) });
    steps.sort((a, b) => a.date.localeCompare(b.date));
    for (const st of steps) await st.run();

    // Recurring service (care plan) — schedule only; job generates drafts
    await saveRecurringSchedule(tx, fin, { name: "Atlas website care plan", accountId: A.atlas, frequency: "monthly", nextRunDate: monthStartISO(addMonthsISO(today, 1)), currency: "USD", lines: [{ description: "Website care & hosting plan", quantity: "1", unitPrice: "450", serviceId: S.creative }], paymentTermsDays: 14 });

    // Suppliers & bills
    const ledger = await tx.select().from(ledgerAccounts);
    const acct = (code: string) => ledger.find((l) => l.code === code)!.id;
    const [lenaPerson] = await tx.select().from(people).where(eq(people.email, "contractor@demo.agency"));
    const lena = await saveSupplier(tx, fin, { name: "Lena Ortiz Modelling", supplierType: "contractor", contactName: "Lena Ortiz", email: "lena@ortiz-modelling.example", defaultCurrency: "USD", paymentTermsDays: 30, defaultExpenseLedgerAccountId: acct("5000"), personId: lenaPerson.id });
    await tx.update(people).set({ supplierId: lena.id }).where(eq(people.id, lenaPerson.id));
    const studio = await saveSupplier(tx, fin, { name: "Frame & Light Studio", supplierType: "vendor", email: "hello@framelight.example", defaultCurrency: "USD", paymentTermsDays: 14, defaultExpenseLedgerAccountId: acct("5100") });
    const cloud = await saveSupplier(tx, fin, { name: "Cloudsuite Software", supplierType: "vendor", email: "billing@cloudsuite.example", defaultCurrency: "USD", paymentTermsDays: 7, defaultExpenseLedgerAccountId: acct("6200") });
    const b1 = await createBill(tx, fin, { supplierId: lena.id, supplierReference: "LO-2026-031", billDate: T(-45), currency: "USD", description: "Model build — phase 1", lines: [{ description: "Model structure & historicals (16h)", amount: "2000", expenseLedgerAccountId: acct("5000"), engagementId: E.meridian }] });
    await approveBill(tx, U.owner, b1.id);
    await paySupplier(tx, fin, { supplierId: lena.id, paymentDate: T(-15), bankAccountId: bankOps, method: "bank_transfer", reference: "LO-2026-031", allocations: [{ billId: b1.id, amount: "2000" }] });
    const b2 = await createBill(tx, fin, { supplierId: lena.id, supplierReference: "LO-2026-044", billDate: T(-20), dueDate: T(10), currency: "USD", description: "Model build — scenarios & QA", lines: [{ description: "Scenario engine & QA (36h)", amount: "4500", expenseLedgerAccountId: acct("5000"), engagementId: E.meridian }] });
    await approveBill(tx, U.owner, b2.id);
    const b3 = await createBill(tx, fin, { supplierId: studio.id, supplierReference: "FL-889", billDate: T(-35), currency: "USD", lines: [{ description: "Brand photography day", amount: "3200", expenseLedgerAccountId: acct("5100"), engagementId: E.atlas }] });
    await approveBill(tx, U.owner, b3.id);
    await paySupplier(tx, fin, { supplierId: studio.id, paymentDate: T(-22), bankAccountId: bankOps, method: "bank_transfer", reference: "FL-889", allocations: [{ billId: b3.id, amount: "3200" }] });
    const b4 = await createBill(tx, fin, { supplierId: cloud.id, supplierReference: "CS-10221", billDate: T(-12), currency: "USD", lines: [{ description: "Workspace licences (monthly)", amount: "480", expenseLedgerAccountId: acct("6200") }] });
    await approveBill(tx, U.owner, b4.id);
    await paySupplier(tx, fin, { supplierId: cloud.id, paymentDate: T(-11), bankAccountId: bankOps, method: "card", reference: "CS-10221", allocations: [{ billId: b4.id, amount: "480" }] });
    await createBill(tx, fin, { supplierId: studio.id, supplierReference: "FL-902", billDate: T(-2), currency: "USD", description: "Northwind shoot (awaiting approval)", lines: [{ description: "Product shoot — half day", amount: "1800", expenseLedgerAccountId: acct("5100"), engagementId: E.northwind }] });

    // Expenses
    const cats = await tx.select().from(expenseCategories);
    const cat = (n: string) => cats.find((c) => c.name === n)!.id;
    const e1 = await submitExpense(tx, U.designer, { expenseDate: T(-16), description: "Print proofs for Atlas guidelines", categoryId: cat("Production costs"), amount: "180", currency: "USD", paidFrom: "personal", engagementId: E.atlas });
    await approveExpense(tx, fin, e1.id);
    await reimburseExpense(tx, fin, e1.id, { bankAccountId: bankOps, date: T(-9) });
    const e2 = await submitExpense(tx, fin, { expenseDate: T(-13), description: "Stock imagery licence", categoryId: cat("Production costs"), amount: "240", currency: "USD", paidFrom: "company", bankAccountId: bankOps, engagementId: E.northwind });
    await approveExpense(tx, U.owner, e2.id);
    await submitExpense(tx, U.pm, { expenseDate: T(-3), description: "Client workshop venue & catering (Atlas)", categoryId: cat("Travel & meals"), amount: "1350", currency: "USD", paidFrom: "personal", engagementId: E.atlas });
    await submitExpense(tx, U.designer, { expenseDate: T(-1), description: "Taxi to Northwind shoot", categoryId: cat("Project travel"), amount: "42", currency: "USD", paidFrom: "personal", engagementId: E.northwind });

    // Cash forecast assumptions (separate from actuals)
    await tx.insert(forecastAdjustments).values([
      { weekStart: addDaysISO(monthStartISO(addMonthsISO(today, 1)), -4), description: "Payroll (monthly, demo)", amount: "38000", currency: "USD", direction: "outflow", recurring: "monthly", createdBy: fin.userId },
      { weekStart: monthStartISO(addMonthsISO(today, 1)), description: "Office rent (monthly, demo)", amount: "4500", currency: "USD", direction: "outflow", recurring: "monthly", createdBy: fin.userId },
      { weekStart: T(15), description: "Quarterly indirect tax payment (estimate)", amount: "6200", currency: "USD", direction: "outflow", recurring: "none", createdBy: fin.userId },
    ]);
    // Company budget for the fiscal year (by month)
    const year = Number(today.slice(0, 4));
    const rows: (typeof budgetLines.$inferInsert)[] = [];
    for (let m = 1; m <= 12; m++) {
      rows.push({ fiscalYear: year, month: m, ledgerAccountId: acct("4000"), amount: "22000", currency: "USD" });
      rows.push({ fiscalYear: year, month: m, ledgerAccountId: acct("4100"), amount: "16000", currency: "USD" });
      rows.push({ fiscalYear: year, month: m, ledgerAccountId: acct("4200"), amount: "9000", currency: "USD" });
      rows.push({ fiscalYear: year, month: m, ledgerAccountId: acct("5000"), amount: "2500", currency: "USD" });
      rows.push({ fiscalYear: year, month: m, ledgerAccountId: acct("6200"), amount: "600", currency: "USD" });
    }
    await tx.insert(budgetLines).values(rows);
  });
  log("finance documents");

  /* ---------------- Bank statement import & matching ---------------- */
  await db.transaction(async (tx) => {
    const fin = U.finance;
    const pays = await tx.execute<{ payment_date: string; amount: string; reference: string | null }>(sql`select payment_date, amount, reference from customer_payments where bank_account_id = ${bankOps} and payment_date >= ${T(-60)} order by payment_date`);
    const sps = await tx.execute<{ payment_date: string; amount: string; reference: string | null }>(sql`select payment_date, amount, reference from supplier_payments where bank_account_id = ${bankOps} and payment_date >= ${T(-60)} order by payment_date`);
    const lines = ["Date,Description,Amount,Reference"];
    for (const p of pays.rows) lines.push(`${p.payment_date},INCOMING TRANSFER ${p.reference ?? ""},${p.amount},${p.reference ?? ""}`);
    for (const p of sps.rows) lines.push(`${p.payment_date},OUTGOING PAYMENT ${p.reference ?? ""},-${p.amount},${p.reference ?? ""}`);
    lines.push(`${T(-13)},CARD STOCKIMAGES,-240.00,`);
    lines.push(`${T(-9)},TRANSFER TO J PARK EXPENSES,-180.00,`);
    lines.push(`${T(-18)},PAYMENT PROCESSOR PAYOUT,1240.00,PO-7731`);
    lines.push(`${T(-14)},AWS EMEA,-312.40,`);
    lines.push(`${T(-10)},MONTHLY ACCOUNT FEE,-25.00,`);
    lines.push(`${T(-2)},UNKNOWN DEBIT CARD 8821,-89.99,`);
    const batch = await stageBankCsv(tx, fin, { bankAccountId: bankOps, fileName: "operating-statement-demo.csv", csv: lines.join("\n") });
    await validateBankImport(tx, fin, batch.id, { date: "Date", description: "Description", amount: "Amount", reference: "Reference" });
    await commitBankImport(tx, fin, batch.id);
    const txns = await tx.execute<{ id: string; amount: string }>(sql`select id, amount from bank_transactions where bank_account_id = ${bankOps} and status = 'unreconciled'`);
    for (const t of txns.rows) {
      const s = await suggestMatches(tx, t.id);
      if (s[0]) await matchBankTransaction(tx, fin, t.id, s[0].type, s[0].id);
    }
  });
  log("bank import");

  /* ---------------- Tasks, events, outreach, misc ---------------- */
  await db.transaction(async (tx) => {
    const mk = (a: Actor, input: Parameters<typeof createTask>[2]) => createTask(tx, a, input);
    await mk(U.pm, { title: "Chase Northwind for key visual decision", kind: "follow_up", engagementId: E.northwind, accountId: A.northwind, contactId: C.fahad, ownerId: U.pm.userId, dueDate: T(0), priority: "high", nextAction: "Call Fahad; offer 15-min walkthrough" });
    await mk(U.pm, { title: "Prepare identity system presentation", engagementId: E.atlas, ownerId: U.designer.userId, dueDate: T(6), priority: "high", estimateHours: "16", checklist: ["Logo lock-ups", "Colour system", "Typography", "Application mock-ups"] });
    const blocked = await mk(U.pm, { title: "Final board pack layout", engagementId: E.meridian, ownerId: U.ops.userId, dueDate: T(-1), priority: "urgent", estimateHours: "6" });
    await changeTaskStatus(tx, U.owner, blocked.id, "blocked", { blockedReason: "Waiting for Meridian historic cash flows (data request overdue)" });
    await mk(U.owner, { title: "Review Meridian budget overrun and draft change request", engagementId: E.meridian, ownerId: U.owner.userId, dueDate: T(-2), priority: "high" });
    await mk(U.sales, { title: "Weekly pipeline review", kind: "task", module: "crm", ownerId: U.sales.userId, dueDate: T(1), recurrence: "weekly", priority: "medium" });
    await mk(U.sales, { title: "Send capabilities deck to Evergreen Schools", kind: "follow_up", module: "crm", ownerId: U.sales.userId, dueDate: T(-1), priority: "medium" });
    await mk(U.finance, { title: "Collections call: Meridian invoice balance", kind: "collection", module: "finance", ownerId: U.finance.userId, accountId: A.meridian, dueDate: T(0), priority: "high" });
    await mk(U.finance, { title: "Prepare quarterly indirect tax pack (demo)", kind: "compliance", module: "finance", ownerId: U.finance.userId, dueDate: T(10), priority: "medium" });
    await mk(U.ops, { title: "Onboarding: order laptop for Maya Chen", kind: "hr", module: "people", ownerId: U.ops.userId, dueDate: T(5) });
    await mk(U.pm, { title: "Draft October article outline", engagementId: E.solace, ownerId: U.pm.userId, dueDate: T(2), priority: "medium", reminderAt: at(1, 9) });

    await createEvent(tx, U.pm, { kind: "meeting", title: "Atlas weekly status", startsAt: at(0, 14), endsAt: at(0, 15), accountId: A.atlas, engagementId: E.atlas, contactId: C.rania, agenda: "Identity routes; photography plan; next invoice." });
    await createEvent(tx, U.owner, { kind: "account_review", title: "Solace quarterly account review & renewal", startsAt: at(5, 11), endsAt: at(5, 12), accountId: A.solace, engagementId: E.solace, contactId: C.marcus, agenda: "Programme results; renewal options; expanding to the board chair." });
    await createEvent(tx, U.sales, { kind: "internal", title: "Pipeline & capacity review", startsAt: at(1, 9), endsAt: at(1, 10) });
    await createEvent(tx, U.pm, { kind: "meeting", title: "Northwind key visual review", startsAt: at(-4, 10), endsAt: at(-4, 11), accountId: A.northwind, engagementId: E.northwind, contactId: C.fahad }, { complete: { notes: "Client liked route B; wants TikTok versions.", decisions: "Raise change request for TikTok cut-downs.", outcome: "positive", followUps: [{ title: "Send change request for TikTok cut-downs", ownerId: U.pm.userId, dueDate: T(-3) }] } });

    // Outreach & campaigns
    const c1 = await tx.insert(campaigns).values({ name: "Q4 LinkedIn — executive positioning", channel: "linkedin", targetSegment: "Founder-CEOs, Series B+ fintech & health", serviceId: (await tx.select().from(services).where(eq(services.key, "executive")))[0].id, offerId: O["Executive positioning programme"], ownerId: U.sales.userId, startDate: T(-40), endDate: T(50), cost: "1200", currency: "USD", status: "active", goal: "6 discovery calls" }).returning();
    const c2 = await tx.insert(campaigns).values({ name: "Partner referrals 2026", channel: "referral", targetSegment: "Halcyon Partners network", ownerId: U.owner.userId, startDate: T(-200), status: "active", goal: "4 qualified referrals" }).returning();
    const ls = await tx.select().from(leads).where(inArray(leads.acquisitionChannel, ["linkedin", "referral", "content"]));
    for (const l of ls) await tx.insert(campaignMembers).values({ campaignId: l.acquisitionChannel === "referral" ? c2[0].id : c1[0].id, leadId: l.id, status: "contacted" }).onConflictDoNothing();
    await tx.update(leads).set({ campaignId: c1[0].id }).where(inArray(leads.acquisitionChannel, ["linkedin", "content"]));
    const t1 = await saveTemplate(tx, U.sales, { name: "Executive positioning — first touch", channel: "email", subject: "{{company}} and the CEO's public voice", body: "Hi {{first_name}},\n\nI noticed {{company}} is entering a period where the CEO's voice will matter to investors and talent. We help leaders build a credible public profile.\n\nWould a 20-minute call next week be useful?\n\n{{sender_name}}", serviceId: (await tx.select().from(services).where(eq(services.key, "executive")))[0].id, segment: "Founder-CEOs" });
    const t2 = await saveTemplate(tx, U.sales, { name: "Executive positioning — follow-up", channel: "email", subject: "Re: {{company}}", body: "Hi {{first_name}}, a short example of how we helped a healthcare CEO: [add case study link]. Worth a conversation?\n\n{{sender_name}}" });
    const seqId = await saveSequence(tx, U.sales, { name: "Q4 executive outreach", description: "Manual-send sequence (no email integration connected).", steps: [{ dayOffset: 0, channel: "email", templateId: t1.id }, { dayOffset: 4, channel: "linkedin", instructions: "Connect on LinkedIn with a short personal note (send manually)." }, { dayOffset: 9, channel: "email", templateId: t2.id }] });
    const targets = await tx.select({ id: leadContacts.id, leadId: leadContacts.leadId }).from(leadContacts).innerJoin(leads, eq(leads.id, leadContacts.leadId)).where(inArray(leads.companyName, ["Cobalt Fintech", "Marlow & Finch", "Nimbus Analytics", "Sahara Ventures"]));
    for (const t of targets) await enroll(tx, U.sales, seqId, { leadContactId: t.id });
    await generateDueDrafts(tx, SYSTEM_ACTOR, new Date(Date.now() + 3600000));
    const [nim] = await tx.select({ id: leadContacts.id, leadId: leadContacts.leadId }).from(leadContacts).innerJoin(leads, eq(leads.id, leadContacts.leadId)).where(eq(leads.companyName, "Nimbus Analytics"));
    await logReply(tx, U.sales, { leadId: nim.leadId, leadContactId: nim.id, channel: "email", sentiment: "neutral", body: "Thanks — interesting but timing is Q1 next year." });
    await tx.update(sequenceEnrollments).set({ enrolledAt: at(-2) });

    // Notifications & health override (logged)
    await tx.insert(notifications).values([
      { userId: U.owner.userId, kind: "approval", title: "Proposal awaiting your approval: Orion brand campaign 2027", href: "/crm/proposals", dedupeKey: "demo:1" },
      { userId: U.owner.userId, kind: "signal", title: "Meridian invoice is more than 30 days overdue", href: "/finance/collections", dedupeKey: "demo:2" },
    ]);
    await overrideAccountHealth(tx, U.owner, A.solace, 80, "CEO confirmed intent to renew on 1:1 call; formal renewal pending procurement.", T(30));
  });
  log("tasks, events, outreach");

  /* ---------------- Recognition, jobs, signals ---------------- */
  await db.transaction(async (tx) => {
    await runRevenueRecognition(tx, SYSTEM_ACTOR, today);
    await changeEngagementStatus(tx, U.owner, E.bluebird, "active");
    await changeEngagementStatus(tx, U.owner, E.bluebird, "completed", "Final strategic plan delivered");
    await tx.execute(sql`update engagements set completed_at = ${at(-200)} where id = ${E.bluebird}`);
    await runRevenueRecognition(tx, SYSTEM_ACTOR, today);
  });
  for (const job of ["refresh-signals", "renewal-tasks", "outreach-drafts", "expire-proposals"]) await runJob(db, job, { triggeredBy: "seed" });
  await db.transaction((tx) => refreshSignals(tx));
  log("done");
}

async function stageIdTx(tx: Tx, key: string) {
  return (await tx.select().from(pipelineStages).where(eq(pipelineStages.key, key)))[0].id;
}

async function createEvent(
  tx: Tx,
  actor: Actor,
  input: { kind: "meeting" | "call" | "discovery" | "account_review" | "internal" | "workshop"; title: string; startsAt: Date; endsAt: Date; accountId?: string; opportunityId?: string; engagementId?: string; contactId?: string; agenda?: string },
  opts: { complete?: { notes: string; decisions?: string; outcome?: string; followUps?: { title: string; ownerId?: string | null; dueDate?: string | null }[] } } = {},
) {
  const ev = await scheduleEvent(tx, actor, { ...input, timeZone: "UTC", organizerId: actor.userId, attendeeUserIds: [actor.userId], attendeeContactIds: input.contactId ? [input.contactId] : [] });
  if (opts.complete) await completeEvent(tx, actor, ev.id, { status: "completed", ...opts.complete });
  return ev;
}

