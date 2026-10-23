import { expect, test, type Page } from "@playwright/test";

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
    await page.getByRole("link", { name: /pwnbook roadmap/ }).click();
    const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Markdown" }).click()]);
    const body = await (await download.createReadStream()).toArray();
    const md = Buffer.concat(body).toString();
    expect(md).toContain("# pwnbook roadmap");
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
    await page.locator("div.\\@container", { hasText: "Update the runbook" }).getByRole("button", { name: "Restore" }).click();
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
    const line = page.getByRole("link", { name: /Nathan.*Stripe webhook bug/ });
    await expect(line.locator("mark").first()).toBeVisible();
    await line.click();
    await expect(page).toHaveURL(/\/meetings\/[0-9a-f-]+\?q=Stripe%20webhook&t=\d+/);
    await expect(page.getByRole("heading", { name: "pwnbook roadmap" })).toBeVisible();
  });

  test("the calendar context filter narrows every page", async ({ page }) => {
    await page.getByRole("button", { name: "pwnbook" }).click();
    await expect(page.getByRole("button", { name: "pwnbook" })).toHaveClass(/bg-accent /);
    await page.goto("/meetings");
    await expect(page.getByText("pwnbook roadmap")).toBeVisible();
    await expect(page.getByText("Northwind onboarding call")).toHaveCount(0);
    await page.goto("/calendar");
    await expect(page.getByText("Beta demo")).toBeVisible();
    await expect(page.getByText("Quarterly planning")).toHaveCount(0);
    await page.getByRole("button", { name: "All", exact: true }).click();
    await expect(page.getByText("Quarterly planning")).toBeVisible();
  });

  test("settings: a bad ICS link is refused, and a calendar can be switched off", async ({ page }) => {
    await page.goto("/settings");
    await page.getByRole("button", { name: "Add" }).click();
    await page.locator("#cal-source").selectOption("ics");
    await page.locator("#cal-id").fill("not a link");
    await page.locator("#cal-ctx").fill("side");
    await page.getByRole("button", { name: "Add calendar" }).click();
    await expect(page.getByText("An ICS feed is a link starting with https://.")).toBeVisible();
    await page.getByLabel("Sync pwnbook").uncheck();
    await expect(page.getByText("Off", { exact: true }).first()).toBeVisible();
    await page.goto("/");
    await expect(page.getByRole("button", { name: "pwnbook" })).toHaveCount(0);
    await page.goto("/settings");
    await page.getByLabel("Sync pwnbook").check();
    await expect(page.locator("p", { hasText: /^Synced/ })).toHaveCount(2);
    await page.goto("/");
    await expect(page.getByRole("button", { name: "pwnbook" })).toBeVisible();
  });
});
