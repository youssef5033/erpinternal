import { db } from "@/db/client";
import { integrations } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { INTEGRATION_CATALOG } from "@/server/system/admin";
import { credentialsKeyConfigured } from "@/server/crypto";
import { integrationAction } from "@/server/actions/system";
import { Badge, Card, CardBody, CardHeader, Notice, PageHeader } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input } from "@/components/forms/fields";

export const metadata = { title: "Integrations" };

export default async function IntegrationsPage() {
  await guard("integrations.manage");
  const rows = await db.select().from(integrations);
  const ai = rows.find((r) => r.kind === "ai" && r.provider === "anthropic");
  const envKey = !!process.env.ANTHROPIC_API_KEY;
  const keyOk = credentialsKeyConfigured();
  const status = ai?.status ?? "not_configured";
  const tone = status === "connected" ? "success" : status === "error" ? "danger" : status === "pending_verification" ? "warning" : "neutral";
  return (
    <>
      <PageHeader crumbs={[{ label: "System & Integrations" }, { label: "Integrations" }]} title="Integrations" description="A connection shows as Connected only after a real verification call succeeds. Credentials are encrypted on the server and never sent to the browser or written to logs." />
      {!keyOk ? <Notice tone="warning" className="mb-4" title="Credential encryption key not set">CREDENTIALS_ENCRYPTION_KEY is missing, so credentials cannot be stored in the database. Server environment variables (e.g. ANTHROPIC_API_KEY) still work.</Notice> : null}
      <div className="grid gap-4 xl:grid-cols-2">
        {INTEGRATION_CATALOG.map((c) => (
          <Card key={c.kind}>
            <CardHeader title={c.name} actions={c.available ? <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge> : <Badge>not available</Badge>} description={c.note} />
            {c.kind === "ai" ? (
              <CardBody>
                <dl className="mb-3 space-y-1 text-[13px]">
                  <div><dt className="inline text-muted">Key source: </dt><dd className="inline">{ai?.credentialHint ? `stored (${ai.credentialHint})` : envKey ? "server environment (ANTHROPIC_API_KEY)" : "none"}</dd></div>
                  {ai?.verifiedAt ? <div><dt className="inline text-muted">Last verified: </dt><dd className="inline"><DateTimeText value={ai.verifiedAt} /></dd></div> : null}
                  {ai?.lastError ? <div className="text-danger">{ai.lastError}{ai.lastErrorAt ? <> (<DateTimeText value={ai.lastErrorAt} />)</> : null}</div> : null}
                </dl>
                <ActionForm action={integrationAction} resetOnSuccess className="space-y-2">
                  <Field label="API key" hint="Stored encrypted (AES-256-GCM). Only a short hint is ever displayed."><Input type="password" name="apiKey" autoComplete="off" placeholder="sk-ant-…" /></Field>
                  <div className="flex flex-wrap gap-2">
                    {keyOk ? <SubmitButton size="sm" name="op" value="save">Save &amp; verify</SubmitButton> : null}
                    {ai?.credentialHint || envKey ? <SubmitButton size="sm" variant="secondary" name="op" value="verify">Verify now</SubmitButton> : null}
                    {ai && (ai.credentialHint || ai.status === "connected" || ai.status === "error") ? <SubmitButton size="sm" variant="ghost" name="op" value="disable" confirm="Disable AI assistance and delete the stored key?">Disable</SubmitButton> : null}
                  </div>
                </ActionForm>
              </CardBody>
            ) : null}
          </Card>
        ))}
      </div>
      <Card className="mt-4">
        <CardHeader title="Data exchange without integrations" />
        <CardBody>
          <ul className="list-disc space-y-1 pl-5 text-[13px]">
            <li>Leads and contacts: CSV import with mapping, validation and duplicate review (CRM → Leads → Import).</li>
            <li>Bank statements: CSV import with duplicate detection (Finance → Bank).</li>
            <li>Exports: leads, accounts, contacts, opportunities, invoices, bills, time and journal lines as CSV (System → Imports &amp; exports).</li>
            <li>Outreach: drafts are copied and sent by people from their own mailbox or LinkedIn, then marked as sent.</li>
          </ul>
        </CardBody>
      </Card>
      {rows.filter((r) => r.kind !== "ai").length ? <p className="mt-2 text-[12px] text-muted">Other stored integration records: {rows.filter((r) => r.kind !== "ai").map((r) => `${r.displayName} (${r.status})`).join(", ")}</p> : null}
    </>
  );
}
