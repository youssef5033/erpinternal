import Link from "next/link";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { guard } from "@/server/auth/session";
import { markNotificationsReadAction } from "@/server/actions/shared";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { DateTimeText } from "@/components/ui/display";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";

export const metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const actor = await guard();
  const rows = await db.select().from(notifications).where(eq(notifications.userId, actor.userId)).orderBy(desc(notifications.createdAt)).limit(100);
  const unread = rows.filter((r) => !r.readAt).length;
  return (
    <>
      <PageHeader title="Notifications" description="In-app reminders, approvals and assignments. Nothing is emailed." actions={unread ? <ActionForm action={markNotificationsReadAction} hideSuccess><SubmitButton variant="secondary">Mark all read</SubmitButton></ActionForm> : null} />
      <Card className="max-w-3xl">
        <CardHeader title={`${unread} unread`} />
        {rows.length ? (
          <ul className="divide-y divide-line">
            {rows.map((n) => (
              <li key={n.id} className={`px-4 py-3 ${n.readAt ? "" : "bg-accent-soft/40"}`}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-[13.5px] font-medium">{n.href ? <Link className="hover:underline" href={n.href}>{n.title}</Link> : n.title}</p>
                    {n.body ? <p className="text-[12.5px] text-muted">{n.body}</p> : null}
                  </div>
                  <div className="text-right text-[12px] text-muted"><DateTimeText value={n.createdAt} />{!n.readAt ? <div><Badge tone="info">new</Badge></div> : null}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : <EmptyState title="No notifications" />}
      </Card>
    </>
  );
}
