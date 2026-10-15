import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function key(): Buffer {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) throw new Error("CREDENTIALS_ENCRYPTION_KEY is not configured; integration credentials cannot be stored.");
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes, base64 encoded.");
  return buf;
}

export function credentialsKeyConfigured() {
  try {
    key();
    return true;
  } catch {
    return false;
  }
}

/** AES-256-GCM. Output: base64(iv | tag | ciphertext). Server-only; never logged. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString("base64");
}

export function decryptSecret(payload: string): string {
  const buf = Buffer.from(payload, "base64");
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** e.g. "sk-…a9F3" — safe to display. */
export function secretHint(secret: string) {
  if (secret.length <= 8) return "••••";
  return `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}
