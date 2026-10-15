"use server";

import { z } from "zod";
import { f } from "@/lib/formdata";
import { runAction, type ActionState } from "./run";
import { generateSuggestion, setSuggestionStatus } from "../ai/assist";

export async function generateAiAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "ai.use", action: "ai.generate", schema: z.object({ kind: f.enumOf(["followup_draft", "account_summary"] as const), entityId: f.id() }), run: async ({ actor, tx, data }) => {
    await generateSuggestion(tx, actor, data.kind, data.entityId);
    return "Suggestion generated. Review it carefully — it has not been sent or saved to the record.";
  } });
}

export async function aiStatusAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { permission: "ai.use", action: "ai.status", schema: z.object({ id: f.id(), status: f.enumOf(["accepted", "edited", "discarded"] as const) }), run: async ({ actor, tx, data }) => {
    await setSuggestionStatus(tx, actor, data.id, data.status);
    return data.status === "discarded" ? "Discarded." : "Marked as used.";
  } });
}
