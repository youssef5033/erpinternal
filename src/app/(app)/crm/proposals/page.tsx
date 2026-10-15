import Link from "next/link";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { q } from "@/db/sql";
import { accounts, opportunities, proposalVersions, proposals, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { opportunityVisibility } from "@/server/auth/scope";
import { crmLookups } from "@/server/crm/lookups";
import { Card, EmptyState, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, Money } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Proposals" };

export default async function ProposalsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("crm.read");
  const sp = await searchParams;
  const L = await crmLookups();
  const conds: (SQL | undefined)[] = [opportunityVisibility(actor)];
  if (sp.status) conds.push(eq(proposals.status, sp.status as "sent"));
  if (sp.q) conds.push(or(ilike(proposals.title, `%${sp.q}%`), ilike(proposals.number, `%${sp.q}%`), ilike(accounts.name, `%${sp.q}%`)));
  if (sp.owner) conds.push(eq(proposals.ownerId, sp.owner));
  if (sp.approval === "pending") conds.push(eq(proposalVersions.approvalStatus, "pending"));
  const rows = await db
    .select({ p: proposals, v: proposalVersions, accountName: accounts.name, oppName: opportunities.name, ownerName: user.name, versions: sql<number>`(select count(*) from proposal_versions pv where pv.proposal_id = ${q(proposals.id)})` })
    .from(proposals)
    .innerJoin(opportunities, eq(opportunities.id, proposals.opportunityId))
    .innerJoin(accounts, eq(accounts.id, proposals.accountId))
    .leftJoin(proposalVersions, eq(proposalVersions.id, proposals.currentVersionId))
    .leftJoin(user, eq(user.id, proposals.ownerId))
    .where(and(...conds))
    .orderBy(desc(proposals.updatedAt));
  return (
    <>
      <PageHeader crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Proposals" }]} title="Proposals" description="Versioned proposals with internal approval and recorded client acceptance. Create a proposal from an opportunity." />
      <FilterBar fields={[{ type: "search", name: "q", label: "Search", placeholder: "Title, number, account" }, { type: "select", name: "status", label: "Status", options: ["draft", "in_review", "approved", "sent", "accepted", "rejected", "expired", "withdrawn"].map((s) => ({ value: s, label: s.replace("_", " ") })) }, { type: "select", name: "approval", label: "Approval", options: [{ value: "pending", label: "Awaiting approval" }] }, { type: "select", name: "owner", label: "Owner", options: L.users }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Proposal</TH><TH>Account / opportunity</TH><TH>Status</TH><TH>Version</TH><TH>Approval</TH><TH>Sent</TH><TH>Valid until</TH><TH>Owner</TH><TH align="right">Total</TH></tr></THead>
            <tbody>
              {rows.map(({ p, v, accountName, oppName, ownerName, versions }) => (
                <TR key={p.id}>
                  <TD><Link className="font-medium hover:underline" href={`/crm/proposals/${p.id}`}>{p.number}</Link><p className="text-[12px] text-muted">{p.title}</p></TD>
                  <TD className="text-[12.5px]"><Link className="hover:underline" href={`/crm/accounts/${p.accountId}`}>{accountName}</Link><br /><Link className="text-muted hover:underline" href={`/crm/opportunities/${p.opportunityId}`}>{oppName}</Link></TD>
                  <TD><StatusBadge status={p.status} /></TD>
                  <TD>v{v?.versionNumber} <span className="text-muted">of {versions}</span></TD>
                  <TD>{v ? <StatusBadge status={v.approvalStatus === "not_requested" ? "draft" : v.approvalStatus} label={v.approvalStatus.replace("_", " ")} /> : null}</TD>
                  <TD>{p.sentAt ? <DateText value={p.sentAt.toISOString().slice(0, 10)} /> : "—"}</TD>
                  <TD><DateText value={p.validUntil} /></TD>
                  <TD>{ownerName}</TD>
                  <TD align="right"><Money value={v?.total} currency={v?.currency} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No proposals" description="Open an opportunity and create a proposal from its Proposals tab." />}
      </Card>
    </>
  );
}
