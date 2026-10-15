import Link from "next/link";
import { and, eq, or } from "drizzle-orm";
import { db } from "@/db/client";
import { savedViews } from "@/db/schema";
import type { Actor } from "@/server/auth/actor";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Checkbox, Input } from "@/components/forms/fields";
import { saveViewAction } from "@/server/actions/shared";

/** Saved filter combinations (personal or shared) for a list page. */
export async function SavedViews({ actor, module, basePath, query }: { actor: Actor; module: string; basePath: string; query: string }) {
  const views = await db.select().from(savedViews).where(and(eq(savedViews.module, module), or(eq(savedViews.userId, actor.userId), eq(savedViews.shared, true)))).orderBy(savedViews.name);
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-[12.5px]">
      <span className="text-muted">Saved views:</span>
      {views.length ? views.map((v) => (
        <Link key={v.id} href={`${basePath}?${v.query}`} className="rounded-full border border-line bg-surface px-2.5 py-0.5 text-ink-2 hover:border-accent hover:text-ink">
          {v.name}
          {v.shared ? " · shared" : ""}
        </Link>
      )) : <span className="text-faint">none yet</span>}
      {query ? (
        <details className="ml-1">
          <summary className="cursor-pointer text-accent">Save current view</summary>
          <ActionForm action={saveViewAction} className="mt-1 flex flex-wrap items-center gap-2">
            <input type="hidden" name="module" value={module} />
            <input type="hidden" name="query" value={query} />
            <Input name="name" placeholder="View name" required className="h-7 w-44 py-0" aria-label="View name" />
            <Checkbox name="shared" label="Share with team" />
            <SubmitButton size="sm" variant="secondary">Save</SubmitButton>
          </ActionForm>
        </details>
      ) : null}
    </div>
  );
}
