import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/utils";

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md";

export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(
    "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition-colors disabled:pointer-events-none disabled:opacity-50",
    size === "sm" ? "h-8 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm",
    variant === "primary" && "bg-accent text-white hover:bg-accent-hover",
    variant === "secondary" && "border border-line-strong bg-surface text-ink hover:bg-sunken",
    variant === "ghost" && "text-ink-2 hover:bg-sunken",
    variant === "subtle" && "bg-accent-soft text-accent-ink hover:bg-[#d6e6e2]",
    variant === "danger" && "border border-[#f1c4bf] bg-surface text-danger hover:bg-danger-soft",
    className,
  );
}

export function Button({ variant, size, className, ...props }: ComponentProps<"button"> & { variant?: Variant; size?: Size }) {
  return <button type={props.type ?? "button"} className={buttonClass(variant, size, className)} {...props} />;
}

export function LinkButton({ variant, size, className, ...props }: ComponentProps<typeof Link> & { variant?: Variant; size?: Size }) {
  return <Link className={buttonClass(variant, size, className)} {...props} />;
}

/* ------------------------------------------------------------------ */
/* Badges                                                              */
/* ------------------------------------------------------------------ */

export type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "creative" | "advisory" | "executive";

const TONES: Record<Tone, string> = {
  neutral: "bg-sunken text-ink-2 ring-line",
  accent: "bg-accent-soft text-accent-ink ring-[#cfe0db]",
  success: "bg-success-soft text-success ring-[#c9e8d4]",
  warning: "bg-warning-soft text-warning ring-[#f3dcb5]",
  danger: "bg-danger-soft text-danger ring-[#f5c9c4]",
  info: "bg-info-soft text-info ring-[#cddcf0]",
  creative: "bg-[#f5ede8] text-creative ring-[#e8d6cb]",
  advisory: "bg-[#e6eff0] text-advisory ring-[#cfe0e2]",
  executive: "bg-[#ecedf6] text-executive ring-[#d7d8eb]",
};

export function Badge({ tone = "neutral", children, className, title }: { tone?: Tone; children: ReactNode; className?: string; title?: string }) {
  return (
    <span title={title} className={cn("inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-[11.5px] font-medium ring-1 ring-inset", TONES[tone], className)}>
      {children}
    </span>
  );
}

const STATUS_TONES: Record<string, Tone> = {
  // generic
  active: "success", approved: "success", accepted: "success", paid: "success", completed: "success", won: "success", signed: "success", connected: "success", succeeded: "success", reconciled: "success", healthy: "success", qualified: "success", converted: "accent", issued: "info", sent: "info", sent_manually: "info", matched: "info",
  draft: "neutral", backlog: "neutral", ready: "neutral", new: "neutral", planned: "neutral", not_started: "neutral", upcoming: "neutral", open: "neutral", researching: "info", nurture: "neutral", not_configured: "neutral", prospect: "neutral", onboarding: "info", partner: "accent", former: "neutral", local_only: "neutral",
  in_progress: "info", internal_review: "info", client_review: "info", in_review: "warning", pending: "warning", submitted: "warning", awaiting_approval: "warning", awaiting_client: "warning", changes_requested: "warning", partially_paid: "warning", watch: "warning", on_hold: "warning", unreconciled: "warning", snoozed: "neutral", pending_verification: "warning", running: "info", requested: "warning",
  overdue: "danger", blocked: "danger", rejected: "danger", lost: "danger", void: "neutral", cancelled: "neutral", expired: "neutral", withdrawn: "neutral", disqualified: "neutral", error: "danger", failed: "danger", at_risk: "danger", stopped: "neutral", unpaid: "neutral", critical: "danger", warning: "warning", info: "info", merged: "neutral", excluded: "neutral", resolved: "success", dismissed: "neutral", credited: "accent", reversed: "neutral",
};

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  if (!status) return <Badge>—</Badge>;
  return <Badge tone={STATUS_TONES[status] ?? "neutral"}>{label ?? status.replace(/_/g, " ")}</Badge>;
}

export function ServiceBadge({ serviceKey, name }: { serviceKey: string | null | undefined; name: string }) {
  const tone = (["creative", "advisory", "executive"].includes(serviceKey ?? "") ? serviceKey : "neutral") as Tone;
  return <Badge tone={tone}>{name}</Badge>;
}

export function PriorityBadge({ priority }: { priority: string }) {
  const tone: Tone = priority === "urgent" ? "danger" : priority === "high" ? "warning" : priority === "medium" ? "neutral" : "neutral";
  return (
    <Badge tone={tone} className={priority === "low" ? "opacity-70" : ""}>
      {priority}
    </Badge>
  );
}

/* ------------------------------------------------------------------ */
/* Layout helpers                                                      */
/* ------------------------------------------------------------------ */

