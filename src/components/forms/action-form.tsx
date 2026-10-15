"use client";

import { useActionState, useEffect, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { buttonClass } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export type ActionState = { ok: boolean; message: string; fieldErrors?: Record<string, string>; ref?: string | null; at?: number } | null;
type Action = (prev: ActionState, fd: FormData) => Promise<ActionState>;

function newKey() {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Form bound to a server action. Adds a one-time submission key (duplicate
 * submit protection), disables inputs while pending, and shows the result.
 */
export function ActionForm({
  action,
  children,
  className,
  resetOnSuccess,
  hideSuccess,
  id,
  onSuccessClose,
}: {
  action: Action;
  children: ReactNode;
  className?: string;
  resetOnSuccess?: boolean;
  hideSuccess?: boolean;
  id?: string;
  onSuccessClose?: () => void;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  const [key, setKey] = useState("");
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKey(newKey());
    if (state?.ok && resetOnSuccess) formRef.current?.reset();
    if (state?.ok && onSuccessClose) onSuccessClose();
  }, [state, resetOnSuccess, onSuccessClose]);
  const errors = state?.fieldErrors ? Object.entries(state.fieldErrors) : [];
  return (
    <form ref={formRef} id={id} action={formAction} className={className} noValidate={false}>
      <input type="hidden" name="_submissionKey" value={key} />
      <fieldset disabled={pending} className="contents">
        {children}
      </fieldset>
      {state && !(state.ok && hideSuccess) ? (
        <div
          role={state.ok ? "status" : "alert"}
          aria-live="polite"
          className={cn("mt-3 rounded-md border px-3 py-2 text-[13px]", state.ok ? "border-[#c9e8d4] bg-success-soft text-success" : "border-[#f5c9c4] bg-danger-soft text-danger")}
        >
          <p className="font-medium">{state.message}</p>
          {errors.length ? (
            <ul className="mt-1 list-disc pl-5 text-ink-2">
              {errors.map(([k, v]) => (
                <li key={k}>
                  <span className="font-medium">{humanize(k)}:</span> {v}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}

function humanize(k: string) {
  return k
    .replace(/\.(\d+)\./g, (_m, n) => ` ${Number(n) + 1} `)
    .replace(/([A-Z])/g, " $1")
    .replace(/[._]/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase())
    .trim();
}

export function SubmitButton({ children, variant = "primary", size, className, name, value, confirm }: { children: ReactNode; variant?: "primary" | "secondary" | "danger" | "subtle" | "ghost"; size?: "sm" | "md"; className?: string; name?: string; value?: string; confirm?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      name={name}
      value={value}
      disabled={pending}
      aria-busy={pending}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      className={buttonClass(variant, size, className)}
    >
      {pending ? <span aria-hidden className="h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent" /> : null}
      {children}
    </button>
  );
}
