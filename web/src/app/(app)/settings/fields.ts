import "server-only";
import { SETTINGS, refreshSettings, settingForDisplay, type SettingGroup } from "@debrief/core/settings";
import { db } from "@/lib/db";
import type { Field } from "./settings-form";

/** These groups' settings for SettingsForm, in registry order, with secrets left out. */
export async function fieldsFor(...groups: SettingGroup[]): Promise<Field[]> {
  await refreshSettings(db());
  return SETTINGS.filter((d) => groups.includes(d.group) && !d.hidden).map((d) => ({ ...d, ...settingForDisplay(d) }));
}
