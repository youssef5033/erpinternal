# Hosting the app in the cloud

The repository includes a Render Blueprint (`render.yaml`). It creates
everything in one step:

| Piece | What it is |
|---|---|
| Web service `agency-erp` | The app. It also runs the background jobs (`JOBS_IN_WEB=true`), so no separate worker is needed. |
| PostgreSQL `agency-erp-db` | A private database, reachable only from your Render services and not from the internet. |
| Disk `documents` (1 GB) | Private storage for uploaded documents, mounted at `/var/data`. |

Each deploy applies database migrations automatically. The first deploy
loads the demo data, because `APP_ENV=demo`. Later deploys never overwrite
data.

**Cost.** The web service runs on a paid instance, because disks need one.
At the time of writing, a Starter instance, a 1 GB disk and the smallest paid
database cost roughly US$14 a month in total. Check
[render.com/pricing](https://render.com/pricing) for current prices. You can
pick other plans in `render.yaml` or in the dashboard.

## 1. Deploy the demo

1. Create an account at [render.com](https://render.com) and connect your
   GitHub account.
2. Go to **New → Blueprint** and choose the `youssef5033/erpinternal`
   repository and the `claude/happy-ptolemy-ebr1mp` branch. You can choose
   `main` instead once the branch is merged.
3. Render asks for **`DEMO_PASSWORD`**. Pick a strong password: anyone who has
   the URL can reach the login page. Render generates the other secrets
   (`BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`) itself.
4. Click **Apply**. The first build and deploy take about 5–10 minutes.
5. Open the URL Render shows, for example
   `https://agency-erp-xxxx.onrender.com`. Sign in as `owner@demo.agency`
   with the password from step 3. The other demo logins (`ops@`, `pm@`,
   `sales@`, `finance@`, `designer@`, `contractor@`, `viewer@`, all
   `@demo.agency`) use the same password.

To check the deploy, open `https://<your-url>/api/health`. It shows
`{"ok":true}` when the app and the database are up. **System → Jobs** inside
the app shows the background job runs.

## 2. Switch to real use

Keep demo data and real data in separate databases. Never put real records
into the demo.

1. In Render, create a new PostgreSQL database, for example
   `agency-erp-prod`, on a paid plan so it has backups.
2. In the web service, go to **Environment** and change these values:
   - `DATABASE_URL`: the new database's **Internal Database URL**.
   - `APP_ENV`: `production`. This removes the DEMO banner, and demo data is
     never loaded.
   - `OWNER_EMAIL`: your email address.
   - `OWNER_NAME`: your name.
   - `OWNER_PASSWORD`: a temporary password of at least 10 characters.
   - `DEMO_PASSWORD`: delete it.
3. Save. Render redeploys, creates the empty database structure and your
   Owner account.
4. Sign in, change your password under **Account**, then delete
   `OWNER_PASSWORD` from the environment. The Owner account is only created
   when it doesn't exist yet, so later deploys never reset your password.
5. Go to **System → Settings** and set the agency name, base currency, fiscal
   year, time zone and invoice numbering **before** posting anything. The base
   currency locks once the first journal exists.
6. Create your team under **Users & Permissions → Users**.

You can then delete the demo database, or keep it for training on a separate
service.

## 3. Custom domain (optional)

1. In the web service, go to **Settings → Custom Domains** and add, for
   example, `erp.youragency.com`. Then create the DNS record Render shows.
2. Add the environment variable `BETTER_AUTH_URL=https://erp.youragency.com`.
   Sign-in cookies are tied to this address.

## 4. Optional: S3-compatible storage instead of the disk

Use this to keep files outside Render, or to run more than one web instance
(a disk can only attach to one). Any private S3-compatible bucket works,
including AWS S3, Cloudflare R2, Backblaze B2 and Wasabi.

| Variable | Value |
|---|---|
| `STORAGE_DRIVER` | `s3` |
| `S3_BUCKET` | your private bucket name |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | an access key limited to that bucket |
| `S3_REGION` | AWS: the bucket's region. Cloudflare R2: `auto` |
| `S3_ENDPOINT` | Leave empty for AWS. R2: `https://<account-id>.r2.cloudflarestorage.com` |
| `S3_SERVER_SIDE_ENCRYPTION` | Optional. On AWS it defaults to `AES256`. With a custom endpoint it defaults to `none`, because those services encrypt at rest themselves. |

Keep the bucket private. Never enable public access. The app serves files
only through its own authorised download route.

Files already on the disk are not copied automatically. Switch before you
upload real documents, or copy the `storage/` folder into the bucket with the
same keys.

## 5. Optional: a separate background worker

For heavier use, run the jobs in their own process:

1. Set `JOBS_IN_WEB=false` on the web service.
2. Add a **Background Worker** service from the same repository:
   - **build command:** `npm ci --include=dev`
   - **start command:** `npm run worker`
   - **environment:** the same variables as the web service, including
     `DATABASE_URL`.

## Backups

- **Database.** Render's paid PostgreSQL plans include automatic backups and
  point-in-time recovery; check the database's **Recovery** tab. You can also
  take your own copy at any time:
  `pg_dump --format=custom "<External Database URL>" > backup.dump`.
  An external URL only works after you add your IP address under the
  database's **Networking** settings.
- **Documents.** Render snapshots disks daily. With S3 storage, enable bucket
  versioning.
- **Encryption key.** Keep a copy of `CREDENTIALS_ENCRYPTION_KEY` somewhere
  safe. Without it, stored integration keys (such as the AI key) cannot be
  decrypted after a restore, and must be entered again.

## Other hosts (Railway, Fly.io, a VPS…)

The app is a standard Node.js service.

| | |
|---|---|
| Node | 20.9 or newer |
| Build | `npm ci --include=dev && npm run build` |
| Start | `npm run db:setup -- --seed-demo-if-empty && npm start` (listens on `$PORT`) |
| Health check | `GET /api/health` |
| Required env | `DATABASE_URL`, `APP_ENV`, `BETTER_AUTH_SECRET`, `CREDENTIALS_ENCRYPTION_KEY`, `BETTER_AUTH_URL` (the public https URL), `JOBS_IN_WEB=true` or a separate `npm run worker` |
| Storage | A persistent volume with `STORAGE_LOCAL_DIR` pointing at it, or S3 (section 4) |

Generate the two secrets with `openssl rand -base64 32`. For a hosted
database such as Neon or Supabase, use its **direct** connection string, not
the pooled one. The job queue needs a persistent connection.
