ALTER TABLE "devices" ADD COLUMN "label" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "color" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "viewed_at" timestamp with time zone;--> statement-breakpoint
-- Meetings from before this was tracked count as seen, except the last two days'.
UPDATE "transcripts" SET "viewed_at" = "processed_at" WHERE "processed_at" < now() - interval '2 days';
