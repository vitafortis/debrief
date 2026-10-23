import type { Metadata } from "next";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";

export const metadata: Metadata = { title: "Slack & tasks · Settings" };

export default async function IntegrationsSettings() {
  const [slack, tasks] = await Promise.all([fieldsFor("notifications"), fieldsFor("tasks")]);
  return (
    <>
      <SettingsForm title="Slack" description="Each meeting's summary and action items, posted once it's summarized. Make an incoming webhook at api.slack.com/apps." fields={slack} />
      <SettingsForm title="Task destinations" description="Where approved action items go. Each calendar picks a default (Calendars)." fields={tasks} />
    </>
  );
}
