import { notFound } from "next/navigation";
import { eq, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contacts } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { crmLookups } from "@/server/crm/lookups";
import { PageHeader } from "@/components/ui/primitives";
import { ContactForm } from "@/components/crm/contact-form";

export default async function EditContactPage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("crm.write");
  const { id } = await params;
  const [c] = await db.select().from(contacts).where(eq(contacts.id, id));
  if (!c) notFound();
  const L = await crmLookups();
  const accs = await db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(isNull(accounts.archivedAt)).orderBy(accounts.name);
  return (
    <>
      <PageHeader crumbs={[{ label: "Contacts", href: "/crm/contacts" }, { label: c.fullName, href: `/crm/contacts/${id}` }, { label: "Edit" }]} title={`Edit ${c.fullName}`} />
      <ContactForm contact={c} accounts={accs.map((a) => ({ value: a.id, label: a.name }))} users={L.users} roles={L.contactRoles} currentUserId={actor.userId} />
    </>
  );
}
