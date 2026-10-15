# Accounting model

- **Ledger.** Double-entry, accrual basis, in one base currency. The base
  currency is set in System → Settings and locks once any journal exists.
- **Source of truth.** Every financial figure is derived from posted journal
  lines or from live document balances. No figure is stored as a running total
  that could drift.
- **Jurisdiction.** The system does not assume one and does not claim
  compliance with any official filing format. Tax rates are user-defined. The
  tax page summarises posted output and input tax for a period so an
  accountant can prepare a filing.

## Integrity guarantees (database level)

Defined in `drizzle/0001_ledger_guards.sql` and tested in
`tests/finance-workflow.test.ts`.

- **Balanced entries.** A deferred constraint trigger rejects any journal entry
  whose base-currency debits and credits do not net to zero.
- **Immutable lines.** Posted journal lines cannot be updated or deleted. Every
  correction is a linked reversal, a credit note, or a new adjusting entry.
- **Period locks.** Entries dated inside a locked period are refused. Reports
  for locked periods therefore cannot change.
- **Idempotency.** Each automated posting carries a unique `postingKey`, for
  example `invoice:<id>:issue`. A retry returns the existing entry instead of
  posting twice.
- **FX rounding.** When foreign-currency lines are converted and rounded to
  cents, any residue is posted to *Foreign exchange gains/losses*. Entries
  therefore balance exactly.

## Currencies

- Each document (invoice, bill, payment, expense) stores its currency and the
  exchange rate used. The rate is the latest one recorded on or before the
  document date (Finance → Accounting → FX rates).
- If no rate exists, the action fails. The system never uses a rate of 1 or
  makes one up.
- Settlement at a different rate posts the difference to *Foreign exchange
  gains/losses* as realised FX.
- Receivables and payables are shown per currency. Totals are only converted
  where a rate exists.

## Posting rules

Signs below: Dr = debit, Cr = credit. "Revenue (stream)" means the revenue
account mapped to the line's service:
- 4000 Creative Direction
- 4100 Advisory
- 4200 Executive Communication
- 4900 Other income

| Event | Entry |
|---|---|
| Issue invoice, **recognise on invoice** | Dr Accounts receivable (gross) / Cr Revenue (stream) (net) / Cr Tax payable (tax) |
| Issue invoice, **deferred** (retainers, milestones, percent-complete, on completion) | Dr Accounts receivable / Cr Deferred revenue / Cr Tax payable |
| Revenue recognition job | Dr Deferred revenue / Cr Revenue (stream). A debit balance on deferred revenue means revenue was earned before it was invoiced (unbilled). |
| Credit note | Mirror of the invoice lines for the credited amount: Dr Revenue or Deferred revenue, Dr Tax payable / Cr Accounts receivable |
| Void invoice | Full reversal of the issue entry. Allowed only when nothing has been allocated or credited. |
| Customer payment received | Dr Bank / Cr Unapplied customer payments |
| Allocate payment to invoice | Dr Unapplied customer payments / Cr Accounts receivable. FX difference goes to FX gains/losses. Any overpayment stays in Unapplied as customer credit. |
| Reverse payment | Linked reversal of the receipt and its allocations; the invoice status is re-derived |
| Approve supplier bill | Dr Expense or direct-cost lines, Dr Tax receivable / Cr Accounts payable |
| Pay supplier | Dr Accounts payable / Cr Bank. FX difference goes to FX gains/losses. |
| Expense paid by company | Dr Expense category, Dr Tax receivable / Cr Bank |
| Expense paid personally | Dr Expense category, Dr Tax receivable / Cr Employee reimbursements payable |
| Reimburse employee | Dr Employee reimbursements payable / Cr Bank |
| Bank opening balance | Dr Bank / Cr Opening balance equity |
| Categorised bank line (fee, interest, owner draw…) | Dr or Cr the chosen ledger account / Cr or Dr Bank |
| Transfer between bank accounts | Dr Bank (to) / Cr Bank (from) |
| Manual journal | Any balanced lines. Requires the `finance.post` permission and a memo, and is reversible only by a linked reversal. |

