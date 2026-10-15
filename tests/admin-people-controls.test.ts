import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, makeActors, resetDb, type TestActors } from "./helpers/db";
import { accounts, contracts, integrations, leaveRequests, people, roles, services, session, timeEntries, user } from "@/db/schema";
import { createEngagement, createDeliverable, setEngagementMembers } from "@/server/delivery/engagements";
import { saveContract, setContractStatus } from "@/server/delivery/contracts";
import { approveTimeEntries, logTime, rejectTimeEntries } from "@/server/delivery/time";
import { decideLeave, requestLeave } from "@/server/people/people";
import { createUser, saveRole, setUserRoles, setUserStatus, verifyAi } from "@/server/system/admin";
import { generateSuggestion } from "@/server/ai/assist";
import { scheduleEvent, updateEvent } from "@/server/delivery/events";
import { calendarItems } from "@/server/ops/calendar";
import { loadActor } from "@/server/auth/actor";
import { ForbiddenError, ValidationError } from "@/server/errors";

let A: TestActors;
let accountId: string;
let serviceId: string;

beforeAll(async () => {
  await resetDb();
  A = await makeActors();
  serviceId = (await db.select().from(services).where(eq(services.key, "advisory")))[0].id;
  const [acc] = await db.insert(accounts).values({ name: "Meridian Capital", normalizedName: "meridian capital", ownerId: A.account_manager.userId, lifecycleStatus: "active" }).returning();
  accountId = acc.id;
});

