import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { aiSuggestions, integrations } from "@/db/schema";
import { can, type Actor } from "@/server/auth/actor";
import { aiStatusAction, generateAiAction } from "@/server/actions/ai";
import { Badge, Card, CardBody, CardHeader } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";

/** Optional AI assistance card. Hidden unless the user has ai.use; explains when AI is not configured. */
export async function AiPanel({ actor, kind, entityId, title, description }: { actor: Actor; kind: "followup_draft" | "account_summary"; entityId: string; title: string; description: string }) {
  if (!can(actor, "ai.use")) return null;
  const [cfg] = await db.select().from(integrations).where(and(eq(integrations.kind, "ai"), eq(integrations.provider, "anthropic")));
  const configured = cfg?.status === "connected" || (!!process.env.ANTHROPIC_API_KEY && cfg?.status !== "disabled");
  const rows = await db.select().from(aiSuggestions).where(and(eq(aiSuggestions.entityId, entityId), eq(aiSuggestions.kind, kind), ne(aiSuggestions.status, "discarded"))).orderBy(desc(aiSuggestions.createdAt)).limit(3);
  return (
    <Card>
      <CardHeader title={<span className="flex items-center gap-2">{title}<Badge tone="info">AI · optional</Badge></span>} description={description} />
      <CardBody>
        {!configured ? (
          <p className="text-[12.5px] text-muted">AI assistance is not connected. {can(actor, "integrations.manage") ? <a className="text-accent hover:underline" href="/system/integrations">Configure it</a> : "Ask an administrator to configure it."} Everything else works without it.</p>
        ) : (
          <ActionForm action={generateAiAction}>
            <input type="hidden" name="kind" value={kind} /><input type="hidden" name="entityId" value={entityId} />
            <SubmitButton size="sm" variant="secondary">Generate suggestion</SubmitButton>
            <p className="mt-1 text-[11.5px] text-muted">Uses only facts recorded here. Nothing is sent or saved to the record.</p>
          </ActionForm>
        )}
        {rows.map((s) => (
          <div key={s.id} className="mt-3 rounded-md border border-dashed border-line-strong bg-sunken/40 p-3">
            <p className="mb-1 flex flex-wrap items-center gap-2 text-[11.5px] text-muted"><Badge tone="info">AI suggestion — review before use</Badge><DateTimeText value={s.createdAt} />{s.status !== "suggested" ? <Badge>{s.status}</Badge> : null}</p>
            <textarea readOnly aria-label="AI suggestion text" defaultValue={s.output} rows={8} className="w-full rounded border border-line bg-surface p-2 text-[12.5px]" />
            <p className="mt-1 text-[11.5px] text-muted">Based on: {(s.sourceRefs ?? []).slice(0, 6).map((r) => r.label).join("; ")}{(s.sourceRefs ?? []).length > 6 ? "…" : ""}</p>
            {s.status === "suggested" ? (
              <ActionForm action={aiStatusAction} className="mt-2 flex gap-2" hideSuccess>
                <input type="hidden" name="id" value={s.id} />
                <SubmitButton size="sm" variant="ghost" name="status" value="edited">Used (after editing)</SubmitButton>
                <SubmitButton size="sm" variant="ghost" name="status" value="discarded">Discard</SubmitButton>
              </ActionForm>
            ) : null}
          </div>
        ))}
      </CardBody>
    </Card>
  );
}