### Invoice status

Status is derived, never typed in:
- `draft`
- `issued`, when `outstanding = total`
- `partially_paid`
- `paid`, when `outstanding = 0`
- `overdue`, when the invoice is past its due date and `outstanding > 0`
- `void`

Here `outstanding = total − allocated payments − credit notes`.

### Revenue recognition methods

An invoice is either *recognised on issue* (posted straight to revenue) or
*deferred*. Deferred invoices are released by the engagement's recognition
method. Each engagement has one method. The plan is computed in
`src/server/finance/revenue.ts`, and only the change since the last posting is
posted.

| Method | Recognises |
|---|---|
| `straight_line` | Retainers: the monthly fee for each service-period month that has **ended**. |
| `milestone` | Milestones accepted by the client: their billing amount, or an equal share of contract value when milestones have no amounts. An internally approved deliverable alone does not count. |
| `time_and_materials` | Approved billable hours × the bill rate snapshotted on the entry, per completed month. |
| `percent_complete` | Contract value × min(1, approved hours ÷ budget hours), cumulative at each month end. |
| `on_completion` | Full contract value when the engagement is marked completed. |

**Percent-complete caps at 100%.** When hours overrun the budget, no further
revenue is recognised: the overrun appears as lower margin, not extra revenue.
If budget hours are missing or zero, nothing is recognised. Set a budget, or
use another method.

"Closed won" on an opportunity is a commercial status. It posts **nothing**
to the ledger. Revenue appears only through invoices and recognition.

## Two views of profit

These two views use different inputs on purpose, and the screens label which
one they show.

| | Management P&L (Finance → Reports) | Client & project margins (Finance → Margins) |
|---|---|---|
| Source | Posted journal lines only | Recognised revenue plus approved time and direct costs per engagement |
| Labour | Only what is posted to expense accounts (for example 6000 Salaries) | Approved hours × the **cost rate effective on the work date**, snapshotted when the time is approved |
| Gross margin | Revenue − direct-cost accounts (5xxx: contractors, production, research, project travel) | Revenue − labour at cost − contractor bills − direct expenses |
| Overhead | Included (6xxx) | Not allocated |

- **Payroll is not posted by the system.** No payroll engine is implemented,
  so internal labour appears in the P&L only when salaries are recorded in the
  ledger, through a bill, a categorised bank line or a manual journal.
  Margins use cost rates instead, so the two gross margins normally differ.
- **Missing cost rates.** Hours with no cost rate covering their work date are
  excluded from margins. The *Complete setup* tab lists them.
- **Historical cost.** Changing a cost rate never rewrites history. Approved
  entries keep their snapshot.

## Reports

All reports are computed from posted lines for the selected dates, and each
links down to the underlying entries:
- P&L, balance sheet, cash flow (direct method from bank-account lines), trial
  balance, general ledger;
- AR and AP aging;
- revenue by service, client and month;
- budget vs actual.

The balance sheet carries current-period profit as *current-year earnings*,
so it balances without a year-end close. The tests assert that:
- assets = liabilities + equity + current earnings;
- P&L net profit equals posted income − expenses;
- AR aging equals the Accounts receivable control balance.

## Cash forecast (13 weeks)

The forecast is built in `src/server/finance/forecast.ts`.

- **Opening cash** is the actual posted bank balance today.
- **Inflows:**
  - open receivables by due date, plus the scenario's collection delay and
    collection rate;
  - planned billing schedules, plus payment terms;
  - optionally, open pipeline × stage probability × the scenario's inclusion
    percentage.
- **Outflows:** approved bills by due date, and approved reimbursements.
- **Adjustments:** manual entries, one-off or recurring, with outflows scaled
  by the scenario's expense multiplier.

Every movement lists its source record and its assumption. Foreign amounts are
converted at the latest recorded rate. The minimum cash threshold
(System → Settings) is drawn on the chart, and breaching it raises a review
signal.
