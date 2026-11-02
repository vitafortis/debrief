import type { Metadata } from "next";
import { folderDir, recordingsDir, storageCounts } from "@debrief/core";
import { db } from "@/lib/db";
import { fieldsFor } from "../fields";
import { SettingsForm } from "../settings-form";
import { PageHead } from "../ui";
import { TestArchive } from "./test-archive";

export const metadata: Metadata = { title: "Storage · Settings" };

export default async function StorageSettings() {
  const [fields, counts] = await Promise.all([fieldsFor("storage"), storageCounts(db())]);
  const nas = folderDir();
  const total = (counts.local ?? 0) + (counts.folder ?? 0) + (counts.s3 ?? 0);
  const where = [
    counts.local ? `${counts.local} on the server only` : null,
    counts.folder ? `${counts.folder} in the NAS folder` : null,
    counts.s3 ? `${counts.s3} in S3` : null,
  ].filter(Boolean);
  return (
    <>
      <PageHead title="Storage">
        Recordings upload to the server ({recordingsDir()}) and are transcribed there, then can be archived somewhere roomier.{" "}
        {total ? `${total} recording${total === 1 ? "" : "s"}: ${where.join(", ")}.` : "No recordings yet."}
      </PageHead>
      <SettingsForm
        fields={fields.map((f) =>
          f.key === "ARCHIVE" && f.options
            ? { ...f, options: f.options.map((o) => (o.value === "folder" ? { ...o, detail: nas ? `Mounted at ${nas}.` : "None mounted yet: see the README, “Archive to a NAS”." } : o)) }
            : f
        )}
        slots={{
          Archive: {
            footer: (
              <>
                <TestArchive />
                <span className="text-xs text-muted-foreground">Writes and removes a small file, with what&apos;s saved.</span>
              </>
            ),
          },
        }}
      />
    </>
  );
}
