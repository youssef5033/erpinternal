import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { channels, contactRoleDefinitions, lookupValues, offers, organizationSettings, pipelines, pipelineStages, services } from "@/db/schema";
import { todayISO } from "@/lib/dates";

export type Settings = typeof organizationSettings.$inferSelect;

export async function getSettings(tx: Tx): Promise<Settings> {
  const [row] = await tx.select().from(organizationSettings).where(eq(organizationSettings.id, 1)).limit(1);
  if (row) return row;
  const [created] = await tx.insert(organizationSettings).values({ id: 1 }).onConflictDoNothing().returning();
  return created ?? (await tx.select().from(organizationSettings).where(eq(organizationSettings.id, 1)))[0];
}

/** "Today" in the agency time zone (all due/overdue logic uses this). */
export async function agencyToday(tx: Tx): Promise<string> {
  const s = await getSettings(tx);
  return todayISO(s.timeZone);
}

export async function listServices(tx: Tx, includeInactive = false) {
  const rows = await tx.select().from(services).orderBy(asc(services.sortOrder));
  return includeInactive ? rows : rows.filter((r) => r.active);
}

export async function listOffers(tx: Tx) {
  return tx.select().from(offers).orderBy(asc(offers.name));
}

export async function listChannels(tx: Tx) {
  return tx.select().from(channels).orderBy(asc(channels.sortOrder));
}

export async function listContactRoles(tx: Tx) {
  return tx.select().from(contactRoleDefinitions).orderBy(asc(contactRoleDefinitions.sortOrder));
}

export async function listLookup(tx: Tx, listKey: string) {
  const rows = await tx.select().from(lookupValues).where(eq(lookupValues.listKey, listKey)).orderBy(asc(lookupValues.sortOrder));
  return rows.filter((r) => r.active).map((r) => r.value);
}

export async function getDefaultPipeline(tx: Tx) {
  const [p] = await tx.select().from(pipelines).where(eq(pipelines.isDefault, true)).limit(1);
  const pipeline = p ?? (await tx.select().from(pipelines).limit(1))[0];
  if (!pipeline) throw new Error("No pipeline configured. Run the setup seed.");
  const stages = await tx.select().from(pipelineStages).where(eq(pipelineStages.pipelineId, pipeline.id)).orderBy(asc(pipelineStages.sortOrder));
  return { pipeline, stages };
}

export async function listPipelinesWithStages(tx: Tx) {
  const ps = await tx.select().from(pipelines).orderBy(asc(pipelines.name));
  const st = await tx.select().from(pipelineStages).orderBy(asc(pipelineStages.sortOrder));
  return ps.map((p) => ({ ...p, stages: st.filter((s) => s.pipelineId === p.id) }));
}
