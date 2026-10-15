import Link from "next/link";

export default function NotFound() {
  return (
    <main id="main" className="mx-auto max-w-lg px-6 py-24 text-center">
      <p className="text-[12px] font-semibold uppercase tracking-wider text-muted">404</p>
      <h1 className="mt-2 text-2xl font-semibold text-ink">Record not found</h1>
      <p className="mt-2 text-[14px] text-muted">It may have been archived, merged into another record, or the link is wrong.</p>
      <Link href="/operations" className="mt-6 inline-block text-[14px] font-medium text-accent hover:underline">
        Back to the daily dashboard
      </Link>
    </main>
  );
}
