ALTER TYPE "public"."import_status" ADD VALUE IF NOT EXISTS 'QUEUED';--> statement-breakpoint
ALTER TYPE "public"."import_status" ADD VALUE IF NOT EXISTS 'PROCESSING';--> statement-breakpoint
ALTER TYPE "public"."import_status" ADD VALUE IF NOT EXISTS 'PARTIALLY_APPLIED';--> statement-breakpoint
CREATE TABLE "background_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"ref_id" uuid NOT NULL,
	"org_id" uuid,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_by" text,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "import_rows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"import_job_id" uuid NOT NULL,
	"hmo_org_id" uuid NOT NULL,
	"row_number" integer NOT NULL,
	"member_number" text NOT NULL,
	"classification" text NOT NULL,
	"warnings" text[] DEFAULT '{}' NOT NULL,
	"changed_fields" text[] DEFAULT '{}' NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"payload_enc" text,
	"outcome" text,
	"error" text,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "warnings" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "options" jsonb;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "detected_type" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "client_mime" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "scan_status" text;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "warning_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "conflict_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "processed_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "applied_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "failed_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "held_rows" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "queued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "finished_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "import_jobs" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_import_job_id_import_jobs_id_fk" FOREIGN KEY ("import_job_id") REFERENCES "public"."import_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_hmo_org_id_organizations_id_fk" FOREIGN KEY ("hmo_org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "background_jobs_kind_ref_uq" ON "background_jobs" USING btree ("kind","ref_id");--> statement-breakpoint
CREATE INDEX "background_jobs_status_idx" ON "background_jobs" USING btree ("status","run_after");--> statement-breakpoint
CREATE UNIQUE INDEX "import_rows_job_row_uq" ON "import_rows" USING btree ("import_job_id","row_number");--> statement-breakpoint
CREATE INDEX "import_rows_job_status_idx" ON "import_rows" USING btree ("import_job_id","status","row_number");--> statement-breakpoint
CREATE INDEX "members_hmo_phone_idx" ON "members" USING btree ("hmo_org_id","phone_hash");