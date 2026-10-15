"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

type Point = { week: string; closing: number; inflow: number; outflow: number };

const fmt = (currency: string) => new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 });

/** Projected closing cash by week (single series; table view lives beside it). */
export function CashChart({ data, currency, threshold }: { data: Point[]; currency: string; threshold: number | null }) {
  const f = fmt(currency);
  return (
    <div className="h-[260px] w-full" role="img" aria-label={`Projected closing cash by week in ${currency}; see the weekly table for exact values.`}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: 8 }}>
          <CartesianGrid stroke="var(--color-line)" strokeDasharray="0" vertical={false} />
          <XAxis dataKey="week" tickFormatter={(w: string) => w.slice(5)} tick={{ fontSize: 11, fill: "var(--color-muted)" }} axisLine={{ stroke: "var(--color-line-strong)" }} tickLine={false} />
          <YAxis tickFormatter={(v: number) => new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(v)} tick={{ fontSize: 11, fill: "var(--color-muted)" }} axisLine={false} tickLine={false} width={48} />
          <Tooltip
            cursor={{ stroke: "var(--color-line-strong)", strokeWidth: 1 }}
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0].payload as Point;
              return (
                <div className="rounded-md border border-line bg-surface px-3 py-2 text-[12px] text-ink shadow-sm">
                  <p className="font-medium">Week of {p.week}</p>
                  <p>Closing: {f.format(p.closing)}</p>
                  <p className="text-muted">In {f.format(p.inflow)} · Out {f.format(p.outflow)}</p>
                </div>
              );
            }}
          />
          {threshold !== null ? <ReferenceLine y={threshold} stroke="var(--color-muted)" strokeDasharray="4 4" label={{ value: `Minimum ${f.format(threshold)}`, position: "insideTopRight", fontSize: 11, fill: "var(--color-muted)" }} /> : null}
          <Line type="monotone" dataKey="closing" stroke="var(--color-accent)" strokeWidth={2} dot={{ r: 4, strokeWidth: 2, stroke: "var(--color-surface, #fff)", fill: "var(--color-accent)" }} activeDot={{ r: 5 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
