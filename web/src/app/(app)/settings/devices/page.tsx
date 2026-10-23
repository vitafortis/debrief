import type { Metadata } from "next";
import { listApiKeys, listContexts, listDevices, publicUrl } from "@debrief/core";
import { db } from "@/lib/db";
import { fmtAgo } from "@/lib/format";
import { ApiKeys, DeviceSettings } from "../recorder-settings";

export const metadata: Metadata = { title: "Devices & keys · Settings" };

export default async function DevicesSettings() {
  const d = db();
  const [keys, devs, contexts] = await Promise.all([listApiKeys(d), listDevices(d), listContexts(d)]);
  return (
    <>
      <ApiKeys
        publicUrl={publicUrl() || "http://<server>:3000"}
        keys={keys.map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, created: fmtAgo(k.createdAt), lastUsed: k.lastUsedAt ? fmtAgo(k.lastUsedAt) : null }))}
      />
      <DeviceSettings contexts={contexts} devices={devs.map((x) => ({ ...x, lastActive: x.lastActive ? fmtAgo(x.lastActive) : null }))} />
    </>
  );
}
