import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { getActor } from "@/server/auth/session";
import { authorizeDocumentDownload, readDocumentBytes } from "@/server/documents";
import { AppError } from "@/server/errors";
import { audit } from "@/server/audit";

/** Authorised private file download. Always sent as an attachment with nosniff. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await getActor();
  if (!actor) return NextResponse.json({ error: "Sign in required" }, { status: 401 });
  const { id } = await ctx.params;
  try {
    const doc = await authorizeDocumentDownload(db, actor, id);
    const bytes = await readDocumentBytes(doc);
    if (doc.visibility !== "internal") await audit(db, actor, { action: "document.downloaded", entityType: "document", entityId: doc.id, summary: `Downloaded ${doc.title} (${doc.visibility})` });
    return new NextResponse(new Uint8Array(bytes), {
      headers: {
        "Content-Type": doc.mimeType,
        "Content-Disposition": `attachment; filename="${encodeURIComponent(doc.fileName)}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "private, no-store",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  } catch (err) {
    if (err instanceof AppError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error("[download]", err);
    return NextResponse.json({ error: "File unavailable" }, { status: 500 });
  }
}
