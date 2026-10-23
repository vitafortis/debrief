import { timeZone } from "@debrief/core/settings";

/** Times are shown in the owner's zone (Settings → General), on the server, so pages render the same everywhere. */
export const tz = () => timeZone();

const cache = new Map<string, Intl.DateTimeFormat>();
/** A formatter in the owner's zone, made once per zone. */
export function fmt(opts: Intl.DateTimeFormatOptions, locale = "en-US") {
  const zone = tz();
  const key = `${zone}|${locale}|${JSON.stringify(opts)}`;
  let f = cache.get(key);
  if (!f) cache.set(key, (f = new Intl.DateTimeFormat(locale, { timeZone: zone, ...opts })));
  return f;
}

export const fmtTime = (d: Date) => fmt({ hour: "numeric", minute: "2-digit" }).format(d);
export const fmtDay = (d: Date) => fmt({ weekday: "short", month: "short", day: "numeric" }).format(d);
export const fmtDayYear = (d: Date) => fmt({ month: "short", day: "numeric", year: "numeric" }).format(d);
export const fmtDateTime = (d: Date) => `${fmtDay(d)}, ${fmtTime(d)}`;
/** YYYY-MM-DD in the owner's zone. */
export const isoDay = (d: Date) => fmt({ year: "numeric", month: "2-digit", day: "2-digit" }, "en-CA").format(d);

export function fmtDuration(secs: number | null | undefined) {
  if (!secs) return "—";
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60 ? `${m % 60} min` : ""}`.trim();
}

/** "2 h ago", "yesterday", or the date. */
export function fmtAgo(d: Date, now = new Date()) {
  const s = (now.getTime() - d.getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400 && isoDay(d) === isoDay(now)) return `${Math.floor(s / 3600)} h ago`;
  if (isoDay(d) === isoDay(new Date(now.getTime() - 86400_000))) return "yesterday";
  return fmtDay(d);
}

/** Midnight in the owner's zone for the day containing `d`, as an instant. */
export function startOfDay(d: Date) {
  const [y, m, dd] = isoDay(d).split("-").map(Number);
  return zonedMidnight(y, m, dd);
}

export function zonedMidnight(y: number, m: number, d: number) {
  // Find the UTC instant whose wall-clock time is y-m-d 00:00.
  const guess = Date.UTC(y, m - 1, d);
  const parts = fmt({ hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (asUtc - guess));
}

export function addDays(d: Date, n: number) {
  const [y, m, dd] = isoDay(d).split("-").map(Number);
  return zonedMidnight(y, m, dd + n);
}

/** Minutes since midnight in the owner's zone. */
export function minutesOfDay(d: Date) {
  const p = fmt({ hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(d);
  return Number(p.find((x) => x.type === "hour")?.value) * 60 + Number(p.find((x) => x.type === "minute")?.value);
}
