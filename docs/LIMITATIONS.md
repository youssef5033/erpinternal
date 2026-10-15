# Assumptions, limitations and next steps

## Assumptions

- **Brand and accounts.** There is a single agency brand and a single legal
  entity, with one base currency for the ledger. Each client company has
  exactly one account; multiple engagements and opportunities sit under it.
- **Tax.** No jurisdiction is assumed. Tax rates, the tax identifier label,
  invoice wording and the fiscal-year start are all settings, and the system
  does not claim official filing compliance.
- **Users.** Users are internal staff and contractors. There is no client or
  supplier login.

## Not implemented, by design for this phase

- **External integrations.** Email, calendar, accounting packages, bank feeds,
  payments, e-signature and LinkedIn have no connectors. The Integrations page
  lists them as not available, and none is ever shown as connected. Bank data
  enters through CSV import; contracts are signed outside the app, and the
  evidence is recorded.
- **Automatic sending.** The system never sends email or messages.
  - Outreach and invoice delivery are manual: a person sends each one outside
    the app and records it.
  - Notifications are in-app only.
  - There is no LinkedIn automation, and none will be built without the
    platform's authorisation.
- **Payroll.** There are no payroll calculations, payslips or statutory
  deductions, and none will be added until requirements are defined for a
  specific jurisdiction. Salaries reach the P&L only if they are recorded as
  bills, bank lines or journals. Margins use cost rates instead (see
  [ACCOUNTING.md](ACCOUNTING.md#two-views-of-profit)).
- **Year-end close.** There is no closing-entry workflow. The balance sheet
  shows current-year earnings; lock the period, then post the transfer to
  retained earnings as a manual journal.
- **Client portal.** There is none, as requested.

## Known limitations

- **AI.** AI assistance is optional and has two uses: drafting a follow-up for
  an opportunity, and summarising an account.
  - Tested: the paths with no key configured (refusal, permission checks, and
    no "connected" status without verification).
  - Not tested: a live call to the provider, because no key was available
    while building.
  - Verification lists one model through the official SDK.
- **Percent-complete recognition.** It caps at 100% of contract value and
  needs budget hours. Overruns show up as margin erosion.
- **Search.** Global search uses `ILIKE` matching on key fields, filtered by
  visibility. That is adequate for the expected data volume; for larger
  volumes, move to PostgreSQL full-text indexes.
- **Calendar times.** The calendar renders in the user's time zone, or the
  agency's when the user has none set. There is no iCal feed or external
  calendar sync.
- **Bank imports.** CSV only, with column mapping. OFX, CAMT and MT940 are not
  parsed.
- **Documents.** Files are versioned and access-controlled, but not
  virus-scanned. Uploads are restricted to an allow-list of types and checked
  against their content.
- **Rate limiting.** Auth endpoints use Better Auth's built-in limit, 30
  requests per minute, enabled when `NODE_ENV=production`. Other routes have
  none. Put a reverse proxy with request limits in front of a
  public deployment.

## Continuation checklist (suggested priorities)

1. **Email connector** (SMTP or provider API), with explicit per-message
   approval to send drafted outreach and invoices. Inbound replies would be
   logged by a mailbox integration, not inferred.
2. **Bank feed or open-banking connector** for read-only statement import into
   the existing staging, matching and reconciliation flow.
3. **Accounting export or sync** (journals and contacts) for the agency's
   external accountant.
4. **E-signature connector**, so signature evidence is captured automatically.
5. **Year-end close workflow**: retained-earnings transfer, then lock.
6. **Payroll journal import** from the payroll provider, so P&L labour matches
   reality. This is not payroll calculation.
7. **Full-text search indexes** and saved views.
8. **Playwright end-to-end suite** in CI, building on the role crawl used
   during development.
