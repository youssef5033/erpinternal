/** Normalisation used for duplicate detection across leads, accounts and contacts. */

const COMPANY_SUFFIXES = [
  "incorporated", "inc", "corporation", "corp", "company", "co", "limited", "ltd", "llc", "llp", "plc",
  "gmbh", "ag", "sa", "sarl", "srl", "bv", "nv", "pty", "pte", "fze", "fzco", "fz llc", "group", "holdings", "the",
];

export function normalizeCompanyName(name: string | null | undefined): string {
  if (!name) return "";
  let s = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  let changed = true;
  while (changed) {
    changed = false;
    for (const suffix of COMPANY_SUFFIXES) {
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, -suffix.length - 1).trim();
        changed = true;
      }
      if (s.startsWith(suffix + " ") && suffix === "the") {
        s = s.slice(suffix.length + 1).trim();
        changed = true;
      }
    }
  }
  return s;
}

const FREE_EMAIL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "hotmail.com", "outlook.com", "live.com", "icloud.com",
  "me.com", "aol.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "yandex.com",
]);

/** Extract a bare registrable-ish domain from a URL, domain or email. */
export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (s.includes("@") && !s.includes("/")) s = s.split("@").pop() ?? "";
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^www\d?\./, "");
  s = s.split(/[/?#:]/)[0];
  if (!s || !s.includes(".")) return null;
  return s;
}

export function isFreeEmailDomain(domain: string | null | undefined) {
  return !!domain && FREE_EMAIL_DOMAINS.has(domain);
}

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const s = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return null;
  return s;
}

export function isValidUrl(value: string) {
  try {
    const u = new URL(value.startsWith("http") ? value : `https://${value}`);
    return !!u.hostname && u.hostname.includes(".");
  } catch {
    return false;
  }
}

export function normalizeWebsite(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  return v.startsWith("http") ? v : `https://${v}`;
}

export function splitName(full: string): { firstName: string | null; lastName: string | null } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] || null, lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}
