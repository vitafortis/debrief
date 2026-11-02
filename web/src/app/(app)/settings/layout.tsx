import { settingsStatus } from "@/lib/settings-status";
import { SettingsNav } from "./nav";

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const { sections, needs } = await settingsStatus();
  return (
    <div className="md:flex md:min-h-full">
      <SettingsNav sections={sections} needs={needs} />
      <div className="min-w-0 flex-1 px-4 pt-5 pb-10 md:px-8 md:pt-8">
        <div className="mx-auto max-w-3xl md:mx-0">{children}</div>
      </div>
    </div>
  );
}
