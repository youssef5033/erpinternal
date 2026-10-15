"use client";

import { Button } from "@/components/ui/primitives";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <p className="text-[12px] font-semibold uppercase tracking-wider text-danger">Error</p>
      <h1 className="mt-2 text-xl font-semibold text-ink">This page could not be loaded</h1>
      <p className="mt-2 text-[14px] text-muted">
        {error.message && !error.message.includes("digest") ? error.message : "An unexpected error occurred while loading data."}
      </p>
      {error.digest ? <p className="mt-1 text-[12px] text-faint">Reference {error.digest}</p> : null}
      <Button className="mt-5" onClick={() => reset()}>
        Try again
      </Button>
    </div>
  );
}
