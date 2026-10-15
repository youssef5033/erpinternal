import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { departments, people, user } from "@/db/schema";

export async function personFormLookups() {
  const [d, m, u] = await Promise.all([
    db.select({ value: departments.id, label: departments.name }).from(departments).orderBy(asc(departments.name)),
    db.select({ value: people.id, label: people.fullName }).from(people).where(eq(people.type, "employee")).orderBy(asc(people.fullName)),
    db.select({ value: user.id, label: user.name }).from(user).orderBy(asc(user.name)),
  ]);
  return { departments: d, managers: m, users: u };
}
