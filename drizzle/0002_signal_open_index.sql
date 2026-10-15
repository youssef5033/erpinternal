DROP INDEX "signals_open_fingerprint_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "signals_open_fingerprint_uq" ON "signals" USING btree ("fingerprint") WHERE resolved_at is null;