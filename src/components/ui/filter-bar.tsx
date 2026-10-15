"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useRef, useTransition } from "react";
import { cn } from "@/lib/utils";

export type FilterField =
  | { type: "search"; name: string; placeholder?: string; label: string }
  | { type: "select"; name: string; label: string; options: { value: string; label: string }[]; allLabel?: string }
  | { type: "date"; name: string; label: string };

/**
 * GET-based filter bar: state lives in the URL (shareable, back-button safe),
 * auto-applies on change, works without JS via the Apply button.
 */
export function FilterBar({ fields, keep = [], className }: { fields: FilterField[]; keep?: string[]; className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const [pending, start] = useTransition();
  const apply = () => {
    const fd = new FormData(formRef.current!);
    const sp = new URLSearchParams();
    for (const k of keep) {
      const v = params.get(k);
      if (v) sp.set(k, v);
    }
    for (const [k, v] of fd.entries()) if (typeof v === "string" && v !== "") sp.set(k, v);
    start(() => router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`));
  };
  const hasFilters = fields.some((f) => params.get(f.name));
  return (
    <form
      key={params.toString()}
      ref={formRef}
      role="search"
      aria-label="Filters"
      className={cn("mb-3 flex flex-wrap items-end gap-2", className)}
      onSubmit={(e) => {
        e.preventDefault();
        apply();
      }}
    >
      {fields.map((f) => (
        <label key={f.name} className={cn("flex flex-col gap-0.5 text-[11.5px] font-medium text-muted", f.type === "search" && "min-w-[200px] flex-1")}>
          {f.label}
          {f.type === "search" ? (
            <input name={f.name} type="search" defaultValue={params.get(f.name) ?? ""} placeholder={f.placeholder} className="h-8 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] font-normal text-ink focus:border-accent focus:outline-none" />
          ) : f.type === "date" ? (
            <input name={f.name} type="date" defaultValue={params.get(f.name) ?? ""} onChange={apply} className="h-8 rounded-md border border-line-strong bg-surface px-2 text-[13px] font-normal text-ink" />
          ) : (
            <select name={f.name} defaultValue={params.get(f.name) ?? ""} onChange={apply} className="h-8 max-w-[220px] rounded-md border border-line-strong bg-surface px-2 text-[13px] font-normal text-ink">
              <option value="">{f.allLabel ?? "All"}</option>
              {f.options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          )}
        </label>
      ))}
      <button type="submit" className="h-8 rounded-md border border-line-strong bg-surface px-3 text-[13px] text-ink hover:bg-sunken">
        {pending ? "Applying…" : "Apply"}
      </button>
      {hasFilters ? (
        <button
          type="button"
          className="h-8 px-2 text-[12.5px] text-muted hover:text-ink"
          onClick={() => {
            const sp = new URLSearchParams();
            for (const k of keep) {
              const v = params.get(k);
              if (v) sp.set(k, v);
            }
            formRef.current?.reset();
            start(() => router.replace(`${pathname}${sp.toString() ? `?${sp}` : ""}`));
          }}
        >
          Clear
        </button>
      ) : null}
    </form>
  );
}
