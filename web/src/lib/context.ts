import "server-only";
import { cookies } from "next/headers";

export const CONTEXT_COOKIE = "debrief-context";

/** The calendar context the sidebar is filtered to ("acme", "lumen"), or null for all. */
export async function currentContext() {
  const v = (await cookies()).get(CONTEXT_COOKIE)?.value;
  return v && v !== "all" ? v : null;
}
