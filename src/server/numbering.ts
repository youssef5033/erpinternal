import { sql } from "drizzle-orm";
import type { Tx } from "@/db/client";

const DEFAULTS: Record<string, { prefix: string; padding: number }> = {
  invoice: { prefix: "INV-", padding: 5 },
  credit_note: { prefix: "CN-", padding: 5 },
  opportunity: { prefix: "OPP-", padding: 4 },
  proposal: { prefix: "PRP-", padding: 4 },
  engagement: { prefix: "ENG-", padding: 4 },
  contract: { prefix: "CTR-", padding: 4 },
  change_request: { prefix: "CR-", padding: 4 },
  payment: { prefix: "PAY-", padding: 5 },
  supplier_payment: { prefix: "SPY-", padding: 5 },
  bill: { prefix: "BILL-", padding: 5 },
  expense: { prefix: "EXP-", padding: 5 },
  journal: { prefix: "JE-", padding: 6 },
};

/**
 * Next number in a sequence. Runs inside the caller's transaction and locks the
 * sequence row, so numbers are sequential and gapless for committed records
 * (a rolled-back transaction also rolls back the increment).
 */
export async function nextNumber(tx: Tx, key: string, prefixOverride?: string): Promise<string> {
  const def = DEFAULTS[key] ?? { prefix: `${key.toUpperCase()}-`, padding: 4 };
  await tx.execute(sql`
    insert into number_sequences (key, prefix, next_value, padding)
    values (${key}, ${prefixOverride ?? def.prefix}, 1, ${def.padding})
    on conflict (key) do nothing`);
  const res = await tx.execute<{ value: number; prefix: string; padding: number }>(sql`
    update number_sequences set next_value = next_value + 1
    where key = ${key}
    returning next_value - 1 as value, prefix, padding`);
  const row = res.rows[0];
  const prefix = prefixOverride ?? row.prefix;
  return `${prefix}${String(row.value).padStart(row.padding, "0")}`;
}
