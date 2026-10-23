const dueFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** "Sat, Oct 24" from a plain YYYY-MM-DD date (no time zone to shift it). */
export const fmtDue = (d: string) => dueFmt.format(new Date(`${d}T12:00:00Z`));
