-- Ledger integrity guards. Posted accounting is append-only; corrections are reversals.

ALTER TABLE "journal_lines" ADD CONSTRAINT "journal_lines_amounts_chk"
  CHECK (debit >= 0 AND credit >= 0 AND (debit = 0 OR credit = 0) AND (debit > 0 OR credit > 0));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_reject_line_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'Posted journal lines are immutable; post a reversal instead' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_lines_immutable BEFORE UPDATE OR DELETE ON "journal_lines"
  FOR EACH ROW EXECUTE FUNCTION ledger_reject_line_change();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_guard_entry_update() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Posted journal entries cannot be deleted; post a reversal instead' USING ERRCODE = 'P0001';
  END IF;
  -- Only linking a reversal (reversed_by_id from NULL to a value) is permitted.
  IF OLD.reversed_by_id IS NULL AND NEW.reversed_by_id IS NOT NULL
     AND NEW.entry_date = OLD.entry_date AND NEW.memo = OLD.memo AND NEW.posting_key = OLD.posting_key
     AND NEW.source_type = OLD.source_type AND NEW.number = OLD.number
     AND NEW.source_id IS NOT DISTINCT FROM OLD.source_id
     AND NEW.reversal_of_id IS NOT DISTINCT FROM OLD.reversal_of_id THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'Posted journal entries are immutable; post a reversal instead' USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_immutable BEFORE UPDATE OR DELETE ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_guard_entry_update();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_check_balanced() RETURNS trigger AS $$
DECLARE
  d numeric; c numeric; n integer;
BEGIN
  SELECT coalesce(sum(debit),0), coalesce(sum(credit),0), count(*) INTO d, c, n
    FROM journal_lines WHERE entry_id = NEW.entry_id;
  IF n < 2 OR d <> c THEN
    RAISE EXCEPTION 'Journal entry % is unbalanced (debits %, credits %, lines %)', NEW.entry_id, d, c, n USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER journal_lines_balanced AFTER INSERT ON "journal_lines"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ledger_check_balanced();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION ledger_check_period_open() RETURNS trigger AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounting_periods p WHERE p.status = 'locked'
             AND NEW.entry_date BETWEEN p.period_start AND p.period_end) THEN
    RAISE EXCEPTION 'Accounting period containing % is locked', NEW.entry_date USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER journal_entries_period_open BEFORE INSERT ON "journal_entries"
  FOR EACH ROW EXECUTE FUNCTION ledger_check_period_open();
--> statement-breakpoint
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_positive_chk" CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_positive_chk" CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_alloc_positive_chk" CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE "time_entries" ADD CONSTRAINT "time_entries_hours_chk" CHECK (hours > 0 AND hours <= 24);
