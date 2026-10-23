import { PageHeader } from "@/components/ui";
import { SettingsTabs } from "./tabs";

export default function SettingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <PageHeader title="Settings" description="Everything Debrief needs, in one place. A value set in .env wins and shows a lock." />
      <SettingsTabs />
      <div className="space-y-6 px-4 pt-6 pb-10 md:px-8">{children}</div>
    </div>
  );
}
