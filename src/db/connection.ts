import type { PoolConfig } from "pg";

/**
 * PostgreSQL connection settings shared by the app pool, the job queue and
 * migrations.
 *
 * TLS: node-postgres verifies the server certificate whenever `sslmode` is in
 * the URL. Providers that sign with their own certificate authority (e.g.
 * Supabase) need that CA: put its PEM text in DATABASE_CA_CERT and the
 * connection is encrypted *and* verified. (The URL's sslmode is then ignored,
 * because node-postgres lets URL parameters override an explicit `ssl` object.)
 */
export function pgConfig(overrides: Partial<PoolConfig> = {}): PoolConfig {
  const url = process.env.DATABASE_URL;
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  if (url && !ca) assertEncryptedIfRemote(url);
  if (!url || !ca) return { connectionString: url, ...overrides };
  const u = new URL(url);
  for (const p of ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"]) u.searchParams.delete(p);
  return { connectionString: u.toString(), ssl: { ca, rejectUnauthorized: true }, ...overrides };
}

/**
 * Refuse to send business data unencrypted over the internet. A database on a
 * public hostname (anything with a dot that is not local) must use TLS: either
 * sslmode in the URL or DATABASE_CA_CERT. Private-network hostnames such as
 * Render's internal `dpg-…` addresses and localhost are allowed as they are.
 * Set DATABASE_ALLOW_PLAINTEXT=true only for a trusted private network.
 */
function assertEncryptedIfRemote(url: string) {
  if (process.env.DATABASE_ALLOW_PLAINTEXT === "true") return;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return; // not a URL (e.g. socket path); nothing to check
  }
  const host = u.hostname;
  const local = host === "localhost" || host === "[::1]" || /^127\./.test(host) || /^(10|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || !host.includes(".");
  const sslmode = u.searchParams.get("sslmode");
  if (!local && (!sslmode || sslmode === "disable" || sslmode === "allow")) {
    throw new Error(`DATABASE_URL points at ${host} without TLS. Add ?sslmode=verify-full, or set DATABASE_CA_CERT (see docs/DEPLOY.md).`);
  }
}
