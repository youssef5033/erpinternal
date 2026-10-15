import Link from "next/link";

export default function Forbidden() {
  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-24 text-center">
      <p className="text-[12px] font-semibold uppercase tracking-wider text-muted">403 · Permission required</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">You don&apos;t have access to this page</h1>
      <p className="mt-2 text-[14px] text-muted">Your role does not include the permission needed here. Ask an Owner/Administrator to update your role in Users &amp; Permissions if you need it.</p>
      <Link href="/operations" className="mt-6 inline-block text-[14px] font-medium text-accent hover:underline">
        Back to the daily dashboard
      </Link>
    </main>
  );
}
