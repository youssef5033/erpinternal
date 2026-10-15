import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, or, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { accounts, contactAccountLinks, contacts, contracts, engagements, invoices, opportunities, pipelineStages, proposals, proposalVersions, services, user, customerPayments } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { can, canAll } from "@/server/auth/actor";
import { accountVisibility } from "@/server/auth/scope";
import { accountHealth } from "@/server/ops/health";
import { crmLookups } from "@/server/crm/lookups";
import { engagementProfitability, rollUp } from "@/server/finance/profitability";
import { derivePaymentStatus, isOverdue, listInvoicesWithBalances } from "@/server/finance/invoices";
import { accountCredit } from "@/server/finance/payments";
import { agencyToday } from "@/server/system/settings";
import { formatDate } from "@/lib/dates";
import { d } from "@/lib/money";
import { Badge, Card, CardBody, CardHeader, DefinitionList, EmptyState, LinkButton, Notice, PageHeader, StatusBadge, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { DateText, KeyValue, Money, Tabs } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input, Select } from "@/components/forms/fields";
import { AuditPanel, DocumentsPanel, TasksPanel, TimelinePanel, listUsers } from "@/components/records/panels";
import { accountLifecycleAction, archiveAccountAction, healthOverrideAction } from "@/server/actions/crm";

const TABS = ["overview", "contacts", "opportunities", "engagements", "documents", "activity", "financials", "health"] as const;

