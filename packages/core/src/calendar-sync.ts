import fs from "node:fs/promises";
import { and, eq, gte, lte, notInArray } from "drizzle-orm";
import { GoogleAuth, OAuth2Client, type AuthClient } from "google-auth-library";
import ical, { type VEvent } from "node-ical";
import type { Db } from "./db";
import { calendarEvents, calendars, eventAttendees } from "./schema";
import { correlateUnmatched } from "./correlate";
import { saveSettings, setting, settingNumber } from "./settings";

/** A calendar event in the shape Debrief stores, whatever it came from. */
export type NormalizedEvent = {
  externalId: string;
  title: string;
  startAt: Date;
  endAt: Date;
  allDay: boolean;
  cancelled: boolean;
  organizerEmail: string | null;
  conferenceUrl: string | null;
  attendees: { email: string; name: string | null; rsvpStatus: string | null }[];
};


const CONFERENCE_RE =
  /https:\/\/(?:[\w-]+\.)?(?:zoom\.us\/(?:j|my|w)\/[^\s<>"']+|meet\.google\.com\/[a-z0-9-]+|app\.slack\.com\/huddle\/[^\s<>"']+|teams\.microsoft\.com\/l\/meetup-join\/[^\s<>"']+)/i;

/** The first Zoom / Meet / Huddle / Teams link in some text. */
export function findConferenceUrl(...texts: (string | null | undefined)[]) {
  for (const t of texts) {
    const m = t?.match(CONFERENCE_RE);
    if (m) return m[0].replace(/[).,;]+$/, "");
  }
  return null;
}

export function syncWindow(now = new Date()) {
  return {
    from: new Date(now.getTime() - settingNumber("SYNC_DAYS_BACK") * 86400_000),
    to: new Date(now.getTime() + settingNumber("SYNC_DAYS_AHEAD") * 86400_000),
  };
}

// ── Google ────────────────────────────────────────────────────────────────

type GoogleEvent = {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  hangoutLink?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string };
  attendees?: { email?: string; displayName?: string; responseStatus?: string; self?: boolean; resource?: boolean }[];
  conferenceData?: { entryPoints?: { entryPointType?: string; uri?: string }[] };
};

let googleClient: { raw: string; client: Promise<AuthClient | null> } | null = null;

/** The Google credentials JSON: pasted in Settings, or a file named by GOOGLE_CREDENTIALS_FILE. */
async function googleCredentials() {
  const file = process.env.GOOGLE_CREDENTIALS_FILE;
  // An empty or missing file means "no Google".
  const raw = file ? await fs.readFile(file, "utf8").catch(() => "") : "";
  return raw.trim() || setting("GOOGLE_CREDENTIALS").trim();
}

/**
 * A Google client from a service account key (share each calendar with its
 * address) or an OAuth "authorized_user" file with a refresh token (sees
 * everything the account can). Made again when the credentials change.
 */
export async function googleAuth(): Promise<AuthClient | null> {
  const raw = await googleCredentials();
  if (googleClient?.raw !== raw) googleClient = { raw, client: makeGoogleClient(raw) };
  return googleClient.client;
}

async function makeGoogleClient(raw: string): Promise<AuthClient | null> {
  if (!raw) return null;
  const json = JSON.parse(raw);
  if (json.type === "authorized_user") {
    const client = new OAuth2Client(json.client_id, json.client_secret);
    client.setCredentials({ refresh_token: json.refresh_token });
    return client;
  }
  return new GoogleAuth({ credentials: json, scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }).getClient();
}

async function googleGet<T>(client: AuthClient, url: string): Promise<T> {
  const res = await client.request<T>({ url });
  return res.data;
}

