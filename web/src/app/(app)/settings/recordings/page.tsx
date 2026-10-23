import type { Metadata } from "next";
import { folderDir, recordingsDir, storageCounts } from "@debrief/core";
import { db } from "@/lib/db";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { TestArchive } from "./test-archive";

export const metadata: Metadata = { title: "Recordings · Settings" };

export default async function RecordingsSettings() {
  const [fields, counts] = await Promise.all([fieldsFor("storage"), storageCounts(db())]);
  const nas = folderDir();
  const where = [
    counts.local ? `${counts.local} on the server only` : null,
    counts.folder ? `${counts.folder} in the NAS folder` : null,
    counts.s3 ? `${counts.s3} in S3` : null,
  ].filter(Boolean);
  return (
    <>
      <section className="card px-4 py-3 text-xs text-muted-foreground">
        <p>
          The recorder uploads to the server ({recordingsDir()}). {nas ? <>The NAS folder is mounted at {nas}.</> : <>No NAS folder is mounted; see the README, &ldquo;Archive to a NAS&rdquo;, to add one.</>}
        </p>
        <p className="mt-1">{where.length ? `Recordings: ${where.join(", ")}.` : "No recordings yet."}</p>
      </section>
      <SettingsForm
        title="Storage"
        description="Recordings are transcribed on the server, then archived. The server keeps a copy for a while so recent meetings play quickly."
        fields={fields}
        footer={<TestArchive />}
      />
    </>
  );
}
