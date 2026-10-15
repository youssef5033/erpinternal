import { getTableName, sql, type Column } from "drizzle-orm";

/**
 * Fully-qualified column reference for correlated subqueries. Drizzle omits
 * the table prefix in single-table queries, which would let an inner table's
 * column of the same name capture the reference. Always use q() inside raw
 * subqueries.
 */
export function q(col: Column) {
  return sql.raw(`"${getTableName(col.table)}"."${col.name}"`);
}
