import Link from "next/link";
import { addDays, endOfMonth, endOfWeek, format, parseISO, startOfMonth, startOfWeek } from "date-fns";
import { db } from "@/db/client";
import { guard } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { calendarItems, KIND_LABEL, type CalendarItem, type CalendarKind } from "@/server/ops/calendar";
import { crmLookups } from "@/server/crm/lookups";
import { agencyToday, getSettings } from "@/server/system/settings";
import { isISODate, toISODate } from "@/lib/dates";
import { cn, qs } from "@/lib/utils";
import { Card, EmptyState, LinkButton, PageHeader, StatusBadge } from "@/components/ui/primitives";
import { Tabs } from "@/components/ui/display";
import { FilterBar } from "@/components/ui/filter-bar";

export const metadata = { title: "Agency calendar" };

const VIEWS = ["month", "week", "day", "agenda"] as const;
type View = (typeof VIEWS)[number];

const KIND_STYLE: Record<CalendarKind, string> = {
  event: "border-l-[#2f6f5e] bg-[#eef6f2]",
  task: "border-l-[#6b6b6b] bg-[#f4f4f2]",
  deliverable: "border-l-[#8a5cf6] bg-[#f3efff]",
  milestone: "border-l-[#b7791f] bg-[#fdf6e7]",
  invoice: "border-l-[#2563eb] bg-[#eef3ff]",
  leave: "border-l-[#94a3b8] bg-[#f1f5f9]",
  renewal: "border-l-[#c2410c] bg-[#fff1e9]",
  proposal: "border-l-[#0e7490] bg-[#ecfbfd]",
};

