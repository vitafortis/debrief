"use client";

import { testArchiveAction } from "@/actions/settings";
import { useAction } from "@/components/task-item";

/** Writes and deletes a small file in the archive with the saved settings. */
export function TestArchive() {
  const [pending, go] = useAction();
  return (
    <button type="button" className="btn btn-secondary btn-sm" disabled={pending} onClick={() => go(() => testArchiveAction())}>
      Test the archive
    </button>
  );
}
