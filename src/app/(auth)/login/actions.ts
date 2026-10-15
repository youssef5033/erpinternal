"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { APIError } from "better-auth/api";
import { auth } from "@/server/auth/auth";
import type { ActionState } from "@/components/forms/action-form";

export async function signIn(_prev: ActionState, fd: FormData): Promise<ActionState> {
  const email = String(fd.get("email") ?? "").trim().toLowerCase();
  const password = String(fd.get("password") ?? "");
  const next = String(fd.get("next") ?? "/operations");
  if (!email || !password) return { ok: false, message: "Enter your email and password." };
  try {
    await auth.api.signInEmail({ body: { email, password }, headers: await headers() });
  } catch (err) {
    if (err instanceof APIError) return { ok: false, message: "Email or password is incorrect, or the account is disabled." };
    console.error("[login]", err);
    return { ok: false, message: "Sign-in failed. Try again." };
  }
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/operations");
}
