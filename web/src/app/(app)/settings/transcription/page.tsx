import type { Metadata } from "next";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { PageHead } from "../ui";

export const metadata: Metadata = { title: "Transcription · Settings" };

export default async function TranscriptionSettings() {
  return (
    <>
      <PageHead title="Transcription">Runs on your server with Whisper, so the audio never leaves it. Changes apply from the next recording.</PageHead>
      <SettingsForm fields={await fieldsFor("transcription")} />
    </>
  );
}
