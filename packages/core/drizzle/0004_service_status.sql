CREATE TABLE "service_status" (
	"service" text PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"commit" text,
	"detail" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
