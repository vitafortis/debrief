/**
 * Settings made in the web app, kept in the settings table and read by every
 * service. An environment variable of the same name still wins (and shows as
 * locked in Settings), so a .env from before keeps working.
 *
 * Reads are synchronous, from a cache each service fills with loadSettings()
 * and refreshes when web sends pg_notify('debrief_settings').
 */
import crypto from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { settings } from "./schema";

export const SETTING_GROUPS = ["general", "signin", "calendars", "storage", "transcription", "claude", "notifications", "tasks"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export type SettingDef = {
  key: string;
  group: SettingGroup;
  label: string;
  type: "text" | "secret" | "number" | "bool" | "select" | "textarea";
  default?: string;
  options?: { value: string; label: string }[];
  placeholder?: string;
  help?: string;
  /** Only shown when another setting has one of these values. */
  when?: { key: string; is: string[] };
  /** Kept in the table but never shown or edited in Settings. */
  hidden?: boolean;
};

export const SETTINGS: SettingDef[] = [
  // General
  { key: "OWNER_NAME", group: "general", label: "Your name", type: "text", placeholder: "Alex", help: "Shown in the sidebar, and used when you sign in with the password." },
  { key: "OWNER_EMAIL", group: "general", label: "Your email", type: "text", placeholder: "you@example.com" },
  { key: "TZ", group: "general", label: "Time zone", type: "text", default: "UTC", placeholder: "America/New_York", help: "Meetings are shown in it, and file names without a zone are read in it." },
  { key: "PUBLIC_URL", group: "general", label: "Address", type: "text", placeholder: "https://debrief.example.com", help: "Where you open Debrief. Used for links in Slack, tasks and notes." },

  // Sign-in (the password itself is set with its own form)
  { key: "AUTH_OIDC_ISSUER", group: "signin", label: "OpenID Connect issuer", type: "text", placeholder: "https://auth.example.com/application/o/debrief/", help: "Authentik, or any OpenID Connect provider. Its redirect URI is <address>/api/auth/callback/oidc." },
  { key: "AUTH_OIDC_ID", group: "signin", label: "Client ID", type: "text" },
  { key: "AUTH_OIDC_SECRET", group: "signin", label: "Client secret", type: "secret" },
  { key: "AUTH_OIDC_NAME", group: "signin", label: "Button label", type: "text", default: "Authentik" },
  { key: "ALLOWED_EMAILS", group: "signin", label: "Allowed emails", type: "text", placeholder: "you@example.com", help: "Comma-separated. Empty lets in anyone your provider signs in." },
  { key: "AUTH_SECRET", group: "signin", label: "Session secret", type: "secret", hidden: true },
  { key: "PASSWORD_HASH", group: "signin", label: "Password", type: "secret", hidden: true },

  // Calendars
  { key: "GOOGLE_CREDENTIALS", group: "calendars", label: "Google credentials", type: "textarea", placeholder: '{ "type": "service_account", … }', help: "A service account's JSON key, or gcloud's application_default_credentials.json. Not needed for ICS feeds." },
  { key: "POLL_INTERVAL_SECONDS", group: "calendars", label: "Sync every (seconds)", type: "number", default: "300" },
  { key: "SYNC_DAYS_BACK", group: "calendars", label: "Days back", type: "number", default: "30" },
  { key: "SYNC_DAYS_AHEAD", group: "calendars", label: "Days ahead", type: "number", default: "14" },
  { key: "MATCH_THRESHOLD", group: "calendars", label: "Match threshold", type: "number", default: "0.7", help: "How much of the shorter of a recording and an event must overlap to link them (0–1)." },

  // Recordings and storage
  {
    key: "ARCHIVE",
    group: "storage",
    label: "Archive recordings to",
    type: "select",
    default: "off",
    options: [
      { value: "off", label: "Nowhere: keep them on the server" },
      { value: "folder", label: "The NAS folder" },
      { value: "s3", label: "S3-compatible storage" },
    ],
    help: "Once transcribed, a recording is copied here, and the server's copy is removed after the days below.",
  },
  { key: "KEEP_LOCAL_DAYS", group: "storage", label: "Keep the server's copy for (days)", type: "number", default: "7", when: { key: "ARCHIVE", is: ["folder", "s3"] } },
  { key: "S3_ENDPOINT", group: "storage", label: "Endpoint", type: "text", placeholder: "https://<account>.r2.cloudflarestorage.com", help: "Empty for AWS.", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_REGION", group: "storage", label: "Region", type: "text", default: "us-east-1", placeholder: "us-east-1, or auto for R2", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_BUCKET", group: "storage", label: "Bucket", type: "text", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_PREFIX", group: "storage", label: "Prefix", type: "text", default: "debrief/", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_ACCESS_KEY_ID", group: "storage", label: "Access key ID", type: "text", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_SECRET_ACCESS_KEY", group: "storage", label: "Secret access key", type: "secret", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "WATCH_FOLDER", group: "storage", label: "Watch the NAS folder for recordings", type: "bool", default: "false", help: "For Meetily, Syncthing or rsync: transcribe any audio file that appears in the NAS folder. The Debrief Recorder doesn't need it." },
  { key: "ABANDON_HOURS", group: "storage", label: "Give up on an unfinished recording after (hours)", type: "number", default: "12", help: "A recording that stopped uploading (the laptop died) is transcribed as far as it got." },
  { key: "SCAN_INTERVAL", group: "storage", label: "Scan every (seconds)", type: "number", default: "30", when: { key: "WATCH_FOLDER", is: ["true"] } },
  { key: "STABLE_SECONDS", group: "storage", label: "Wait for a file to stop growing (seconds)", type: "number", default: "60", when: { key: "WATCH_FOLDER", is: ["true"] } },

  // Transcription
  {
    key: "WHISPER_MODEL",
    group: "transcription",
    label: "Model",
    type: "select",
    default: "large-v3",
    options: ["large-v3", "large-v3-turbo", "distil-large-v3", "medium", "small", "small.en", "base.en"].map((v) => ({ value: v, label: v })),
    help: "Smaller models are 2–4× faster and a little less accurate. A new model downloads on the next recording.",
  },
  { key: "WHISPER_DEVICE", group: "transcription", label: "Device", type: "select", default: "cpu", options: [{ value: "cpu", label: "CPU" }, { value: "cuda", label: "GPU (CUDA)" }] },
  { key: "COMPUTE_TYPE", group: "transcription", label: "Compute type", type: "text", placeholder: "int8 on CPU, float16 on GPU" },
  { key: "CPU_THREADS", group: "transcription", label: "CPU threads", type: "number", default: "0", help: "0 uses every core." },
  { key: "LANGUAGE", group: "transcription", label: "Language", type: "text", placeholder: "Detected; or e.g. en" },
  { key: "BEAM_SIZE", group: "transcription", label: "Beam size", type: "number", default: "5", help: "Lower is faster, higher a little more accurate." },
  { key: "HF_TOKEN", group: "transcription", label: "Hugging Face token", type: "secret", help: "Turns on speaker labels. Accept the terms of pyannote/speaker-diarization-community-1 first." },
  {
    key: "DIARIZE",
    group: "transcription",
    label: "Speaker labels",
    type: "select",
    default: "",
    options: [
      { value: "", label: "On when there's a token" },
      { value: "true", label: "On" },
      { value: "false", label: "Off" },
    ],
  },

  // Claude
  { key: "ANTHROPIC_API_KEY", group: "claude", label: "Anthropic API key", type: "secret", help: "Lets Debrief summarize meetings and find their action items itself. Claude through MCP works without it." },
  { key: "ANTHROPIC_MODEL", group: "claude", label: "Model", type: "text", default: "claude-sonnet-5-5" },
  { key: "AUTO_EXTRACT", group: "claude", label: "Summarize every new meeting", type: "bool", default: "true" },
  { key: "MCP_TOKEN", group: "claude", label: "Fixed MCP token", type: "secret", help: "Optional. API keys made below work as MCP bearer tokens too." },

  // Notifications
  { key: "SLACK_WEBHOOK_URL", group: "notifications", label: "Slack webhook", type: "secret", placeholder: "https://hooks.slack.com/services/…" },
  { key: "SLACK_WEBHOOKS", group: "notifications", label: "Slack webhook per context", type: "secret", placeholder: "work:https://hooks.slack.com/…,side:https://hooks.slack.com/…", help: "A context without one uses the webhook above." },

  // Tasks
  { key: "AKIFLOW_WEBHOOK_URL", group: "tasks", label: "Akiflow webhook", type: "secret", help: "A Zapier, Make or IFTTT hook that creates the Akiflow task." },
  { key: "AKIFLOW_DEFAULT_DURATION", group: "tasks", label: "Akiflow task length (minutes)", type: "number", default: "30" },
  { key: "LINEAR_API_KEY", group: "tasks", label: "Linear API key", type: "secret" },
  { key: "LINEAR_TEAM", group: "tasks", label: "Linear team", type: "text", placeholder: "ENG" },
  { key: "LINEAR_TEAMS", group: "tasks", label: "Linear team per context", type: "text", placeholder: "work:ENG,side:SIDE" },
];

const DEFS = new Map(SETTINGS.map((d) => [d.key, d]));
export const settingDef = (key: string) => DEFS.get(key);

/** Old environment names that still count. */
const ALIASES: Record<string, string[]> = { WHISPER_DEVICE: ["DEVICE"] };

type Cache = { values: Map<string, string>; loadedAt: number };
const g = globalThis as unknown as { __debriefSettings?: Cache };

function fromEnv(key: string) {
  for (const name of [key, ...(ALIASES[key] ?? [])]) {
    const v = process.env[name];
    if (v !== undefined && v !== "") return v;
  }
  return undefined;
}

/** The value in force: the environment, else what's saved, else the default. */
export function setting(key: string): string {
  return fromEnv(key) ?? g.__debriefSettings?.values.get(key) ?? DEFS.get(key)?.default ?? "";
}

export const settingNumber = (key: string) => {
  const n = Number(setting(key));
  return Number.isFinite(n) ? n : Number(DEFS.get(key)?.default ?? 0);
};
export const settingBool = (key: string) => /^(1|true|yes|on)$/i.test(setting(key));

/** Where a setting's value comes from. */
export function settingSource(key: string): "env" | "saved" | "default" {
  if (fromEnv(key) !== undefined) return "env";
  return g.__debriefSettings?.values.has(key) ? "saved" : "default";
}

export async function loadSettings(db: Db) {
  // Before the first migration there's no table yet: nothing is saved.
  const rows = await db
    .select()
    .from(settings)
    .catch((err) => {
      if ((err as { cause?: { code?: string } }).cause?.code === "42P01") return [];
      throw err;
    });
  g.__debriefSettings = { values: new Map(rows.map((r) => [r.key, r.value])), loadedAt: Date.now() };
}

/** Reloads when the cache is older than maxAge: for services that don't LISTEN. */
export async function refreshSettings(db: Db, maxAgeMs = 5000) {
  const c = g.__debriefSettings;
  if (!c || Date.now() - c.loadedAt > maxAgeMs) await loadSettings(db);
}

/** Saves settings (null or "" clears one) and tells the other services. */
export async function saveSettings(db: Db, values: Record<string, string | null>) {
  for (const [key, value] of Object.entries(values)) {
    if (!DEFS.has(key)) throw new Error(`Unknown setting ${key}.`);
    if (value === null || value === "") await db.delete(settings).where(sql`${settings.key} = ${key}`);
    else
      await db
        .insert(settings)
        .values({ key, value })
        .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  }
  await loadSettings(db);
  await db.execute(sql`select pg_notify('debrief_settings', '')`);
}

/** The value for display: secrets never leave the server, only whether they're set. */
export function settingForDisplay(def: SettingDef) {
  const value = setting(def.key);
  const source = settingSource(def.key);
  if (def.type === "secret" || def.type === "textarea") return { value: def.type === "secret" ? "" : value ? "(set)" : "", isSet: !!value, source };
  return { value, isSet: !!value, source };
}

/** The session secret: AUTH_SECRET from the environment, or one made on first start and kept. */
export async function ensureAuthSecret(db: Db) {
  if (setting("AUTH_SECRET")) return setting("AUTH_SECRET");
  await db
    .insert(settings)
    .values({ key: "AUTH_SECRET", value: crypto.randomBytes(32).toString("base64url") })
    .onConflictDoNothing();
  await loadSettings(db);
  return setting("AUTH_SECRET");
}

/** scrypt, so the owner password is never stored as written. */
export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt:${salt.toString("base64url")}:${hash.toString("base64url")}`;
}

export function checkPassword(password: string, stored: string) {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64url"), want.length);
  return crypto.timingSafeEqual(got, want);
}

/** Checks the owner password against DEBRIEF_PASSWORD from the environment, else the one set in the app. */
export function verifyOwnerPassword(password: string) {
  if (!password) return false;
  const env = process.env.DEBRIEF_PASSWORD;
  if (env) {
    const a = crypto.createHash("sha256").update(password).digest();
    const b = crypto.createHash("sha256").update(env).digest();
    return crypto.timingSafeEqual(a, b);
  }
  const stored = setting("PASSWORD_HASH");
  return !!stored && checkPassword(password, stored);
}

export const ownerPasswordSet = () => !!(process.env.DEBRIEF_PASSWORD || setting("PASSWORD_HASH"));

export async function setOwnerPassword(db: Db, password: string) {
  if (process.env.DEBRIEF_PASSWORD) throw new Error("The password is set by DEBRIEF_PASSWORD in the environment.");
  if (password.length < 8) throw new Error("Use at least 8 characters.");
  const value = hashPassword(password);
  await db
    .insert(settings)
    .values({ key: "PASSWORD_HASH", value })
    .onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
  await loadSettings(db);
}

/** The time zone meetings are shown in. */
export const timeZone = () => setting("TZ") || "UTC";

/** PUBLIC_URL without a trailing slash, or "" when it isn't known. */
export const publicUrl = () => setting("PUBLIC_URL").replace(/\/$/, "");
