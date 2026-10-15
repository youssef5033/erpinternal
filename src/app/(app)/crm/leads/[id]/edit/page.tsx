import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { leadServiceFits, leads } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { leadVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { PageHeader } from "@/components/ui/primitives";
import { LeadForm } from "@/components/crm/lead-form";

export default async function EditLeadPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.write");
  const { id } = await params;
  const [lead] = await db.select().from(leads).where(and(eq(leads.id, id), leadVisibility(actor)));
  if (!lead) notFound();
  const fits = await db.select().from(leadServiceFits).where(eq(leadServiceFits.leadId, id));
  const L = await crmLookups();
  return (
    <>
      <PageHeader crumbs={[{ label: "Leads", href: "/crm/leads" }, { label: lead.companyName, href: `/crm/leads/${id}` }, { label: "Edit" }]} title={`Edit ${lead.companyName}`} />
      <LeadForm lead={lead} serviceIds={fits.map((f) => f.serviceId)} users={L.users} channels={L.channels} services={L.services} campaigns={L.campaigns} industries={L.industries} sizeBands={L.sizeBands} customFields={L.customFields.filter((c) => c.entityType === "lead")} currentUserId={actor.userId} />
    </>
  );
}
