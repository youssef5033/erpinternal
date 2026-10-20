"use server";

import { z } from "zod";
import { f } from "@/lib/formdata";
import { runAction, type ActionState } from "./run";
import { addGoal, carryOverGoals, deleteGoal, setGoalDone, stepGoalProgress } from "../ops/goals";

// Goals are personal: any signed-in user can manage their own (no role permission needed).
const PERIOD = f.enumOf(["day", "week"] as const);

export async function addGoalAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    action: "goal.add",
    schema: z.object({ period: PERIOD, date: f.date(), title: f.str(200), target: f.optInt() }),
    run: async ({ actor, tx, data }) => {
      await addGoal(tx, actor, data);
      return "Goal added.";
    },
  });
}

export async function goalStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    action: "goal.status",
    schema: z.object({ id: f.id(), op: f.enumOf(["done", "reopen", "plus", "minus", "delete"] as const) }),
    run: async ({ actor, tx, data }) => {
      if (data.op === "done" || data.op === "reopen") await setGoalDone(tx, actor, data.id, data.op === "done");
      else if (data.op === "plus" || data.op === "minus") await stepGoalProgress(tx, actor, data.id, data.op === "plus" ? 1 : -1);
      else await deleteGoal(tx, actor, data.id);
      return "Updated.";
    },
  });
}

export async function carryOverGoalsAction(_p: ActionState, fd: FormData) {
  return runAction(fd, {
    action: "goal.carry",
    schema: z.object({ period: PERIOD, date: f.date() }),
    run: async ({ actor, tx, data }) => {
      const n = await carryOverGoals(tx, actor, data.period, data.date);
      return n ? `Carried over ${n} unfinished goal${n === 1 ? "" : "s"}.` : "Nothing left to carry over.";
    },
  });
}
