"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireViewer } from "@/lib/auth";
import { CONTEXT_COOKIE } from "@/lib/context";

export async function setContext(context: string | null) {
  await requireViewer();
  const jar = await cookies();
  if (context) jar.set(CONTEXT_COOKIE, context, { path: "/", sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  else jar.delete(CONTEXT_COOKIE);
  revalidatePath("/", "layout");
}
