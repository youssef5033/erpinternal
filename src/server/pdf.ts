import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/money";

/** Minimal, dependency-free PDF layout helpers (Helvetica, A4). */
class Writer {
  page!: PDFPage;
  y = 0;
  constructor(public doc: PDFDocument, public font: PDFFont, public bold: PDFFont) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([595.28, 841.89]);
    this.y = 800;
  }
  ensure(h: number) {
    if (this.y - h < 50) this.newPage();
  }
  text(t: string, opts: { x?: number; size?: number; bold?: boolean; color?: [number, number, number]; width?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const width = opts.width ?? 495;
    const lines = wrap(sanitize(t), font, size, width);
    for (const line of lines) {
      this.ensure(size + 4);
      this.page.drawText(line, { x: opts.x ?? 50, y: this.y, size, font, color: rgb(...(opts.color ?? [0.1, 0.12, 0.11])) });
      this.y -= size + 4;
    }
  }
  row(cols: { t: string; x: number; align?: "right"; bold?: boolean }[], size = 9.5) {
    this.ensure(size + 6);
    for (const c of cols) {
      const font = c.bold ? this.bold : this.font;
      const s = sanitize(c.t);
      const w = font.widthOfTextAtSize(s, size);
      this.page.drawText(s, { x: c.align === "right" ? c.x - w : c.x, y: this.y, size, font, color: rgb(0.1, 0.12, 0.11) });
    }
    this.y -= size + 6;
  }
  rule() {
    this.ensure(8);
    this.page.drawLine({ start: { x: 50, y: this.y + 4 }, end: { x: 545, y: this.y + 4 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.78) });
    this.y -= 6;
  }
  gap(h = 8) {
    this.y -= h;
  }
}

/** Standard fonts are WinAnsi: replace characters they cannot encode. */
function sanitize(s: string) {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/…/g, "...")
    .replace(/→/g, "->")
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/g, "?");
}

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const word of para.split(/\s+/)) {
      const test = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(test, size) > width && line) {
        out.push(line);
        line = word;
      } else line = test;
    }
    out.push(line);
  }
  return out;
}

async function newDoc(title: string) {
  const doc = await PDFDocument.create();
  doc.setTitle(title);
  doc.setProducer("Agency ERP");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, w: new Writer(doc, font, bold) };
}

export type InvoicePdfData = {
  kind: "invoice" | "credit_note";
  number: string;
  issueDate: string;
  dueDate?: string | null;
  currency: string;
  agency: { name: string; legalName?: string | null; address?: string | null; email?: string | null; taxIdentifier?: string | null; taxLabel?: string | null; bankDetails?: string | null; footer?: string | null };
  customer: { name: string; billingAddress?: string | null; billingEmail?: string | null; taxIdentifier?: string | null };
  reference?: string | null;
  lines: { description: string; quantity: string; unitPrice: string; discountPercent: string; taxRatePercent: string; lineTotal: string }[];
  subtotal: string;
  discountTotal: string;
  taxTotal: string;
  total: string;
  amountPaid?: string;
  outstanding?: string;
  notes?: string | null;
  draft?: boolean;
};

export async function renderInvoicePdf(data: InvoicePdfData) {
  const { doc, w } = await newDoc(`${data.kind === "invoice" ? "Invoice" : "Credit note"} ${data.number}`);
  w.text(data.agency.legalName || data.agency.name, { size: 16, bold: true });
  if (data.agency.address) w.text(data.agency.address, { size: 9 });
  if (data.agency.email) w.text(data.agency.email, { size: 9 });
  if (data.agency.taxIdentifier) w.text(`${data.agency.taxLabel || "Tax ID"}: ${data.agency.taxIdentifier}`, { size: 9 });
  w.gap(10);
  w.text(`${data.kind === "invoice" ? "INVOICE" : "CREDIT NOTE"} ${data.number}${data.draft ? " (DRAFT - not issued)" : ""}`, { size: 13, bold: true });
  w.text(`Issue date: ${formatDate(data.issueDate)}${data.dueDate ? `    Due date: ${formatDate(data.dueDate)}` : ""}`, { size: 9.5 });
  if (data.reference) w.text(`Reference: ${data.reference}`, { size: 9.5 });
  w.gap(6);
  w.text("Bill to", { size: 9, bold: true });
  w.text(data.customer.name, { size: 10 });
  if (data.customer.billingAddress) w.text(data.customer.billingAddress, { size: 9 });
  if (data.customer.billingEmail) w.text(data.customer.billingEmail, { size: 9 });
  if (data.customer.taxIdentifier) w.text(`Tax ID: ${data.customer.taxIdentifier}`, { size: 9 });
  w.gap(10);
  w.row([{ t: "Description", x: 50, bold: true }, { t: "Qty", x: 330, align: "right", bold: true }, { t: "Unit price", x: 400, align: "right", bold: true }, { t: "Tax %", x: 450, align: "right", bold: true }, { t: "Amount", x: 545, align: "right", bold: true }]);
  w.rule();
  for (const l of data.lines) {
    const desc = wrap(sanitize(l.description), w.font, 9.5, 260);
    w.row([{ t: desc[0], x: 50 }, { t: Number(l.quantity).toString(), x: 330, align: "right" }, { t: formatMoney(l.unitPrice, data.currency), x: 400, align: "right" }, { t: Number(l.taxRatePercent).toString(), x: 450, align: "right" }, { t: formatMoney(l.lineTotal, data.currency), x: 545, align: "right" }]);
    for (const extra of desc.slice(1)) w.row([{ t: extra, x: 50 }]);
    if (Number(l.discountPercent) > 0) w.row([{ t: `  Discount ${Number(l.discountPercent)}%`, x: 50 }], 8.5);
  }
  w.rule();
  const tot = (label: string, v: string, bold = false) => w.row([{ t: label, x: 450, align: "right", bold }, { t: formatMoney(v, data.currency), x: 545, align: "right", bold }]);
  tot("Subtotal", data.subtotal);
  if (Number(data.discountTotal) > 0) tot("Discount", `-${data.discountTotal}`);
  tot("Tax", data.taxTotal);
  tot("Total", data.total, true);
  if (data.amountPaid !== undefined) tot("Paid / credited", data.amountPaid);
  if (data.outstanding !== undefined) tot("Balance due", data.outstanding, true);
  w.gap(10);
  if (data.notes) w.text(data.notes, { size: 9 });
  if (data.agency.bankDetails) {
    w.gap(4);
    w.text("Payment details", { size: 9, bold: true });
    w.text(data.agency.bankDetails, { size: 9 });
  }
  if (data.agency.footer) {
    w.gap(6);
    w.text(data.agency.footer, { size: 8.5, color: [0.4, 0.42, 0.41] });
  }
  return Buffer.from(await doc.save());
}

