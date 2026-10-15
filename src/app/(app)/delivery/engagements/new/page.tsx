import { guard } from "@/server/auth/session";
import { Card, CardBody, Notice, PageHeader } from "@/components/ui/primitives";
import { EngagementForm } from "@/components/delivery/engagement-form";
import { engagementFormLookups } from "@/components/delivery/lookups";
import { db } from "@/db/client";
import { getSettings } from "@/server/system/settings";

export const metadata = { title: "New engagement" };

export default async function NewEngagementPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("delivery.write");
  const sp = await searchParams;
  const L = await engagementFormLookups(actor, sp.account);
  const s = await getSettings(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "Clients & Delivery", href: "/delivery" }, { label: "Engagements", href: "/delivery/engagements" }, { label: "New" }]} title="New engagement" />
      <Notice className="mb-4 max-w-5xl">Work won through the pipeline should be created with <b>Opportunity → Handover</b>, which carries over the accepted proposal, scope, contract and billing schedule. Use this form for work agreed outside the pipeline.</Notice>
      <Card className="max-w-5xl"><CardBody><EngagementForm {...L} v={{ accountId: sp.account, serviceId: sp.service, currency: s.baseCurrency, ownerId: actor.userId }} /></CardBody></Card>
    </>
  );
}
