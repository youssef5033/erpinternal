import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

export const inputClass =
  "block w-full rounded-md border border-line-strong bg-surface px-2.5 py-1.5 text-[13.5px] text-ink placeholder:text-faint focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 disabled:bg-sunken disabled:text-muted aria-[invalid=true]:border-danger";

export function Field({ label, htmlFor, hint, error, required, children, className }: { label: string; htmlFor?: string; hint?: ReactNode; error?: string; required?: boolean; children: ReactNode; className?: string }) {
  return (
    <div className={cn("min-w-0", className)}>
      <label htmlFor={htmlFor} className="mb-1 block text-[12.5px] font-medium text-ink-2">
        {label}
        {required ? <span className="text-danger"> *</span> : null}
      </label>
      {children}
      {error ? (
        <p className="mt-1 text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-[12px] text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={cn(inputClass, className)} {...props} />;
}

export function Textarea({ className, rows = 3, ...props }: ComponentProps<"textarea">) {
  return <textarea rows={rows} className={cn(inputClass, "resize-y", className)} {...props} />;
}

export function Select({ className, options, placeholder, ...props }: ComponentProps<"select"> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select className={cn(inputClass, "pr-8", className)} {...props}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Checkbox({ label, className, ...props }: ComponentProps<"input"> & { label: ReactNode }) {
  return (
    <label className={cn("inline-flex items-center gap-2 text-[13px] text-ink-2", className)}>
      <input type="checkbox" className="h-4 w-4 rounded border-line-strong accent-[var(--color-accent)]" {...props} />
      {label}
    </label>
  );
}

export function FormGrid({ children, cols = 2, className }: { children: ReactNode; cols?: 1 | 2 | 3 | 4; className?: string }) {
  return <div className={cn("grid gap-3", cols === 2 && "sm:grid-cols-2", cols === 3 && "sm:grid-cols-3", cols === 4 && "sm:grid-cols-2 lg:grid-cols-4", className)}>{children}</div>;
}

export const CURRENCIES = ["USD", "EUR", "GBP", "AED", "SAR", "QAR", "CAD", "AUD", "CHF", "SGD", "EGP", "JOD", "KWD", "BHD", "OMR", "ZAR", "INR"].map((c) => ({ value: c, label: c }));

export function opt<T extends string>(values: readonly T[], label?: (v: T) => string) {
  return values.map((v) => ({ value: v, label: label ? label(v) : v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()) }));
}
