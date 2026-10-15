import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ledgerAccounts, people } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { SupplierForm } from "@/components/finance/supplier-form";

export const metadata = { title: "New supplier" };

export default async function NewSupplierPage() {
  await guard("finance.write");
  const ledgers = (await db.select().from(ledgerAccounts).where(eq(ledgerAccounts.type, "expense")).orderBy(asc(ledgerAccounts.code))).map((l) => ({ value: l.id, label: `${l.code} ${l.name}` }));
  const ppl = (await db.select({ value: people.id, label: people.fullName }).from(people).where(eq(people.type, "contractor")).orderBy(people.fullName));
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Suppliers & contractors", href: "/finance/suppliers" }, { label: "New" }]} title="New supplier" />
      <Card className="max-w-5xl"><CardBody><SupplierForm ledgers={ledgers} people={ppl} /></CardBody></Card>
    </>
  );
}