export function Card({ className, children, ...props }: ComponentProps<"section">) {
  return (
    <section className={cn("rounded-[var(--radius-card)] border border-line bg-surface", className)} {...props}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, actions, className }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-[14px] font-semibold text-ink">{title}</h2>
        {description ? <p className="mt-0.5 text-[12.5px] text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function CardBody({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("px-4 py-3", className)}>{children}</div>;
}

export type Crumb = { label: string; href?: string };

export function PageHeader({ title, description, crumbs, actions, meta }: { title: ReactNode; description?: ReactNode; crumbs?: Crumb[]; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-5">
      {crumbs?.length ? (
        <nav aria-label="Breadcrumb" className="mb-1.5">
          <ol className="flex flex-wrap items-center gap-1 text-[12.5px] text-muted">
            {crumbs.map((c, i) => (
              <li key={i} className="flex items-center gap-1">
                {c.href ? (
                  <Link href={c.href} className="hover:text-ink hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page">{c.label}</span>
                )}
                {i < crumbs.length - 1 ? <span aria-hidden className="text-faint">/</span> : null}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-[22px] font-semibold tracking-tight text-ink">{title}</h1>
          {description ? <p className="mt-1 max-w-3xl text-[13.5px] text-muted">{description}</p> : null}
          {meta ? <div className="mt-2 flex flex-wrap items-center gap-2">{meta}</div> : null}
        </div>
        {actions ? <div className="no-print flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function EmptyState({ title, description, action, className }: { title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center px-6 py-10 text-center", className)}>
      <div aria-hidden className="mb-3 h-9 w-9 rounded-full border border-dashed border-line-strong" />
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {description ? <p className="mt-1 max-w-md text-[13px] text-muted">{description}</p> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Notice({ tone = "info", title, children, className }: { tone?: "info" | "warning" | "danger" | "success"; title?: string; children?: ReactNode; className?: string }) {
  const map = { info: "border-[#cddcf0] bg-info-soft text-info", warning: "border-[#f3dcb5] bg-warning-soft text-warning", danger: "border-[#f5c9c4] bg-danger-soft text-danger", success: "border-[#c9e8d4] bg-success-soft text-success" };
  return (
    <div role={tone === "danger" ? "alert" : "status"} className={cn("rounded-md border px-3 py-2 text-[13px]", map[tone], className)}>
      {title ? <p className="font-semibold">{title}</p> : null}
      {children ? <div className={cn(title && "mt-0.5", "text-ink-2")}>{children}</div> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Tables                                                              */
/* ------------------------------------------------------------------ */

export function Table({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto", className)}>
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  );
}
export function THead({ children }: { children: ReactNode }) {
  return <thead className="border-b border-line bg-[#fafaf8] text-left text-[11.5px] font-medium uppercase tracking-wide text-muted">{children}</thead>;
}
export function TH({ children, className, align }: { children?: ReactNode; className?: string; align?: "right" | "left" | "center" }) {
  return <th scope="col" className={cn("whitespace-nowrap px-3 py-2 font-medium", align === "right" && "text-right", align === "center" && "text-center", className)}>{children}</th>;
}
export function TR({ children, className }: { children: ReactNode; className?: string }) {
  return <tr className={cn("border-b border-line last:border-0 hover:bg-[#fafaf8]", className)}>{children}</tr>;
}
export function TD({ children, className, align, colSpan }: { children?: ReactNode; className?: string; align?: "right" | "left" | "center"; colSpan?: number }) {
  return <td colSpan={colSpan} className={cn("px-3 py-2 align-top text-ink-2", align === "right" && "num text-right", align === "center" && "text-center", className)}>{children}</td>;
}

export function DefinitionList({ items, columns = 2 }: { items: { label: string; value: ReactNode; full?: boolean }[]; columns?: 1 | 2 | 3 }) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-3", columns === 3 ? "sm:grid-cols-3" : columns === 2 ? "sm:grid-cols-2" : "grid-cols-1")}>
      {items.map((it, i) => (
        <div key={i} className={cn("min-w-0", it.full && "sm:col-span-full")}>
          <dt className="text-[11.5px] font-medium uppercase tracking-wide text-faint">{it.label}</dt>
          <dd className="mt-0.5 break-words text-[13.5px] text-ink">{it.value ?? <span className="text-faint">—</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Avatar({ name, size = 24 }: { name: string | null | undefined; size?: number }) {
  const initials = (name ?? "?").split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
  return (
    <span aria-hidden style={{ width: size, height: size, fontSize: size * 0.42 }} className="inline-flex shrink-0 items-center justify-center rounded-full bg-accent-soft font-semibold text-accent-ink">
      {initials || "?"}
    </span>
  );
}

export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return <h3 className={cn("mb-2 text-[12px] font-semibold uppercase tracking-wide text-muted", className)}>{children}</h3>;
}

export function Muted({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("text-muted", className)}>{children}</span>;
}
