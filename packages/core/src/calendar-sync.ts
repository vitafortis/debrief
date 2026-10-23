import fs from "node:fs/promises";
import { and, eq, gte, lte, notInArray } from "drizzle-orm";
import { GoogleAuth, OAuth2Client, type AuthClient } from "google-auth-library";
import ical, { type VEvent } from "node-ical";
import type { Db } from "./db";
import { calendarEvents, calendars, eventAttendees } from "./schema";
import { correlateUnmatched } from "./correlate";

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

const DAYS_BACK = Number(process.env.SYNC_DAYS_BACK ?? 30);
const DAYS_AHEAD = Number(process.env.SYNC_DAYS_AHEAD ?? 14);

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
    from: new Date(now.getTime() - DAYS_BACK * 86400_000),
    to: new Date(now.getTime() + DAYS_AHEAD * 86400_000),
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

let googleClient: Promise<AuthClient | null> | null = null;

/**
 * Google credentials from GOOGLE_CREDENTIALS_FILE: a service account key (share
 * each calendar with its address) or an OAuth "authorized_user" file with a
 * refresh token (sees everything the account can).
 */
export function googleAuth(): Promise<AuthClient | null> {
  googleClient ??= (async () => {
    const file = process.env.GOOGLE_CREDENTIALS_FILE;
    if (!file) return null;
    // compose mounts the secret either way; an empty or missing file means "no Google".
    const raw = await fs.readFile(file, "utf8").catch(() => "");
    if (!raw.trim()) return null;
    const json = JSON.parse(raw);
    if (json.type === "authorized_user") {
      const client = new OAuth2Client(json.client_id, json.client_secret);
      client.setCredentials({ refresh_token: json.refresh_token });
      return client;
    }
    return new GoogleAuth({ credentials: json, scopes: ["https://www.googleapis.com/auth/calendar.readonly"] }).getClient();
  })();
  return googleClient;
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
  if (!client) throw new Error("Google Calendar isn't set up: GOOGLE_CREDENTIALS_FILE is not set.");
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
 * Adds calendars named in GOOGLE_CALENDARS ("ironclad:work@example.com,
 * pwnbook:primary") and ICS_CALENDARS ("pwnbook:https://…"), and any in the
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
      const message = (err as Error).message.slice(0, 500);
      await db.update(calendars).set({ lastError: message }).where(eq(calendars.id, cal.id));
      results.push({ calendar: cal.name, error: message });
    }
  }
  const correlation = await correlateUnmatched(db);
  return { calendars: results, correlation };
}
