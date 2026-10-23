CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "storage" text DEFAULT 'folder' NOT NULL;--> statement-breakpoint
ALTER TABLE "recordings" ADD COLUMN "archived_at" timestamp with time zone;