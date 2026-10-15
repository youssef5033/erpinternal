"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import type { NavSection } from "./nav";

export function Sidebar({ sections, agencyName, demo }: { sections: NavSection[]; agencyName: string; demo: boolean }) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setOpen(false), [pathname]);
  const isActive = (href: string) => (href === "/operations" || href === "/crm" || href === "/delivery" || href === "/people" ? pathname === href : pathname === href || pathname.startsWith(href + "/"));
  const nav = (
    <nav aria-label="Primary" className="flex-1 overflow-y-auto px-2 pb-6">
      {sections.map((s) => (
        <div key={s.key} className="mt-4">
          <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-[#9aa49f]">{s.label}</p>
          <ul>
            {s.items.map((it) => {
              const active = isActive(it.href);
              return (
                <li key={it.href}>
                  <Link
                    href={it.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "flex items-center rounded-md px-2 py-1.5 text-[13px]",
                      active ? "bg-white/10 font-medium text-white" : "text-[#c9d1cd] hover:bg-white/5 hover:text-white",
                    )}
                  >
                    {it.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
  return (
    <>
      <button
        type="button"
        className="no-print fixed left-3 top-2.5 z-40 rounded-md border border-line bg-surface px-2 py-1 text-[13px] lg:hidden"
        aria-expanded={open}
        aria-controls="sidebar"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "Close" : "Menu"}
      </button>
      {open ? <div className="fixed inset-0 z-30 bg-black/30 lg:hidden" onClick={() => setOpen(false)} aria-hidden /> : null}
      <aside
        id="sidebar"
        className={cn(
          "no-print fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-[#18231f] transition-transform lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="flex h-12 items-center gap-2 border-b border-white/10 px-4">
          <span aria-hidden className="h-6 w-6 rounded bg-[#2f6b62]" />
          <Link href="/operations" className="truncate text-[14px] font-semibold text-white">
            {agencyName}
          </Link>
          {demo ? <span className="ml-auto rounded bg-[#a15c07] px-1.5 text-[10px] font-semibold uppercase text-white">Demo</span> : null}
        </div>
        {nav}
      </aside>
    </>
  );
}
