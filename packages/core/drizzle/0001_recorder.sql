CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_hash_unique" UNIQUE("hash")
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"name" text PRIMARY KEY NOT NULL,
	"context" text,
	"default_destination" text,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY NOT NULL,
	"device" text NOT NULL,
	"folder" text NOT NULL,
	"file_name" text NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"title" text,
	"app" text,
	"status" text DEFAULT 'recording' NOT NULL,
	"duration_secs" real,
	"api_key_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_folder_unique" UNIQUE("folder")
);
--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "uploads" ADD CONSTRAINT "uploads_api_key_id_api_keys_id_fk" FOREIGN KEY ("api_key_id") REFERENCES "public"."api_keys"("id") ON DELETE set null ON UPDATE no action;