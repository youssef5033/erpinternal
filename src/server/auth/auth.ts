import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { account, session, user, verification } from "@/db/schema";

/**
 * Better Auth: email + password, database sessions, no self sign-up (users are
 * created by administrators in Users & Permissions). Disabled users cannot
 * create sessions.
 */
export const auth = betterAuth({
  appName: "Agency ERP",
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  database: drizzleAdapter(db, {
    provider: "pg",
    schema: { user, session, account, verification },
  }),
  emailAndPassword: {
    enabled: true,
    disableSignUp: true,
    minPasswordLength: 10,
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: { enabled: process.env.NODE_ENV === "production", window: 60, max: 30 },
  advanced: {
    database: { generateId: () => crypto.randomUUID() },
    useSecureCookies: process.env.BETTER_AUTH_URL?.startsWith("https://") ?? false,
  },
  databaseHooks: {
    session: {
      create: {
        before: async (s) => {
          const [u] = await db.select({ status: user.status }).from(user).where(eq(user.id, s.userId)).limit(1);
          if (!u || u.status !== "active") return false;
          return { data: s };
        },
      },
    },
  },
  plugins: [nextCookies()],
});
