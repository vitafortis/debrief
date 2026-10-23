import type { Metadata } from "next";
import { headers } from "next/headers";
import { AuthCard } from "@/components/auth-card";
import { SetupForm } from "./setup-form";

export const metadata: Metadata = { title: "Set up Debrief" };

export default async function SetupPage() {
  const h = await headers();
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:3000";
  const proto = h.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return (
    <AuthCard title="Welcome. Choose the password you'll sign in with; the rest is in Settings.">
      <SetupForm address={`${proto}://${host}`} />
    </AuthCard>
  );
}
