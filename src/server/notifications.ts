import type { Tx } from "@/db/client";
import { notifications } from "@/db/schema";

/** In-app notification (no email is sent). dedupeKey makes repeats a no-op. */
export async function notify(tx: Tx, n: { userId: string; kind: string; title: string; body?: string | null; href?: string | null; dedupeKey?: string | null }) {
  await tx.insert(notifications).values({ userId: n.userId, kind: n.kind, title: n.title, body: n.body ?? null, href: n.href ?? null, dedupeKey: n.dedupeKey ?? null }).onConflictDoNothing();
}
