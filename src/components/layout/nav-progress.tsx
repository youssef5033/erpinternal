"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

/** Fire before a programmatic `router.push/replace` so the progress bar shows for it too. */
export function signalNavigation() {
  window.dispatchEvent(new Event("app:navigate"));
}

/**
 * Immediate feedback for every in-app navigation. Tabs, filters and calendar
 * buttons only change the URL's query, which keeps the current page on screen
 * while the server renders the next one; on a slow host that looked like a
 * dead click. While a navigation is pending this shows a bar at the top and
 * dims the main content; both clear as soon as the new URL renders.
 */
export function NavProgress() {
  const pathname = usePathname();
  const params = useSearchParams();
  const [active, setActive] = useState(false);
  const current = `${pathname}?${params.toString()}`;

  useEffect(() => {
    // The URL changed: the new page has rendered.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActive(false);
  }, [current]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Capture phase: runs before next/link's own handler (which prevents the default).
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element | null)?.closest?.("a");
      if (!a || !a.href || a.hasAttribute("download") || (a.target && a.target !== "_self")) return;
      const url = new URL(a.href, window.location.href);
      if (url.origin !== window.location.origin || url.pathname.startsWith("/api/")) return;
      if (url.pathname === window.location.pathname && url.search === window.location.search) return;
      setActive(true);
    };
    const onProgrammatic = () => setActive(true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("app:navigate", onProgrammatic);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("app:navigate", onProgrammatic);
    };
  }, []);

  useEffect(() => {
    document.documentElement.toggleAttribute("data-navigating", active);
    if (!active) return;
    // Never leave the indicator stuck (e.g. a navigation that was cancelled).
    const t = window.setTimeout(() => setActive(false), 20000);
    return () => window.clearTimeout(t);
  }, [active]);

  if (!active) return null;
  return (
    <div role="progressbar" aria-label="Loading" className="no-print fixed inset-x-0 top-0 z-[60] h-[3px] overflow-hidden bg-accent/15">
      <div className="nav-progress-bar h-full w-1/3 bg-accent" />
    </div>
  );
}
