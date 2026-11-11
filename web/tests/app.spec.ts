import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

// These tests change the seeded data, so a retry would start from a different state.
test.describe.configure({ retries: 0 });

async function signIn(page: Page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-password");
  await page.click("button:has-text('Sign in')");
  await expect(page).toHaveURL("/");
}

test("signing in: wrong password is refused, the right one lands on today", async ({ page }) => {
  await page.goto("/recordings");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Frecordings/);
  await page.fill("#pw", "nope");
  await page.click("button:has-text('Sign in')");
  await expect(page.getByText("That password isn't right.")).toBeVisible();
  await page.fill("#pw", "e2e-password");
  await page.click("button:has-text('Sign in')");
  await expect(page).toHaveURL("/recordings");
});

test("API routes need a session", async ({ request }) => {
  expect((await request.get("/api/audio/00000000-0000-0000-0000-000000000000")).status()).toBe(401);
  expect((await request.get("/api/recordings/00000000-0000-0000-0000-000000000000/export")).status()).toBe(401);
  expect((await request.get("/api/health")).status()).toBe(200);
});

test("the recorder API needs an API key, not a session", async ({ request }) => {
  expect((await request.get("/api/recorder/ping")).status()).toBe(401);
  expect((await request.get("/api/recorder/ping", { headers: { authorization: "Bearer dbk_made-up" } })).status()).toBe(401);
  const put = await request.put("/api/recorder/recordings/3b8f1c2a-0000-4000-8000-0000000000e2", { data: { device: "x", startedAt: new Date().toISOString() } });
  expect(put.status()).toBe(401);
});

