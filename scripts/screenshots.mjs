// Screenshots of the demo data (packages/core/scripts/seed-demo.ts), dark and light, for the README.
//   BASE_URL=http://localhost:3150 PASSWORD=demo node scripts/screenshots.mjs [names…]
import { chromium } from "@playwright/test";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3150";
const OUT = path.resolve(import.meta.dirname, "../docs/screenshots");
const only = process.argv.slice(2);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
await page.goto(`${BASE}/login`);
await page.fill("#pw", process.env.PASSWORD ?? "demo");
await page.click("button:has-text('Sign in')");
await page.waitForURL(`${BASE}/`);

const firstMeeting = async (title) => {
  await page.goto(`${BASE}/meetings`);
  return page.locator(`a:has-text("${title}")`).first().getAttribute("href");
};

const scenes = {
  dashboard: async () => page.goto(`${BASE}/`),
  meeting: async () => {
    await page.goto(`${BASE}${await firstMeeting("Platform standup")}`);
    await page.waitForTimeout(800);
  },
  search: async () => page.goto(`${BASE}/search?q=${encodeURIComponent("API timeline")}`),
  tasks: async () => page.goto(`${BASE}/tasks`),
  calendar: async () => page.goto(`${BASE}/calendar`),
  settings: async () => page.goto(`${BASE}/settings`),
  login: async () => {
    const p = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    await p.goto(`${BASE}/login`);
    return p;
  },
};

for (const theme of ["dark", "light"]) {
  for (const [name, go] of Object.entries(scenes)) {
    if (only.length && !only.includes(name)) continue;
    const target = name === "login" ? await go() : (await go(), page);
    await target.evaluate((t) => {
      localStorage.setItem("debrief-theme", t);
      document.documentElement.dataset.theme = t;
    }, theme);
    await target.waitForLoadState("networkidle").catch(() => {});
    await target.waitForTimeout(400);
    const file = path.join(OUT, `${name}${theme === "light" ? "-light" : ""}.png`);
    await target.screenshot({ path: file });
    console.log(file);
    if (name === "login") await target.close();
  }
}
await browser.close();
