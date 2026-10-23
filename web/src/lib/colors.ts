// Green last: it sits too close to the emerald accent.
const SERIES = ["var(--series-2)", "var(--series-1)", "var(--series-4)", "var(--series-3)"];

/** A steady colour per calendar context, by its place in the sorted list. */
export function contextColor(context: string | null | undefined, all: string[]) {
  if (!context) return "var(--muted-foreground)";
  const i = all.indexOf(context);
  return SERIES[(i < 0 ? 0 : i) % SERIES.length];
}
