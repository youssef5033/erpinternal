# Agency ERP

Internal ERP with an integrated CRM for a single-brand agency with three service
streams: Creative Direction; Strategy, Financial & Operational Advisory; and
Executive Communication. Each client company has one account. Opportunities,
engagements, contracts, budgets and deliverables are kept separately underneath
that account.

This is internal only. There is no client portal.

- **Stack:** Next.js 16 (App Router), TypeScript, PostgreSQL with Drizzle ORM
  and SQL migrations, Better Auth, Tailwind CSS 4, Recharts, and pg-boss for
  background jobs.
- **Storage:** private document storage, either local disk or S3-compatible.

**Hosting it in the cloud:** see [`docs/DEPLOY.md`](docs/DEPLOY.md). It
covers a free setup (Render + Supabase, $0 a month) and a paid
single-provider setup on Render.

Further docs: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md),
[`docs/ACCOUNTING.md`](docs/ACCOUNTING.md),
[`docs/DEFINITIONS.md`](docs/DEFINITIONS.md),
[`docs/LIMITATIONS.md`](docs/LIMITATIONS.md).

## Requirements

- Node.js 20.9 or newer (developed on Node 22).
- PostgreSQL 14 or newer (developed on 16).
- For end-to-end checks only: a Chromium browser for Playwright.

## First run (development)

```bash
npm install
cp .env.example .env            # then fill in the secrets (see below)
createdb agency_erp
npm run db:setup                # applies migrations and creates reference data
                                # (roles, chart of accounts, services, stages)
OWNER_PASSWORD='choose-a-long-one' \
  npm run db:setup -- --owner-email you@agency.com --owner-name "Your Name"
npm run dev                     # http://localhost:3000
npm run worker                  # separate terminal: scheduled jobs
```

Public sign-up is disabled. The first Owner is created by `db:setup`. Every
other user is created by an Owner or admin under **Users & Permissions → Users**.
No email is sent; share the temporary password through a secure channel.

## Production

```bash
npm run build
npm run db:setup                # idempotent; run it on every deploy to apply migrations
npm start                       # web
npm run worker                  # one worker process
```

- Run the app behind HTTPS and set `BETTER_AUTH_URL` to the public URL.
- Keep `STORAGE_LOCAL_DIR` (or the S3 bucket) private. Files are only served
  through authorised route handlers, which check record access and write an
  audit entry.

## Environment variables

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection string. Production and demo **must** use different databases. A database on a public hostname must use TLS, or the app refuses to start. |
| `DATABASE_CA_CERT` | hosted DB | The provider's CA certificate (PEM text), used for encrypted and verified connections (for example Supabase). |
| `DB_POOL_MAX`, `PGBOSS_POOL_MAX` | no | Connection limits for the app and the job queue. Default 10 each. |
| `APP_ENV` | yes | `production`, `demo` or `development`. In `demo` the app shows a permanent DEMO banner, and `demo:reset` is allowed. |
| `BETTER_AUTH_URL` | yes* | Public base URL, used for cookies and auth callbacks. *On Render it defaults to the service URL. |
| `BETTER_AUTH_SECRET` | yes | 32+ random bytes (`openssl rand -base64 32`). Signs sessions. |
| `CREDENTIALS_ENCRYPTION_KEY` | yes | 32 random bytes, base64. Encrypts integration credentials at rest (AES-256-GCM). Losing it makes stored keys unreadable, so they must be re-entered. |
| `STORAGE_DRIVER` | no | `local` (default) or `s3`. |
| `STORAGE_LOCAL_DIR` | no | Default `./storage`. Must be outside `public/`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | when `s3` | A private S3-compatible bucket. |
| `UPLOAD_MAX_MB` | no | Upload size limit. Default 15. |
| `JOBS_ENABLED` | no | Set to `false` to stop the worker scheduling jobs. |
| `JOBS_IN_WEB` | no | `true` runs the background jobs inside the web server, so no separate `npm run worker` process is needed. |
| `S3_SERVER_SIDE_ENCRYPTION` | no | Encryption header sent to S3. On AWS it defaults to `AES256`; with a custom `S3_ENDPOINT` it is not sent. |
| `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` | hosted first run | `db:setup` creates this Owner if no user with that email exists yet. It never resets an existing password. |
| `ANTHROPIC_API_KEY` | no | Optional AI assistance. The app works fully without it. A key can also be stored encrypted from **System → Integrations**. |
| `AI_MODEL` | no | Model for AI suggestions. Default `claude-opus-5-5`. |
| `DEMO_PASSWORD` | demo only | Password given to the seeded demo users. |

Secrets are read only on the server. They are never sent to the browser or
written to logs or the audit trail; the audit records only that a key changed.

## Demo environment

The demo uses its own database and is clearly labelled. Every record in it is
fictional: no real clients, people, bank data or credentials.

```bash
createdb agency_erp_demo
# .env: DATABASE_URL=.../agency_erp_demo, APP_ENV=demo, DEMO_PASSWORD=demo-password-2026
npm run demo:reset              # migrate, wipe, reseed (refuses unless APP_ENV=demo
                                # and the database name contains "demo")
npm run dev
```

All demo users share the password `demo-password-2026`, or whatever
`DEMO_PASSWORD` is set to.

| Login | Role | What it shows |
|---|---|---|
| `owner@demo.agency` | Owner | Everything, including users, roles and settings |
| `ops@demo.agency` | Operations manager | Delivery, people, approvals, finance operations |
| `pm@demo.agency` | Account manager | Accounts, opportunities and engagements they own |
| `sales@demo.agency` | Sales | Leads, opportunities, outreach; no cost rates or salaries |
| `finance@demo.agency` | Finance | Ledger, invoices, bills, bank, reports; no private HR |
| `designer@demo.agency` | Team member | Assigned tasks, time, deliverables |
| `contractor@demo.agency` | Contractor | Only engagements and files explicitly assigned |
| `viewer@demo.agency` | Read-only | Reads everything permitted; cannot change anything |

To reset the demo at any time, run `npm run demo:reset`. It truncates every
table, clears the job queue and local demo files, and reseeds.

## Backup and restore

```bash
pg_dump --format=custom --no-owner "$DATABASE_URL" > backup-$(date +%F).dump
tar czf storage-$(date +%F).tgz storage/        # when STORAGE_DRIVER=local

pg_restore --clean --if-exists --no-owner -d "$DATABASE_URL" backup-YYYY-MM-DD.dump
```

- Back up the database and the storage directory or bucket together. Documents
  are referenced by key from the database.
- Keep `CREDENTIALS_ENCRYPTION_KEY` with the backup; without it, stored
  integration keys cannot be decrypted.
- **System → Data** offers CSV exports per entity, which are audited.

## Checks

```bash
npm run typecheck
npm run lint
npm test                        # Vitest against agency_erp_test (see .env.test); migrates and resets it
npm run build
```

`npm test` runs 40 tests covering the ledger, permissions and the end-to-end
workflows (see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md#tests)). The test
database is wiped on each run; never point `.env.test` at real data.
