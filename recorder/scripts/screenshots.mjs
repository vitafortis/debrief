// Screenshots of the recorder's windows for the README, from the real UI files with sample data.
//   node recorder/scripts/screenshots.mjs
import { chromium } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ui = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
const out = path.resolve(ui, "../../docs/screenshots");

const settings = {
  server_url: "https://debrief.armgrp.dev",
  fallback_url: "http://192.168.1.20:3000",
  api_key: "dbk_7pQ2xVd9…",
  device_name: "work-macbook",
  detect_meetings: true,
  default_action: "ask",
  rules: [
    { app: "zoom", action: "record" },
    { app: "Microsoft Teams", action: "ask" },
    { app: "Google Chrome", action: "ask" },
    { app: "Slack", action: "ask" },
    { app: "Discord", action: "ignore" },
  ],
  stop_after_secs: 45,
  microphone: "",
  capture_system_audio: true,
  recordings_dir: "",
  keep_local_days: 14,
  launch_at_login: true,
};
const ago = (m) => new Date(Date.now() - m * 60000).toISOString();
const status = {
  recording: true,
  app: "zoom.us",
  elapsed: "23:41",
  mic_level: 260,
  system_level: 480,
  upload: { online: true, server: "https://debrief.armgrp.dev", waiting: 0, last_error: null },
  recordings_dir: "~/Library/Application Support/dev.armgrp.debrief.recorder/recordings",
  recent: [
    { started_at: ago(24), app: "zoom.us", minutes: 23.7, state: "recording" },
    { started_at: ago(150), app: "Microsoft Teams", minutes: 31.2, state: "uploaded" },
    { started_at: ago(320), app: "Google Chrome", minutes: 14.5, state: "uploaded" },
  ],
  mic_users: ["zoom.us"],
};
const prompt = { kind: "start", app: "Microsoft Teams", message: "Microsoft Teams is using your microphone." };

const mock = ({ settings, status, prompt }) => {
  window.__TAURI__ = {
    core: {
      invoke: async (cmd) =>
        ({ get_settings: settings, status, microphones: ["MacBook Pro Microphone", "Shure MV7"], current_prompt: prompt })[cmd] ?? null,
    },
    event: { listen: async () => () => {} },
  };
};

const browser = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const page = await browser.newPage({ viewport: { width: 560, height: 1180 }, deviceScaleFactor: 2, colorScheme: scheme });
  await page.addInitScript(mock, { settings, status, prompt });
  await page.goto(`file://${ui}/index.html`);
  await page.waitForTimeout(400);
  // As tall as the content, so the sticky Save bar sits at the bottom.
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  await page.setViewportSize({ width: 560, height });
  await page.waitForTimeout(100);
  await page.screenshot({ path: `${out}/recorder${scheme === "dark" ? "-dark" : ""}.png` });
  await page.close();
}
const pop = await browser.newPage({ viewport: { width: 380, height: 196 }, deviceScaleFactor: 2, colorScheme: "light" });
await pop.addInitScript(mock, { settings, status, prompt });
await pop.goto(`file://${ui}/prompt.html`);
await pop.evaluate(() => (document.body.style.background = "oklch(93% 0.01 200)"));
await pop.waitForTimeout(300);
await pop.screenshot({ path: `${out}/recorder-prompt.png` });
await browser.close();
console.log("Saved recorder screenshots to", out);
