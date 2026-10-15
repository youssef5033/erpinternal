import { guard } from "@/server/auth/session";
import { crmLookups } from "@/server/crm/lookups";
import { opportunityFormLookups } from "@/server/crm/opp-lookups";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { Field, Select } from "@/components/forms/fields";
import { OpportunityForm } from "@/components/crm/opportunity-form";

export const metadata = { title: "New opportunity" };

export default async function NewOpportunityPage({ searchParams }: { searchParams: Promise<{ account?: string; kind?: string; engagement?: string }> }) {
  const actor = await guard("crm.write");
  const sp = await searchParams;
  const L = await crmLookups();
  const O = await opportunityFormLookups(sp.account);
  return (
    <>
      <PageHeader crumbs={[{ label: "Opportunities", href: "/crm/opportunities" }, { label: "New" }]} title="New opportunity" description="Opportunities always belong to an existing account (shared customer identity). Convert a lead to create one from research." />
      {!sp.account ? (
        <Card>
          <CardBody>
            <form method="get" className="flex flex-wrap items-end gap-2">
              <Field label="Account" htmlFor="account"><Select id="account" name="account" options={O.accounts} required /></Field>
              {sp.kind ? <input type="hidden" name="kind" value={sp.kind} /> : null}
              <button className="h-9 rounded-md bg-accent px-3.5 text-sm font-medium text-white" type="submit">Continue</button>
            </form>
          </CardBody>
        </Card>
      ) : (
        <OpportunityForm accounts={O.accounts} contacts={O.contacts} users={L.users} services={L.services} channels={L.channels} campaigns={L.campaigns} stages={O.stages} engagements={O.engagements} defaults={{ accountId: sp.account, kind: sp.kind, currency: O.accountCurrency, ownerId: actor.userId }} serviceIds={[]} contactIds={O.contacts.map((c) => c.value)}/>
      )}
    </>
  );
}
