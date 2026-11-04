import type { Metadata } from "next";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { PageHead } from "../ui";

export const metadata: Metadata = { title: "Slack & tasks · Settings" };

const mark = (text: string, hue: number) => (
  <span className="grid size-8 shrink-0 place-items-center rounded-lg text-xs font-bold text-white" style={{ background: `oklch(52% 0.15 ${hue})` }} aria-hidden>
    {text}
  </span>
);

export default async function IntegrationsSettings() {
  const fields = await fieldsFor("notifications", "tasks");
  return (
    <>
      <PageHead title="Slack & tasks">Where each recording&apos;s summary and its approved action items go. Each calendar picks its default task destination.</PageHead>
      <SettingsForm
        fields={fields}
        connect={["Slack", "Akiflow", "Linear"]}
        slots={{
          Slack: { badge: mark("S", 330), note: "Posts each recording's summary and action items once it's summarized." },
          Akiflow: { badge: mark("Ak", 285), note: "Approved tasks go to a Zapier, Make or IFTTT hook." },
          Linear: { badge: mark("L", 265), note: "Approved tasks become issues." },
        }}
      />
    </>
  );
}
