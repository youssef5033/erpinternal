import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { agencyToday, getSettings } from "@/server/system/settings";
import { isISODate } from "@/lib/dates";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { EventForm } from "@/components/calendar/event-form";
import { eventLookups } from "@/components/calendar/lookups";

export const metadata = { title: "Schedule meeting" };

export default async function NewEventPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.write", "delivery.write");
  const sp = await searchParams;
  const s = await getSettings(db);
  const today = await agencyToday(db);
  const L = await eventLookups(actor);
  return (
    <>
      <PageHeader crumbs={[{ label: "Operations", href: "/operations" }, { label: "Agency calendar", href: "/operations/calendar" }, { label: "Schedule meeting" }]} title="Schedule meeting" />
      <Card className="max-w-4xl">
        <CardBody>
          <EventForm users={L.users.filter((u) => u.value !== actor.userId)} accounts={L.accounts} engagements={L.engagements} defaults={{ date: isISODate(sp.date) ? sp.date! : today, timeZone: actor.timeZone ?? s.timeZone, accountId: sp.account, engagementId: sp.engagement, opportunityId: sp.opportunity, leadId: sp.lead, contactId: sp.contact, kind: sp.kind }} />
        </CardBody>
      </Card>
    </>
  );
}
