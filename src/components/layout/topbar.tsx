"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { DropdownMenu } from "radix-ui";
import { buttonClass } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

export type QuickAction = { label: string; href: string };

const menuContent = "z-50 min-w-[200px] rounded-md border border-line bg-surface p-1 text-[13px] shadow-lg";
const menuItem = "flex cursor-pointer select-none items-center rounded px-2 py-1.5 text-ink-2 outline-none data-[highlighted]:bg-sunken data-[highlighted]:text-ink";

export function Topbar({ quickActions, userName, userEmail, roleNames, unread, signOut }: { quickActions: QuickAction[]; userName: string; userEmail: string; roleNames: string[]; unread: number; signOut: () => Promise<void> }) {
  const router = useRouter();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName) && !t.isContentEditable) {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <header className="no-print sticky top-0 z-20 flex h-12 items-center gap-2 border-b border-line bg-surface/95 px-3 pl-20 backdrop-blur lg:pl-4">
      <form
        role="search"
        className="flex min-w-0 flex-1 items-center"
        onSubmit={(e) => {
          e.preventDefault();
          const q = searchRef.current?.value.trim();
          if (q) router.push(`/search?q=${encodeURIComponent(q)}`);
        }}
      >
        <label htmlFor="global-search" className="sr-only">
          Search everything
        </label>
        <input
          ref={searchRef}
          id="global-search"
          type="search"
          placeholder="Search accounts, contacts, leads, deals, invoices…   ( / )"
          className="h-8 w-full max-w-xl rounded-md border border-line bg-canvas px-3 text-[13px] placeholder:text-faint focus:border-accent focus:bg-surface focus:outline-none"
        />
      </form>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={buttonClass("primary", "sm")} aria-label="Create new">
          + New
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
            {quickActions.map((a) => (
              <DropdownMenu.Item key={a.href} className={menuItem} onSelect={() => router.push(a.href)}>
                {a.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <Link href="/notifications" className={cn(buttonClass("ghost", "sm"), "relative")} aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}>
        Inbox
        {unread ? <span className="num ml-1 rounded bg-danger px-1 text-[10.5px] font-semibold text-white">{unread}</span> : null}
      </Link>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className={cn(buttonClass("ghost", "sm"), "max-w-[180px]")} aria-label="Account menu">
          <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-accent-soft text-[11px] font-semibold text-accent-ink">
            {userName
              .split(/\s+/)
              .slice(0, 2)
              .map((p) => p[0]?.toUpperCase())
              .join("")}
          </span>
          <span className="hidden truncate sm:inline">{userName}</span>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={6} className={menuContent}>
            <div className="px-2 py-1.5">
              <p className="font-medium text-ink">{userName}</p>
              <p className="text-[12px] text-muted">{userEmail}</p>
              <p className="mt-1 text-[11.5px] text-faint">{roleNames.join(", ") || "No role"}</p>
            </div>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item className={menuItem} onSelect={() => router.push("/account")}>
              My profile & time zone
            </DropdownMenu.Item>
            <DropdownMenu.Item className={menuItem} onSelect={() => void signOut().then(() => router.push("/login"))}>
              Sign out
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </header>
  );
}
