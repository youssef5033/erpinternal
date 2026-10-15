import { guard } from "@/server/auth/session";
import { Card, CardBody, PageHeader } from "@/components/ui/primitives";
import { TaskForm } from "@/components/people/task-form";
import { taskLookups } from "@/components/people/task-lookups";

export const metadata = { title: "New task" };

export default async function NewTaskPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const actor = await guard();
  const sp = await searchParams;
  const L = await taskLookups(actor);
  return (
    <>
      <PageHeader crumbs={[{ label: "People" }, { label: "Tasks", href: "/people/tasks" }, { label: "New" }]} title="New task" />
      <Card className="max-w-4xl"><CardBody><TaskForm {...L} defaults={{ ownerId: actor.userId, engagementId: sp.engagement, accountId: sp.account }} /></CardBody></Card>
    </>
  );
}
