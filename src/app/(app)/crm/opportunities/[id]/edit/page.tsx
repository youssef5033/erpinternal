import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { opportunities, opportunityContacts, opportunityServices } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { opportunityVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { opportunityFormLookups } from "@/server/crm/opp-lookups";
import { PageHeader } from "@/components/ui/primitives";
import { OpportunityForm } from "@/components/crm/opportunity-form";

export default async function EditOpportunityPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.write");
  const { id } = await params;
  const [o] = await db.select().from(opportunities).where(and(eq(opportunities.id, id), opportunityVisibility(actor)));
  if (!o) notFound();
  const L = await crmLookups();
  const O = await opportunityFormLookups(o.accountId);
  const svc = await db.select().from(opportunityServices).where(eq(opportunityServices.opportunityId, id));
  const cts = await db.select().from(opportunityContacts).where(eq(opportunityContacts.opportunityId, id));
  return (
    <>
      <PageHeader crumbs={[{ label: "Opportunities", href: "/crm/opportunities" }, { label: o.number, href: `/crm/opportunities/${id}` }, { label: "Edit" }]} title={`Edit ${o.name}`} />
      <OpportunityForm opp={o} serviceIds={svc.map((s) => s.serviceId)} contactIds={cts.map((c) => c.contactId)} accounts={O.accounts} contacts={O.contacts} users={L.users} services={L.services} channels={L.channels} campaigns={L.campaigns} stages={O.stages} engagements={O.engagements} defaults={{ ownerId: actor.userId }} />
    </>
  );
}
