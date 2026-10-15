import { z } from "zod";

/**
 * Convert FormData into a nested object. Supports dotted names
 * ("lines.0.description") and repeated keys ending in [] ("serviceIds[]").
 */
export function formToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [rawKey, rawValue] of fd.entries()) {
    if (rawKey.startsWith("$ACTION")) continue;
    if (typeof rawValue !== "string") continue;
    const value = rawValue;
    if (rawKey.endsWith("[]")) {
      const k = rawKey.slice(0, -2);
      const arr = (out[k] as string[] | undefined) ?? [];
      if (value !== "") arr.push(value);
      out[k] = arr;
      continue;
    }
    const parts = rawKey.split(".");
    let cur: Record<string, unknown> | unknown[] = out;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      const last = i === parts.length - 1;
      const nextIsIndex = !last && /^\d+$/.test(parts[i + 1]);
      if (Array.isArray(cur)) {
        const idx = Number(p);
        if (last) cur[idx] = value;
        else cur = (cur[idx] ??= nextIsIndex ? [] : {}) as Record<string, unknown> | unknown[];
      } else {
        if (last) cur[p] = value;
        else cur = (cur[p] ??= nextIsIndex ? [] : {}) as Record<string, unknown> | unknown[];
      }
    }
  }
  // compact sparse arrays (removed rows)
  const compact = (v: unknown): unknown => (Array.isArray(v) ? v.filter((x) => x !== undefined).map(compact) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, compact(x)])) : v);
  return compact(out) as Record<string, unknown>;
}

const empty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : typeof v === "string" ? v.trim() : v);

export const f = {
  str: (max = 500) => z.preprocess(empty, z.string().max(max)),
  optStr: (max = 5000) => z.preprocess(empty, z.string().max(max).optional().nullable()).transform((v) => v ?? null),
  text: (max = 20000) => z.preprocess(empty, z.string().max(max).optional().nullable()).transform((v) => v ?? null),
  date: () => z.preprocess(empty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date")),
  optDate: () => z.preprocess(empty, z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date").optional().nullable()).transform((v) => v ?? null),
  money: () => z.preprocess((v) => (typeof v === "string" ? v.replace(/[,\s]/g, "") : v), z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Enter an amount like 1250.00")),
  optMoney: () => z.preprocess((v) => (typeof v === "string" ? (v.replace(/[,\s]/g, "") || undefined) : v), z.string().regex(/^-?\d+(\.\d{1,2})?$/, "Enter an amount like 1250.00").optional().nullable()).transform((v) => v ?? null),
  decimal: () => z.preprocess((v) => (typeof v === "string" ? v.replace(/[,\s]/g, "") : v), z.string().regex(/^\d+(\.\d{1,4})?$/, "Enter a number")),
  optDecimal: () => z.preprocess((v) => (typeof v === "string" ? (v.trim() || undefined) : v), z.string().regex(/^\d+(\.\d{1,4})?$/, "Enter a number").optional().nullable()).transform((v) => v ?? null),
  int: () => z.preprocess(empty, z.coerce.number().int()),
  optInt: () => z.preprocess(empty, z.coerce.number().int().optional().nullable()).transform((v) => v ?? null),
  bool: () => z.preprocess((v) => v === "on" || v === "true" || v === "1" || v === true, z.boolean()),
  currency: () => z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/, "Choose a currency")),
  id: () => z.preprocess(empty, z.string().uuid("Choose a value")),
  optId: () => z.preprocess(empty, z.string().uuid().optional().nullable()).transform((v) => v ?? null),
  userId: () => z.preprocess(empty, z.string().min(1).optional().nullable()).transform((v) => v ?? null),
  ids: () => z.preprocess((v) => (Array.isArray(v) ? v : v ? [v] : []), z.array(z.string().min(1))),
  enumOf: <T extends string>(values: readonly [T, ...T[]]) => z.preprocess(empty, z.enum(values)),
};

export function zodFieldErrors(err: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of err.issues) {
    const k = issue.path.join(".") || "_";
    if (!out[k]) out[k] = issue.message;
  }
  return out;
}
