/** Times are shown in the owner's zone (TZ), on the server, so pages render the same everywhere. */
export const TZ = process.env.TZ || "UTC";

const f = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts });
const time = f({ hour: "numeric", minute: "2-digit" });
const day = f({ weekday: "short", month: "short", day: "numeric" });
const dayYear = f({ month: "short", day: "numeric", year: "numeric" });
const iso = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export const fmtTime = (d: Date) => time.format(d);
export const fmtDay = (d: Date) => day.format(d);
export const fmtDayYear = (d: Date) => dayYear.format(d);
export const fmtDateTime = (d: Date) => `${day.format(d)}, ${time.format(d)}`;
/** YYYY-MM-DD in TZ. */
export const isoDay = (d: Date) => iso.format(d);

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

/** Midnight in TZ for the day containing `d`, as an instant. */
export function startOfDay(d: Date) {
  const [y, m, dd] = isoDay(d).split("-").map(Number);
  return zonedMidnight(y, m, dd);
}

export function zonedMidnight(y: number, m: number, d: number) {
  // Find the UTC instant whose TZ wall-clock time is y-m-d 00:00.
  const guess = Date.UTC(y, m - 1, d);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  }).formatToParts(new Date(guess));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"));
  return new Date(guess - (asUtc - guess));
}

export function addDays(d: Date, n: number) {
  const [y, m, dd] = isoDay(d).split("-").map(Number);
  return zonedMidnight(y, m, dd + n);
}

/** Minutes since midnight in TZ. */
export function minutesOfDay(d: Date) {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: TZ, hourCycle: "h23", hour: "numeric", minute: "numeric" }).formatToParts(d);
  return Number(p.find((x) => x.type === "hour")?.value) * 60 + Number(p.find((x) => x.type === "minute")?.value);
}
