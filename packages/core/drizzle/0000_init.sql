CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"calendar_id" uuid NOT NULL,
	"title" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"cancelled" boolean DEFAULT false NOT NULL,
	"organizer_email" text,
	"conference_url" text,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendars" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" text NOT NULL,
	"external_id" text NOT NULL,
	"name" text NOT NULL,
	"context" text DEFAULT 'default' NOT NULL,
	"default_destination" text DEFAULT 'akiflow' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_synced_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_attendees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"event_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"rsvp_status" text
);
--> statement-breakpoint
CREATE TABLE "recordings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_path" text NOT NULL,
	"file_size" bigint,
	"duration_secs" integer,
	"recorded_at" timestamp with time zone NOT NULL,
	"device" text,
	"title_hint" text,
	"waveform" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"progress" real,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recordings_file_path_unique" UNIQUE("file_path")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"item_number" integer NOT NULL,
	"assignee" text,
	"description" text NOT NULL,
	"details" text,
	"due_date" date,
	"priority" text,
	"context" text,
	"destination" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"source_start" real,
	"pushed_to" text,
	"external_id" text,
	"external_url" text,
	"push_error" text,
	"pushed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcript_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"transcript_id" uuid NOT NULL,
	"event_id" uuid NOT NULL,
	"confidence" real NOT NULL,
	"manual" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"recording_id" uuid NOT NULL,
	"content" text NOT NULL,
	"speaker_segments" jsonb,
	"speaker_names" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"title" text,
	"summary" text,
	"language" text DEFAULT 'en',
	"model_version" text,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"tasks_extracted_at" timestamp with time zone,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || content)) STORED,
	CONSTRAINT "transcripts_recording_id_unique" UNIQUE("recording_id")
);
--> statement-breakpoint
ALTER TABLE "calendar_events" ADD CONSTRAINT "calendar_events_calendar_id_calendars_id_fk" FOREIGN KEY ("calendar_id") REFERENCES "public"."calendars"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "event_attendees" ADD CONSTRAINT "event_attendees_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_events" ADD CONSTRAINT "transcript_events_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcript_events" ADD CONSTRAINT "transcript_events_event_id_calendar_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."calendar_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_events_calendar_external" ON "calendar_events" USING btree ("calendar_id","external_id");--> statement-breakpoint
CREATE INDEX "calendar_events_start" ON "calendar_events" USING btree ("start_at");--> statement-breakpoint
CREATE UNIQUE INDEX "calendars_source_external" ON "calendars" USING btree ("source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "event_attendees_event_email" ON "event_attendees" USING btree ("event_id","email");--> statement-breakpoint
CREATE INDEX "recordings_recorded_at" ON "recordings" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "recordings_status" ON "recordings" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_transcript_item" ON "tasks" USING btree ("transcript_id","item_number");--> statement-breakpoint
CREATE INDEX "tasks_status" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_events_pair" ON "transcript_events" USING btree ("transcript_id","event_id");--> statement-breakpoint
CREATE INDEX "idx_transcripts_search" ON "transcripts" USING gin ("search_vector");