# Hosting the app in the cloud

There are two ready-made Render setups:

| | Free (`render.yaml`, the default) | Paid (`render-paid.yaml`) |
|---|---|---|
| Cost | US$0 a month | About US$14 a month at the time of writing |
| App | Render free web service | Render Starter web service |
| Database | Supabase free tier (500 MB) | Render PostgreSQL |
| Documents | Supabase Storage (1 GB free) | Render disk |
| Accounts needed | Render and Supabase | Render only |
| Catch | Sleeps when idle unless pinged (step 4) | None |

Both run the background jobs inside the web service. Both apply database
migrations on every deploy and load the demo data on the first start.

---

## Free setup: Render + Supabase

About 20 minutes, done once. Keep a text file open to collect the values
you'll copy along the way; you'll paste them into Render in step 3.

### 1. Supabase: database

1. Create an account at [supabase.com](https://supabase.com), then click
   **New project**.
   - **Name:** `agency-erp`.
   - **Database password:** generate a strong one and save it in your text
     file.
   - **Region:** the one closest to you.
2. Once the project is ready, click **Connect** at the top of the page. Choose
   **Session pooler**, not "Direct connection" and not "Transaction pooler",
   and copy the URI. It looks like:
   ```
   postgresql://postgres.abcdefgh:[YOUR-PASSWORD]@aws-0-eu-central-1.pooler.supabase.com:5432/postgres
   ```
   Replace `[YOUR-PASSWORD]` with the database password from step 1. This is
   your **`DATABASE_URL`**.
3. Go to **Project Settings → Database → SSL Configuration** and click
   **Download certificate**. Open the downloaded `.crt` file in a text
   editor. Its full text, from `-----BEGIN CERTIFICATE-----` to
   `-----END CERTIFICATE-----`, is your **`DATABASE_CA_CERT`**. The app uses it
   to verify that it's really talking to your Supabase database.
4. On the same page, turn on **Enforce SSL on incoming connections**.

### 2. Supabase: document storage

1. Go to **Storage → New bucket**.
   - **Name:** `erp-documents`.
   - **Public bucket:** leave it **off**. The bucket must be private.
2. Go to **Storage → Settings**, in the **S3 Connection** section:
   - Copy the **Endpoint**, which looks like
     `https://abcdefgh.supabase.co/storage/v1/s3`. This is your
     **`S3_ENDPOINT`**.
   - Copy the **Region**, for example `eu-central-1`. This is your
     **`S3_REGION`**.
   - Click **New access key**. Copy the **Access key ID** (your
     **`S3_ACCESS_KEY_ID`**) and the **Secret access key** (your
     **`S3_SECRET_ACCESS_KEY`**). The secret is shown only once.

### 3. Render: the app

1. Create an account at [render.com](https://render.com) and connect your
   GitHub account.
2. Go to **New → Blueprint** and choose the `youssef5033/erpinternal`
   repository and the `claude/happy-ptolemy-ebr1mp` branch. Use `main` once
   the branch is merged.
3. Render asks for these values. Paste each from your text file:

   | Field | Value |
   |---|---|
   | `DEMO_PASSWORD` | A strong password of your choice. The login page is public. |
   | `DATABASE_URL` | Session pooler URI with your password (step 1.2) |
   | `DATABASE_CA_CERT` | Full certificate text (step 1.3) |
   | `S3_BUCKET` | `erp-documents` |
   | `S3_ENDPOINT` | Endpoint (step 2.2) |
   | `S3_REGION` | Region (step 2.2) |
   | `S3_ACCESS_KEY_ID` | Access key ID (step 2.2) |
   | `S3_SECRET_ACCESS_KEY` | Secret access key (step 2.2) |

   Render generates `BETTER_AUTH_SECRET` and `CREDENTIALS_ENCRYPTION_KEY`
   itself.
4. Click **Apply**. The first build and start take about 10 minutes.
5. Open the URL Render shows, for example
   `https://agency-erp-xxxx.onrender.com`. Sign in as `owner@demo.agency`
   with your `DEMO_PASSWORD`. The other demo logins (`ops@`, `pm@`,
   `sales@`, `finance@`, `designer@`, `contractor@`, `viewer@`, all
   `@demo.agency`) use the same password.

### 4. Keep it awake (free uptime pinger)

A free Render service goes to sleep after 15 minutes without visitors. The
next visit then takes about a minute, and scheduled jobs don't run while it
sleeps. To keep it awake:

1. Create a free account at [uptimerobot.com](https://uptimerobot.com) or
   [cron-job.org](https://cron-job.org).
2. Add an HTTP monitor for `https://<your-url>/api/health`, every 10 minutes.

Render's 750 free hours a month cover one service running all the time. The
pinger also counts as activity on Supabase, which pauses free projects after a
week of inactivity.

If the app does sleep, nothing is lost. When it wakes, it runs any daily job
it missed (recurring invoices, revenue recognition, renewals…), and each job
still runs at most once per period.

### Free tier limits

- **Database:** 500 MB. That's plenty for years of an agency's records;
  documents are stored separately.
- **Documents:** 1 GB in total. Uploads are limited to 15 MB each.
- **Backups:** the free Supabase plan doesn't include downloadable backups.
  Take your own regularly; see [Backups](#backups).
- **Builds:** Render's free build minutes are enough for normal use, at about
  5 minutes per deploy.

If you outgrow it, upgrade Supabase to Pro and/or the Render service to
Starter in their dashboards. No code changes are needed.

---

## Switching from demo to real use

Keep demo data and real data apart. Never type real records into the demo.

1. Create a **second Supabase project**, for example `agency-erp-prod`, and
   repeat steps 1–2 for it.
2. In Render, open the web service, go to **Environment**, and update:
   - `DATABASE_URL`, `DATABASE_CA_CERT` and the `S3_*` values: the new
     project's values.
   - `APP_ENV`: `production`. This removes the DEMO banner, and demo data is
     never loaded.
   - Add `OWNER_EMAIL`, `OWNER_NAME`, and `OWNER_PASSWORD` (a temporary
     password of at least 10 characters).
   - Delete `DEMO_PASSWORD`.
3. Save. Render redeploys, creates the empty database structure and your
   Owner account.
4. Sign in, change your password under **Account**, then delete
   `OWNER_PASSWORD` from Render. The Owner is created only when it doesn't
   exist, so later deploys never reset your password.
5. Go to **System → Settings** and set the agency name, base currency, fiscal
   year, time zone and invoice numbering **before** posting anything. The base
   currency locks once the first journal exists.
6. Create your team under **Users & Permissions → Users**.

## Custom domain (optional)

1. In the Render service, go to **Settings → Custom Domains** and add, for
   example, `erp.youragency.com`. Then create the DNS record Render shows.
2. Add the environment variable `BETTER_AUTH_URL=https://erp.youragency.com`.

## Backups

- **Database:** from your computer, with PostgreSQL's tools installed:
  ```bash
  pg_dump --format=custom "<your DATABASE_URL>" > erp-backup-$(date +%F).dump
  ```
  Paid Supabase and Render databases also have automatic daily backups.
- **Documents:** download the bucket from Supabase Storage, or sync it with
  any S3 tool using the same access keys.
- **Encryption key:** keep a copy of `CREDENTIALS_ENCRYPTION_KEY` (Render →
  Environment). Without it, stored integration keys (such as the AI key)
  cannot be read after a restore, and must be entered again.

---

## Paid setup (`render-paid.yaml`)

A single provider with no pinger needed: the app, a Render PostgreSQL
database and a 1 GB disk for documents.

1. Go to **New → Blueprint** and choose the repository and branch. Set
   **Blueprint Path** to `render-paid.yaml`.
2. Enter a `DEMO_PASSWORD` and click **Apply**.

When you move to real use, create a new Render PostgreSQL database for real
data and follow "Switching from demo to real use" above. Use the new
database's **Internal Database URL** as `DATABASE_URL`; `DATABASE_CA_CERT`
isn't needed.

## Settings reference

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string. A database on a public hostname must use TLS: either `sslmode=verify-full` in the URL or `DATABASE_CA_CERT`. Otherwise the app refuses to start. |
| `DATABASE_CA_CERT` | The database provider's CA certificate (PEM text). Encrypts *and* verifies the connection. |
| `DB_POOL_MAX`, `PGBOSS_POOL_MAX` | Connection limits for the app and for the job queue (defaults 10 and 10). |
| `JOBS_IN_WEB` | `true` runs the scheduled jobs inside the web service. |
| `STORAGE_DRIVER` | `s3` (Supabase Storage, R2, AWS…) or `local` (a disk). |
| `S3_*` | Bucket, endpoint, region and keys for `s3`. `S3_SERVER_SIDE_ENCRYPTION` defaults to `AES256` on AWS, and to `none` with a custom endpoint. |
| `APP_ENV` | `demo` or `production`. |
| `OWNER_EMAIL`, `OWNER_NAME`, `OWNER_PASSWORD` | First Owner account. It's created once and never overwritten. |
| `BETTER_AUTH_URL` | Public URL. On Render it defaults to the service URL. |
| `LOW_MEMORY_BUILD` | `true` builds with one worker and skips the in-build type check, which brings peak build memory from about 1.6 GB to about 1.0 GB. Use it only if a build fails with "out of memory"; types are still checked by `npm run typecheck` and the tests. |

**Other hosts.** The app is a standard Node.js 20.9+ service:
- **build:** `npm ci --include=dev && npm run build`
- **start:** `npm run db:setup -- --seed-demo-if-empty && node --max-old-space-size=256 node_modules/next/dist/bin/next start`
  (it listens on `$PORT`). The heap cap suits a 512 MB instance; raise it on
  larger ones.
- **health check:** `/api/health`
