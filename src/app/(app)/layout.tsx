import { and, eq, isNull, sql } from "drizzle-orm";
import { Suspense } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { Sidebar } from "@/components/layout/sidebar";
import { Topbar, type QuickAction } from "@/components/layout/topbar";
import { NavProgress } from "@/components/layout/nav-progress";
import { NAV } from "@/components/layout/nav";
import { requireActor } from "@/server/auth/session";
import { can } from "@/server/auth/actor";
import { auth } from "@/server/auth/auth";
import { getSettings } from "@/server/system/settings";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  const settings = await getSettings(db);
  const sections = NAV.filter((s) => !s.perm || s.perm.some((p) => can(actor, p)))
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || i.perm.some((p) => can(actor, p))) }))
    .filter((s) => s.items.length);
  const quick: (QuickAction & { ok: boolean })[] = [
    { label: "Lead", href: "/crm/leads/new", ok: can(actor, "crm.write") },
    { label: "Account", href: "/crm/accounts/new", ok: can(actor, "crm.write") },
    { label: "Contact", href: "/crm/contacts/new", ok: can(actor, "crm.write") },
    { label: "Opportunity", href: "/crm/opportunities/new", ok: can(actor, "crm.write") },
    { label: "Engagement", href: "/delivery/engagements/new", ok: can(actor, "delivery.write") },
    { label: "Task", href: "/people/tasks/new", ok: can(actor, "delivery.write") || can(actor, "crm.write") || can(actor, "finance.write") },
    { label: "Appointment", href: "/operations/calendar/events/new", ok: can(actor, "crm.write") || can(actor, "delivery.write") },
    { label: "Invoice", href: "/finance/invoices/new", ok: can(actor, "finance.write") },
    { label: "Expense", href: "/finance/bills?tab=submit", ok: can(actor, "expenses.submit") || can(actor, "finance.write") },
    { label: "Payment received", href: "/finance/collections?tab=record", ok: can(actor, "finance.write") },
    { label: "Time entry", href: "/people/timesheets?new=1", ok: can(actor, "time.write") },
  ];
  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(notifications).where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)));
  const demo = process.env.APP_ENV === "demo";

  async function signOut() {
    "use server";
    await auth.api.signOut({ headers: await headers() });
    redirect("/login");
  }

  return (
    <div className="min-h-screen">
      <Suspense fallback={null}>
        <NavProgress />
      </Suspense>
      <Sidebar sections={sections} agencyName={settings.agencyName} demo={demo} />
      <div className="lg:pl-60">
        {demo ? (
          <div role="note" className="no-print border-b border-[#f3dcb5] bg-warning-soft px-4 py-1.5 text-center text-[12.5px] text-warning">
            Demo environment — all companies, people and figures are fictional and stored in a separate demo database. Nothing is sent externally.
          </div>
        ) : null}
        <Topbar quickActions={quick.filter((q) => q.ok).map(({ label, href }) => ({ label, href }))} userName={actor.name} userEmail={actor.email} roleNames={actor.roleNames} unread={Number(n)} signOut={signOut} />
        <main id="main" className="mx-auto w-full max-w-[1400px] px-4 py-5 sm:px-6">
          {children}
        </main>
      </div>
    </div>
  );
}
