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

export const SETTING_GROUPS = ["account", "signin", "calendars", "storage", "transcription", "ai", "notifications", "tasks"] as const;
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export type SettingDef = {
  key: string;
  group: SettingGroup;
  label: string;
  type: "text" | "secret" | "number" | "bool" | "select" | "textarea";
  default?: string;
  /** For a select, or the suggestions for a text setting (a dropdown with Other…); `detail` is the tile's second line or the option's note. */
  options?: { value: string; label: string; detail?: string }[];
  placeholder?: string;
  help?: string;
  /** Only shown when another setting has one of these values. */
  when?: { key: string; is: string[] };
  /** Kept in the table but never shown or edited in Settings. */
  hidden?: boolean;
  /** The heading it's shown under on its page; settings with the same one share a card. */
  section?: string;
  /** Folded under Advanced. */
  advanced?: boolean;
  /** A select shown as tiles, or a number shown as a choice of hours. */
  display?: "tiles" | "hour";
};

const PROVIDER = (...is: string[]) => ({ key: "AI_PROVIDER", is });

export const SETTINGS: SettingDef[] = [
  // Account
  { key: "OWNER_NAME", group: "account", section: "Profile", label: "Name", type: "text", placeholder: "Alex", help: "Shown in the sidebar, and for your side of a call in transcripts." },
  { key: "OWNER_EMAIL", group: "account", section: "Profile", label: "Email", type: "text", placeholder: "you@example.com" },
  { key: "TZ", group: "account", section: "Profile", label: "Time zone", type: "text", default: "UTC", placeholder: "America/New_York", help: "Meetings show in it." },
  { key: "WORK_DAY_START", group: "account", section: "Profile", label: "Working hours start", type: "number", display: "hour", default: "8", help: "The home calendar opens on your working hours." },
  { key: "WORK_DAY_END", group: "account", section: "Profile", label: "Working hours end", type: "number", display: "hour", default: "18" },
  { key: "PUBLIC_URL", group: "account", label: "Address", type: "text", placeholder: "https://debrief.example.com", help: "Where you open Debrief. Used for links in Slack, tasks and notes, and for connecting Google.", advanced: true },
  { key: "UPDATE_CHECK", group: "account", label: "Check GitHub for new versions", type: "bool", default: "true", help: "About once an hour. Nothing about you is sent.", advanced: true },

  // Sign-in (the password itself is set with its own form)
  { key: "AUTH_OIDC_ISSUER", group: "signin", label: "Issuer", type: "text", placeholder: "https://auth.example.com/application/o/debrief/", help: "Authentik, or any OpenID Connect provider. Its redirect URI is <address>/api/auth/callback/oidc." },
  { key: "AUTH_OIDC_ID", group: "signin", label: "Client ID", type: "text" },
  { key: "AUTH_OIDC_SECRET", group: "signin", label: "Client secret", type: "secret" },
  { key: "ALLOWED_EMAILS", group: "signin", label: "Allowed emails", type: "text", placeholder: "you@example.com", help: "Comma-separated. Empty lets in anyone your provider signs in." },
  { key: "AUTH_OIDC_NAME", group: "signin", label: "Button label", type: "text", default: "Authentik", advanced: true },
  { key: "AUTH_SECRET", group: "signin", label: "Session secret", type: "secret", hidden: true },
  { key: "PASSWORD_HASH", group: "signin", label: "Password", type: "secret", hidden: true },

  // Calendars
  { key: "GOOGLE_OAUTH_CLIENT_ID", group: "calendars", label: "OAuth client ID", type: "text", placeholder: "1234…apps.googleusercontent.com", hidden: true },
  { key: "GOOGLE_OAUTH_CLIENT_SECRET", group: "calendars", label: "OAuth client secret", type: "secret", hidden: true },
  { key: "GOOGLE_ACCOUNTS", group: "calendars", label: "Connected Google accounts", type: "secret", hidden: true },
  { key: "GOOGLE_CREDENTIALS", group: "calendars", label: "Google credentials", type: "textarea", placeholder: '{ "type": "service_account", … }', help: "Set when you connect Google. Or a service account's JSON key, or gcloud's application_default_credentials.json.", advanced: true },
  { key: "POLL_INTERVAL_SECONDS", group: "calendars", label: "Sync every (seconds)", type: "number", default: "300", advanced: true },
  { key: "SYNC_DAYS_BACK", group: "calendars", label: "Days back", type: "number", default: "30", advanced: true },
  { key: "SYNC_DAYS_AHEAD", group: "calendars", label: "Days ahead", type: "number", default: "14", advanced: true },
  { key: "MATCH_THRESHOLD", group: "calendars", label: "Match threshold", type: "number", default: "0.7", help: "How much of the shorter of a recording and an event must overlap to link them (0–1).", advanced: true },

  // Recordings and storage
  {
    key: "ARCHIVE",
    group: "storage",
    section: "After transcribing, keep recordings",
    label: "Archive recordings to",
    type: "select",
    display: "tiles",
    default: "off",
    options: [
      { value: "off", label: "On the server", detail: "Nothing else to set up." },
      { value: "folder", label: "In a NAS folder", detail: "The folder mounted at /archive." },
      { value: "s3", label: "In S3 storage", detail: "AWS, R2, Backblaze, MinIO." },
    ],
  },
  { key: "KEEP_LOCAL_DAYS", group: "storage", section: "Archive", label: "Keep the server's copy for (days)", type: "number", default: "7", help: "So recent meetings play quickly.", when: { key: "ARCHIVE", is: ["folder", "s3"] } },
  { key: "S3_BUCKET", group: "storage", section: "Archive", label: "Bucket", type: "text", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_ENDPOINT", group: "storage", section: "Archive", label: "Endpoint", type: "text", placeholder: "https://<account>.r2.cloudflarestorage.com", help: "Empty for AWS.", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_REGION", group: "storage", section: "Archive", label: "Region", type: "text", default: "us-east-1", placeholder: "us-east-1, or auto for R2", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_ACCESS_KEY_ID", group: "storage", section: "Archive", label: "Access key ID", type: "text", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_SECRET_ACCESS_KEY", group: "storage", section: "Archive", label: "Secret access key", type: "secret", when: { key: "ARCHIVE", is: ["s3"] } },
  { key: "S3_PREFIX", group: "storage", label: "S3 prefix", type: "text", default: "debrief/", when: { key: "ARCHIVE", is: ["s3"] }, advanced: true },
  { key: "WATCH_FOLDER", group: "storage", label: "Watch the NAS folder for new audio", type: "bool", default: "false", help: "For Meetily, Syncthing or rsync: transcribe any audio file that appears in the NAS folder. The Debrief Recorder doesn't need it.", advanced: true },
  { key: "SCAN_INTERVAL", group: "storage", label: "Scan every (seconds)", type: "number", default: "30", when: { key: "WATCH_FOLDER", is: ["true"] }, advanced: true },
  { key: "STABLE_SECONDS", group: "storage", label: "Wait for a file to stop growing (seconds)", type: "number", default: "60", when: { key: "WATCH_FOLDER", is: ["true"] }, advanced: true },
  { key: "ABANDON_HOURS", group: "storage", label: "Give up on an unfinished upload after (hours)", type: "number", default: "12", help: "A recording that stopped uploading (the laptop died) is transcribed as far as it got.", advanced: true },

  // Transcription
  {
    key: "WHISPER_MODEL",
    group: "transcription",
    section: "Speed and accuracy",
    label: "Model",
    type: "select",
    display: "tiles",
    default: "large-v3",
    options: [
      { value: "small", label: "Fast", detail: "small · about 4× quicker, fine for clear calls" },
      { value: "large-v3-turbo", label: "Balanced", detail: "large-v3-turbo · near-best, 2× quicker" },
      { value: "large-v3", label: "Most accurate", detail: "large-v3 · slowest on a CPU" },
    ],
    help: "A new model downloads on the next recording.",
  },
  { key: "HF_TOKEN", group: "transcription", section: "Speakers", label: "Hugging Face token", type: "secret", help: "Tells apart the people on a call (Speaker 1, 2…). Recorder calls mark your own lines either way. Accept the terms of pyannote/speaker-diarization-community-1 first." },
  {
    key: "LANGUAGE",
    group: "transcription",
    section: "Speakers",
    label: "Language",
    type: "select",
    default: "",
    options: [
      { value: "", label: "Detect" },
      ...Object.entries({ en: "English", es: "Spanish", fr: "French", de: "German", it: "Italian", pt: "Portuguese", nl: "Dutch", ja: "Japanese", zh: "Chinese", ko: "Korean", hi: "Hindi" }).map(([value, label]) => ({ value, label })),
    ],
  },
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
    advanced: true,
  },
  { key: "WHISPER_DEVICE", group: "transcription", label: "Run on", type: "select", default: "cpu", options: [{ value: "cpu", label: "CPU" }, { value: "cuda", label: "GPU (CUDA)" }], advanced: true },
  { key: "CPU_THREADS", group: "transcription", label: "CPU threads", type: "number", default: "0", help: "0 uses every core.", advanced: true },
  { key: "COMPUTE_TYPE", group: "transcription", label: "Compute type", type: "text", placeholder: "int8 on CPU, float16 on GPU", advanced: true },
  { key: "BEAM_SIZE", group: "transcription", label: "Beam size", type: "number", default: "5", help: "Lower is faster, higher a little more accurate.", advanced: true },

  // AI
  {
    key: "AI_PROVIDER",
    group: "ai",
    section: "Provider",
    label: "Provider",
    type: "select",
    display: "tiles",
    default: "anthropic",
    options: [
      { value: "anthropic", label: "Anthropic", detail: "Claude" },
      { value: "openai", label: "OpenAI", detail: "GPT models" },
      { value: "gemini", label: "Google", detail: "Gemini" },
      { value: "custom", label: "Other", detail: "Ollama, OpenRouter, LM Studio: anything OpenAI-compatible" },
    ],
  },
  { key: "AI_BASE_URL", group: "ai", section: "Connection", label: "Server address", type: "text", placeholder: "http://ollama:11434/v1", help: "The OpenAI-compatible base URL, ending before /chat/completions.", when: PROVIDER("custom") },
  { key: "ANTHROPIC_API_KEY", group: "ai", section: "Connection", label: "API key", type: "secret", placeholder: "sk-ant-…", help: "From console.anthropic.com → API keys.", when: PROVIDER("anthropic") },
  { key: "OPENAI_API_KEY", group: "ai", section: "Connection", label: "API key", type: "secret", placeholder: "sk-…", help: "From platform.openai.com → API keys.", when: PROVIDER("openai") },
  { key: "GEMINI_API_KEY", group: "ai", section: "Connection", label: "API key", type: "secret", placeholder: "AIza…", help: "From aistudio.google.com → Get API key.", when: PROVIDER("gemini") },
  { key: "AI_API_KEY", group: "ai", section: "Connection", label: "API key", type: "secret", placeholder: "Optional", help: "Ollama and LM Studio don't need one.", when: PROVIDER("custom") },
  // Rough cost of summarizing an hour-long meeting (about 13k tokens in, 3k out with thinking), at list prices.
  {
    key: "ANTHROPIC_MODEL",
    group: "ai",
    section: "Connection",
    label: "Model",
    type: "text",
    default: "claude-haiku-5-5",
    options: [
      { value: "claude-haiku-5-5", label: "Haiku 5.5", detail: "cheapest, about $0.003 a meeting" },
      { value: "claude-sonnet-5-5", label: "Sonnet 5.5", detail: "sharper on long calls, about $0.06" },
      { value: "claude-opus-5-5", label: "Opus 5.5", detail: "most capable, about $0.11" },
    ],
    help: "Cost per hour-long meeting at Anthropic's list prices. Haiku is plenty for summaries.",
    when: PROVIDER("anthropic"),
  },
  {
    key: "OPENAI_MODEL",
    group: "ai",
    section: "Connection",
    label: "Model",
    type: "text",
    default: "gpt-5-mini",
    options: [
      { value: "gpt-5-nano", label: "GPT-5 nano", detail: "cheapest" },
      { value: "gpt-5-mini", label: "GPT-5 mini", detail: "cheap, good at summaries" },
      { value: "gpt-5", label: "GPT-5", detail: "most capable, dearest" },
    ],
    when: PROVIDER("openai"),
  },
  {
    key: "GEMINI_MODEL",
    group: "ai",
    section: "Connection",
    label: "Model",
    type: "text",
    default: "gemini-2.5-flash",
    options: [
      { value: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash-Lite", detail: "cheapest" },
      { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash", detail: "cheap, good at summaries" },
      { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro", detail: "most capable, dearest" },
    ],
    when: PROVIDER("gemini"),
  },
  { key: "AI_MODEL", group: "ai", section: "Connection", label: "Model", type: "text", placeholder: "llama3.1", help: "One that can call tools (function calling).", when: PROVIDER("custom") },
  { key: "AUTO_EXTRACT", group: "ai", section: "Summaries", label: "Summarize every new meeting", type: "bool", default: "true", help: "Off: use Summarize on a meeting when you want one." },
  { key: "MCP_TOKEN", group: "ai", label: "Fixed MCP token", type: "secret", help: "Optional. Keys from Recorder & devices work as MCP bearer tokens too.", advanced: true },

  // Slack
  { key: "SLACK_WEBHOOK_URL", group: "notifications", section: "Slack", label: "Incoming webhook", type: "secret", placeholder: "https://hooks.slack.com/services/…", help: "Make one at api.slack.com/apps → Incoming Webhooks." },
  { key: "SLACK_WEBHOOKS", group: "notifications", label: "Slack webhook per context", type: "secret", placeholder: "work:https://hooks.slack.com/…,side:https://hooks.slack.com/…", help: "A context without one uses the webhook above.", advanced: true },

  // Tasks
  { key: "AKIFLOW_WEBHOOK_URL", group: "tasks", section: "Akiflow", label: "Webhook", type: "secret", placeholder: "https://hooks.zapier.com/…", help: "A Zapier, Make or IFTTT hook that creates the Akiflow task." },
  { key: "AKIFLOW_DEFAULT_DURATION", group: "tasks", section: "Akiflow", label: "Task length (minutes)", type: "number", default: "30" },
  { key: "LINEAR_API_KEY", group: "tasks", section: "Linear", label: "API key", type: "secret", help: "Linear → Settings → Security & access → Personal API keys." },
  { key: "LINEAR_TEAM", group: "tasks", section: "Linear", label: "Team", type: "text", placeholder: "ENG" },
  { key: "LINEAR_TEAMS", group: "tasks", label: "Linear team per context", type: "text", placeholder: "work:ENG,side:SIDE", advanced: true },
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
