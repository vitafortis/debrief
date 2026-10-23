import type { Metadata } from "next";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";

export const metadata: Metadata = { title: "Transcription · Settings" };

export default async function TranscriptionSettings() {
  return (
    <SettingsForm
      title="Transcription"
      description="faster-whisper on the server, with pyannote for speaker labels. The transcriber picks up changes before its next recording."
      fields={await fieldsFor("transcription")}
    />
  );
}
