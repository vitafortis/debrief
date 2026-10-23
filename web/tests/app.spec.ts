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
  await page.goto("/meetings");
  await expect(page).toHaveURL(/\/login\?callbackUrl=%2Fmeetings/);
  await page.fill("#pw", "nope");
  await page.click("button:has-text('Sign in')");
  await expect(page.getByText("That password isn't right.")).toBeVisible();
  await page.fill("#pw", "e2e-password");
  await page.click("button:has-text('Sign in')");
  await expect(page).toHaveURL("/meetings");
});

test("API routes need a session", async ({ request }) => {
  expect((await request.get("/api/audio/00000000-0000-0000-0000-000000000000")).status()).toBe(401);
  expect((await request.get("/api/meetings/00000000-0000-0000-0000-000000000000/export")).status()).toBe(401);
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

  test("dashboard shows today's meetings, the queue and tasks to review", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Today", exact: true })).toBeVisible();
    await expect(page.getByText("Platform standup").first()).toBeVisible();
    await expect(page.locator(".badge", { hasText: "62%" })).toContainText("Transcribing");
    await expect(page.getByText("Send Sarah the API v2 timeline")).toBeVisible();
  });

  test("a meeting: event, transcript with names, find, rename a speaker", async ({ page }) => {
    await page.goto("/meetings");
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

  test("a meeting can be linked to another event by hand and back", async ({ page }) => {
    await page.goto("/meetings?unmatched=1");
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
    await page.goto("/meetings");
    await page.getByRole("link", { name: /lumen roadmap/ }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Markdown" }).click()]);
    const body = await (await download.createReadStream()).toArray();
    const md = Buffer.concat(body).toString();
    expect(md).toContain("# lumen roadmap");
    expect(md).toContain("**Jules Moreau** `0:04`");
    expect(md).toContain("- [x] Fix the Stripe webhook");
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

  test("search shows matching lines with speakers and links into the meeting", async ({ page }) => {
    await page.goto("/search?q=Stripe%20webhook");
    await expect(page.getByText("1 meeting matching")).toBeVisible();
    const line = page.getByRole("link", { name: /Alex.*Stripe webhook bug/ });
    await expect(line.locator("mark").first()).toBeVisible();
    await line.click();
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+\?q=Stripe%20webhook&t=\d+/);
    await expect(page.getByRole("heading", { name: "lumen roadmap" })).toBeVisible();
  });

  test("the calendar context filter narrows every page", async ({ page }) => {
    await page.getByRole("button", { name: "lumen" }).click();
    await expect(page.getByRole("button", { name: "lumen" })).toHaveClass(/bg-accent /);
    await page.goto("/meetings");
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
    await page.getByRole("button", { name: "Add" }).click();
    await page.locator("#cal-source").selectOption("ics");
    await page.locator("#cal-id").fill("not a link");
    await page.locator("#cal-ctx").fill("side");
    await page.getByRole("button", { name: "Add calendar" }).click();
    await expect(page.getByText("An ICS feed is a link starting with https://.")).toBeVisible();
    await page.getByLabel("Sync lumen").uncheck();
    await expect(page.getByText("Off", { exact: true }).first()).toBeVisible();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "lumen" })).toHaveCount(0);
    await page.goto("/settings/calendars");
    await page.getByLabel("Sync lumen").check();
    await expect(page.locator("p", { hasText: /^Synced/ })).toHaveCount(2);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "lumen" })).toBeVisible();
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
    await page.goto("/settings/claude");
    await page.getByLabel("Model").fill("claude-e2e-model");
    await page.getByLabel("Anthropic API key").fill("sk-ant-e2e-not-real");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Model")).toHaveValue("claude-e2e-model");
    await expect(page.getByLabel("Anthropic API key")).toHaveValue("");
    await expect(page.getByLabel("Anthropic API key")).toHaveAttribute("placeholder", /Saved/);
    expect(await page.content()).not.toContain("sk-ant-e2e-not-real");
    await page.getByRole("button", { name: "Remove" }).click();
    await page.getByLabel("Model").fill("");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();

    // PUBLIC_URL, TZ and OWNER_NAME come from the test server's environment.
    await page.goto("/settings");
    await expect(page.getByText(".env", { exact: true })).toHaveCount(3);
    await page.goto("/settings/sign-in");
    await expect(page.getByText(/Set by DEBRIEF_PASSWORD in the environment/)).toBeVisible();
  });
});
