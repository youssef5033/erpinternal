import Decimal from "decimal.js";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export type MoneyInput = string | number | Decimal | null | undefined;

/** Decimal from DB string / number / null (null => 0). Never use JS floats for money. */
export function d(value: MoneyInput): Decimal {
  if (value === null || value === undefined || value === "") return new Decimal(0);
  return new Decimal(value);
}

/** Round to 2 dp and serialise for a numeric(18,2) column. */
export function toMoney(value: MoneyInput): string {
  return d(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
}

export function toFixed4(value: MoneyInput): string {
  return d(value).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed(4);
}

export function sum(values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(d(v)), new Decimal(0));
}

export function isZero(value: MoneyInput) {
  return d(value).abs().lessThan("0.005");
}

export function pct(part: MoneyInput, whole: MoneyInput): Decimal | null {
  const w = d(whole);
  if (w.isZero()) return null;
  return d(part).div(w).times(100);
}

/**
 * Allocate `total` across `weights` proportionally, putting rounding pennies on
 * the largest share so the parts always sum exactly to the total.
 */
export function allocateProportionally(total: MoneyInput, weights: MoneyInput[]): string[] {
  const t = d(total);
  const ws = weights.map(d);
  const wsum = ws.reduce((a, b) => a.plus(b), new Decimal(0));
  if (wsum.isZero()) return ws.map(() => "0.00");
  const parts = ws.map((w) => t.times(w).div(wsum).toDecimalPlaces(2, Decimal.ROUND_DOWN));
  let remainder = t.minus(parts.reduce((a, b) => a.plus(b), new Decimal(0)));
  const order = ws.map((w, i) => ({ w, i })).sort((a, b) => b.w.comparedTo(a.w));
  let k = 0;
  const cent = new Decimal("0.01");
  while (remainder.greaterThanOrEqualTo(cent) && order.length) {
    const idx = order[k % order.length].i;
    parts[idx] = parts[idx].plus(cent);
    remainder = remainder.minus(cent);
    k++;
  }
  return parts.map((p) => p.toFixed(2));
}

export function formatMoney(value: MoneyInput, currency: string, opts: { compact?: boolean; sign?: boolean } = {}) {
  const n = d(value).toNumber();
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      notation: opts.compact ? "compact" : "standard",
      maximumFractionDigits: opts.compact ? 1 : 2,
      minimumFractionDigits: opts.compact ? 0 : 2,
      signDisplay: opts.sign ? "exceptZero" : "auto",
    }).format(n);
  } catch {
    return `${currency} ${d(value).toFixed(2)}`;
  }
}

export { Decimal };
