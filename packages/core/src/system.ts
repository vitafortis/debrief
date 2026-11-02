/**
 * Which build each service runs, whether it's alive, and whether a newer
 * build is out. Each service calls reportStatus() every minute; the images
 * carry DEBRIEF_VERSION and DEBRIEF_COMMIT from the build.
 */
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { serviceStatus } from "./schema";
import { settingBool } from "./settings";

export const SERVICES = ["web", "transcriber", "calendar-sync", "mcp"] as const;
export type Service = (typeof SERVICES)[number];

const REPO = "vitafortis/debrief";

/** This process's build: "0.1.16" and a short commit, or "dev" outside the images. */
export function buildInfo() {
  return { version: process.env.DEBRIEF_VERSION || "dev", commit: process.env.DEBRIEF_COMMIT?.slice(0, 7) || null, builtAt: process.env.DEBRIEF_BUILT || null };
}

const started = new Date();

export async function reportStatus(db: Db, service: Service, detail: string | null = null) {
  const b = buildInfo();
  await db
    .insert(serviceStatus)
    .values({ service, version: b.version, commit: b.commit, detail, startedAt: started, seenAt: new Date() })
    .onConflictDoUpdate({ target: serviceStatus.service, set: { version: b.version, commit: b.commit, detail, startedAt: started, seenAt: sql`now()` } });
}

/** Checks in now and every minute; failures wait for the next one. */
export function startStatusReports(db: Db, service: Service, detail?: () => string | null) {
  const beat = () => reportStatus(db, service, detail?.() ?? null).catch((err) => console.warn("Couldn't report status:", (err as Error).message));
  void beat();
  return setInterval(beat, 60_000);
}

/** How long a service may go quiet before it counts as down. The transcriber reports less often mid-recording. */
const quietFor = (s: { service: string; detail: string | null }) => (s.service === "transcriber" && s.detail === "transcribing" ? 20 : 3) * 60_000;

export type ServiceHealth = {
  service: Service;
  version: string | null;
  commit: string | null;
  detail: string | null;
  seenAt: Date | null;
  state: "ok" | "down" | "unseen" | "behind";
};

/** Every service with its state; "behind" is a different build from web's (this process). */
export async function serviceHealth(db: Db, now = new Date()): Promise<ServiceHealth[]> {
  const rows = await db.select().from(serviceStatus);
  const mine = buildInfo();
  return SERVICES.map((service): ServiceHealth => {
    if (service === "web") return { service, version: mine.version, commit: mine.commit, detail: null, seenAt: now, state: "ok" };
    const r = rows.find((x) => x.service === service);
    if (!r) return { service, version: null, commit: null, detail: null, seenAt: null, state: "unseen" };
    const state = now.getTime() - r.seenAt.getTime() > quietFor(r) ? "down" : r.version !== mine.version ? "behind" : "ok";
    return { service, version: r.version, commit: r.commit, detail: r.detail, seenAt: r.seenAt, state };
  });
}

export type LatestBuild = { version: string; commit: string; builtAt: Date; url: string };

const g = globalThis as unknown as { __debriefLatest?: { at: number; value: LatestBuild | null; pending?: Promise<void> } };

/** The run number GitHub gives each image build becomes its patch version, as in .github/workflows/images.yml. */
export function versionFromRun(current: string, runNumber: number) {
  const [major = "0", minor = "1"] = current.split(".");
  return `${major}.${minor}.${runNumber}`;
}

/** Compares "0.1.9" and "0.1.16" as numbers. */
export function newerVersion(a: string, b: string) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function fetchLatest(): Promise<LatestBuild | null> {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/images.yml/runs?branch=main&event=push&status=success&per_page=1`, {
    headers: { accept: "application/vnd.github+json", "user-agent": "debrief" },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const run = ((await res.json()) as { workflow_runs?: { run_number: number; head_sha: string; updated_at: string; html_url: string }[] }).workflow_runs?.[0];
  if (!run) return null;
  return { version: versionFromRun(buildInfo().version, run.run_number), commit: run.head_sha.slice(0, 7), builtAt: new Date(run.updated_at), url: `https://github.com/${REPO}/commits/main` };
}

/**
 * The newest image build on GitHub, looked up at most once an hour and never
 * waited on: the first call starts the lookup and returns what's known.
 */
export function latestBuild(): LatestBuild | null {
  if (!settingBool("UPDATE_CHECK") || buildInfo().version === "dev") return null;
  const c = (g.__debriefLatest ??= { at: 0, value: null });
  if (!c.pending && Date.now() - c.at > 3600_000) {
    c.pending = fetchLatest()
      .then((v) => void (c.value = v))
      .catch((err) => console.warn("Couldn't check for a new version:", (err as Error).message))
      .finally(() => {
        c.at = Date.now();
        c.pending = undefined;
      });
  }
  return c.value;
}

/** The newer build, if there is one. */
export function updateAvailable() {
  const l = latestBuild();
  return l && newerVersion(l.version, buildInfo().version) ? l : null;
}
