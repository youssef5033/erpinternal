export default function Loading() {
  return (
    <div aria-busy="true" aria-live="polite" className="animate-pulse">
      <span className="sr-only">Loading…</span>
      <div className="mb-2 h-3 w-40 rounded bg-sunken" />
      <div className="mb-6 h-6 w-72 rounded bg-sunken" />
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="h-24 rounded-lg bg-sunken" />
        <div className="h-24 rounded-lg bg-sunken" />
        <div className="h-24 rounded-lg bg-sunken" />
      </div>
      <div className="mt-4 h-64 rounded-lg bg-sunken" />
    </div>
  );
}
