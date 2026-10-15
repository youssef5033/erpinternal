import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "./errors";

/**
 * Private object storage. Files are never placed under /public; they are only
 * readable through the authorised download route (src/app/api/documents/[id]/download).
 *  - local: files under STORAGE_LOCAL_DIR (default ./storage)
 *  - s3: any S3-compatible private bucket (S3_* variables)
 */
export interface StorageDriver {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  remove(key: string): Promise<void>;
  readonly name: string;
}

class LocalDriver implements StorageDriver {
  readonly name = "local";
  constructor(private root: string) {}
  private resolve(key: string) {
    if (!/^[a-z0-9/_.-]+$/i.test(key) || key.includes("..")) throw new Error("Invalid storage key");
    const full = path.resolve(this.root, key);
    if (!full.startsWith(path.resolve(this.root) + path.sep)) throw new Error("Invalid storage key");
    return full;
  }
  async put(key: string, body: Buffer) {
    const full = this.resolve(key);
    await mkdir(path.dirname(full), { recursive: true, mode: 0o700 });
    await writeFile(full, body, { mode: 0o600 });
  }
  async get(key: string) {
    return readFile(this.resolve(key));
  }
  async remove(key: string) {
    await unlink(this.resolve(key)).catch(() => undefined);
  }
}

class S3Driver implements StorageDriver {
  readonly name = "s3";
  private clientPromise: Promise<import("@aws-sdk/client-s3").S3Client>;
  constructor(private bucket: string) {
    this.clientPromise = import("@aws-sdk/client-s3").then(
      ({ S3Client }) =>
        new S3Client({
          region: process.env.S3_REGION || "us-east-1",
          endpoint: process.env.S3_ENDPOINT || undefined,
          forcePathStyle: !!process.env.S3_ENDPOINT,
          credentials:
            process.env.S3_ACCESS_KEY_ID && process.env.S3_SECRET_ACCESS_KEY
              ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY }
              : undefined,
        }),
    );
  }
  async put(key: string, body: Buffer, contentType: string) {
    const { PutObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    await client.send(new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType, ServerSideEncryption: "AES256" }));
  }
  async get(key: string) {
    const { GetObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    const res = await client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const bytes = await res.Body!.transformToByteArray();
    return Buffer.from(bytes);
  }
  async remove(key: string) {
    const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
    const client = await this.clientPromise;
    await client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

let driver: StorageDriver | null = null;
export function storage(): StorageDriver {
  if (driver) return driver;
  if (process.env.STORAGE_DRIVER === "s3") {
    if (!process.env.S3_BUCKET) throw new Error("STORAGE_DRIVER=s3 requires S3_BUCKET");
    driver = new S3Driver(process.env.S3_BUCKET);
  } else {
    driver = new LocalDriver(path.resolve(process.env.STORAGE_LOCAL_DIR || "./storage"));
  }
  return driver;
}

/** Allow-list of upload types. HTML, SVG, scripts and executables are rejected. */
const ALLOWED: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "image/png": [".png"],
  "image/jpeg": [".jpg", ".jpeg"],
  "image/webp": [".webp"],
  "image/gif": [".gif"],
  "text/plain": [".txt"],
  "text/csv": [".csv"],
  "application/zip": [".zip"],
  "application/msword": [".doc"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/vnd.ms-excel": [".xls"],
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
  "application/vnd.ms-powerpoint": [".ppt"],
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
  "video/mp4": [".mp4"],
  "audio/mpeg": [".mp3"],
};

function sniff(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString("latin1") === "PNG") return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (buf.subarray(0, 4).toString("latin1") === "RIFF" && buf.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (buf[0] === 0x50 && buf[1] === 0x4b) return "zip"; // zip/docx/xlsx/pptx container
  return null;
}

export type ValidatedUpload = { buffer: Buffer; fileName: string; mimeType: string; sizeBytes: number; sha256: string };

export function validateUpload(fileName: string, declaredType: string, buffer: Buffer): ValidatedUpload {
  const maxMb = Number(process.env.UPLOAD_MAX_MB || 15);
  if (buffer.length === 0) throw new ValidationError("The file is empty.");
  if (buffer.length > maxMb * 1024 * 1024) throw new ValidationError(`Files must be ${maxMb} MB or smaller.`);
  const safeName = path.basename(fileName).replace(/[^\w.\- ()]/g, "_").slice(0, 180) || "file";
  const ext = path.extname(safeName).toLowerCase();
  const mime = Object.entries(ALLOWED).find(([, exts]) => exts.includes(ext))?.[0];
  if (!mime) throw new ValidationError(`File type "${ext || "unknown"}" is not allowed.`);
  const sniffed = sniff(buffer);
  if (sniffed) {
    const containerOk = sniffed === "zip" && (mime.includes("openxmlformats") || mime === "application/zip");
    if (!containerOk && sniffed !== mime) throw new ValidationError("The file content does not match its extension.");
  } else if (["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)) {
    throw new ValidationError("The file content does not match its extension.");
  }
  if (mime.startsWith("text/") && /<script|<html|<svg/i.test(buffer.subarray(0, 2048).toString("utf8"))) {
    throw new ValidationError("Text files containing markup are not allowed.");
  }
  void declaredType;
  return {
    buffer,
    fileName: safeName,
    mimeType: mime,
    sizeBytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
}

export function newStorageKey(prefix: string, fileName: string) {
  const ext = path.extname(fileName).toLowerCase().replace(/[^a-z0-9.]/g, "");
  const now = new Date();
  return `${prefix}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${randomUUID()}${ext}`;
}
