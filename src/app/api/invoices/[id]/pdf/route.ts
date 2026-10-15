import { NextResponse } from "next/server";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, creditNotes, invoiceLines, invoices } from "@/db/schema";
import { getActor } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { invoiceVisibility } from "@/server/auth/scope";
import { invoiceBalances } from "@/server/finance/invoices";
import { audit } from "@/server/audit";
import { getSettings } from "@/server/system/settings";
import { renderInvoicePdf } from "@/server/pdf";

/** Invoice or credit-note PDF. Generated on request from the stored (issued) record; never emailed. */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (!can(actor, "finance.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const [row] = await db.select({ i: invoices, a: accounts }).from(invoices).innerJoin(accounts, eq(accounts.id, invoices.accountId)).where(and(eq(invoices.id, id), invoiceVisibility(actor)));
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const s = await getSettings(db);
  const agency = { name: s.agencyName, legalName: s.legalName, address: s.address, email: s.email, taxIdentifier: s.taxIdentifier, taxLabel: s.taxIdentifierLabel, bankDetails: s.bankDetails, footer: s.invoiceFooter };
  const customer = { name: row.a.name, billingAddress: row.a.billingAddress, billingEmail: row.a.billingEmail, taxIdentifier: row.a.taxIdentifier };
  const cnId = new URL(req.url).searchParams.get("creditNote");
  let pdf: Uint8Array;
  let filename: string;
  if (cnId) {
    const [cn] = await db.select().from(creditNotes).where(and(eq(creditNotes.id, cnId), eq(creditNotes.invoiceId, id)));
    if (!cn || cn.status !== "issued") return NextResponse.json({ error: "Not found" }, { status: 404 });
    pdf = await renderInvoicePdf({ kind: "credit_note", number: cn.number!, issueDate: cn.issueDate!, currency: cn.currency, agency, customer, reference: `Credit against invoice ${row.i.number}`, lines: [{ description: cn.reason, quantity: "1", unitPrice: cn.subtotal, discountPercent: "0", taxRatePercent: "0", lineTotal: cn.subtotal }], subtotal: cn.subtotal, discountTotal: "0", taxTotal: cn.taxTotal, total: cn.total });
    filename = `${cn.number}.pdf`;
  } else {
    const lines = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)).orderBy(asc(invoiceLines.sortOrder));
    const [bal] = await invoiceBalances(db, [id]);
    pdf = await renderInvoicePdf({
      kind: "invoice",
      number: row.i.number ?? "DRAFT",
      issueDate: row.i.issueDate ?? new Date().toISOString().slice(0, 10),
      dueDate: row.i.dueDate,
      currency: row.i.currency,
      agency,
      customer,
      reference: row.i.reference,
      lines: lines.map((l) => ({ description: l.description, quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: l.discountPercent, taxRatePercent: l.taxRatePercent, lineTotal: l.lineTotal })),
      subtotal: row.i.subtotal,
      discountTotal: row.i.discountTotal,
      taxTotal: row.i.taxTotal,
      total: row.i.total,
      amountPaid: row.i.status === "issued" && bal ? bal.allocated : undefined,
      outstanding: row.i.status === "issued" && bal ? bal.outstanding : undefined,
      notes: [row.i.notes, row.i.terms].filter(Boolean).join("\n\n") || null,
      draft: row.i.status !== "issued",
    });
    filename = `${row.i.number ?? "draft-invoice"}.pdf`;
  }
  await audit(db, actor, { action: "invoice.pdf_downloaded", entityType: "invoice", entityId: id, summary: `Downloaded ${filename}` });
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" } });
}
