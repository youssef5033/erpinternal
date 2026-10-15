import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { campaigns, channels, contactRoleDefinitions, customFieldDefinitions, offers, services, user } from "@/db/schema";
import { listLookup } from "../system/settings";

/** Option lists shared by CRM forms and filters. */
export async function crmLookups() {
  const [u, ch, sv, cp, ind, sz, cf, roles, of] = await Promise.all([
    db.select({ id: user.id, name: user.name }).from(user).where(eq(user.status, "active")).orderBy(user.name),
    db.select().from(channels).orderBy(asc(channels.sortOrder)),
    db.select().from(services).orderBy(asc(services.sortOrder)),
    db.select({ id: campaigns.id, name: campaigns.name }).from(campaigns).orderBy(campaigns.name),
    listLookup(db, "industry"),
    listLookup(db, "size_band"),
    db.select().from(customFieldDefinitions).where(eq(customFieldDefinitions.active, true)).orderBy(asc(customFieldDefinitions.sortOrder)),
    db.select().from(contactRoleDefinitions).orderBy(asc(contactRoleDefinitions.sortOrder)),
    db.select().from(offers).where(eq(offers.active, true)).orderBy(offers.name),
  ]);
  return {
    users: u.map((x) => ({ value: x.id, label: x.name })),
    usersRaw: u,
    channels: ch.filter((c) => c.active).map((c) => ({ value: c.key, label: c.label })),
    channelLabel: (k: string | null) => ch.find((c) => c.key === k)?.label ?? (k ? k : "Unknown"),
    services: sv.filter((s) => s.active).map((s) => ({ value: s.id, label: s.name })),
    servicesRaw: sv,
    campaigns: cp.map((c) => ({ value: c.id, label: c.name })),
    industries: ind,
    sizeBands: sz,
    customFields: cf,
    contactRoles: roles.map((r) => ({ value: r.key, label: r.label })),
    offers: of,
    lostReasons: await listLookup(db, "lost_reason"),
  };
}
