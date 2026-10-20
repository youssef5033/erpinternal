CREATE TABLE "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"period" text NOT NULL,
	"period_start" date NOT NULL,
	"title" text NOT NULL,
	"target" integer,
	"progress" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"carried_from_id" uuid,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "goals_period_chk" CHECK ("goals"."period" in ('day', 'week')),
	CONSTRAINT "goals_status_chk" CHECK ("goals"."status" in ('open', 'done', 'carried')),
	CONSTRAINT "goals_target_chk" CHECK ("goals"."target" is null or "goals"."target" > 0),
	CONSTRAINT "goals_progress_chk" CHECK ("goals"."progress" >= 0)
);
--> statement-breakpoint
ALTER TABLE "goals" ADD CONSTRAINT "goals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "goals_user_period_idx" ON "goals" USING btree ("user_id","period","period_start");--> statement-breakpoint
CREATE UNIQUE INDEX "goals_carried_from_uq" ON "goals" USING btree ("carried_from_id");