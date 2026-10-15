import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, proposalAcceptances, proposalVersions, proposals } from "@/db/schema";
import { getActor } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { opportunityVisibility } from "@/server/auth/scope";
import { getSettings } from "@/server/system/settings";
import { renderProposalPdf } from "@/server/pdf";
import { opportunities } from "@/db/schema";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  if (!can(actor, "crm.read")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await ctx.params;
  const [row] = await db.select({ p: proposals, accountName: accounts.name }).from(proposals).innerJoin(accounts, eq(accounts.id, proposals.accountId)).innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId)).where(and(eq(proposals.id, id), opportunityVisibility(actor)));
  if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const vn = Number(new URL(req.url).searchParams.get("v") ?? 0);
  const versions = await db.select().from(proposalVersions).where(eq(proposalVersions.proposalId, id));
  const v = versions.find((x) => x.versionNumber === vn) ?? versions.find((x) => x.id === row.p.currentVersionId)!;
  const [acc] = await db.select().from(proposalAcceptances).where(and(eq(proposalAcceptances.proposalId, id), eq(proposalAcceptances.versionId, v.id)));
  const s = await getSettings(db);
  const pdf = await renderProposalPdf({
    number: row.p.number, title: row.p.title, versionNumber: v.versionNumber, agencyName: s.legalName ?? s.agencyName, clientName: row.accountName, validUntil: row.p.validUntil,
    status: v.approvalStatus === "approved" ? row.p.status : "draft",
    introduction: v.introduction, scope: v.scope, deliverables: v.deliverables, exclusions: v.exclusions, assumptions: v.assumptions, timeline: v.timeline, terms: v.terms,
    currency: v.currency, pricingModel: v.pricingModel, lines: v.lines, subtotal: v.subtotal, discountAmount: v.discountAmount, taxAmount: v.taxAmount, total: v.total, paymentSchedule: v.paymentSchedule,
    acceptance: acc ? { acceptedByName: acc.acceptedByName, acceptedAt: acc.acceptedAt, method: acc.method } : null,
  });
  return new NextResponse(new Uint8Array(pdf), { headers: { "Content-Type": "application/pdf", "Content-Disposition": `attachment; filename="${row.p.number}-v${v.versionNumber}.pdf"`, "Cache-Control": "private, no-store" } });
}
