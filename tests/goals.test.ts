import { beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db, makeActors, resetDb, type TestActors } from "./helpers/db";
import { goals } from "@/db/schema";
import { addGoal, carryOverGoals, deleteGoal, goalHistory, listGoals, MAX_GOALS_PER_PERIOD, openInPreviousPeriod, periodStartFor, setGoalDone, stepGoalProgress } from "@/server/ops/goals";
import { NotFoundError, ValidationError } from "@/server/errors";

let A: TestActors;
const t = <T>(fn: Parameters<typeof db.transaction<T>>[0]) => db.transaction(fn);

beforeAll(async () => {
  await resetDb();
  A = await makeActors();
});

describe("goals", () => {
  it("files weekly goals under the Monday of their week and daily goals under their day", async () => {
    expect(periodStartFor("week", "2026-10-22")).toBe("2026-10-19"); // Thursday → Monday
    expect(periodStartFor("week", "2026-10-25")).toBe("2026-10-19"); // Sunday stays in that week
    expect(periodStartFor("day", "2026-10-22")).toBe("2026-10-22");
    const w = await t((tx) => addGoal(tx, A.sales, { period: "week", date: "2026-10-23", title: "  Close two deals  " }));
    expect(w.periodStart).toBe("2026-10-19");
    expect(w.title).toBe("Close two deals");
    expect((await listGoals(db, A.sales, "week", "2026-10-21")).map((g) => g.id)).toContain(w.id);
  });

  it("keeps goals private: other users cannot see, tick or remove them", async () => {
    const g = await t((tx) => addGoal(tx, A.sales, { period: "day", date: "2026-10-20", title: "Call Acme" }));
    expect(await listGoals(db, A.owner, "day", "2026-10-20")).toHaveLength(0);
    await expect(t((tx) => setGoalDone(tx, A.owner, g.id, true))).rejects.toBeInstanceOf(NotFoundError);
    await expect(t((tx) => deleteGoal(tx, A.owner, g.id))).rejects.toBeInstanceOf(NotFoundError);
    await t((tx) => setGoalDone(tx, A.sales, g.id, true));
    const [row] = await db.select().from(goals).where(eq(goals.id, g.id));
    expect(row.status).toBe("done");
    expect(row.completedAt).not.toBeNull();
    await t((tx) => setGoalDone(tx, A.sales, g.id, false));
    expect((await db.select().from(goals).where(eq(goals.id, g.id)))[0].status).toBe("open");
  });

  it("tracks progress towards a numeric target and completes at the target", async () => {
    const g = await t((tx) => addGoal(tx, A.sales, { period: "day", date: "2026-10-21", title: "Discovery calls", target: 3 }));
    for (let i = 0; i < 3; i++) await t((tx) => stepGoalProgress(tx, A.sales, g.id, 1));
    let [row] = await db.select().from(goals).where(eq(goals.id, g.id));
    expect([row.progress, row.status]).toEqual([3, "done"]);
    await t((tx) => stepGoalProgress(tx, A.sales, g.id, 1)); // capped at target
    await t((tx) => stepGoalProgress(tx, A.sales, g.id, -1));
    [row] = await db.select().from(goals).where(eq(goals.id, g.id));
    expect([row.progress, row.status]).toEqual([2, "open"]);
    const plain = await t((tx) => addGoal(tx, A.sales, { period: "day", date: "2026-10-21", title: "No number" }));
    await expect(t((tx) => stepGoalProgress(tx, A.sales, plain.id, 1))).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates input and limits goals per period", async () => {
    await expect(t((tx) => addGoal(tx, A.finance, { period: "day", date: "2026-10-20", title: "   " }))).rejects.toBeInstanceOf(ValidationError);
    await expect(t((tx) => addGoal(tx, A.finance, { period: "day", date: "2026-10-20", title: "x".repeat(201) }))).rejects.toBeInstanceOf(ValidationError);
    await expect(t((tx) => addGoal(tx, A.finance, { period: "day", date: "2026-10-20", title: "Bad target", target: 0 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(t((tx) => addGoal(tx, A.finance, { period: "day", date: "not-a-date", title: "Bad date" }))).rejects.toBeInstanceOf(ValidationError);
    for (let i = 0; i < MAX_GOALS_PER_PERIOD; i++) await t((tx) => addGoal(tx, A.finance, { period: "day", date: "2026-11-02", title: `Goal ${i}` }));
    await expect(t((tx) => addGoal(tx, A.finance, { period: "day", date: "2026-11-02", title: "One too many" }))).rejects.toThrow(/already have/);
  });

  it("carries unfinished goals forward once, keeping the originals as history", async () => {
    const a = await t((tx) => addGoal(tx, A.account_manager, { period: "week", date: "2026-10-12", title: "Ship brand deck", target: 4 }));
    const b = await t((tx) => addGoal(tx, A.account_manager, { period: "week", date: "2026-10-12", title: "Renewal call" }));
    const c = await t((tx) => addGoal(tx, A.account_manager, { period: "week", date: "2026-10-12", title: "Done already" }));
    await t((tx) => setGoalDone(tx, A.account_manager, c.id, true));
    await t((tx) => stepGoalProgress(tx, A.account_manager, a.id, 1));
    expect(await openInPreviousPeriod(db, A.account_manager, "week", "2026-10-20")).toBe(2);
    expect(await t((tx) => carryOverGoals(tx, A.account_manager, "week", "2026-10-20"))).toBe(2);
    expect(await t((tx) => carryOverGoals(tx, A.account_manager, "week", "2026-10-20"))).toBe(0); // idempotent
    const now = await listGoals(db, A.account_manager, "week", "2026-10-19");
    expect(now.map((g) => g.title).sort()).toEqual(["Renewal call", "Ship brand deck"]);
    expect(now.find((g) => g.title === "Ship brand deck")!.progress).toBe(1); // progress carried
    const before = await listGoals(db, A.account_manager, "week", "2026-10-12");
    expect(before.find((g) => g.id === a.id)!.status).toBe("carried");
    expect(before.find((g) => g.id === b.id)!.status).toBe("carried");
    expect(before.find((g) => g.id === c.id)!.status).toBe("done");
    await expect(t((tx) => setGoalDone(tx, A.account_manager, a.id, true))).rejects.toBeInstanceOf(ValidationError);
    // Removing the carried copy reopens the original
    await t((tx) => deleteGoal(tx, A.account_manager, now.find((g) => g.title === "Renewal call")!.id));
    expect((await db.select().from(goals).where(eq(goals.id, b.id)))[0].status).toBe("open");
    const hist = await goalHistory(db, A.account_manager, "week", "2026-10-20", 2);
    expect(hist).toEqual([
      { start: "2026-10-12", total: 3, done: 1 },
      { start: "2026-10-19", total: 1, done: 0 },
    ]);
  });
});
