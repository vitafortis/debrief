"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { TASK_DESTINATIONS, addTask, pushApproved, pushTask, setTaskStatus, taskInput, updateTask } from "@debrief/core";
import { db } from "@/lib/db";
import { requireViewer } from "@/lib/auth";

type Result = { ok: true; message?: string } | { ok: false; error: string };

function done(message?: string): Result {
  revalidatePath("/tasks");
  revalidatePath("/");
  revalidatePath("/meetings/[id]", "page");
  return { ok: true, message };
}
const fail = (err: unknown): Result => ({
  ok: false,
  error: err instanceof z.ZodError ? "Check the task's fields." : (err as Error).message,
});

const ids = z.array(z.uuid()).max(500);

export async function editTask(id: string, patch: unknown) {
  try {
    await requireViewer();
    const row = await updateTask(db(), z.uuid().parse(id), taskInput.partial().parse(patch));
    if (!row) return { ok: false, error: "That task is gone." } as Result;
    return done();
  } catch (err) {
    return fail(err);
  }
}

export async function addTaskToMeeting(transcriptId: string, input: unknown) {
  try {
    await requireViewer();
    await addTask(db(), z.uuid().parse(transcriptId), taskInput.parse(input));
    return done("Task added.");
  } catch (err) {
    return fail(err);
  }
}

export async function setStatus(taskIds: string[], status: "pending" | "approved" | "dismissed") {
  try {
    await requireViewer();
    const n = await setTaskStatus(db(), ids.parse(taskIds), z.enum(["pending", "approved", "dismissed"]).parse(status));
    return done(`${n.length} ${n.length === 1 ? "task" : "tasks"} ${status === "pending" ? "back to review" : status}.`);
  } catch (err) {
    return fail(err);
  }
}

/** Approves and pushes the given tasks to wherever each is headed. */
export async function approveAndPush(taskIds: string[]) {
  try {
    await requireViewer();
    const list = ids.parse(taskIds);
    await setTaskStatus(db(), list, "approved");
    const out = await pushApproved(db(), list);
    if (out.failed.length) {
      revalidatePath("/tasks");
      return { ok: false, error: `${out.pushed} sent, ${out.failed.length} failed: ${out.failed[0].error}` } as Result;
    }
    return done(`Sent ${out.pushed} ${out.pushed === 1 ? "task" : "tasks"}.`);
  } catch (err) {
    return fail(err);
  }
}

export async function pushOne(taskId: string, destination?: string) {
  try {
    await requireViewer();
    const dest = destination ? z.enum(TASK_DESTINATIONS).parse(destination) : undefined;
    const row = await pushTask(db(), z.uuid().parse(taskId), dest);
    return done(row.externalUrl ? `Created ${row.externalId}.` : "Sent to Akiflow.");
  } catch (err) {
    revalidatePath("/tasks");
    return fail(err);
  }
}
