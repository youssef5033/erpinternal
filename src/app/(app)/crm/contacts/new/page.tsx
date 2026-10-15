import { isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { crmLookups } from "@/server/crm/lookups";
import { PageHeader } from "@/components/ui/primitives";
import { ContactForm } from "@/components/crm/contact-form";

export default async function NewContactPage({ searchParams }: { searchParams: Promise<{ account?: string }> }) {
  const actor = await guard("crm.write");
  const { account } = await searchParams;
  const L = await crmLookups();
  const accs = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(isNull(accounts.archivedAt)).orderBy(accounts.name);
  return (
    <>
      <PageHeader crumbs={[{ label: "Contacts", href: "/crm/contacts" }, { label: "New" }]} title="New contact" />
      <ContactForm accounts={accs.map((a) => ({ value: a.id, label: a.name }))} users={L.users} roles={L.contactRoles} defaultAccountId={account} currentUserId={actor.userId} />
    </>
  );
}
