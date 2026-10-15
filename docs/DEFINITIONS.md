# Metric definitions

Every number on screen is shown with its basis (what is counted, from which
records), its date range or "as of" date, and a link to the underlying
records. When a figure cannot be computed honestly, the tile says
**Unavailable** and gives the reason, for example a missing exchange rate, no
capacity defined, or a permission the viewer lacks. It never shows zero or an
estimate in that case.

## Dashboard: Numbers & evidence

| Metric | Definition |
|---|---|
| Recognised revenue | Posted credits less debits on revenue accounts dated in the period (accrual). Amounts invoiced but not yet earned stay in deferred revenue and are excluded. |
| Expenses | Approved bills and expenses posted to expense accounts in the period, shown split into direct costs and overhead. |
| Management P&L: net profit | Revenue − direct costs − overhead + other income, from posted lines. |
| Cash received | Customer receipts posted to bank or cash accounts in the period, by receipt date. |
| Cash paid | Supplier payments, company-paid expenses, reimbursements and categorised bank outflows in the period. |
| Outstanding receivables | Issued invoices: total − allocated payments − credit notes, as of today. Shown **per currency**. |
| Overdue receivables | Outstanding balance on issued invoices past their due date. |
| Payments due in 14 days | Outstanding balance on approved supplier bills due on or before today + 14 days, including bills already overdue. |
| Client & project gross margin | Recognised revenue − approved labour at the historical cost rate − direct supplier and expense costs, per engagement. Overhead is not allocated. See [ACCOUNTING.md](ACCOUNTING.md#two-views-of-profit). |
| Open pipeline | Sum of the value of open opportunities, converted to base currency at the latest rate on or before today. *Weighted* multiplies each by its stage probability, or by the opportunity's override. |
| Utilisation | Billable logged hours ÷ available capacity. Capacity is weekly capacity × working days, minus approved leave, for active people. |
| Lowest forecast cash (13 weeks) | Lowest weekly closing balance in the base-scenario cash forecast. |

## CRM analytics

The period filter applies to a **specific date field**, which is named on
screen:

- **Lead cohort.** Leads *added* in the period. Merged leads are excluded.
- **Qualification rate.** Cohort leads that ever reached *Qualified* or were
  converted ÷ cohort leads.
- **Contacted.** Cohort leads with at least one outbound email, message,
  LinkedIn touch or call, all logged manually.
- **Response rate.** Contacted leads with at least one recorded inbound reply ÷
  contacted leads.
- **Opportunity cohort.** Opportunities *created* in the period.
- **Proposal rate.** Cohort opportunities with a proposal sent ÷ cohort
  opportunities.
- **Win rate.** Won ÷ (won + lost), for opportunities *closed* in the period,
  using the win and loss dates.
- **Sales cycle.** Average days from creation to win, for deals won in the
  period.
- **Won contract value (bookings).** Closed value of deals won in the period,
  converted at the rate on the win date. Bookings are **not revenue**.
- **Attribution.**
  - First-touch: the acquisition channel and campaign recorded on the lead or
    opportunity. Missing values stay **Unknown** and are never guessed.
  - Later touches are reported separately, as touches by channel.
  - Acquisition cost appears only where campaign costs are recorded.
- **Owner scope.** Users whose CRM read access is limited to assigned records
  see analytics for their own records only.

## Review signals

Signals are recalculated every 15 minutes and on demand. Each one links to the
record that needs action and states how to resolve it. A signal closes
automatically once its condition no longer holds.

| Signal | Condition |
|---|---|
| Overdue invoice | Issued invoice past its due date with an outstanding balance |
| Project over budget | Approved hours or direct costs exceed the engagement budget |
| Scope change awaiting approval | Change request submitted and not yet approved or rejected |
| Late deliverable | Past its due date and not yet approved by the client |
| Revision limit exceeded | Client revision rounds exceed the included revisions |
| Retainer approaching renewal | Ends within the renewal window, with no next period and no renewal opportunity |
| Missing time entries | No time logged on working days in the look-back window, excluding approved leave |
| Unreconciled bank transactions | Statement lines older than 7 days not matched to a record |
| Spending outside threshold | Submitted expense above the approval threshold |
| Low forecast cash | Base-scenario 13-week forecast drops below the minimum cash threshold |
| Sales follow-up overdue | Open opportunity or active lead whose next action date has passed |
| Proposal awaiting follow-up | Proposal sent more than 7 days ago with no client interaction since |
| Unsigned or missing contract | Active engagement without a signed or active contract |

Thresholds are set in **System → Settings**: stale-opportunity days, renewal
lead days, missing-time look-back, expense approval threshold and minimum cash.

## Delivery health

- **Budget used.** Approved hours ÷ budget hours, and approved cost ÷ budget
  cost.
- **Schedule.** Milestones and deliverables past due and not yet
  accepted or approved.
- **Revision rounds.** Counted only from client-requested revisions on a
  deliverable version. Internal review rounds are not counted.
