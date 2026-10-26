import type { Metadata } from "next";
import { listApiKeys, listContexts, listDevices, publicUrl } from "@debrief/core";
import { db } from "@/lib/db";
import { Download } from "lucide-react";
import { fmtAgo } from "@/lib/format";
import { ApiKeys, DeviceSettings } from "../recorder-settings";

export const metadata: Metadata = { title: "Devices & keys · Settings" };

export default async function DevicesSettings() {
  const d = db();
  const [keys, devs, contexts] = await Promise.all([listApiKeys(d), listDevices(d), listContexts(d)]);
  const url = publicUrl() || "http://<server>:3000";
  return (
    <>
      <RecorderDownload publicUrl={url} />
      <ApiKeys
        publicUrl={url}
        keys={keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, created: fmtAgo(k.createdAt), lastUsed: k.lastUsedAt ? fmtAgo(k.lastUsedAt) : null }))}
      />
      <DeviceSettings contexts={contexts} devices={devs.map((x) => ({ ...x, lastActive: x.lastActive ? fmtAgo(x.lastActive) : null }))} />
    </>
  );
}

// Release assets keep the same names every version (see .github/workflows/recorder.yml), so these always fetch the newest.
const RELEASES = "https://github.com/vitafortis/debrief/releases";

function RecorderDownload({ publicUrl }: { publicUrl: string }) {
  return (
    <section id="recorder" className="card overflow-hidden">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">Debrief Recorder</h2>
        <p className="text-xs text-muted-foreground">Records your calls on a Mac or PC and sends them here.</p>
      </div>
      <div className="flex flex-wrap gap-2 border-b border-border px-4 py-3">
        <a href={`${RELEASES}/latest/download/Debrief-Recorder-macOS.dmg`} className="btn btn-primary btn-sm">
          <Download /> Mac
        </a>
        <a href={`${RELEASES}/latest/download/Debrief-Recorder-Windows.exe`} className="btn btn-primary btn-sm">
          <Download /> Windows
        </a>
        <a href={`${RELEASES}/latest`} className="btn btn-ghost btn-sm" target="_blank" rel="noreferrer">
          Release notes
        </a>
      </div>
      <ol className="list-decimal space-y-1.5 px-4 py-3 pl-8 text-xs text-muted-foreground">
        <li>
          Install it. It isn&apos;t signed yet: on a Mac, drag it to Applications, then right-click it → <b className="font-medium text-foreground">Open</b> the first time. On
          Windows, at the SmartScreen warning choose <b className="font-medium text-foreground">More info → Run anyway</b>.
        </li>
        <li>Create a key for this computer below.</li>
        <li>
          In the recorder&apos;s Settings, enter <code className="font-mono text-foreground">{publicUrl}</code> and the key, then{" "}
          <b className="font-medium text-foreground">Test connection</b> and <b className="font-medium text-foreground">Save</b>.
        </li>
        <li>Allow the microphone, and on a Mac System Audio Recording, the first time it records.</li>
      </ol>
    </section>
  );
}
