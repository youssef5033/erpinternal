import Link from "next/link";
import { and, asc, desc, eq, ilike, inArray, isNull, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contracts, documents, engagements, user } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { accountVisibility, documentVisibility } from "@/server/auth/scope";
import { agencyToday } from "@/server/system/settings";
import { addDaysISO } from "@/lib/dates";
import { qs } from "@/lib/utils";
import { Badge, Card, CardHeader, EmptyState, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, DateTimeText, Money, Pagination, Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Commercial documents" };

const COMMERCIAL_TYPES = ["proposal", "contract", "sow", "legal", "client_file", "brand_asset", "evidence"] as const;

export default async function CommercialDocumentsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("documents.read");
  const sp = await searchParams;
  const tab = sp.tab === "contracts" ? "contracts" : "files";
  const today = await agencyToday(db);
  const accts = await db.select({ value: accounts.id, label: accounts.name }).from(accounts).where(and(isNull(accounts.archivedAt), accountVisibility(actor))).orderBy(asc(accounts.name));
  return (
    <>
      <PageHeader crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Commercial documents" }]} title="Commercial documents" description="Proposals, contracts, SOWs and legal files across all accounts. Files are stored privately; every download is authorised and logged." />
      <Tabs current={tab} tabs={[{ key: "files", label: "Files", href: `/crm/documents${qs({ ...sp, tab: null, page: null })}` }, { key: "contracts", label: "Contract register", href: `/crm/documents${qs({ ...sp, tab: "contracts", page: null })}` }]} />
      <div className="mt-4">{tab === "files" ? <Files sp={sp} actor={actor} accts={accts} today={today} /> : <Contracts sp={sp} actor={actor} accts={accts} today={today} />}</div>
    </>
  );
}

