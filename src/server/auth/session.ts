import "server-only";
import { cache } from "react";
import { headers } from "next/headers";
import { forbidden, redirect } from "next/navigation";
import { db } from "@/db/client";
import { auth } from "./auth";
import { can, loadActor, type Actor } from "./actor";
import type { Permission } from "./permissions";

/** Current actor for this request (memoised per request). Null when signed out. */
export const getActor = cache(async (): Promise<Actor | null> => {
  const s = await auth.api.getSession({ headers: await headers() });
  if (!s?.user) return null;
  return loadActor(db, s.user.id);
});

/** Require a signed-in, active user; redirects to /login otherwise. */
export async function requireActor(): Promise<Actor> {
  const actor = await getActor();
  if (!actor) redirect("/login");
  return actor;
}

/** Page/route guard: signed in AND holds one of the permissions, else 403 page. */
export async function guard(...anyOf: Permission[]): Promise<Actor> {
  const actor = await requireActor();
  if (anyOf.length && !anyOf.some((p) => can(actor, p))) forbidden();
  return actor;
}
