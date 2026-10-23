import "server-only";
import { SETTINGS, refreshSettings, settingForDisplay, type SettingGroup } from "@debrief/core/settings";
import { db } from "@/lib/db";
import type { Field } from "./settings-form";

/** A group's settings for SettingsForm, with secrets left out. */
export async function fieldsFor(group: SettingGroup, keys?: string[]): Promise<Field[]> {
  await refreshSettings(db());
  return SETTINGS.filter((d) => d.group === group && !d.hidden && (!keys || keys.includes(d.key))).map((d) => ({ ...d, ...settingForDisplay(d) }));
}