test.describe("signed in", () => {
  test.beforeEach(async ({ page }) => signIn(page));

  test("home shows setup, the queue, the calendar and what needs cleanup", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Finish setting up Debrief" })).toBeVisible();
    await expect(page.locator(".badge", { hasText: "62%" })).toContainText("Transcribing");
    const calendar = page.getByRole("region", { name: "Calendar" });
    await expect(calendar.getByText("Platform standup").first()).toBeVisible();
    await calendar.getByRole("link", { name: "Day", exact: true }).click();
    await expect(page).toHaveURL(/view=day/);
    const cleanup = page.getByRole("region", { name: "Needs cleanup" });
    await expect(cleanup.getByText("Untitled")).toBeVisible();
    await expect(cleanup.locator(".badge-device", { hasText: "Desktop" }).first()).toBeVisible();
    await expect(cleanup.getByText("4 tasks to review")).toBeVisible();
  });

  test("a recording: event, transcript with names, find, rename a speaker", async ({ page }) => {
    await page.goto("/recordings");
    await page.getByRole("link", { name: /Northwind onboarding call/ }).click();
    await expect(page.getByRole("heading", { name: "Northwind onboarding call" })).toBeVisible();
    await expect(page.getByText("Matched by time (100% overlap).")).toBeVisible();
    await expect(page.getByText("Kai Tanaka").first()).toBeVisible();
    await page.getByPlaceholder("Find in transcript").fill("Okta");
    await expect(page.locator("mark", { hasText: "Okta" })).toHaveCount(1);
    await page.getByLabel("Name for Speaker 3").fill("Nate");
    await page.getByRole("button", { name: "Save names" }).click();
    await expect(page.getByText("Nate").first()).toBeVisible();
  });

  test("recordings can be found by words, attendee, device and date", async ({ page }) => {
    await page.goto("/recordings");
    await page.getByPlaceholder("Title or words said").fill("Okta");
    await page.getByRole("button", { name: "Search" }).click();
    await expect(page).toHaveURL(/q=Okta/);
    await expect(page.getByRole("link", { name: /Northwind onboarding call/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Platform standup/ })).toHaveCount(0);
    await expect(page.locator("mark", { hasText: "Okta" }).first()).toBeVisible();

    await page.goto("/recordings?attendee=Jules");
    await expect(page.getByRole("link", { name: /lumen roadmap/ })).toBeVisible();
    await expect(page.getByRole("link", { name: /Northwind onboarding call/ })).toHaveCount(0);

    await page.goto("/recordings?device=win-desktop&q=timeline");
    await expect(page.getByText("No recordings match")).toBeVisible();
    await page.getByRole("link", { name: "Clear the search" }).click();
    await expect(page.getByRole("link", { name: /Platform standup/ })).toBeVisible();
    // The old address still works, and the list can show just what hasn't been opened.
    await page.goto("/meetings");
    await expect(page).toHaveURL(/\/recordings$/);
    await page.getByRole("link", { name: /^To review/ }).first().click();
    await expect(page).toHaveURL(/show=new/);
    await expect(page.getByText("Transcribed, and not opened yet.")).toBeVisible();
  });

  test("a recording can be linked to another event by hand and back", async ({ page }) => {
    await page.goto("/recordings?show=unmatched");
    await page.getByRole("link", { name: /Quick call/ }).click();
    await expect(page.getByText("No event overlapped this recording enough to match.")).toBeVisible();
    const pick = page.getByLabel("Calendar event");
    const option = await pick.locator("option", { hasText: "Northwind onboarding call" }).getAttribute("value");
    await pick.selectOption(option!);
    await expect(page.getByText("Chosen by hand.")).toBeVisible();
    await pick.selectOption("");
    await expect(page.getByText("No event overlapped this recording enough to match.")).toBeVisible();
  });

  test("export as Markdown", async ({ page }) => {
    await page.goto("/recordings");
    await page.getByRole("link", { name: /lumen roadmap/ }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Markdown" }).click()]);
    const body = await (await download.createReadStream()).toArray();
    const md = Buffer.concat(body).toString();
    expect(md).toContain("# lumen roadmap");
    expect(md).toContain("**Jules Moreau** `0:04`");
    expect(md).toContain("- [x] Fix the Stripe webhook");
    expect(md).toContain("## Shared screens\n\n`4:12`\n\nlumen · Next release");
  });

  test("a recording's shared screens: the picture, its text, and a jump to that moment", async ({ page }) => {
    await page.goto("/recordings");
    await page.getByRole("link", { name: /lumen roadmap/ }).click();
    await page.getByRole("tab", { name: /Shared screens/ }).click();
    const shot = page.getByRole("img", { name: "Screen at 4:12" });
    await expect(shot).toBeVisible();
    expect(await shot.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1280);
    await page.getByText("Text on this screen").click();
    await expect(page.getByText("Reusable finding blocks and severity tables")).toBeVisible();
    await page.getByRole("tab", { name: "Transcript" }).click();
    await expect(page.getByText("Every pentester we talked to asked for it.")).toBeVisible();
  });

  test("a recording's window video sits above the audio, and can be hidden", async ({ page }) => {
    // Where the recorder's upload would have put it (RECORDINGS_DIR in playwright.config.ts), ten seconds in.
    const dir = path.join(os.tmpdir(), "debrief-e2e-recordings", "win-desktop", "lumen_roadmap", "video");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "000010000.mp4"), Buffer.from("\0\0\0\x18ftypmp42"));
    try {
      await page.goto("/recordings");
      await page.getByRole("link", { name: /lumen roadmap/ }).click();
      await expect(page.getByText("The meeting window wasn't showing yet.")).toBeVisible();
      await page.getByRole("button", { name: "Video" }).click();
      await expect(page.getByText("The meeting window wasn't showing yet.")).toBeHidden();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("tasks: edit, approve, dismiss and restore", async ({ page }) => {
    await page.goto("/tasks");
    const row = page.locator("div.\\@container", { hasText: "Draft the new pricing page" });
    await row.getByRole("button", { name: /Draft the new pricing page/ }).click();
    await page.locator("textarea").fill("Draft the new pricing page with annual plans");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const edited = page.locator("div.\\@container", { hasText: "with annual plans" });
    await edited.getByRole("button", { name: "Approve" }).click();
    await expect(edited).toHaveCount(0);
    await page.getByRole("link", { name: /Approved/ }).click();
    await expect(page.getByText("Draft the new pricing page with annual plans")).toBeVisible();

    await page.goto("/tasks");
    const runbook = page.locator("div.\\@container", { hasText: "Update the runbook" });
    await runbook.getByTitle("Dismiss").click();
    await expect(runbook).toHaveCount(0);
    await page.goto("/tasks?status=dismissed");
    const dismissed = page.locator("div.\\@container", { hasText: "Update the runbook" });
    await dismissed.getByRole("button", { name: "Restore" }).click();
    // Wait for the save to land (the row leaves the Dismissed list) before moving on.
    await expect(dismissed).toHaveCount(0);
    await page.goto("/tasks");
    await expect(page.getByText("Update the runbook")).toBeVisible();
  });

  test("Send is off until the destination is set up", async ({ page }) => {
    await page.goto("/tasks");
    await expect(page.getByText("Neither Akiflow nor Linear is set up yet")).toBeVisible();
    await expect(page.getByRole("button", { name: "Send", exact: true }).first()).toBeDisabled();
  });

  test("search shows matching lines with speakers and links into the recording", async ({ page }) => {
    await page.goto("/search?q=Stripe%20webhook");
    await expect(page.getByText("1 recording matching")).toBeVisible();
    const line = page.getByRole("link", { name: /Alex.*Stripe webhook bug/ });
    await expect(line.locator("mark").first()).toBeVisible();
    await line.click();
    await expect(page).toHaveURL(/\/recordings\/[0-9a-f-]+\?q=Stripe%20webhook&t=\d+/);
    await expect(page.getByRole("heading", { name: "lumen roadmap" })).toBeVisible();
  });

  test("the calendar context filter narrows every page", async ({ page }) => {
    await page.getByRole("button", { name: "lumen" }).click();
    await expect(page.getByRole("button", { name: "lumen" })).toHaveClass(/bg-accent /);
    await page.goto("/recordings");
    await expect(page.getByText("lumen roadmap")).toBeVisible();
    await expect(page.getByText("Northwind onboarding call")).toHaveCount(0);
    // The seed puts these three days either side of today, so look at each day rather than this week.
    const day = (n: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(Date.now() + n * 86400_000));
    await page.goto(`/calendar?view=day&date=${day(3)}`);
    await expect(page.getByText("Beta demo")).toBeVisible();
    await page.goto(`/calendar?view=day&date=${day(-3)}`);
    await expect(page.getByText("Quarterly planning")).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByText("Quarterly planning")).toBeVisible();
  });

  test("settings: a bad ICS link is refused, and a calendar can be switched off", async ({ page }) => {
    await page.goto("/settings/calendars");
    await page.getByRole("button", { name: "Add a calendar" }).click();
    await page.getByRole("radio", { name: /Outlook, iCloud or other/ }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("ICS link").fill("not a link");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByRole("button", { name: "Add and sync" }).click();
    await expect(page.getByText("An ICS link starts with https://.")).toBeVisible();
    await page.getByLabel("Sync lumen").click();
    await expect(page.getByLabel("Sync lumen")).toHaveAttribute("aria-checked", "false");
    await page.goto("/");
    await expect(page.getByRole("button", { name: "lumen" })).toHaveCount(0);
    await page.goto("/settings/calendars");
    await page.getByLabel("Sync lumen").click();
    await expect(page.getByText(/events · synced/)).toHaveCount(2);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "lumen" })).toBeVisible();
    // A good link is added, and the form closes so another can be added.
    await page.goto("/settings/calendars");
    await page.getByRole("button", { name: "Add a calendar" }).click();
    await page.getByRole("radio", { name: /Outlook, iCloud or other/ }).click();
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByLabel("ICS link").fill("https://calendar.example.com/team.ics");
    await page.getByRole("button", { name: "Next" }).click();
    await page.getByPlaceholder("Client calendar").fill("Team offsite");
    await page.getByRole("button", { name: "Add and sync" }).click();
    await expect(page.getByText("Team offsite")).toBeVisible();
    await expect(page.getByRole("button", { name: "Add and sync" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Add a calendar" })).toBeVisible();
  });

  test("settings: the sections list shows each one's state, and the old addresses still work", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
    await expect(page.getByText("Version", { exact: true })).toBeVisible();
    await page.goto("/settings/claude");
    await expect(page).toHaveURL(/\/settings\/ai$/);
    await page.goto("/settings/recordings");
    await expect(page).toHaveURL(/\/settings\/storage$/);
  });

  test("a key from Settings lets the recorder upload; then its device can be tagged and the key revoked", async ({ page, request }) => {
    await page.goto("/settings/devices");
    await page.getByLabel("Key name").fill("E2E MacBook");
    await page.getByRole("button", { name: "Create key" }).click();
    const key = (await page.locator("code", { hasText: /^dbk_/ }).textContent())!.trim();
    const auth = { authorization: `Bearer ${key}` };

    const ping = await request.get("/api/recorder/ping?device=E2E%20Mac", { headers: auth });
    expect(await ping.json()).toMatchObject({ ok: true, key: "E2E MacBook", device: "e2e-mac", context: null });
    const id = crypto.randomUUID();
    const base = `/api/recorder/recordings/${id}`;
    const started = await request.put(base, { headers: auth, data: { device: "E2E Mac", startedAt: new Date().toISOString(), app: "zoom.us" } });
    expect(await started.json()).toMatchObject({ status: "recording", offset: 0 });
    const body = Buffer.from("OggS fake audio for the test");
    expect(await (await request.patch(`${base}/audio`, { headers: { ...auth, "upload-offset": "0" }, data: body })).json()).toEqual({ offset: body.length });
    const stale = await request.patch(`${base}/audio`, { headers: { ...auth, "upload-offset": "0" }, data: body });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).offset).toBe(body.length);
    const done = await request.post(`${base}/complete`, { headers: auth, data: { bytes: body.length, durationSecs: 3 } });
    // Queued for the transcriber straight away.
    expect(await done.json()).toMatchObject({ status: "completed", recording: "pending" });

    await page.reload();
    const ctx = page.getByLabel("Context for e2e-mac");
    await expect(ctx).toHaveValue("");
    await ctx.selectOption("lumen");
    await expect(page.getByLabel("Tasks from e2e-mac go to")).toBeEnabled();
    await page.reload();
    await expect(page.getByLabel("Context for e2e-mac")).toHaveValue("lumen");

    page.once("dialog", (d) => d.accept());
    await page.locator("div", { hasText: /^E2E MacBook/ }).getByTitle("Revoke").click();
    await expect(page.getByText("Key revoked.")).toBeVisible();
    expect((await request.get("/api/recorder/ping", { headers: auth })).status()).toBe(401);
  });

  test("settings: a saved setting sticks, a secret isn't shown back, and .env values are locked", async ({ page }) => {
    await page.goto("/settings/ai");
    await expect(page.getByRole("radio", { name: /Anthropic/ })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("claude-haiku-5-5");
    await page.getByLabel("Model", { exact: true }).selectOption("__other");
    await page.getByLabel("Model name").fill("claude-e2e-model");
    await page.getByLabel("API key").fill("sk-ant-e2e-not-real");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Model name")).toHaveValue("claude-e2e-model");
    await expect(page.getByLabel("API key")).toHaveValue("");
    await expect(page.getByLabel("API key")).toHaveAttribute("placeholder", /Saved/);
    expect(await page.content()).not.toContain("sk-ant-e2e-not-real");
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByLabel("Model", { exact: true }).selectOption("claude-sonnet-5-5");
    await expect(page.getByLabel("Model name")).toHaveCount(0);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.", { exact: true })).toBeVisible();

    // Picking another provider shows its own key and model.
    await page.getByRole("radio", { name: /^OpenAI/ }).click();
    await expect(page.getByLabel("Model", { exact: true })).toHaveValue("gpt-5-mini");
    await page.getByRole("button", { name: "Discard" }).click();

    // PUBLIC_URL, TZ and OWNER_NAME come from the test server's environment.
    await page.goto("/settings/account");
    await expect(page.getByText(".env", { exact: true })).toHaveCount(3);
    await expect(page.getByText(/Set by DEBRIEF_PASSWORD in the environment/)).toBeVisible();
  });

  test("recordings: what's still transcribing shows above the list, and a recording can be deleted", async ({ page }) => {
    await page.goto("/recordings");
    const queue = page.getByRole("region", { name: "In progress" });
    await expect(queue.getByText("API v2 design review")).toBeVisible();
    await expect(queue.getByText("Transcribing")).toBeVisible();
    // The recording the upload test sent is waiting for the transcriber: delete it from here.
    page.once("dialog", (d) => d.accept());
    await queue.getByRole("button", { name: /^Delete Recording from/ }).click();
    await expect(page.getByText("Deleted.")).toBeVisible();
    await expect(queue.getByRole("button", { name: /^Delete Recording from/ })).toHaveCount(0);

    // A finished recording, from its own page.
    await page.getByRole("link", { name: /Quick call/ }).click();
    page.once("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Delete Quick call" }).click();
    await expect(page).toHaveURL(/\/recordings$/);
    await expect(page.getByRole("link", { name: /Quick call/ })).toHaveCount(0);
  });
});
