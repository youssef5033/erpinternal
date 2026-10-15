import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { accountVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { PageHeader } from "@/components/ui/primitives";
import { AccountForm } from "@/components/crm/account-form";

export default async function EditAccountPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.write");
  const { id } = await params;
  const [a] = await db.select().from(accounts).where(and(eq(accounts.id, id), accountVisibility(actor)));
  if (!a) notFound();
  const L = await crmLookups();
  return (
    <>
      <PageHeader crumbs={[{ label: "Accounts", href: "/crm/accounts" }, { label: a.name, href: `/crm/accounts/${id}` }, { label: "Edit" }]} title={`Edit ${a.name}`} />
      <AccountForm account={a} users={L.users} channels={L.channels} industries={L.industries} sizeBands={L.sizeBands} currentUserId={actor.userId} />
    </>
  );
}