export default async function CalendarPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard("operations.view");
  const sp = await searchParams;
  const settings = await getSettings(db);
  const today = await agencyToday(db);
  const view: View = (VIEWS as readonly string[]).includes(sp.view ?? "") ? (sp.view as View) : "month";
  const anchor = isISODate(sp.date) ? sp.date! : today;
  const a = parseISO(anchor);
  let from: string, to: string, prev: string, next: string, title: string;
  if (view === "month") {
    from = toISODate(startOfWeek(startOfMonth(a), { weekStartsOn: 1 }));
    to = toISODate(endOfWeek(endOfMonth(a), { weekStartsOn: 1 }));
    prev = toISODate(addDays(startOfMonth(a), -1));
    next = toISODate(addDays(endOfMonth(a), 1));
    title = format(a, "MMMM yyyy");
  } else if (view === "week") {
    from = toISODate(startOfWeek(a, { weekStartsOn: 1 }));
    to = toISODate(addDays(parseISO(from), 6));
    prev = toISODate(addDays(parseISO(from), -7));
    next = toISODate(addDays(parseISO(from), 7));
    title = `${format(parseISO(from), "d MMM")} – ${format(parseISO(to), "d MMM yyyy")}`;
  } else if (view === "day") {
    from = to = anchor;
    prev = toISODate(addDays(a, -1));
    next = toISODate(addDays(a, 1));
    title = format(a, "EEEE d MMMM yyyy");
  } else {
    from = anchor;
    to = toISODate(addDays(a, 29));
    prev = toISODate(addDays(a, -30));
    next = toISODate(addDays(a, 30));
    title = `Next 30 days from ${format(a, "d MMM yyyy")}`;
  }
  const kinds = sp.kind ? (sp.kind.split(",").filter((k) => k in KIND_LABEL) as CalendarKind[]) : undefined;
  const owner = sp.mine === "1" ? actor.userId : sp.owner || undefined;
  const tz = actor.timeZone ?? settings.timeZone;
  const items = await calendarItems(db, actor, from, to, { kinds, owner, timeZone: tz });
  const L = await crmLookups();
  const link = (p: Record<string, string | null | undefined>) => `/operations/calendar${qs({ ...sp, ...p })}`;
  const timeFmt = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit" });
  const canSchedule = can(actor, "crm.write") || can(actor, "delivery.write");

  const days: string[] = [];
  for (let d = parseISO(from); toISODate(d) <= to; d = addDays(d, 1)) days.push(toISODate(d));
  const onDay = (day: string) => items.filter((i) => (i.endDate ? i.date <= day && i.endDate >= day : i.date === day));

  const Chip = ({ i, compact }: { i: CalendarItem; compact?: boolean }) => (
    <Link href={i.href} className={cn("block truncate rounded-[4px] border-l-[3px] px-1.5 py-0.5 text-[11.5px] leading-tight text-ink hover:brightness-95", KIND_STYLE[i.kind], i.status === "cancelled" && "line-through opacity-60")} title={`${KIND_LABEL[i.kind]}: ${i.title}${i.subtitle ? ` — ${i.subtitle}` : ""}`}>
      {i.start ? <span className="num mr-1 text-muted">{timeFmt.format(i.start)}</span> : null}
      {i.title}
      {!compact && i.subtitle ? <span className="block truncate text-[11px] text-muted">{i.subtitle}</span> : null}
    </Link>
  );

  return (
    <>
      <PageHeader
        crumbs={[{ label: "Operations", href: "/operations" }, { label: "Agency calendar" }]}
        title="Agency calendar"
        description={`Meetings, deadlines, milestones, renewals, invoice due dates and leave in one place. Times shown in ${tz}.`}
        actions={canSchedule ? <LinkButton variant="primary" href={`/operations/calendar/events/new${qs({ date: view === "day" ? anchor : null })}`}>Schedule meeting</LinkButton> : null}
      />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <LinkButton size="sm" href={link({ date: prev })} aria-label="Previous">←</LinkButton>
          <LinkButton size="sm" href={link({ date: null })}>Today</LinkButton>
          <LinkButton size="sm" href={link({ date: next })} aria-label="Next">→</LinkButton>
          <h2 className="ml-2 text-[16px] font-semibold">{title}</h2>
        </div>
        <Tabs current={view} tabs={VIEWS.map((v) => ({ key: v, label: v[0].toUpperCase() + v.slice(1), href: link({ view: v === "month" ? null : v }) }))} />
      </div>
      <FilterBar
        keep={["view", "date"]}
        fields={[
          { type: "select", name: "kind", label: "Show", options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })), allLabel: "Everything" },
          { type: "select", name: "owner", label: "Person", options: L.users },
          { type: "select", name: "mine", label: "Mine", options: [{ value: "1", label: "Only mine" }] },
        ]}
      />
      <div className="mb-3 flex flex-wrap gap-3 text-[12px] text-muted">
        {(Object.keys(KIND_LABEL) as CalendarKind[]).map((k) => (
          <span key={k} className="flex items-center gap-1"><span className={cn("inline-block h-3 w-3 rounded-sm border-l-[3px]", KIND_STYLE[k])} />{KIND_LABEL[k]}</span>
        ))}
      </div>

      {view === "month" ? (
        <Card className="overflow-x-auto">
          <div className="grid min-w-[760px] grid-cols-7 border-b border-line text-[12px] font-medium text-muted">
            {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((d) => <div key={d} className="px-2 py-1.5">{d}</div>)}
          </div>
          <div className="grid min-w-[760px] grid-cols-7">
            {days.map((day) => {
              const list = onDay(day);
              const inMonth = day.slice(0, 7) === anchor.slice(0, 7);
              return (
                <div key={day} className={cn("min-h-[112px] border-b border-r border-line p-1.5", !inMonth && "bg-sunken/50")}>
                  <Link href={link({ view: "day", date: day })} className={cn("mb-1 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-[12px]", day === today ? "bg-accent font-semibold text-white" : inMonth ? "text-ink" : "text-faint")}>{Number(day.slice(8))}</Link>
                  <div className="space-y-0.5">
                    {list.slice(0, 4).map((i) => <Chip key={`${i.kind}-${i.id}`} i={i} compact />)}
                    {list.length > 4 ? <Link href={link({ view: "day", date: day })} className="block px-1 text-[11.5px] text-accent">+{list.length - 4} more</Link> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ) : null}

      {view === "week" ? (
        <Card className="overflow-x-auto">
          <div className="grid min-w-[900px] grid-cols-7">
            {days.map((day) => (
              <div key={day} className="min-h-[360px] border-r border-line p-2">
                <Link href={link({ view: "day", date: day })} className={cn("mb-2 block text-[12.5px] font-medium", day === today ? "text-accent" : "text-ink-2")}>{format(parseISO(day), "EEE d MMM")}</Link>
                <div className="space-y-1">{onDay(day).map((i) => <Chip key={`${i.kind}-${i.id}`} i={i} />)}</div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {view === "day" || view === "agenda" ? (
        <Card>
          {items.length ? (
            <ul className="divide-y divide-line">
              {days.filter((d) => onDay(d).length).map((day) => (
                <li key={day} className="px-4 py-3">
                  <p className={cn("mb-2 text-[12.5px] font-semibold", day === today ? "text-accent" : "text-ink-2")}>{format(parseISO(day), "EEEE d MMMM")}</p>
                  <ul className="space-y-1.5">
                    {onDay(day).map((i) => (
                      <li key={`${i.kind}-${i.id}`} className={cn("flex items-start gap-3 rounded-md border-l-[3px] px-3 py-2", KIND_STYLE[i.kind])}>
                        <span className="num w-[92px] shrink-0 text-[12.5px] text-muted">{i.start && i.end ? `${timeFmt.format(i.start)}–${timeFmt.format(i.end)}` : i.endDate ? `${i.date.slice(5)}→${i.endDate.slice(5)}` : "All day"}</span>
                        <span className="min-w-0 flex-1">
                          <Link href={i.href} className={cn("font-medium hover:underline", i.status === "cancelled" && "line-through")}>{i.title}</Link>
                          <span className="block text-[12px] text-muted">{KIND_LABEL[i.kind]}{i.subtitle ? ` · ${i.subtitle}` : ""}</span>
                        </span>
                        {i.status && i.kind !== "leave" ? <StatusBadge status={i.status} /> : null}
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Nothing scheduled" description="Meetings, deadlines and leave you can see will appear here." />}
        </Card>
      ) : null}
    </>
  );
}