describe("contracts", () => {
  it("requires signature evidence and freezes value and term once signed", async () => {
    const c = await db.transaction((tx) => saveContract(tx, A.account_manager, { title: "SOW", accountId, contractType: "sow", value: "12000", currency: "USD", startDate: "2026-10-01", endDate: "2026-12-31" }));
    await expect(db.transaction((tx) => setContractStatus(tx, A.account_manager, c.id, { status: "signed", signedAt: "2026-10-02" }))).rejects.toBeInstanceOf(ValidationError);
    await db.transaction((tx) => setContractStatus(tx, A.account_manager, c.id, { status: "signed", signedAt: "2026-10-02", signatureMethod: "signed_document", signatureEvidence: "Countersigned PDF uploaded" }));
    const [row] = await db.select().from(contracts).where(eq(contracts.id, c.id));
    expect(row.status).toBe("signed");
    expect(row.signatureEvidence).toContain("Countersigned");
    await expect(db.transaction((tx) => saveContract(tx, A.account_manager, { id: c.id, title: "SOW", accountId, contractType: "sow", value: "15000", currency: "USD", startDate: "2026-10-01", endDate: "2026-12-31" }))).rejects.toThrow(/cannot be edited/);
    await expect(db.transaction((tx) => setContractStatus(tx, A.account_manager, c.id, { status: "sent" }))).rejects.toThrow(/cannot move/);
    await expect(db.transaction((tx) => saveContract(tx, A.read_only, { title: "X", accountId, contractType: "nda" }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("time approval", () => {
  it("blocks approving or rejecting your own time and snapshots cost for others", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.operations_manager, { name: "Model build", accountId, serviceId, billingModel: "hourly", hourlyRate: "200", currency: "USD", ownerId: A.operations_manager.userId }));
    const own = await db.transaction((tx) => logTime(tx, A.operations_manager, { workDate: "2026-10-05", hours: "2", engagementId: eng.id, billable: true }));
    await expect(db.transaction((tx) => approveTimeEntries(tx, A.operations_manager, [own.id]))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => rejectTimeEntries(tx, A.operations_manager, [own.id], "fix"))).rejects.toBeInstanceOf(ForbiddenError);
    await db.transaction((tx) => setEngagementMembers(tx, A.operations_manager, eng.id, [{ userId: A.team_member.userId }]));
    const theirs = await db.transaction((tx) => logTime(tx, A.team_member, { workDate: "2026-10-05", hours: "3", engagementId: eng.id, billable: true }));
    await db.transaction((tx) => approveTimeEntries(tx, A.operations_manager, [theirs.id]));
    const [t] = await db.select().from(timeEntries).where(eq(timeEntries.id, theirs.id));
    expect(t.status).toBe("approved");
    expect(t.billRate).toBe("200.00");
  });
});

describe("leave", () => {
  it("separates requester and approver, blocks overlaps, and requires a reason to reject", async () => {
    const [me] = await db.select().from(people).where(eq(people.userId, A.team_member.userId));
    const req = await db.transaction((tx) => requestLeave(tx, A.team_member, { personId: me.id, leaveType: "annual", startDate: "2026-11-02", endDate: "2026-11-06" }));
    expect(Number(req.hours)).toBe(40);
    await expect(db.transaction((tx) => requestLeave(tx, A.team_member, { personId: me.id, leaveType: "annual", startDate: "2026-11-05", endDate: "2026-11-09" }))).rejects.toThrow(/overlaps/);
    const [other] = await db.select().from(people).where(eq(people.userId, A.sales.userId));
    await expect(db.transaction((tx) => requestLeave(tx, A.team_member, { personId: other.id, leaveType: "annual", startDate: "2026-12-01", endDate: "2026-12-01" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => decideLeave(tx, A.team_member, req.id, "approved"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => decideLeave(tx, A.operations_manager, req.id, "rejected"))).rejects.toBeInstanceOf(ValidationError);
    await db.transaction((tx) => decideLeave(tx, A.operations_manager, req.id, "approved"));
    const [row] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, req.id));
    expect(row.status).toBe("approved");
    expect(row.approverId).toBe(A.operations_manager.userId);
    // Own leave cannot be self-approved even by an approver
    const [ops] = await db.select().from(people).where(eq(people.userId, A.operations_manager.userId));
    const mine = await db.transaction((tx) => requestLeave(tx, A.operations_manager, { personId: ops.id, leaveType: "annual", startDate: "2026-12-14", endDate: "2026-12-15" }));
    await expect(db.transaction((tx) => decideLeave(tx, A.operations_manager, mine.id, "approved"))).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("users and roles", () => {
  it("keeps at least one active Owner and signs users out when access changes", async () => {
    const ownerRole = (await db.select().from(roles).where(eq(roles.key, "owner")))[0];
    const salesRole = (await db.select().from(roles).where(eq(roles.key, "sales")))[0];
    await expect(db.transaction((tx) => setUserRoles(tx, A.owner, A.owner.userId, [salesRole.id]))).rejects.toThrow(/Owner/);
    await expect(db.transaction((tx) => setUserStatus(tx, A.owner, A.owner.userId, "disabled"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => createUser(tx, A.owner, { name: "Weak", email: "weak@test.local", password: "short", roleIds: [salesRole.id] }))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => createUser(tx, A.sales, { name: "Nope", email: "nope@test.local", password: "long-enough-password-1", roleIds: [ownerRole.id] }))).rejects.toBeInstanceOf(ForbiddenError);
    const u = await db.transaction((tx) => createUser(tx, A.owner, { name: "New Hire", email: "new@test.local", password: "long-enough-password-1", roleIds: [salesRole.id] }));
    await db.insert(session).values({ id: crypto.randomUUID(), token: crypto.randomUUID(), userId: u.id, expiresAt: new Date(Date.now() + 86400000) });
    await db.transaction((tx) => setUserStatus(tx, A.owner, u.id, "disabled"));
    expect(await db.select().from(session).where(eq(session.userId, u.id))).toHaveLength(0);
    expect(await loadActor(db, u.id)).toBeNull();
    const [row] = await db.select().from(user).where(eq(user.id, u.id));
    expect(row.status).toBe("disabled");
    await expect(db.transaction((tx) => saveRole(tx, A.owner, { id: ownerRole.id, name: "Owner", grants: {} }))).rejects.toBeInstanceOf(ForbiddenError);
    const rid = await db.transaction((tx) => saveRole(tx, A.owner, { name: "Auditor", grants: { "audit.read": "all", "finance.read": "assigned" } }));
    const auditor = await db.transaction((tx) => createUser(tx, A.owner, { name: "Aud", email: "aud@test.local", password: "long-enough-password-1", roleIds: [rid] }));
    const act = (await loadActor(db, auditor.id))!;
    expect(act.grants.get("audit.read")).toBe("all");
    expect(act.grants.get("finance.read")).toBe("assigned");
    expect(act.grants.has("finance.write")).toBe(false);
  });
});

describe("integrations and AI honesty", () => {
  it("never reports a connection without a successful verification and refuses AI without a key", async () => {
    const prev = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(db.transaction((tx) => verifyAi(tx, A.owner))).rejects.toBeInstanceOf(ValidationError);
      const rows = await db.select().from(integrations);
      expect(rows.filter((r) => r.status === "connected")).toHaveLength(0);
      await expect(db.transaction((tx) => generateSuggestion(tx, A.owner, "account_summary", accountId))).rejects.toThrow(/not configured/);
      await expect(db.transaction((tx) => generateSuggestion(tx, A.contractor, "account_summary", accountId))).rejects.toBeInstanceOf(ForbiddenError);
    } finally {
      if (prev) process.env.ANTHROPIC_API_KEY = prev;
    }
  });
});

describe("calendar and events visibility", () => {
  it("hides other engagements' items from contractors and blocks editing events they cannot see", async () => {
    const eng = await db.transaction((tx) => createEngagement(tx, A.operations_manager, { name: "Private engagement", accountId, serviceId, billingModel: "fixed", contractValue: "5000", currency: "USD", ownerId: A.operations_manager.userId }));
    await db.transaction((tx) => createDeliverable(tx, A.operations_manager, eng.id, { name: "Secret deck", dueDate: "2026-10-20" }));
    const ev = await db.transaction((tx) => scheduleEvent(tx, A.operations_manager, { kind: "meeting", title: "Steering committee", startsAt: new Date("2026-10-21T10:00:00Z"), endsAt: new Date("2026-10-21T11:00:00Z"), timeZone: "UTC", engagementId: eng.id, accountId }));
    const forContractor = await calendarItems(db, A.contractor, "2026-10-01", "2026-10-31", { timeZone: "UTC" });
    expect(forContractor.some((i) => i.title === "Secret deck" || i.title === "Steering committee")).toBe(false);
    const forOps = await calendarItems(db, A.operations_manager, "2026-10-01", "2026-10-31", { timeZone: "UTC" });
    expect(forOps.some((i) => i.title === "Secret deck")).toBe(true);
    expect(forOps.some((i) => i.title === "Steering committee")).toBe(true);
    await expect(db.transaction((tx) => updateEvent(tx, A.contractor, ev.id, { kind: "meeting", title: "Hijack", startsAt: new Date("2026-10-21T10:00:00Z"), endsAt: new Date("2026-10-21T11:00:00Z"), timeZone: "UTC" }))).rejects.toBeInstanceOf(ForbiddenError);
  });
});