export function normalizeGoogleEvent(e: GoogleEvent): NormalizedEvent | null {
  const startRaw = e.start?.dateTime ?? e.start?.date;
  const endRaw = e.end?.dateTime ?? e.end?.date ?? startRaw;
  if (!startRaw || !endRaw) return null;
  const self = e.attendees?.find((a) => a.self);
  const video = e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri;
  return {
    externalId: e.id,
    title: e.summary?.trim() || "(no title)",
    startAt: new Date(startRaw),
    endAt: new Date(endRaw),
    allDay: !e.start?.dateTime,
    // An invite you declined is not a meeting you were in.
    cancelled: e.status === "cancelled" || self?.responseStatus === "declined",
    organizerEmail: e.organizer?.email ?? null,
    conferenceUrl: video ?? e.hangoutLink ?? findConferenceUrl(e.location, e.description),
    attendees: (e.attendees ?? [])
      .filter((a) => a.email && !a.resource)
      .map((a) => ({ email: a.email!.toLowerCase(), name: a.displayName ?? null, rsvpStatus: a.responseStatus ?? null })),
  };
}

export async function fetchGoogleEvents(calendarId: string, from: Date, to: Date): Promise<NormalizedEvent[]> {
  const client = await googleAuth();
  if (!client) throw new Error("Google isn't connected. Connect it in Settings → Calendars.");
  const out: NormalizedEvent[] = [];
  let pageToken: string | undefined;
  do {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: "true",
      showDeleted: "true",
      maxResults: "2500",
    });
    if (pageToken) params.set("pageToken", pageToken);
    const page = await googleGet<{ items?: GoogleEvent[]; nextPageToken?: string }>(
      client,
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${params}`
    );
    for (const item of page.items ?? []) {
      const n = normalizeGoogleEvent(item);
      if (n) out.push(n);
    }
    pageToken = page.nextPageToken;
  } while (pageToken);
  return out;
}

/** Calendars the Google account has in its list (empty for a service account until calendars are shared and added). */
export async function listGoogleCalendars() {
  const client = await googleAuth();
  if (!client) return [];
  const data = await googleGet<{ items?: { id: string; summary?: string; summaryOverride?: string; primary?: boolean; accessRole?: string }[] }>(
    client,
    "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=reader"
  );
  return (data.items ?? []).map((c) => ({ id: c.id, name: c.summaryOverride ?? c.summary ?? c.id, primary: !!c.primary }));
}

/** Google's sign-in, for "Connect Google": needs an OAuth client made in the owner's own Google Cloud project. */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.readonly";

export const googleOAuthReady = () => !!(setting("GOOGLE_OAUTH_CLIENT_ID") && setting("GOOGLE_OAUTH_CLIENT_SECRET"));

function oauthClient(redirectUri: string) {
  return new OAuth2Client(setting("GOOGLE_OAUTH_CLIENT_ID"), setting("GOOGLE_OAUTH_CLIENT_SECRET"), redirectUri);
}

/** Where "Connect Google" sends you. offline + consent, so Google hands back a refresh token every time. */
export function googleConnectUrl(redirectUri: string, state: string) {
  return oauthClient(redirectUri).generateAuthUrl({ access_type: "offline", prompt: "consent", scope: [GOOGLE_SCOPE, "openid", "email"], state, include_granted_scopes: true });
}

/**
 * Trades Google's code for a refresh token and keeps it as the Google
 * credentials, in the same "authorized_user" shape gcloud writes.
 */
export async function googleConnect(db: Db, code: string, redirectUri: string) {
  const { tokens } = await oauthClient(redirectUri).getToken(code);
  if (!tokens.refresh_token) throw new Error("Google didn't send a refresh token. Remove Debrief's access at myaccount.google.com/permissions, then connect again.");
  if (tokens.scope && !tokens.scope.includes(GOOGLE_SCOPE)) throw new Error("Tick the box that lets Debrief see your calendars, then connect again.");
  let account: string | null = null;
  if (tokens.id_token) {
    try {
      account = JSON.parse(Buffer.from(tokens.id_token.split(".")[1], "base64url").toString()).email ?? null;
    } catch {
      // The email only labels the connection.
    }
  }
  const creds = { type: "authorized_user", client_id: setting("GOOGLE_OAUTH_CLIENT_ID"), client_secret: setting("GOOGLE_OAUTH_CLIENT_SECRET"), refresh_token: tokens.refresh_token, account };
  await saveSettings(db, { GOOGLE_CREDENTIALS: JSON.stringify(creds) });
  return account;
}

/** What the Google credentials are, without the secrets: for Settings. */
export async function googleCredentialInfo(): Promise<{ kind: "none" | "account" | "service"; email: string | null; fromFile: boolean }> {
  const raw = await googleCredentials();
  const fromFile = !!process.env.GOOGLE_CREDENTIALS_FILE && raw !== setting("GOOGLE_CREDENTIALS").trim();
  if (!raw) return { kind: "none", email: null, fromFile };
  try {
    const j = JSON.parse(raw);
    if (j.type === "service_account") return { kind: "service", email: j.client_email ?? null, fromFile };
    return { kind: "account", email: j.account ?? null, fromFile };
  } catch {
    return { kind: "none", email: null, fromFile };
  }
}

/** Tries a calendar before it's added: its name and how many events it has in the sync window. */
export async function checkCalendar(source: "google" | "ics", externalId: string) {
  const { from, to } = syncWindow();
  try {
    if (source === "ics") {
      const events = await fetchIcsEvents(externalId, from, to);
      return { events: events.length, name: null as string | null };
    }
    const events = await fetchGoogleEvents(externalId, from, to);
    const listed = await listGoogleCalendars().catch(() => []);
    return { events: events.length, name: listed.find((c) => c.id === externalId)?.name ?? null };
  } catch (err) {
    throw new Error(explainCalendarError(source, (err as Error).message));
  }
}

/** Google's and the feed server's errors, as what to do about them. */
export function explainCalendarError(source: string, message: string) {
  const info = /not ?found|404/i.test(message) ? "notfound" : /403|forbidden|insufficient/i.test(message) ? "denied" : /invalid_grant|401/i.test(message) ? "expired" : null;
  if (source === "google") {
    if (info === "notfound") return "Google said this calendar doesn't exist for Debrief. Check the calendar ID, and with a service account, share the calendar with it.";
    if (info === "denied") return "Google won't let Debrief read this calendar. Share it with the service account, or connect an account that can see it.";
    if (info === "expired") return "Google's sign-in has expired or was revoked. Connect Google again.";
  } else if (info === "notfound" || info === "denied") return "The feed's server refused the link. Copy it again: private links change when they're reset.";
  return message;
}

// ── ICS feeds (Outlook, a Google "secret address", anything else) ─────────

const text = (v: unknown): string => (typeof v === "string" ? v : v && typeof v === "object" && "val" in v ? String((v as { val: unknown }).val) : "");
const mailto = (v: unknown) => text(v).replace(/^mailto:/i, "").toLowerCase() || null;

function icsAttendees(e: VEvent) {
  const list = Array.isArray(e.attendee) ? e.attendee : e.attendee ? [e.attendee] : [];
  return list
    .map((a) => {
      const params = (a as { params?: Record<string, string> }).params ?? {};
      const email = mailto(a);
      const status = params.PARTSTAT?.toLowerCase();
      return email
        ? { email, name: params.CN ?? null, rsvpStatus: status === "needs-action" ? "needsAction" : (status ?? null) }
        : null;
    })
    .filter((a): a is NonNullable<typeof a> => !!a);
}

export function normalizeIcs(body: string, from: Date, to: Date): NormalizedEvent[] {
  const parsed = ical.sync.parseICS(body);
  const out: NormalizedEvent[] = [];
  for (const c of Object.values(parsed)) {
    if (!c || c.type !== "VEVENT") continue;
    const e = c as VEvent;
    const instances = ical.expandRecurringEvent(e, { from, to, expandOngoing: true });
    for (const inst of instances) {
      const ev = inst.event;
      out.push({
        externalId: inst.isRecurring ? `${e.uid}@${new Date(inst.start).toISOString()}` : e.uid,
        title: text(inst.summary).trim() || "(no title)",
        startAt: new Date(inst.start),
        endAt: new Date(inst.end ?? inst.start),
        allDay: inst.isFullDay,
        cancelled: ev.status === "CANCELLED",
        organizerEmail: mailto(ev.organizer),
        conferenceUrl: findConferenceUrl(text(ev.location), text(ev.url), text(ev.description)),
        attendees: icsAttendees(ev),
      });
    }
  }
  return out;
}

export async function fetchIcsEvents(url: string, from: Date, to: Date) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`The calendar feed answered ${res.status}.`);
  return normalizeIcs(await res.text(), from, to);
}

// ── Storing ───────────────────────────────────────────────────────────────

/**
 * Replaces one calendar's events inside the window with `events`: new ones
 * are added, changed ones updated, and ones that are gone are deleted.
 */
export async function storeEvents(db: Db, calendar: { id: string; source: string }, events: NormalizedEvent[], from: Date, to: Date) {
  await db.transaction(async (tx) => {
    const keep: string[] = [];
    for (const e of events) {
      const values = {
        source: calendar.source,
        externalId: e.externalId,
        calendarId: calendar.id,
        title: e.title,
        startAt: e.startAt,
        endAt: e.endAt,
        allDay: e.allDay,
        cancelled: e.cancelled,
        organizerEmail: e.organizerEmail,
        conferenceUrl: e.conferenceUrl,
        syncedAt: new Date(),
      };
      const [row] = await tx
        .insert(calendarEvents)
        .values(values)
        .onConflictDoUpdate({ target: [calendarEvents.calendarId, calendarEvents.externalId], set: values })
        .returning({ id: calendarEvents.id });
      keep.push(row.id);
      await tx.delete(eventAttendees).where(eq(eventAttendees.eventId, row.id));
      const seen = new Set<string>();
      const attendees = e.attendees.filter((a) => !seen.has(a.email) && seen.add(a.email));
      if (attendees.length) await tx.insert(eventAttendees).values(attendees.map((a) => ({ ...a, eventId: row.id })));
    }
    const inWindow = and(eq(calendarEvents.calendarId, calendar.id), gte(calendarEvents.startAt, from), lte(calendarEvents.startAt, to));
    await tx.delete(calendarEvents).where(keep.length ? and(inWindow, notInArray(calendarEvents.id, keep)) : inWindow);
  });
}

/**
 * Adds calendars named in GOOGLE_CALENDARS ("acme:work@example.com,
 * lumen:primary") and ICS_CALENDARS ("lumen:https://…"), and any in the
 * Google account's list (switched off until enabled in Settings).
 */
export async function registerConfiguredCalendars(db: Db) {
  const parse = (raw: string | undefined) =>
    (raw ?? "")
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const i = s.indexOf(":");
        // "https://…" alone has no context label.
        return i > 0 && !s.slice(0, i).includes("/") && !/^https?$/i.test(s.slice(0, i))
          ? { context: s.slice(0, i).trim(), id: s.slice(i + 1).trim() }
          : { context: "default", id: s };
      });
  const add = (source: string, externalId: string, name: string, context: string, enabled: boolean) =>
    db.insert(calendars).values({ source, externalId, name, context, enabled }).onConflictDoNothing();

  for (const c of parse(process.env.GOOGLE_CALENDARS)) await add("google", c.id, c.id, c.context, true);
  for (const c of parse(process.env.ICS_CALENDARS)) await add("ics", c.id, `${c.context} feed`, c.context, true);
  try {
    for (const c of await listGoogleCalendars()) await add("google", c.id, c.name, "default", c.primary);
  } catch (err) {
    console.warn("Couldn't list Google calendars:", (err as Error).message);
  }
}

/** Syncs every enabled calendar, then links transcripts that had no meeting yet. */
export async function syncAllCalendars(db: Db) {
  const { from, to } = syncWindow();
  const list = await db.select().from(calendars).where(eq(calendars.enabled, true));
  const results: { calendar: string; events?: number; error?: string }[] = [];
  for (const cal of list) {
    try {
      const events =
        cal.source === "google" ? await fetchGoogleEvents(cal.externalId, from, to) : await fetchIcsEvents(cal.externalId, from, to);
      await storeEvents(db, cal, events, from, to);
      await db.update(calendars).set({ lastSyncedAt: new Date(), lastError: null }).where(eq(calendars.id, cal.id));
      results.push({ calendar: cal.name, events: events.length });
    } catch (err) {
      const message = explainCalendarError(cal.source, (err as Error).message).slice(0, 500);
      await db.update(calendars).set({ lastError: message }).where(eq(calendars.id, cal.id));
      results.push({ calendar: cal.name, error: message });
    }
  }
  const correlation = await correlateUnmatched(db);
  return { calendars: results, correlation };
}