async function Files({ sp, actor, accts, today }: { sp: Record<string, string | undefined>; actor: Awaited<ReturnType<typeof guard>>; accts: { value: string; label: string }[]; today: string }) {
  const conds: (SQL | undefined)[] = [isNull(documents.archivedAt), eq(documents.isLatest, 1), documentVisibility(actor), sp.type ? eq(documents.docType, sp.type as "proposal") : inArray(documents.docType, [...COMMERCIAL_TYPES])];
  if (sp.q) conds.push(ilike(documents.title, `%${sp.q}%`));
  if (sp.account) conds.push(eq(documents.accountId, sp.account));
  if (sp.approval) conds.push(eq(documents.approvalStatus, sp.approval as "pending"));
  if (sp.expiring === "1") conds.push(sql`${documents.expiresAt} <= ${addDaysISO(today, 60)}`);
  const where = and(...conds);
  const page = Math.max(1, Number(sp.page ?? 1));
  const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(documents).where(where);
  const rows = await db
    .select({ d: documents, accountName: accounts.name, uploader: user.name })
    .from(documents)
    .leftJoin(accounts, eq(accounts.id, documents.accountId))
    .leftJoin(user, eq(user.id, documents.uploadedBy))
    .where(where)
    .orderBy(desc(documents.createdAt))
    .limit(50)
    .offset((page - 1) * 50);
  return (
    <>
      <FilterBar keep={["tab"]} fields={[{ type: "search", name: "q", label: "Search", placeholder: "Title" }, { type: "select", name: "type", label: "Type", options: COMMERCIAL_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") })) }, { type: "select", name: "account", label: "Account", options: accts }, { type: "select", name: "approval", label: "Approval", options: [{ value: "pending", label: "Pending" }, { value: "approved", label: "Approved" }, { value: "rejected", label: "Rejected" }] }, { type: "select", name: "expiring", label: "Expiry", options: [{ value: "1", label: "Expired or expiring ≤ 60 days" }] }]} />
      <Card>
        {rows.length ? (
          <Table>
            <THead><tr><TH>Document</TH><TH>Type</TH><TH>Linked to</TH><TH>Version</TH><TH>Approval</TH><TH>Expires</TH><TH>Uploaded</TH><TH /></tr></THead>
            <tbody>
              {rows.map(({ d, accountName, uploader }) => (
                <TR key={d.id}>
                  <TD><span className="font-medium">{d.title}</span><div className="text-[12px] text-muted">{d.fileName} · {(d.sizeBytes / 1024).toFixed(0)} KB</div></TD>
                  <TD><Badge>{d.docType.replace(/_/g, " ")}</Badge>{d.visibility !== "internal" ? <Badge tone="warning" className="ml-1">{d.visibility.replace("_", " ")}</Badge> : null}</TD>
                  <TD className="text-[12.5px]">
                    {d.accountId ? <Link className="hover:underline" href={`/crm/accounts/${d.accountId}?tab=documents`}>{accountName}</Link> : null}
                    {d.proposalId ? <div><Link className="text-accent hover:underline" href={`/crm/proposals/${d.proposalId}`}>Proposal</Link></div> : null}
                    {d.opportunityId ? <div><Link className="text-accent hover:underline" href={`/crm/opportunities/${d.opportunityId}`}>Opportunity</Link></div> : null}
                    {d.engagementId ? <div><Link className="text-accent hover:underline" href={`/delivery/engagements/${d.engagementId}?tab=documents`}>Engagement</Link></div> : null}
                  </TD>
                  <TD>v{d.versionNumber}</TD>
                  <TD>{d.approvalStatus === "none" ? "—" : <StatusBadge status={d.approvalStatus} />}</TD>
                  <TD><DateText value={d.expiresAt} overdue={!!d.expiresAt && d.expiresAt < today} /></TD>
                  <TD className="text-[12.5px]"><DateTimeText value={d.createdAt} /><div className="text-muted">{uploader}</div></TD>
                  <TD align="right"><a className="text-[12.5px] text-accent hover:underline" href={`/api/documents/${d.id}/download`}>Download</a></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No documents match" description="Upload documents from an account, opportunity, proposal or engagement so they stay linked to their source." />}
        <Pagination page={page} pageSize={50} total={Number(total)} hrefFor={(p) => `/crm/documents${qs({ ...sp, page: p })}`} />
      </Card>
    </>
  );
}

async function Contracts({ sp, actor, accts, today }: { sp: Record<string, string | undefined>; actor: Awaited<ReturnType<typeof guard>>; accts: { value: string; label: string }[]; today: string }) {
  const conds: (SQL | undefined)[] = [accountVisibility(actor)];
  if (sp.account) conds.push(eq(contracts.accountId, sp.account));
  if (sp.status) conds.push(eq(contracts.status, sp.status as "draft"));
  if (sp.expiring === "1") conds.push(sql`${contracts.endDate} <= ${addDaysISO(today, 90)} and ${contracts.status} in ('signed','active')`);
  const rows = await db
    .select({ c: contracts, accountName: accounts.name, engName: engagements.name })
    .from(contracts)
    .innerJoin(accounts, eq(accounts.id, contracts.accountId))
    .leftJoin(engagements, eq(engagements.id, contracts.engagementId))
    .where(and(...conds))
    .orderBy(asc(contracts.endDate));
  const showValue = can(actor, "finance.read") || can(actor, "crm.write");
  return (
    <>
      <FilterBar keep={["tab"]} fields={[{ type: "select", name: "account", label: "Account", options: accts }, { type: "select", name: "status", label: "Status", options: ["draft", "sent", "signed", "active", "expired", "terminated"].map((v) => ({ value: v, label: v })) }, { type: "select", name: "expiring", label: "Expiry", options: [{ value: "1", label: "Ending ≤ 90 days" }] }]} />
      <Card>
        <CardHeader title="Contracts" description="Signature status is recorded by people (signed document or manual record) unless a verified e-signature integration is connected." />
        {rows.length ? (
          <Table>
            <THead><tr><TH>Contract</TH><TH>Account / engagement</TH><TH>Type</TH><TH>Status</TH><TH>Signed</TH><TH>Term</TH><TH>Notice</TH>{showValue ? <TH align="right">Value</TH> : null}</tr></THead>
            <tbody>
              {rows.map(({ c, accountName, engName }) => (
                <TR key={c.id}>
                  <TD><span className="font-medium">{c.title}</span><div className="text-[12px] text-muted">{c.number}</div></TD>
                  <TD className="text-[12.5px]"><Link className="hover:underline" href={`/crm/accounts/${c.accountId}`}>{accountName}</Link>{c.engagementId ? <div><Link className="text-accent hover:underline" href={`/delivery/engagements/${c.engagementId}?tab=contracts`}>{engName}</Link></div> : null}</TD>
                  <TD className="uppercase text-[12px]">{c.contractType.replace("_", " ")}</TD>
                  <TD><StatusBadge status={c.status} />{c.autoRenew ? <Badge className="ml-1">auto-renew</Badge> : null}</TD>
                  <TD className="text-[12.5px]">{c.signedAt ? <><DateText value={c.signedAt} /><div className="text-muted">{c.signatureMethod?.replace(/_/g, " ")}</div></> : "—"}</TD>
                  <TD className="text-[12.5px]"><DateText value={c.startDate} /> – <DateText value={c.endDate} overdue={!!c.endDate && c.endDate < today && ["signed", "active"].includes(c.status)} /></TD>
                  <TD>{c.noticePeriodDays ? `${c.noticePeriodDays}d` : "—"}</TD>
                  {showValue ? <TD align="right">{c.value ? <Money value={c.value} currency={c.currency} /> : "—"}</TD> : null}
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No contracts match" />}
      </Card>
    </>
  );
}
