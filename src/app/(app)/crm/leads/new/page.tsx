import { guard } from "@/server/auth/session";
import { crmLookups } from "@/server/crm/lookups";
import { PageHeader } from "@/components/ui/primitives";
import { LeadForm } from "@/components/crm/lead-form";

export const metadata = { title: "New lead" };

export default async function NewLeadPage() {
  const actor = await guard("crm.write");
  const L = await crmLookups();
  return (
    <>
      <PageHeader crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Leads", href: "/crm/leads" }, { label: "New" }]} title="New lead" description="Duplicates are checked against existing leads, accounts and contacts by normalized domain, email and company name." />
      <LeadForm users={L.users} channels={L.channels} services={L.services} campaigns={L.campaigns} industries={L.industries} sizeBands={L.sizeBands} customFields={L.customFields.filter((c) => c.entityType === "lead")} currentUserId={actor.userId} />
    </>
  );
}
