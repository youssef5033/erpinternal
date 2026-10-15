import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { CURRENCIES, Field, FormGrid, Input, Select } from "@/components/forms/fields";
import { manualJournalAction } from "@/server/actions/finance";

type Opt = { value: string; label: string };

/** Balanced manual journal. The database rejects unbalanced entries; the server also validates. */
export function JournalForm({ ledgers, today, base, kind = "manual" }: { ledgers: Opt[]; today: string; base: string; kind?: "manual" | "opening_balance" }) {
  return (
    <ActionForm action={manualJournalAction}>
      <input type="hidden" name="kind" value={kind} />
      <FormGrid cols={3}>
        <Field label="Entry date" required><Input type="date" name="entryDate" defaultValue={today} required /></Field>
        <Field label="Currency"><Select name="currency" options={CURRENCIES} defaultValue={base} /></Field>
        <Field label="Memo (why this entry is needed)" required><Input name="memo" required placeholder={kind === "opening_balance" ? "Opening balances at go-live" : "e.g. Accrue October freelancer cost"} /></Field>
      </FormGrid>
      <div className="mt-3 hidden grid-cols-[1fr_130px_130px_1fr] gap-2 px-1 text-[11.5px] font-medium uppercase tracking-wide text-muted md:grid"><span>Account</span><span>Debit</span><span>Credit</span><span>Line description</span></div>
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="grid gap-2 md:grid-cols-[1fr_130px_130px_1fr]">
            <Select aria-label={`Line ${i + 1} account`} name={`lines.${i}.ledgerAccountId`} options={ledgers} placeholder="—" />
            <Input aria-label={`Line ${i + 1} debit`} name={`lines.${i}.debit`} inputMode="decimal" placeholder="0.00" />
            <Input aria-label={`Line ${i + 1} credit`} name={`lines.${i}.credit`} inputMode="decimal" placeholder="0.00" />
            <Input aria-label={`Line ${i + 1} description`} name={`lines.${i}.description`} />
          </div>
        ))}
      </div>
      <p className="mt-2 text-[12px] text-muted">Debits must equal credits. Posted journals cannot be edited — correct them with a reversal. Postings into a locked period are refused.</p>
      <div className="mt-3 flex justify-end"><SubmitButton confirm="Post this journal to the ledger?">Post journal</SubmitButton></div>
    </ActionForm>
  );
}
