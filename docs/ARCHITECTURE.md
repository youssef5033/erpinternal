# Architecture

The app is a modular monolith: one Next.js application, one PostgreSQL
database, and one background worker. Modules share the database, but each
module owns its own tables and domain functions.

```
src/
  app/(app)/…        Screens (React Server Components) grouped by navigation section
  app/api/…          Route handlers: auth, private document download, PDF, CSV export
  components/…       UI building blocks; client components only where interaction needs it
  db/schema/…        Drizzle schema per module (crm, delivery, finance, people, ops, system…)
  server/
    auth/            Better Auth config, session → Actor, permissions catalogue, record scope
    actions/         "use server" form actions (thin: parse → permission → domain fn)
    crm/ delivery/ finance/ people/ ops/ system/ ai/ jobs/
                     Domain functions — all business rules live here
    audit.ts, notifications.ts, storage.ts, documents.ts, numbering.ts, idempotency.ts
drizzle/             SQL migrations (generated + hand-written ledger guards)
scripts/             setup, demo seed/reset, worker
tests/               Vitest integration tests against a real PostgreSQL
```

## Request flow

1. **Session.** `src/proxy.ts` sends unauthenticated requests to `/login`.
   Pages call `requireActor()`, which loads the user, their roles and their
   effective grants. A disabled user, or one with no roles, is signed out.
2. **Page access.** Pages call `guard(...permissions)`. When none of the
   permissions is held, the page returns Next's `forbidden()`. The navigation
   only shows sections the actor can open.
3. **Mutations.** Every write goes through a server action built with
   `runAction(formData, { permission, action, schema, run })`. It:
   - checks the permission;
   - validates the input with zod and returns field errors to the form;
   - deduplicates double submissions with a submission key;
   - runs the domain function in a single database transaction.
4. **Domain functions.** Functions such as `issueInvoice` and
   `approveTimeEntries` check permissions and record-level scope again. That
   means a test, a job or a future API cannot bypass the checks. They write an
   audit entry in the same transaction.

### Permissions

- Grants have the form `module.action`, for example `finance.post` or
  `crm.write`. Each grant has a scope: `all` or `assigned`.
- The roles are Owner, Operations manager, Account manager, Sales, Finance,
  Team member, Contractor and Read-only. You can edit them, except Owner, and
  add new ones under **Users & Permissions → Roles**.
- Assigned scope is applied in SQL by helpers in `src/server/auth/scope.ts`,
  such as `accountVisibility` and `engagementVisibility`. The rules are:
  - **Owners and account managers** see records they own or are members of.
  - **Contractors** see only engagements, tasks and documents explicitly
    assigned to them.
  - **Sensitive fields** have their own permissions: cost rates, salaries,
    private HR notes, and bank details.
- Separation of duties:
  - Nobody can approve their own time, leave, bills or expenses.
  - The last active Owner cannot be demoted or disabled.
  - Changing a user's roles, status or password ends their sessions.

### Honesty constraints built into the code

- **Integrations.** An integration is marked `connected` only after a real
  verification call succeeds. Today only the AI provider can be verified.
  Email, calendar, accounting, banking, payments, e-signature and LinkedIn are
  listed as **not available**, with no fake connect buttons.
- **Outreach.** Outreach runs in draft or manual mode only. The system prepares
  drafts; a person sends each message outside the app and records that it was
  sent. Replies are recorded by hand. Opt-outs suppress all future steps.
  Nothing is sent automatically, and there is no LinkedIn automation.
- **AI.** AI output is stored as a labelled suggestion, together with the IDs of
  the records it was built from. It is never sent and never written onto a
  record automatically. The prompt forbids inventing contact details, budgets,
  replies, claims or commitments, and asks for `[placeholders]` instead.
- **Money.** Totals come from posted journals or live document balances; none
  are hardcoded. Different currencies are never added together without an
  explicit exchange rate. When a rate is missing, the metric reports
  "unavailable" and says why.

## Background jobs

`npm run worker` starts pg-boss. With `JOBS_IN_WEB=true` (used by the
Render Blueprint) the web server runs the same worker itself, through
`src/instrumentation.ts`. Job definitions live in
`src/server/jobs/registry.ts`.

| Job | Schedule (UTC) | What it does |
|---|---|---|
| refresh-signals | every 15 min | Recalculates review signals: overdue AR, stale deals, missing time, late deliverables, cash threshold… |
| recurring-invoices | 06:15 daily | Creates due recurring/scheduled invoices as **drafts**. Idempotent per period. |
| revenue-recognition | 06:30 daily | Posts newly earned revenue. Idempotent per recognition key. |
| outreach-drafts | hourly :05 | Prepares due sequence steps as drafts for manual sending. |
| renewal-tasks | 06:45 daily | Creates renewal tasks and rolls retainer service periods. |
| expire-proposals | 07:00 daily | Marks sent proposals past validity as expired. |
| reminders | every 15 min | In-app reminders for tasks and meetings. |
| housekeeping | 03:00 daily | Purges expired submission keys. |

- Each run is recorded with a bucket key, so a retried or concurrent run does
  not duplicate work.
- **System → Jobs** shows the last runs and their errors, and has a manual
  "Run now".

## Documents

- Uploads are checked for size, an allow-list of types, and content that matches the extension. HTML, SVG, scripts and executables
  are rejected.
- Files are stored under a random key in private storage.
- Every download goes through `/api/documents/[id]`, which checks access to
  the linked record and writes an audit entry.

## Tests

Tests are in `tests/*.test.ts` and run against a real PostgreSQL database
(`agency_erp_test`), which is migrated and reset on every run. They exercise
the domain functions directly, so permissions and posting rules are tested
exactly as the UI uses them.

| Workflow | Covered by |
|---|---|
| 1. Lead import, validation, duplicate detection and merge, qualification | `crm-workflow` |
| 2. Conversion to account, contact and opportunity (reusing an existing account) | `crm-workflow` |
| 3. Proposal draft, revision, approval, send and recorded acceptance | `crm-workflow` |
| 4. Won to handover to engagement, exactly once, with no revenue on "won" | `crm-workflow` |
| 5. Scope, milestones, tasks, time, deliverable review and approval; scope change | `delivery-ops-security` |
| 6. Retainer renewal and recurring invoices (idempotent, concurrent-safe) | `delivery-ops-security` |
| 7. Outreach drafts, manual send, reply, opt-out suppression | `delivery-ops-security` |
| 8. Invoice, partial payment, allocation, overdue signal, credit and void | `finance-workflow` |
| 9. Contractor bill, approval, payment, engagement margin with historical cost | `finance-workflow` |
| 10. Bank import, duplicate detection, matching and reconciliation | `finance-workflow` |
| 11. Reports reconcile to posted entries; multi-currency with historical rates | `finance-workflow` |
| 12. Milestone billing and recognition after deliverable approval and acceptance | `finance-workflow` |
| 13. Roles, record scope, private files, separation of duties, admin safeguards, AI and integration honesty | `delivery-ops-security`, `admin-people-controls` |

Ledger guards are tested at the database level: unbalanced entries are
rejected, posted lines cannot be changed, locked periods refuse postings, and
posting keys are idempotent.

In addition to the automated tests, a Playwright crawl signed in as each of
the eight demo roles and visited every navigation item and every link it found
(about 320 pages as Owner). It found no error responses or page errors; the
broken links it uncovered were fixed.
