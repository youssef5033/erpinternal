import Link from "next/link";
import type { receivablesAging } from "@/server/finance/reports";
import { Card, CardHeader, EmptyState, Table, TD, TH, THead, TR } from "@/components/ui/primitives";
import { Money } from "@/components/ui/display";

type Aging = Awaited<ReturnType<typeof receivablesAging>>;

/** Aging by party and bucket, one table per currency (never summed across currencies). */
export function AgingTable({ aging, partyHref, itemHref, title }: { aging: Aging; partyHref: (id: string) => string; itemHref: (id: string) => string; title: string }) {
  if (!aging.currencies.length) return <Card><CardHeader title={title} /><EmptyState title="Nothing outstanding" /></Card>;
  return (
    <div className="space-y-4">
      {aging.currencies.map((c) => (
        <Card key={c.currency}>
          <CardHeader title={`${title} — ${c.currency}`} description={`As of ${aging.asOf}. Buckets by days past due date.`} />
          <Table>
            <THead><tr><TH>Party</TH>{aging.buckets.map((b) => <TH key={b.key} align="right">{b.label}</TH>)}<TH align="right">Total</TH></tr></THead>
            <tbody>
              {c.rows.map((r) => (
                <TR key={r.partyId}>
                  <TD>
                    <Link className="font-medium hover:underline" href={partyHref(r.partyId)}>{r.party}</Link>
                    <div className="text-[12px] text-muted">{r.items.map((it, i) => <span key={it.id}>{i ? ", " : ""}<Link className="hover:underline" href={itemHref(it.id)}>{it.ref}</Link></span>)}</div>
                  </TD>
                  {aging.buckets.map((b) => <TD key={b.key} align="right" className={b.key !== "current" && Number(r.buckets[b.key]) > 0 ? "text-danger" : ""}>{Number(r.buckets[b.key]) ? <Money value={r.buckets[b.key]} currency={c.currency} /> : "—"}</TD>)}
                  <TD align="right" className="font-medium"><Money value={r.total} currency={c.currency} /></TD>
                </TR>
              ))}
              <TR className="bg-sunken/60 font-medium">
                <TD>Total</TD>
                {aging.buckets.map((b) => <TD key={b.key} align="right"><Money value={c.totals[b.key]} currency={c.currency} /></TD>)}
                <TD align="right"><Money value={c.total} currency={c.currency} /></TD>
              </TR>
            </tbody>
          </Table>
        </Card>
      ))}
    </div>
  );
}
