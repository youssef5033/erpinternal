import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { engagements } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { engagementVisibility } from "@/server/auth/scope";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { EngagementForm } from "@/components/delivery/engagement-form";
import { engagementFormLookups } from "@/components/delivery/lookups";

export const metadata = { title: "Edit engagement" };

export default async function EditEngagementPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("delivery.write");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [e] = await db.select().from(engagements).where(and(eq(engagements.id, id), engagementVisibility(actor, "delivery.write")));
  if (!e) notFound();
  const L = await engagementFormLookups(actor, e.accountId);
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: "Engagements", href: "/delivery/engagements" }, { label: e.name, href: `/delivery/engagements/${id}` }, { label: "Edit" }]} title={`Edit ${e.name}`} description="Changes to value, budget or end date after scope is agreed should go through a change request so the client approval is recorded." />
      <Card className="max-w-5xl"><CardBody><EngagementForm {...L} v={e} /></CardBody></Card>
    </>
  );
}
