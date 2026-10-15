import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate, formatDateTime } from "@/lib/dates";
import { d, formatMoney } from "@/lib/money";
import { cn } from "@/lib/utils";

export function Money({ value, currency, className, compact, sign, emphasize }: { value: string | number | null | undefined; currency: string | null | undefined; className?: string; compact?: boolean; sign?: boolean; emphasize?: "negative" }) {
  if (value === null || value === undefined || !currency) return <span className="text-faint">—</span>;
  const neg = d(value).isNegative();
  return <span className={cn("num whitespace-nowrap", emphasize === "negative" && neg && "text-danger", className)}>{formatMoney(value, currency, { compact, sign })}</span>;
}

export function DateText({ value, className, overdue }: { value: string | null | undefined; className?: string; overdue?: boolean }) {
  return (
    <time dateTime={value ?? undefined} className={cn("whitespace-nowrap", overdue && "font-medium text-danger", className)}>
      {formatDate(value)}
    </time>
  );
}

export function DateTimeText({ value, timeZone }: { value: Date | string | null | undefined; timeZone?: string }) {
  return <time className="whitespace-nowrap">{formatDateTime(value, timeZone)}</time>;
}

/** Link-based tabs: work without JS, keyboard accessible, shareable URLs. */
export function Tabs({ tabs, current, className }: { tabs: { key: string; label: ReactNode; href: string; count?: number | null }[]; current: string; className?: string }) {
  return (
    <nav aria-label="Views" className={cn("mb-4 overflow-x-auto border-b border-line", className)}>
      <ul className="flex min-w-max gap-1">
        {tabs.map((t) => {
          const active = t.key === current;
          return (
            <li key={t.key}>
              <Link
                href={t.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-[13.5px] font-medium",
                  active ? "border-accent text-ink" : "border-transparent text-muted hover:border-line-strong hover:text-ink",
                )}
              >
                {t.label}
                {t.count != null ? <span className={cn("num rounded px-1.5 text-[11px]", active ? "bg-accent-soft text-accent-ink" : "bg-sunken text-muted")}>{t.count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * A decision-supporting metric. Every number links to its records and
 * explains its basis, date range and currency (via native <details>).
 */
export function MetricCard({
  label,
  value,
  currency,
  href,
  basis,
  range,
  detail,
  unavailableReason,
  suffix,
}: {
  label: string;
  value: string | null;
  currency: string | null;
  href: string;
  basis: string;
  range: string;
  detail?: { label: string; value: string; currency?: string; href?: string }[];
  unavailableReason?: string;
  suffix?: string;
}) {
  return (
    <div className="flex flex-col rounded-[var(--radius-card)] border border-line bg-surface p-3.5">
      <div className="flex items-start justify-between gap-2">
        <p className="text-[12.5px] font-medium text-muted">{label}</p>
        <Link href={href} className="text-[12px] text-accent hover:underline">
          Records →
        </Link>
      </div>
      <p className="num mt-1 text-[22px] font-semibold tracking-tight text-ink">
        {value === null ? (
          <span className="text-[14px] font-normal text-faint">Unavailable</span>
        ) : currency ? (
          formatMoney(value, currency)
        ) : (
          `${value}${suffix ?? ""}`
        )}
      </p>
      {unavailableReason ? <p className="mt-1 text-[12px] text-warning">{unavailableReason}</p> : null}
      {detail?.length ? (
        <ul className="mt-2 space-y-0.5 text-[12.5px]">
          {detail.map((x, i) => (
            <li key={i} className="flex justify-between gap-3">
              {x.href ? (
                <Link href={x.href} className="truncate text-ink-2 hover:underline">
                  {x.label}
                </Link>
              ) : (
                <span className="truncate text-ink-2">{x.label}</span>
              )}
              <span className="num text-ink">{x.currency ? formatMoney(x.value, x.currency) : x.value}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <details className="mt-auto pt-2 text-[12px] text-muted">
        <summary className="cursor-pointer select-none hover:text-ink">How is this calculated?</summary>
        <p className="mt-1">{basis}</p>
        <p className="mt-1">
          <span className="font-medium">Range:</span> {range}
          {currency ? (
            <>
              {" · "}
              <span className="font-medium">Currency:</span> {currency}
            </>
          ) : null}
        </p>
      </details>
    </div>
  );
}

export function Progress({ value, max = 100, tone }: { value: number; max?: number; tone?: "accent" | "warning" | "danger" }) {
  const pct = Math.max(0, Math.min(100, (value / (max || 1)) * 100));
  const t = tone ?? (pct > 100 ? "danger" : pct > 85 ? "warning" : "accent");
  return (
    <div className="h-1.5 w-full overflow-hidden rounded bg-sunken" role="progressbar" aria-valuenow={Math.round(value)} aria-valuemin={0} aria-valuemax={max}>
      <div className={cn("h-full rounded", t === "danger" ? "bg-danger" : t === "warning" ? "bg-warning" : "bg-accent")} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Pagination({ page, pageSize, total, hrefFor }: { page: number; pageSize: number; total: number; hrefFor: (p: number) => string }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return <p className="px-3 py-2 text-[12px] text-muted">{total} record{total === 1 ? "" : "s"}</p>;
  return (
    <nav aria-label="Pagination" className="flex items-center justify-between px-3 py-2 text-[12.5px] text-muted">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(total, page * pageSize)} of {total}
      </span>
      <span className="flex gap-1">
        {page > 1 ? (
          <Link className="rounded border border-line px-2 py-0.5 hover:bg-sunken" href={hrefFor(page - 1)}>
            Previous
          </Link>
        ) : null}
        {page < pages ? (
          <Link className="rounded border border-line px-2 py-0.5 hover:bg-sunken" href={hrefFor(page + 1)}>
            Next
          </Link>
        ) : null}
      </span>
    </nav>
  );
}

export function KeyValue({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 text-[13px]">
      <span className="text-muted">{label}</span>
      <span className="text-right text-ink">{children}</span>
    </div>
  );
}
