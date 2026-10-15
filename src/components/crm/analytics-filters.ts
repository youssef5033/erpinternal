import type { Actor } from "@/server/auth/actor";
import { scopeOf } from "@/server/auth/actor";
import type { CrmFilters } from "@/server/crm/analytics";
import { isISODate, resolvePeriod } from "@/lib/dates";

export const PERIOD_OPTIONS = [
  { value: "month", label: "This month" },
  { value: "last_month", label: "Last month" },
  { value: "quarter", label: "This quarter" },
  { value: "last_90", label: "Last 90 days" },
  { value: "ytd", label: "Fiscal year to date" },
  { value: "last_12", label: "Last 12 months" },
];

/**
 * Parse CRM analytics filters from the URL. Users whose crm.read grant is scoped to
 * "assigned" records only ever see their own numbers (owner is forced to themselves).
 */
export function parseCrmFilters(sp: Record<string, string | undefined>, actor: Actor, today: string, fyStart: number): { f: CrmFilters; label: string; ownerLocked: boolean } {
  const custom = isISODate(sp.from) && isISODate(sp.to) && sp.from! <= sp.to!;
  const p = custom ? { from: sp.from!, to: sp.to!, label: `${sp.from} → ${sp.to}` } : resolvePeriod(sp.period ?? "last_90", today, fyStart);
  const ownerLocked = scopeOf(actor, "crm.read") === "assigned";
  return {
    f: {
      from: p.from,
      to: p.to,
      owner: ownerLocked ? actor.userId : sp.owner || undefined,
      service: sp.service || undefined,
      offer: sp.offer || undefined,
      channel: sp.channel || undefined,
      country: sp.country || undefined,
      campaign: sp.campaign || undefined,
    },
    label: p.label,
    ownerLocked,
  };
}

/** Query-string fragment that carries the same filters into list drill-downs. */
export function drill(f: CrmFilters, extra: Record<string, string | undefined>) {
  const p = new URLSearchParams();
  const add = (k: string, v: string | undefined) => {
    if (v) p.set(k, v);
  };
  add("owner", f.owner);
  add("service", f.service);
  add("channel", f.channel);
  add("country", f.country);
  add("campaign", f.campaign);
  for (const [k, v] of Object.entries(extra)) add(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}
