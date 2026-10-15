import { redirect } from "next/navigation";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Field, Input } from "@/components/forms/fields";
import { getActor } from "@/server/auth/session";
import { signIn } from "./actions";

export const metadata = { title: "Sign in" };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  if (await getActor()) redirect("/operations");
  const { next } = await searchParams;
  const demo = process.env.APP_ENV === "demo";
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-canvas px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <span aria-hidden className="h-7 w-7 rounded bg-accent" />
          <span className="text-[15px] font-semibold text-ink">Agency ERP</span>
        </div>
        <div className="rounded-xl border border-line bg-surface p-6">
          <h1 className="text-lg font-semibold text-ink">Sign in</h1>
          <p className="mt-1 text-[13px] text-muted">Internal access only. Accounts are created by an administrator.</p>
          <ActionForm action={signIn} className="mt-5 space-y-3">
            <input type="hidden" name="next" value={next ?? "/operations"} />
            <Field label="Email" htmlFor="email">
              <Input id="email" name="email" type="email" autoComplete="username" required autoFocus />
            </Field>
            <Field label="Password" htmlFor="password">
              <Input id="password" name="password" type="password" autoComplete="current-password" required />
            </Field>
            <SubmitButton className="w-full">Sign in</SubmitButton>
          </ActionForm>
        </div>
        {demo ? (
          <div className="mt-4 rounded-lg border border-[#f3dcb5] bg-warning-soft p-3 text-[12.5px] text-ink-2">
            <p className="font-semibold text-warning">Demo environment</p>
            <p className="mt-1">
              Sign in as <code>owner@demo.agency</code> (or sales@, finance@, pm@, ops@, designer@, contractor@, viewer@ <code>demo.agency</code>) with the demo password from <code>DEMO_PASSWORD</code> in your environment.
            </p>
          </div>
        ) : null}
      </div>
    </main>
  );
}
