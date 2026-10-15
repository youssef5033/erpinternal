import { notFound, redirect } from "next/navigation";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { invoiceLines, invoices } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { invoiceVisibility } from "@/server/auth/scope";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { InvoiceForm } from "@/components/finance/invoice-form";
import { invoiceLookups } from "@/components/finance/lookups";

export const metadata = { title: "Edit invoice" };

export default async function EditInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const actor = await guard("finance.write");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const [i] = await db.select().from(invoices).where(and(eq(invoices.id, id), invoiceVisibility(actor)));
  if (!i) notFound();
  if (i.status !== "draft") redirect(`/finance/invoices/${id}`);
  const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.sortOrder));
  const L = await invoiceLookups(i.accountId);
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Invoices", href: "/finance/invoices" }, { label: "Draft", href: `/finance/invoices/${id}` }, { label: "Edit" }]} title="Edit draft invoice" />
      <Card className="max-w-6xl"><CardBody><InvoiceForm L={L} v={i} lines={lines} /></CardBody></Card>
    </>
  );
}
