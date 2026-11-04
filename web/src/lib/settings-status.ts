import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import {
  aiConfigured,
  aiLabel,
  archiveTarget,
  calendars,
  integrationStatus,
  listDevices,
  recordings,
  serviceHealth,
  setting,
  slackConfigured,
  updateAvailable,
  type ServiceHealth,
} from "@debrief/core";
import { db } from "@/lib/db";
import { authMode, oidcEnabled, oidcName } from "@/lib/auth";
import { fmtAgo } from "@/lib/format";

export type SectionKey = "overview" | "account" | "devices" | "calendars" | "transcription" | "storage" | "ai" | "integrations";
export type Status = "ok" | "need" | "off";
export type SectionStatus = { status: Status; value: string; detail: string };

export const SERVICE_NAMES: Record<ServiceHealth["service"], string> = { web: "Web", transcriber: "Transcriber", "calendar-sync": "Calendar sync", mcp: "MCP" };

/** What each service's state means, in a line. */
export function serviceLine(s: ServiceHealth, webVersion: string) {
  if (s.service === "web") return "This page";
  if (s.state === "unseen") return "Hasn't checked in. Is its container running this version?";
  const seen = s.seenAt ? `checked in ${fmtAgo(s.seenAt)}` : "";
  if (s.state === "down") return `Not running? Last ${seen}.`;
  if (s.state === "behind") return `Runs ${s.version}, web runs ${webVersion}. Redeploy the stack so they match.`;
  return [s.detail, seen].filter(Boolean).join(" · ");
}

/** Every section's dot, its value in the phone list, and its line on Overview. */
export async function settingsStatus(): Promise<{ sections: Record<Exclude<SectionKey, "overview">, SectionStatus>; services: ServiceHealth[]; needs: number }> {
  const d = db();
  const [cals, devices, [last], queue, services] = await Promise.all([
    d.select({ enabled: calendars.enabled, lastError: calendars.lastError, lastSyncedAt: calendars.lastSyncedAt }).from(calendars),
    listDevices(d),
    d.select({ at: recordings.createdAt }).from(recordings).where(eq(recordings.status, "done")).orderBy(desc(recordings.createdAt)).limit(1),
    d.select({ status: recordings.status, n: sql<number>`count(*)::int` }).from(recordings).groupBy(recordings.status),
    serviceHealth(d),
  ]);
  const counts = Object.fromEntries(queue.map((q) => [q.status, q.n]));
  const on = cals.filter((c) => c.enabled);
  const broken = on.filter((c) => c.lastError);
  const lastSync = on.map((c) => c.lastSyncedAt).filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
  const transcriber = services.find((s) => s.service === "transcriber")!;
  const sync = services.find((s) => s.service === "calendar-sync")!;
  const archive = archiveTarget();
  const i = integrationStatus();
  const connected = [slackConfigured() && "Slack", i.akiflow && "Akiflow", i.linear && "Linear"].filter(Boolean) as string[];
  const mode = authMode();
  const recent = devices.filter((x) => x.lastActive);

  const sections: Record<Exclude<SectionKey, "overview">, SectionStatus> = {
    account: {
      status: "ok",
      value: mode === "none" ? "No sign-in" : oidcEnabled() ? oidcName() : "Password",
      detail: mode === "none" ? "Sign-in is off (AUTH_MODE=none): a proxy in front should guard Debrief." : oidcEnabled() ? `Through ${oidcName()}, with the password as a fallback.` : "With your password.",
    },
    devices: {
      status: devices.length ? "ok" : "need",
      value: devices.length ? `${devices.length} device${devices.length === 1 ? "" : "s"}` : "None yet",
      detail: recent.length
        ? recent
            .slice(0, 2)
            .map((x) => `${x.badge.label} active ${fmtAgo(x.lastActive!)}`)
            .join(", ") + "."
        : "No recordings yet. Install the recorder on your Mac or PC.",
    },
    calendars: {
      status: !on.length || broken.length || sync.state === "down" ? "need" : "ok",
      value: on.length ? `${on.length} syncing` : "None",
      detail: !on.length
        ? "No calendar connected, so recordings stay untitled."
        : broken.length
          ? `${broken.length} of ${on.length} can't sync. Open it to see why.`
          : sync.state === "down"
            ? "The calendar-sync service isn't running."
            : lastSync
              ? `${on.length} calendar${on.length === 1 ? "" : "s"}, synced ${fmtAgo(lastSync)}.`
              : "Waiting for the first sync.",
    },
    transcription: {
      status: transcriber.state === "down" || counts.error ? "need" : "ok",
      value: setting("WHISPER_MODEL"),
      detail:
        transcriber.state === "down"
          ? "The transcriber isn't running."
          : [
              last ? `Last transcript ${fmtAgo(last.at)}.` : "Nothing transcribed yet.",
              counts.pending && `${counts.pending} waiting.`,
              counts.processing && `${counts.processing} in progress.`,
              counts.error && `${counts.error} failed.`,
            ]
              .filter(Boolean)
              .join(" "),
    },
    storage: {
      status: archive === "off" ? "off" : "ok",
      value: archive === "off" ? "On the server" : archive === "folder" ? "NAS folder" : "S3",
      detail: archive === "folder" ? "Copied to the NAS folder once transcribed." : archive === "s3" ? `Copied to ${setting("S3_BUCKET") || "S3"} once transcribed.` : "Recordings stay on the server.",
    },
    ai: {
      status: aiConfigured() ? "ok" : "need",
      value: aiConfigured() ? aiLabel().replace(/ \(.*/, "") : "Off",
      detail: aiConfigured() ? `${aiLabel()} writes the summaries and action items.` : "No provider yet. Pick Claude, OpenAI, Gemini or your own model for summaries and action items.",
    },
    integrations: {
      status: connected.length ? "ok" : "off",
      value: connected.length ? connected.join(", ") : "None",
      detail: connected.length ? `${connected.join(", ")} connected.` : "Nothing connected. Optional.",
    },
  };
  const versionTrouble = services.some((s) => s.state !== "ok") || !!updateAvailable();
  const needs = Object.values(sections).filter((s) => s.status === "need").length + (versionTrouble ? 1 : 0);
  return { sections, services, needs };
}
