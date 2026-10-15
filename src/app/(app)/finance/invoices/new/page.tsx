import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { getSettings } from "@/server/system/settings";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { InvoiceForm } from "@/components/finance/invoice-form";
import { invoiceLookups } from "@/components/finance/lookups";
import { eq } from "drizzle-orm";
import { accounts, engagements } from "@/db/schema";

export const metadata = { title: "New invoice" };

export default async function NewInvoicePage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  await guard("finance.write");
  const sp = await searchParams;
  const s = await getSettings(db);
  const L = await invoiceLookups(sp.account);
  const [acc] = sp.account ? await db.select().from(accounts).where(eq(accounts.id, sp.account)) : [];
  const [eng] = sp.engagement ? await db.select().from(engagements).where(eq(engagements.id, sp.engagement)) : [];
  return (
    <>
      <PageHeader crumbs={[{ label: "Finance" }, { label: "Invoices", href: "/finance/invoices" }, { label: "New" }]} title="New invoice" description="Creates a draft. Nothing is posted or sent until the draft is issued." />
      <Card className="max-w-6xl">
        <CardBody>
          <InvoiceForm L={L} v={{ accountId: sp.account, engagementId: sp.engagement, currency: eng?.currency ?? acc?.defaultCurrency ?? s.baseCurrency, paymentTermsDays: acc?.paymentTermsDays ?? s.defaultPaymentTermsDays }} lines={[]} />
        </CardBody>
      </Card>
    </>
  );
}
