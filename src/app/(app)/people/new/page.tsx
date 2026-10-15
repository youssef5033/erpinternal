import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { getSettings } from "@/server/system/settings";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { PersonForm } from "@/components/people/person-form";
import { personFormLookups } from "@/components/people/lookups";

export const metadata = { title: "Add person" };

export default async function NewPersonPage() {
  await guard("people.write");
  const L = await personFormLookups();
  const s = await getSettings(db);
  return (
    <>
      <PageHeader crumbs={[{ label: "People", href: "/people" }, { label: "Add person" }]} title="Add person" description="Start an onboarding checklist from the person's page after saving." />
      <Card className="max-w-5xl"><CardBody><PersonForm {...L} defaultTz={s.timeZone} /></CardBody></Card>
    </>
  );
}