export type ProposalPdfData = {
  number: string;
  title: string;
  versionNumber: number;
  agencyName: string;
  clientName: string;
  validUntil?: string | null;
  status: string;
  introduction?: string | null;
  scope?: string | null;
  deliverables: { name: string; description?: string; milestone?: string | null }[];
  exclusions?: string | null;
  assumptions?: string | null;
  timeline?: string | null;
  terms?: string | null;
  currency: string;
  pricingModel: string;
  lines: { description: string; quantity: string; unitPrice: string }[];
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  paymentSchedule: { label: string; percent?: string | null; amount?: string | null; milestone?: string | null; dueAfterDays?: number | null }[];
  acceptance?: { acceptedByName: string; acceptedAt: string; method: string } | null;
};

export async function renderProposalPdf(p: ProposalPdfData) {
  const { doc, w } = await newDoc(`${p.number} ${p.title}`);
  w.text(p.agencyName, { size: 11, bold: true, color: [0.12, 0.29, 0.27] });
  w.gap(4);
  w.text(p.title, { size: 18, bold: true });
  w.text(`Proposal ${p.number} - version ${p.versionNumber} - prepared for ${p.clientName}`, { size: 10 });
  if (p.validUntil) w.text(`Valid until ${formatDate(p.validUntil)}`, { size: 9.5 });
  if (["draft", "in_review"].includes(p.status)) w.text("DRAFT - not approved for sending", { size: 9.5, bold: true, color: [0.63, 0.36, 0.03] });
  const section = (title: string, body?: string | null) => {
    if (!body) return;
    w.gap(10);
    w.text(title, { size: 11.5, bold: true });
    w.text(body, { size: 10 });
  };
  section("Introduction", p.introduction);
  section("Scope", p.scope);
  if (p.deliverables.length) {
    w.gap(10);
    w.text("Deliverables", { size: 11.5, bold: true });
    for (const d of p.deliverables) w.text(`- ${d.name}${d.milestone ? ` (${d.milestone})` : ""}${d.description ? `: ${d.description}` : ""}`, { size: 10 });
  }
  section("Exclusions", p.exclusions);
  section("Assumptions", p.assumptions);
  section("Timeline", p.timeline);
  w.gap(10);
  w.text(`Investment (${p.pricingModel})`, { size: 11.5, bold: true });
  for (const l of p.lines) w.row([{ t: l.description, x: 50 }, { t: `${Number(l.quantity)} x ${formatMoney(l.unitPrice, p.currency)}`, x: 545, align: "right" }]);
  w.rule();
  if (Number(p.discountAmount) > 0) w.row([{ t: "Discount", x: 50 }, { t: `-${formatMoney(p.discountAmount, p.currency)}`, x: 545, align: "right" }]);
  if (Number(p.taxAmount) > 0) w.row([{ t: "Tax", x: 50 }, { t: formatMoney(p.taxAmount, p.currency), x: 545, align: "right" }]);
  w.row([{ t: "Total", x: 50, bold: true }, { t: formatMoney(p.total, p.currency), x: 545, align: "right", bold: true }]);
  if (p.paymentSchedule.length) {
    w.gap(8);
    w.text("Payment schedule", { size: 11.5, bold: true });
    for (const s of p.paymentSchedule) w.text(`- ${s.label}: ${s.percent ? `${s.percent}%` : s.amount ? formatMoney(s.amount, p.currency) : ""}${s.milestone ? ` on acceptance of ${s.milestone}` : s.dueAfterDays != null ? ` (${s.dueAfterDays} days after start)` : ""}`, { size: 10 });
  }
  section("Terms", p.terms);
  if (p.acceptance) {
    w.gap(12);
    w.text(`Acceptance recorded: ${p.acceptance.acceptedByName} on ${formatDate(p.acceptance.acceptedAt)} (${p.acceptance.method.replace(/_/g, " ")}). This is a recorded acceptance, not a verified electronic signature.`, { size: 9, color: [0.4, 0.42, 0.41] });
  }
  return Buffer.from(await doc.save());
}

/** Simple one-page document (used for demo contracts/briefs). */
export async function renderSimpleDocPdf(title: string, paragraphs: string[]) {
  const { doc, w } = await newDoc(title);
  w.text(title, { size: 16, bold: true });
  w.gap(6);
  for (const p of paragraphs) {
    w.text(p, { size: 10 });
    w.gap(6);
  }
  return Buffer.from(await doc.save());
}
