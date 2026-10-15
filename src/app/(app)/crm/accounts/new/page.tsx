import { guard } from "@/server/auth/session";
import { crmLookups } from "@/server/crm/lookups";
import { PageHeader } from "@/components/ui/primitives";
import { AccountForm } from "@/components/crm/account-form";

export const metadata = { title: "New account" };

export default async function NewAccountPage() {
  const actor = await guard("crm.write");
  const L = await crmLookups();
  return (
    <>
      <PageHeader crumbs={[{ label: "Accounts", href: "/crm/accounts" }, { label: "New" }]} title="New account" description="One shared record per company — used by CRM, delivery and finance." />
      <AccountForm users={L.users} channels={L.channels} industries={L.industries} sizeBands={L.sizeBands} currentUserId={actor.userId} />
    </>
  );
}
