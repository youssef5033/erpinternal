import type { LedgerType } from "@/db/schema";

/**
 * Default agency chart of accounts. `systemKey` accounts are used by posting
 * rules (docs/ACCOUNTING.md); others are editable defaults.
 */
export type CoaSeed = { code: string; name: string; type: LedgerType; subtype: string; systemKey?: string; isDirectCost?: boolean; serviceKey?: string; description?: string };

export const DEFAULT_COA: CoaSeed[] = [
  // Assets
  { code: "1000", name: "Bank and cash", type: "asset", subtype: "bank_group", description: "Parent for bank/cash ledger accounts (one per bank account)." },
  { code: "1100", name: "Accounts receivable", type: "asset", subtype: "receivable", systemKey: "accounts_receivable" },
  { code: "1300", name: "Tax receivable (input tax)", type: "asset", subtype: "tax", systemKey: "input_tax" },
  { code: "1400", name: "Prepayments", type: "asset", subtype: "current_asset" },
  { code: "1500", name: "Equipment", type: "asset", subtype: "fixed_asset" },
  // Liabilities
  { code: "2000", name: "Accounts payable", type: "liability", subtype: "payable", systemKey: "accounts_payable" },
  { code: "2100", name: "Tax payable (output tax)", type: "liability", subtype: "tax", systemKey: "output_tax" },
  { code: "2200", name: "Deferred revenue (contract liability)", type: "liability", subtype: "deferred_revenue", systemKey: "deferred_revenue", description: "Invoiced but not yet earned. A debit balance means revenue recognised ahead of invoicing (unbilled revenue)." },
  { code: "2300", name: "Unapplied customer payments", type: "liability", subtype: "customer_credit", systemKey: "unapplied_cash", description: "Customer money received but not yet allocated to invoices (includes overpayments)." },
  { code: "2400", name: "Employee reimbursements payable", type: "liability", subtype: "payable", systemKey: "reimbursements_payable" },
  { code: "2500", name: "Accrued liabilities", type: "liability", subtype: "current_liability" },
  // Equity
  { code: "3000", name: "Opening balance equity", type: "equity", subtype: "equity", systemKey: "opening_balance_equity" },
  { code: "3100", name: "Retained earnings", type: "equity", subtype: "equity", systemKey: "retained_earnings" },
  { code: "3200", name: "Owner's capital", type: "equity", subtype: "equity" },
  { code: "3300", name: "Owner's drawings", type: "equity", subtype: "equity" },
  // Income
  { code: "4000", name: "Revenue — Creative Direction", type: "income", subtype: "revenue", systemKey: "revenue_creative", serviceKey: "creative" },
  { code: "4100", name: "Revenue — Strategy, Financial & Operational Advisory", type: "income", subtype: "revenue", systemKey: "revenue_advisory", serviceKey: "advisory" },
  { code: "4200", name: "Revenue — Executive Communication", type: "income", subtype: "revenue", systemKey: "revenue_executive", serviceKey: "executive" },
  { code: "4800", name: "Reimbursable income", type: "income", subtype: "revenue" },
  { code: "4900", name: "Other income", type: "income", subtype: "other_income", systemKey: "revenue_other" },
  { code: "4950", name: "Foreign exchange gains/losses", type: "income", subtype: "fx", systemKey: "fx_gain_loss", description: "Realised FX differences on settlement and rounding." },
  // Direct costs (count in gross margin)
  { code: "5000", name: "Contractors and freelancers", type: "expense", subtype: "direct_cost", systemKey: "contractor_costs", isDirectCost: true },
  { code: "5100", name: "Production and media costs", type: "expense", subtype: "direct_cost", isDirectCost: true },
  { code: "5200", name: "Research and data costs", type: "expense", subtype: "direct_cost", isDirectCost: true },
  { code: "5300", name: "Project travel", type: "expense", subtype: "direct_cost", isDirectCost: true },
  // Overhead
  { code: "6000", name: "Salaries and wages", type: "expense", subtype: "overhead" },
  { code: "6100", name: "Rent and workspace", type: "expense", subtype: "overhead" },
  { code: "6200", name: "Software and subscriptions", type: "expense", subtype: "overhead" },
  { code: "6300", name: "Marketing and business development", type: "expense", subtype: "overhead", systemKey: "marketing" },
  { code: "6400", name: "Professional fees", type: "expense", subtype: "overhead" },
  { code: "6500", name: "Travel and meals", type: "expense", subtype: "overhead" },
  { code: "6600", name: "Bank and payment fees", type: "expense", subtype: "overhead", systemKey: "bank_fees" },
  { code: "6700", name: "Training and development", type: "expense", subtype: "overhead" },
  { code: "6900", name: "General and administrative", type: "expense", subtype: "overhead", systemKey: "general_expense" },
];

export const DEFAULT_EXPENSE_CATEGORIES: { name: string; code: string }[] = [
  { name: "Software", code: "6200" },
  { name: "Travel & meals", code: "6500" },
  { name: "Project travel", code: "5300" },
  { name: "Production costs", code: "5100" },
  { name: "Research & data", code: "5200" },
  { name: "Marketing", code: "6300" },
  { name: "Office & admin", code: "6900" },
  { name: "Training", code: "6700" },
  { name: "Bank fees", code: "6600" },
];
