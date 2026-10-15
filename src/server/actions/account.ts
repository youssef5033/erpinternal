"use server";

import { z } from "zod";
import { and, eq, ne } from "drizzle-orm";
import { headers } from "next/headers";
import { f } from "@/lib/formdata";
import { session, user } from "@/db/schema";
import { runAction, type ActionState } from "./run";
import { auth } from "../auth/auth";
import { audit } from "../audit";
import { ValidationError } from "../errors";

export async function updateProfileAction(_p: ActionState, fd: FormData) {
  return runAction(fd, { action: "account.profile", schema: z.object({ name: f.str(200), title: f.optStr(200), timeZone: f.optStr(64) }), run: async ({ actor, tx, data }) => {
    if (data.timeZone) {
      try {
        new Intl.DateTimeFormat("en", { timeZone: data.timeZone });
      } catch {
        throw new ValidationError(`Unknown time zone "${data.timeZone}".`, { timeZone: "Use an IANA name such as Europe/London" });
      }
    }
    await tx.update(user).set({ name: data.name, title: data.title, timeZone: data.timeZone, updatedAt: new Date() }).where(eq(user.id, actor.userId));
    await audit(tx, actor, { action: "account.profile_updated", entityType: "user", entityId: actor.userId, summary: "Updated own profile" });
    return "Profile saved.";
  } });
}

export async function changePasswordAction(_p: ActionState, fd: FormData): Promise<ActionState> {
  const currentPassword = String(fd.get("currentPassword") ?? "");
  const newPassword = String(fd.get("newPassword") ?? "");
  if (newPassword.length < 12 || !/[a-z]/i.test(newPassword) || !/\d/.test(newPassword)) return { ok: false, message: "Use at least 12 characters with letters and numbers.", fieldErrors: { newPassword: "Too weak" } };
  if (newPassword !== String(fd.get("confirm") ?? "")) return { ok: false, message: "The new passwords do not match.", fieldErrors: { confirm: "Does not match" } };
  try {
    await auth.api.changePassword({ body: { currentPassword, newPassword, revokeOtherSessions: true }, headers: await headers() });
  } catch {
    return { ok: false, message: "Current password is incorrect.", fieldErrors: { currentPassword: "Incorrect" } };
  }
  return runAction(fd, { action: "account.password_changed", schema: z.object({}), run: async ({ actor, tx }) => {
    await audit(tx, actor, { action: "account.password_changed", entityType: "user", entityId: actor.userId, summary: "Changed own password; other sessions signed out" });
    return "Password changed. Your other sessions were signed out.";
  } });
}

export async function revokeOtherSessionsAction(_p: ActionState, fd: FormData) {
  const current = await auth.api.getSession({ headers: await headers() });
  return runAction(fd, { action: "account.sessions", schema: z.object({}), run: async ({ actor, tx }) => {
    const res = await tx.delete(session).where(and(eq(session.userId, actor.userId), current ? ne(session.id, current.session.id) : undefined)).returning({ id: session.id });
    await audit(tx, actor, { action: "account.sessions_revoked", entityType: "user", entityId: actor.userId, summary: `Signed out ${res.length} other session(s)` });
    return `${res.length} other session(s) signed out.`;
  } });
}
