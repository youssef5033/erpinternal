import type { Goal } from "@/server/ops/goals";
import { addGoalAction, carryOverGoalsAction, goalStatusAction } from "@/server/actions/goals";
import { ActionForm, SubmitButton } from "@/components/forms/action-form";
import { Badge, Card, CardHeader } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/**
 * A list of personal goals for one day or one week: tick off, step progress
 * towards a numeric target, remove, add, and carry over what was left
 * unfinished in the previous period.
 */
export function GoalsCard({
  title,
  description,
  period,
  date,
  goals,
  openBefore = 0,
  readOnly = false,
  emptyText,
  className,
}: {
  title: string;
  description?: string;
  period: "day" | "week";
  date: string;
  goals: Goal[];
  openBefore?: number;
  readOnly?: boolean;
  emptyText?: string;
  className?: string;
}) {
  const live = goals.filter((g) => g.status !== "carried");
  const done = live.filter((g) => g.status === "done").length;
  const prevLabel = period === "day" ? "yesterday" : "last week";
  return (
    <Card className={className}>
      <CardHeader
        title={title}
        description={description}
        actions={live.length ? <Badge tone={done === live.length ? "success" : "neutral"}>{done}/{live.length} done</Badge> : null}
      />
      {goals.length ? (
        <ul className="divide-y divide-line">
          {goals.map((g) => (
            <GoalRow key={g.id} g={g} readOnly={readOnly} />
          ))}
        </ul>
      ) : (
        <p className="px-4 py-3 text-[12.5px] text-muted">{readOnly ? "No goals were set." : emptyText ? emptyText : period === "day" ? "No goals for today yet. What would make today a success?" : "No goals for this week yet. What should this week achieve?"}</p>
      )}
      {!readOnly ? (
        <div className="space-y-2 border-t border-line px-4 py-3">
          <ActionForm action={addGoalAction} resetOnSuccess hideSuccess className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="period" value={period} />
            <input type="hidden" name="date" value={date} />
            <label className="sr-only" htmlFor={`goal-title-${period}-${date}`}>
              New {period === "day" ? "daily" : "weekly"} goal
            </label>
            <input
              id={`goal-title-${period}-${date}`}
              name="title"
              required
              maxLength={200}
              placeholder={period === "day" ? "Add a goal for today…" : "Add a goal for this week…"}
              className="h-8 min-w-0 flex-1 rounded-md border border-line-strong bg-surface px-2.5 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            />
            <label className="sr-only" htmlFor={`goal-target-${period}-${date}`}>
              Numeric target (optional)
            </label>
            <input
              id={`goal-target-${period}-${date}`}
              name="target"
              type="number"
              min={1}
              max={100000}
              step={1}
              placeholder="Target #"
              title="Optional: a number to reach, e.g. 5 calls"
              className="h-8 w-[88px] rounded-md border border-line-strong bg-surface px-2 text-[13px] text-ink placeholder:text-faint focus:border-accent focus:outline-none"
            />
            <SubmitButton size="sm">Add</SubmitButton>
          </ActionForm>
          {openBefore > 0 ? (
            <ActionForm action={carryOverGoalsAction}>
              <input type="hidden" name="period" value={period} />
              <input type="hidden" name="date" value={date} />
              <SubmitButton size="sm" variant="ghost" className="px-0 text-accent">
                Carry over {openBefore} unfinished goal{openBefore === 1 ? "" : "s"} from {prevLabel}
              </SubmitButton>
            </ActionForm>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function GoalRow({ g, readOnly }: { g: Goal; readOnly: boolean }) {
  const isDone = g.status === "done";
  const carried = g.status === "carried";
  return (
    <li className="flex items-center gap-2 px-4 py-2">
      {readOnly || carried ? (
        <span aria-hidden className={cn("flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded border", isDone ? "border-accent bg-accent text-white" : "border-line-strong")}>
          {isDone ? <Check /> : null}
        </span>
      ) : (
        <ActionForm action={goalStatusAction} hideSuccess className="contents">
          <input type="hidden" name="id" value={g.id} />
          <input type="hidden" name="op" value={isDone ? "reopen" : "done"} />
          <SubmitButton
            size="sm"
            variant="ghost"
            className={cn("h-[18px] w-[18px] shrink-0 justify-center rounded border p-0", isDone ? "border-accent bg-accent text-white hover:bg-accent" : "border-line-strong bg-surface")}
          >
            {isDone ? <Check /> : null}
            <span className="sr-only">{isDone ? `Mark "${g.title}" as not done` : `Mark "${g.title}" as done`}</span>
          </SubmitButton>
        </ActionForm>
      )}
      <span className={cn("min-w-0 flex-1 text-[13px]", isDone ? "text-muted line-through" : carried ? "text-faint" : "text-ink")}>
        {g.title}
        {carried ? <span className="ml-1.5 text-[11.5px] no-underline">(carried forward)</span> : null}
        {g.carriedFromId && !carried ? <span className="ml-1.5 text-[11.5px] text-faint">carried over</span> : null}
      </span>
      {g.target ? (
        <span className="flex shrink-0 items-center gap-1">
          {!readOnly && !carried ? <StepButton id={g.id} op="minus" label={`Decrease progress of "${g.title}"`} disabled={g.progress <= 0} /> : null}
          <span className="num min-w-[44px] text-center text-[12.5px] text-ink-2">
            {g.progress}/{g.target}
          </span>
          {!readOnly && !carried ? <StepButton id={g.id} op="plus" label={`Increase progress of "${g.title}"`} disabled={g.progress >= g.target} /> : null}
        </span>
      ) : null}
      {!readOnly && !carried ? (
        <ActionForm action={goalStatusAction} hideSuccess className="contents">
          <input type="hidden" name="id" value={g.id} />
          <input type="hidden" name="op" value="delete" />
          <SubmitButton size="sm" variant="ghost" className="h-6 shrink-0 px-1.5 text-faint hover:text-danger" confirm={`Remove the goal "${g.title}"?`}>
            <span aria-hidden>×</span>
            <span className="sr-only">{`Remove "${g.title}"`}</span>
          </SubmitButton>
        </ActionForm>
      ) : null}
    </li>
  );
}

function StepButton({ id, op, label, disabled }: { id: string; op: "plus" | "minus"; label: string; disabled: boolean }) {
  if (disabled) return <span aria-hidden className="inline-flex h-6 w-6 items-center justify-center text-faint/50">{op === "plus" ? "+" : "−"}</span>;
  return (
    <ActionForm action={goalStatusAction} hideSuccess className="contents">
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="op" value={op} />
      <SubmitButton size="sm" variant="secondary" className="h-6 w-6 justify-center p-0">
        <span aria-hidden>{op === "plus" ? "+" : "−"}</span>
        <span className="sr-only">{label}</span>
      </SubmitButton>
    </ActionForm>
  );
}

function Check() {
  return (
    <svg viewBox="0 0 16 16" className="h-3 w-3" aria-hidden>
      <path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
