import { settingsStatus } from "@/lib/settings-status";
import { PageHeader } from "@/components/ui";
import { SettingsNav } from "./nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { sections, needs } = await settingsStatus();
  return (
    <div>
      {/* The same header as every other page; each section's own title sits under it. */}
      <PageHeader title="Settings" description="How Debrief records, transcribes and connects to your tools." />
      <div className="md:flex">
        <SettingsNav sections={sections} needs={needs} />
        <div className="min-w-0 flex-1 px-4 pb-10 md:px-8">
          <div className="mx-auto max-w-3xl md:mx-0">{children}</div>
        </div>
      </div>
    </div>
  );
}