export default async function AccountPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ tab?: string }> }) {
  const actor = await guard("crm.read", "delivery.read");
  const { id } = await params;
  const sp = await searchParams;
  const [row] = await db.select({ a: accounts, ownerName: user.name }).from(accounts).leftJoin(user, eq(user.id, accounts.ownerId)).where(and(eq(accounts.id, id), accountVisibility(actor)));
  if (!row) notFound();
  const a = row.a;
  const tab = (TABS as readonly string[]).includes(sp.tab ?? "") ? sp.tab! : "overview";
  const canFinance = can(actor, "finance.read");
  const [health, L, users, today] = await Promise.all([accountHealth(db, id, { includeBudget: canFinance }), crmLookups(), listUsers(), agencyToday(db)]);
  const [cts, opps, engs, ctrs] = await Promise.all([
    db.select().from(contacts).where(or(eq(contacts.primaryAccountId, id), sql`${contacts.id} in (select contact_id from ${contactAccountLinks} where account_id = ${id})`)).orderBy(contacts.fullName),
    db.select({ o: opportunities, stage: pipelineStages.name, ownerName: user.name }).from(opportunities).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId)).leftJoin(user, eq(user.id, opportunities.ownerId)).where(eq(opportunities.accountId, id)).orderBy(desc(opportunities.createdAt)),
    db.select({ e: engagements, service: services, ownerName: user.name }).from(engagements).innerJoin(services, eq(services.id, engagements.serviceId)).leftJoin(user, eq(user.id, engagements.ownerId)).where(eq(engagements.accountId, id)).orderBy(desc(engagements.startDate)),
    db.select().from(contracts).where(eq(contracts.accountId, id)).orderBy(desc(contracts.createdAt)),
  ]);
  const href = (t: string) => `/crm/accounts/${id}${t === "overview" ? "" : `?tab=${t}`}`;
  const canWrite = can(actor, "crm.write") && (canAll(actor, "crm.write") || a.ownerId === actor.userId);
  const bandTone = health.band === "healthy" ? "success" : health.band === "watch" ? "warning" : "danger";
  const renewals = engs.filter((x) => x.e.billingModel === "retainer" && ["active", "onboarding"].includes(x.e.status));
  const expansions = opps.filter((o) => o.o.kind !== "new_business");

  return (
    <>
      <PageHeader
        crumbs={[{ label: "CRM & Commercial", href: "/crm" }, { label: "Accounts", href: "/crm/accounts" }, { label: a.name }]}
        title={a.name}
        description={a.description ?? undefined}
        meta={
          <>
            <StatusBadge status={a.lifecycleStatus} />
            <Link href={href("health")}><Badge tone={bandTone}>Health {health.score}{health.override ? " (override)" : ""}</Badge></Link>
            {Array.from(new Set(engs.map((x) => x.service.shortName))).map((s) => <Badge key={s}>{s}</Badge>)}
            <span className="text-[12.5px] text-muted">Owner: {row.ownerName ?? "—"}</span>
          </>
        }
        actions={
          <>
            {can(actor, "crm.write") ? <LinkButton href={`/crm/opportunities/new?account=${id}`}>New opportunity</LinkButton> : null}
            {can(actor, "delivery.write") ? <LinkButton href={`/delivery/engagements/new?account=${id}`}>New engagement</LinkButton> : null}
            {canFinance && can(actor, "finance.write") ? <LinkButton href={`/finance/invoices/new?account=${id}`}>New invoice</LinkButton> : null}
            {canWrite ? <LinkButton href={`/crm/accounts/${id}/edit`} variant="primary">Edit</LinkButton> : null}
          </>
        }
      />
      {a.archivedAt ? <Notice tone="warning" title="Archived account" className="mb-4">Hidden from lists. Records remain intact.</Notice> : null}
      <Tabs
        tabs={TABS.filter((t) => t !== "financials" || canFinance).map((t) => ({ key: t, label: t === "opportunities" ? "Opportunities & proposals" : t[0].toUpperCase() + t.slice(1), href: href(t), count: t === "contacts" ? cts.length : t === "opportunities" ? opps.length : t === "engagements" ? engs.length : null }))}
        current={tab}
      />

      {tab === "overview" ? (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
          <div className="space-y-4">
            <Card>
              <CardHeader title="Company profile" />
              <CardBody>
                <DefinitionList
                  columns={3}
                  items={[
                    { label: "Website", value: a.website ? <a href={a.website} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">{a.domain}</a> : null },
                    { label: "Industry", value: a.industry },
                    { label: "Location", value: [a.city, a.country].filter(Boolean).join(", ") || null },
                    { label: "Size", value: a.sizeBand },
                    { label: "First-touch source", value: `${L.channelLabel(a.acquisitionChannel)}${a.acquisitionDetail ? ` — ${a.acquisitionDetail}` : ""}` },
                    { label: "Acquired", value: a.acquiredAt ? <DateText value={a.acquiredAt} /> : null },
                    { label: "Billing email", value: a.billingEmail },
                    { label: "Billing contact", value: a.billingContactName },
                    { label: "Payment terms", value: a.paymentTermsDays != null ? `${a.paymentTermsDays} days` : null },
                    { label: "Currency", value: a.defaultCurrency },
                    { label: "Tax ID", value: a.taxIdentifier },
                    { label: "Tags", value: a.tags.length ? a.tags.map((t) => `#${t}`).join(" ") : null },
                    { label: "Billing address", value: a.billingAddress, full: true },
                  ]}
                />
                {a.sourceLeadId ? <p className="mt-3 text-[12.5px]"><Link className="text-accent hover:underline" href={`/crm/leads/${a.sourceLeadId}`}>View original lead research →</Link></p> : null}
              </CardBody>
            </Card>
            <Card>
              <CardHeader title="Engagements across services" actions={<Link className="text-[12.5px] text-accent hover:underline" href={href("engagements")}>All →</Link>} />
              <EngagementTable rows={engs} />
            </Card>
            <Card>
              <CardHeader title="Renewals & expansion" description="Retainers approaching renewal and growth opportunities on this account." />
              <CardBody className="space-y-2 text-[13px]">
                {renewals.map(({ e }) => (
                  <p key={e.id}>
                    <Link href={`/delivery/engagements/${e.id}?tab=renewal`} className="font-medium hover:underline">{e.number} {e.name}</Link> — retainer ends <DateText value={e.endDate} overdue={!!e.endDate && e.endDate < today} />{e.noticePeriodDays ? ` (notice ${e.noticePeriodDays}d)` : ""}
                  </p>
                ))}
                {expansions.map(({ o, stage }) => (
                  <p key={o.id}>
                    <Badge>{o.kind.replace("_", " ")}</Badge> <Link href={`/crm/opportunities/${o.id}`} className="font-medium hover:underline">{o.name}</Link> · {stage} · <Money value={o.value} currency={o.currency} />
                  </p>
                ))}
                {!renewals.length && !expansions.length ? <p className="text-muted">No renewals or expansion opportunities.</p> : null}
                {can(actor, "crm.write") ? <LinkButton size="sm" href={`/crm/opportunities/new?account=${id}&kind=expansion`}>Add expansion opportunity</LinkButton> : null}
              </CardBody>
            </Card>
            <TasksPanel actor={actor} link={{ accountId: id }} users={users} />
          </div>
          <div className="space-y-4">
            <Card>
              <CardHeader title="Key contacts" actions={<Link className="text-[12.5px] text-accent hover:underline" href={`/crm/contacts/new?account=${id}`}>Add</Link>} />
              <ul className="divide-y divide-line">
                {cts.slice(0, 6).map((c) => (
                  <li key={c.id} className="px-4 py-2 text-[13px]">
                    <Link href={`/crm/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>
                    {c.doNotContact ? <Badge tone="danger" className="ml-1">do not contact</Badge> : null}
                    <p className="text-[12px] text-muted">{c.jobTitle}{c.buyingRoles.length ? ` · ${c.buyingRoles.map((r) => L.contactRoles.find((x) => x.value === r)?.label ?? r).join(", ")}` : ""}</p>
                  </li>
                ))}
                {!cts.length ? <li className="px-4 py-3 text-[13px] text-muted">No contacts.</li> : null}
              </ul>
            </Card>
            <HealthCard health={health} id={id} />
            {canWrite ? (
              <Card>
                <CardHeader title="Lifecycle" description="Separate from lead qualification and opportunity stage." />
                <CardBody className="space-y-3">
                  <ActionForm action={accountLifecycleAction} className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="id" value={id} />
                    <Select name="status" aria-label="Lifecycle" defaultValue={a.lifecycleStatus} className="w-40" options={["prospect", "onboarding", "active", "former", "partner"].map((v) => ({ value: v, label: v }))} />
                    <Input name="reason" placeholder="Reason" aria-label="Reason" className="w-40" />
                    <SubmitButton size="sm" variant="secondary">Update</SubmitButton>
                  </ActionForm>
                  <ActionForm action={archiveAccountAction}>
                    <input type="hidden" name="id" value={id} />
                    <input type="hidden" name="archived" value={a.archivedAt ? "false" : "true"} />
                    <SubmitButton size="sm" variant="ghost">{a.archivedAt ? "Restore account" : "Archive account"}</SubmitButton>
                  </ActionForm>
                </CardBody>
              </Card>
            ) : null}
            <AuditPanel actor={actor} entityType="account" entityId={id} />
          </div>
        </div>
      ) : null}

      {tab === "contacts" ? (
        <Card>
          <CardHeader title="Contacts and buying roles" actions={can(actor, "crm.write") ? <LinkButton size="sm" href={`/crm/contacts/new?account=${id}`}>Add contact</LinkButton> : null} />
          {cts.length ? (
            <Table>
              <THead><tr><TH>Name</TH><TH>Title</TH><TH>Buying roles</TH><TH>Email / phone</TH><TH>Preferred</TH><TH>Restrictions</TH></tr></THead>
              <tbody>
                {cts.map((c) => (
                  <TR key={c.id}>
                    <TD><Link href={`/crm/contacts/${c.id}`} className="font-medium hover:underline">{c.fullName}</Link>{c.primaryAccountId !== id ? <Badge className="ml-1">linked</Badge> : null}</TD>
                    <TD>{c.jobTitle}</TD>
                    <TD><div className="flex flex-wrap gap-1">{c.buyingRoles.map((r) => <Badge key={r} tone="accent">{L.contactRoles.find((x) => x.value === r)?.label ?? r}</Badge>)}</div></TD>
                    <TD className="text-[12.5px]">{c.email}<br />{c.phone}</TD>
                    <TD>{c.preferredChannel ?? "—"}</TD>
                    <TD>{c.doNotContact ? <Badge tone="danger">opted out</Badge> : c.contactRestrictions ?? <span className="text-faint">—</span>}</TD>
                  </TR>
                ))}
              </tbody>
            </Table>
          ) : <EmptyState title="No contacts" />}
        </Card>
      ) : null}

      {tab === "opportunities" ? <OpportunitiesTab accountId={id} opps={opps} /> : null}

      {tab === "engagements" ? (
        <Card>
          <CardHeader title="Engagements" description="Each sold piece of work has its own engagement, scope, budget and deliverables — all on this one account." />
          <EngagementTable rows={engs} />
          <CardBody>
            <p className="mb-2 text-[12.5px] font-medium text-ink-2">Contracts & statements of work</p>
            {ctrs.length ? (
              <ul className="space-y-1 text-[13px]">
                {ctrs.map((c) => <li key={c.id}>{c.number} · {c.title} · <StatusBadge status={c.status} />{c.signedAt ? <> · signed <DateText value={c.signedAt} /></> : null}{c.endDate ? <> · ends <DateText value={c.endDate} /></> : null}</li>)}
              </ul>
            ) : <p className="text-[13px] text-muted">No contracts recorded.</p>}
          </CardBody>
        </Card>
      ) : null}

      {tab === "documents" ? <DocumentsPanel actor={actor} link={{ accountId: id }} /> : null}
      {tab === "activity" ? <TimelinePanel actor={actor} filter={{ accountId: id }} title="Account timeline (all contacts, deals and engagements)" /> : null}
      {tab === "financials" && canFinance ? <FinancialsTab accountId={id} today={today} /> : null}
      {tab === "health" ? <HealthCard health={health} id={id} full canWrite={canWrite} /> : null}
    </>
  );
}

function EngagementTable({ rows }: { rows: { e: typeof engagements.$inferSelect; service: typeof services.$inferSelect; ownerName: string | null }[] }) {
  if (!rows.length) return <EmptyState title="No engagements yet" />;
  return (
    <Table>
      <THead><tr><TH>Engagement</TH><TH>Service</TH><TH>Billing</TH><TH>Status</TH><TH>Owner</TH><TH>Dates</TH><TH align="right">Contract value</TH></tr></THead>
      <tbody>
        {rows.map(({ e, service, ownerName }) => (
          <TR key={e.id}>
            <TD><Link href={`/delivery/engagements/${e.id}`} className="font-medium hover:underline">{e.number} {e.name}</Link></TD>
            <TD><Badge tone={service.key as "creative"}>{service.shortName}</Badge></TD>
            <TD>{e.billingModel}</TD>
            <TD><StatusBadge status={e.status} /></TD>
            <TD>{ownerName ?? "—"}</TD>
            <TD className="text-[12.5px]"><DateText value={e.startDate} /> – <DateText value={e.endDate} /></TD>
            <TD align="right"><Money value={e.contractValue} currency={e.currency} /></TD>
          </TR>
        ))}
      </tbody>
    </Table>
  );
}

async function OpportunitiesTab({ accountId, opps }: { accountId: string; opps: { o: typeof opportunities.$inferSelect; stage: string; ownerName: string | null }[] }) {
  const props = await db.select({ p: proposals, v: proposalVersions }).from(proposals).leftJoin(proposalVersions, eq(proposalVersions.id, proposals.currentVersionId)).where(eq(proposals.accountId, accountId)).orderBy(desc(proposals.createdAt));
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Opportunities" />
        {opps.length ? (
          <Table>
            <THead><tr><TH>Opportunity</TH><TH>Type</TH><TH>Stage</TH><TH>Owner</TH><TH>Expected close</TH><TH align="right">Value</TH></tr></THead>
            <tbody>
              {opps.map(({ o, stage, ownerName }) => (
                <TR key={o.id}>
                  <TD><Link href={`/crm/opportunities/${o.id}`} className="font-medium hover:underline">{o.number} {o.name}</Link></TD>
                  <TD>{o.kind.replace("_", " ")}</TD>
                  <TD><StatusBadge status={o.status === "open" ? "open" : o.status} label={stage} /></TD>
                  <TD>{ownerName}</TD>
                  <TD><DateText value={o.expectedCloseDate} /></TD>
                  <TD align="right"><Money value={o.value} currency={o.currency} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No opportunities" />}
      </Card>
      <Card>
        <CardHeader title="Proposals" />
        {props.length ? (
          <Table>
            <THead><tr><TH>Proposal</TH><TH>Status</TH><TH>Version</TH><TH>Valid until</TH><TH align="right">Total</TH></tr></THead>
            <tbody>
              {props.map(({ p, v }) => (
                <TR key={p.id}>
                  <TD><Link href={`/crm/proposals/${p.id}`} className="font-medium hover:underline">{p.number} {p.title}</Link></TD>
                  <TD><StatusBadge status={p.status} /></TD>
                  <TD>v{v?.versionNumber}</TD>
                  <TD><DateText value={p.validUntil} /></TD>
                  <TD align="right"><Money value={v?.total} currency={v?.currency} /></TD>
                </TR>
              ))}
            </tbody>
          </Table>
        ) : <EmptyState title="No proposals" />}
      </Card>
    </div>
  );
}

async function FinancialsTab({ accountId, today }: { accountId: string; today: string }) {
  const actor = await guard("finance.read");
  const invs = await listInvoicesWithBalances(db, eq(invoices.accountId, accountId));
  const prof = await engagementProfitability(db, { where: eq(engagements.accountId, accountId) });
  const total = rollUp(prof.rows, "accountId")[0];
  const credit = await accountCredit(db, accountId);
  const pays = await db.select().from(customerPayments).where(eq(customerPayments.accountId, accountId)).orderBy(desc(customerPayments.paymentDate)).limit(20);
  const byCur = new Map<string, { invoiced: number; outstanding: number; overdue: number }>();
  for (const r of invs) {
    if (r.invoice.status !== "issued") continue;
    const g = byCur.get(r.invoice.currency) ?? { invoiced: 0, outstanding: 0, overdue: 0 };
    g.invoiced += Number(r.invoice.total);
    g.outstanding += Number(r.outstanding);
    if (isOverdue(r.invoice, r.outstanding, today)) g.overdue += Number(r.outstanding);
    byCur.set(r.invoice.currency, g);
  }
  void actor;
  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <Card>
          <CardHeader title="Invoices" description="Payment status is derived from allocations and credit notes." actions={<Link className="text-[12.5px] text-accent hover:underline" href={`/finance/invoices?account=${accountId}`}>All →</Link>} />
          {invs.length ? (
            <Table>
              <THead><tr><TH>Invoice</TH><TH>Status</TH><TH>Issued</TH><TH>Due</TH><TH align="right">Total</TH><TH align="right">Outstanding</TH></tr></THead>
              <tbody>
                {invs.map(({ invoice: i, outstanding, engagementNumber }) => {
                  const st = derivePaymentStatus(i, { allocated: "0", credited: "0", outstanding });
                  const od = isOverdue(i, outstanding, today);
                  return (
                    <TR key={i.id}>
                      <TD><Link href={`/finance/invoices/${i.id}`} className="font-medium hover:underline">{i.number ?? "Draft"}</Link><p className="text-[11.5px] text-muted">{engagementNumber}</p></TD>
                      <TD><StatusBadge status={od ? "overdue" : i.status === "issued" ? (d(outstanding).isZero() ? "paid" : d(outstanding).lessThan(d(i.total)) ? "partially_paid" : "unpaid") : st} /></TD>
                      <TD><DateText value={i.issueDate} /></TD>
                      <TD><DateText value={i.dueDate} overdue={od} /></TD>
                      <TD align="right"><Money value={i.total} currency={i.currency} /></TD>
                      <TD align="right"><Money value={outstanding} currency={i.currency} /></TD>
                    </TR>
                  );
                })}
              </tbody>
            </Table>
          ) : <EmptyState title="No invoices" />}
        </Card>
        <Card>
          <CardHeader title="Profitability by engagement" description={`Base currency ${prof.baseCurrency}. Recognised revenue − labour (historical cost) − direct costs.`} />
          <Table>
            <THead><tr><TH>Engagement</TH><TH align="right">Revenue</TH><TH align="right">Labour</TH><TH align="right">Direct</TH><TH align="right">Margin</TH></tr></THead>
            <tbody>
              {prof.rows.map((r) => (
                <TR key={r.engagementId}>
                  <TD><Link className="hover:underline" href={`/delivery/engagements/${r.engagementId}?tab=budget`}>{r.number} {r.name}</Link></TD>
                  <TD align="right"><Money value={r.revenue} currency={prof.baseCurrency} /></TD>
                  <TD align="right"><Money value={r.laborCost} currency={prof.baseCurrency} /></TD>
                  <TD align="right"><Money value={(Number(r.contractorCost) + Number(r.otherDirectCost)).toFixed(2)} currency={prof.baseCurrency} /></TD>
                  <TD align="right"><Money value={r.grossMargin} currency={prof.baseCurrency} emphasize="negative" /> {r.marginPct ? <span className="text-[11.5px] text-muted">({r.marginPct}%)</span> : null}</TD>
                </TR>
              ))}
            </tbody>
          </Table>
        </Card>
      </div>
      <div className="space-y-4">
        <Card>
          <CardHeader title="Receivables" description="Per currency — never mixed." />
          <CardBody>
            {Array.from(byCur.entries()).map(([c, g]) => (
              <div key={c} className="mb-2">
                <KeyValue label={`Invoiced (${c})`}><Money value={g.invoiced} currency={c} /></KeyValue>
                <KeyValue label="Outstanding"><Money value={g.outstanding} currency={c} /></KeyValue>
                <KeyValue label="Overdue"><span className={g.overdue ? "text-danger" : ""}><Money value={g.overdue} currency={c} /></span></KeyValue>
              </div>
            ))}
            {credit.map((c) => <KeyValue key={c.currency} label={`Unallocated credit (${c.currency})`}><Money value={c.credit} currency={c.currency} /></KeyValue>)}
            {total ? <KeyValue label={`Lifetime margin (${prof.baseCurrency})`}><Money value={total.grossMargin} currency={prof.baseCurrency} /> {total.marginPct ? `(${total.marginPct}%)` : ""}</KeyValue> : null}
          </CardBody>
        </Card>
        <Card>
          <CardHeader title="Payments received" />
          <ul className="divide-y divide-line">
            {pays.map((p) => <li key={p.id} className="flex justify-between px-4 py-2 text-[13px]"><Link href={`/finance/payments/${p.id}`} className="hover:underline">{p.number} · {formatDate(p.paymentDate)}{p.status === "reversed" ? " (reversed)" : ""}</Link><Money value={p.amount} currency={p.currency} /></li>)}
            {!pays.length ? <li className="px-4 py-3 text-[13px] text-muted">None.</li> : null}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function HealthCard({ health, id, full, canWrite }: { health: Awaited<ReturnType<typeof accountHealth>>; id: string; full?: boolean; canWrite?: boolean }) {
  return (
    <Card>
      <CardHeader title={`Account health: ${health.score}/100`} description="Explainable score: starts at 100; each factor below subtracts points with its evidence." actions={<StatusBadge status={health.band} label={health.band.replace("_", " ")} />} />
      <CardBody className="space-y-2 text-[13px]">
        {health.override ? (
          <Notice tone="info" title={`Manual override: ${health.override.score} (computed ${health.computedScore})`}>{health.override.reason} — logged {formatDate(health.override.createdAt)}</Notice>
        ) : null}
        {health.factors.length ? (
          <ul className="space-y-1.5">
            {health.factors.map((f) => (
              <li key={f.key} className="flex justify-between gap-3">
                <span>
                  <Link href={f.href} className="font-medium hover:underline">{f.label}</Link>
                  <span className="block text-[12px] text-muted">{f.evidence}</span>
                </span>
                <span className="num font-medium text-danger">{f.impact}</span>
              </li>
            ))}
          </ul>
        ) : <p className="text-muted">No risk factors detected.</p>}
        {!full ? <Link href={`/crm/accounts/${id}?tab=health`} className="text-[12.5px] text-accent hover:underline">Method & override →</Link> : null}
        {full ? (
          <details className="text-[12.5px] text-muted">
            <summary className="cursor-pointer">Scoring method</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>Overdue invoices −15 each (max −30); −10 more if any is &gt;60 days overdue</li>
              <li>Late deliverables −10 each (max −20)</li>
              <li>Engagement over budget −15 each (max −30)</li>
              <li>No client contact: −15 if &gt;45 days, −25 if &gt;90 days (active/onboarding)</li>
              <li>Retainer ending within the renewal window with no renewal −10</li>
              <li>Scope change waiting &gt;14 days −5 each</li>
              <li>Bands: ≥75 healthy · 50–74 watch · &lt;50 at risk</li>
            </ul>
          </details>
        ) : null}
        {full && canWrite ? (
          <ActionForm action={healthOverrideAction} className="space-y-2 border-t border-line pt-3">
            <input type="hidden" name="id" value={id} />
            <p className="text-[12.5px] font-medium text-ink-2">Manual override (logged in the audit trail)</p>
            <div className="flex flex-wrap gap-2">
              <Field label="Score" htmlFor="hscore"><Input id="hscore" name="score" type="number" min={0} max={100} defaultValue={health.score} className="w-24" /></Field>
              <Field label="Expires" htmlFor="hexp"><Input id="hexp" name="expiresAt" type="date" /></Field>
            </div>
            <Field label="Reason" htmlFor="hreason"><Input id="hreason" name="reason" required /></Field>
            <div className="flex gap-2">
              <SubmitButton size="sm">Save override</SubmitButton>
              {health.override ? <SubmitButton size="sm" variant="ghost" name="revoke" value="true">Remove override</SubmitButton> : null}
            </div>
          </ActionForm>
        ) : null}
      </CardBody>
    </Card>
  );
}
