<!-- BEGIN:nextjs-agent-rules -->

## This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## Project conventions

- Read `docs/ARCHITECTURE.md` first. Business rules live in `src/server/<module>/`; server actions in `src/server/actions/` stay thin (`runAction`), and pages only read.
- Every domain function re-checks permission (`assertCan`) and record scope (`src/server/auth/scope.ts`) and writes an `audit()` entry in the same transaction.
- Money uses `decimal.js` helpers in `src/lib/money.ts`; never JS floats. Never sum different currencies without `getRate`.
- Ledger postings go through `postJournal` with a unique `postingKey`; posted lines are immutable (DB triggers). Corrections are reversals.
- Never mark an integration connected without a real verification, never send messages automatically, and keep AI output as unsent suggestions.
- Adding exports to an existing `"use server"` file needs a dev-server restart.
- Before pushing: `npm run typecheck && npm run lint && npm test && npm run build`.
