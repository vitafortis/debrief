const { invoke } = window.__TAURI__.core;
const $ = (id) => document.getElementById(id);
const FIELDS = ["server_url", "fallback_url", "api_key", "device_name", "recordings_dir"];
const NUMS = ["stop_after_secs", "keep_local_days"];
const BOOLS = ["detect_meetings", "capture_system_audio", "launch_at_login"];
const ACTIONS = [
  ["ask", "Ask"],
  ["record", "Always record"],
  ["ignore", "Never"],
];
let settings = null;
let dirty = false;

function el(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k in e) e[k] = v;
    else e.setAttribute(k, v);
  }
  e.append(...kids);
  return e;
}

function markDirty() {
  dirty = true;
  $("saved").textContent = "Unsaved changes";
  $("saved").className = "small grow muted";
}

function renderRules() {
  const box = $("rules");
  box.replaceChildren(
    ...settings.rules.map((r, i) =>
      el(
        "div",
        {},
        el("input", { className: "input", value: r.app, placeholder: "App name", spellcheck: false, on: { input: (e) => ((r.app = e.target.value), markDirty()) } }),
        el(
          "select",
          { className: "input", on: { change: (e) => ((r.action = e.target.value), markDirty()) } },
          ...ACTIONS.map(([v, t]) => el("option", { value: v, textContent: t, selected: r.action === v }))
        ),
        el("button", { className: "btn btn-ghost btn-sm", title: "Remove", textContent: "×", on: { click: () => (settings.rules.splice(i, 1), renderRules(), markDirty()) } })
      )
    )
  );
}

function renderDefault() {
  for (const b of $("default_action").querySelectorAll("button")) b.classList.toggle("on", b.dataset.v === settings.default_action);
}

async function load() {
  settings = await invoke("get_settings");
  for (const f of FIELDS) $(f).value = settings[f] ?? "";
  for (const f of NUMS) $(f).value = settings[f];
  for (const f of BOOLS) $(f).checked = !!settings[f];
  renderRules();
  renderDefault();
  const mics = await invoke("microphones");
  $("microphone").replaceChildren(
    el("option", { value: "", textContent: "System default" }),
    ...mics.map((m) => el("option", { value: m, textContent: m, selected: m === settings.microphone }))
  );
  if (settings.microphone && !mics.includes(settings.microphone)) $("microphone").append(el("option", { value: settings.microphone, textContent: `${settings.microphone} (not connected)`, selected: true }));
  dirty = false;
}

function collect() {
  const s = structuredClone(settings);
  for (const f of FIELDS) s[f] = $(f).value.trim();
  for (const f of NUMS) s[f] = Math.max(0, parseInt($(f).value, 10) || 0);
  for (const f of BOOLS) s[f] = $(f).checked;
  s.microphone = $("microphone").value;
  return s;
}

async function save() {
  try {
    await invoke("save_settings", { settings: collect() });
    settings = await invoke("get_settings");
    dirty = false;
    $("saved").textContent = "Saved";
    $("saved").className = "small grow muted";
  } catch (e) {
    $("saved").textContent = String(e);
    $("saved").className = "small grow";
    $("saved").style.color = "var(--danger)";
  }
}

const ago = (iso) => {
  const d = new Date(iso);
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.round(mins / 60)} h ago`;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};

async function poll() {
  let s;
  try {
    s = await invoke("status");
  } catch {
    return;
  }
  $("rec-dot").className = `dot ${s.recording ? "rec" : ""}`;
  $("rec-title").textContent = s.recording ? `Recording${s.app ? ` ${s.app}` : ""} · ${s.elapsed}` : "Not recording";
  $("rec-sub").textContent = s.recording
    ? s.app
      ? `Stops when ${s.app} lets go of the microphone, or from here.`
      : "Started by hand: stop it here or from the menu bar."
    : "It starts when a meeting app uses the microphone, by the rules below.";
  $("rec-toggle").textContent = s.recording ? "Stop" : "Start recording";
  $("rec-toggle").className = `btn btn-sm ${s.recording ? "btn-danger" : ""}`;
  $("meters").hidden = !s.recording;
  $("m-mic").style.width = `${Math.min(100, Math.sqrt(s.mic_level / 1000) * 100)}%`;
  $("m-sys").style.width = `${Math.min(100, Math.sqrt(s.system_level / 1000) * 100)}%`;

  const u = s.upload;
  $("up-dot").className = `dot ${u.online === true ? "on" : u.online === false ? "bad" : ""}`;
  $("up-text").textContent =
    u.online === false
      ? `Can't reach Debrief${u.waiting ? ` · ${u.waiting} waiting` : ""}: ${u.last_error ?? ""}`
      : u.online === true
        ? u.waiting
          ? `Uploading ${u.waiting} recording${u.waiting === 1 ? "" : "s"} to ${u.server}`
          : `Connected to ${u.server}. Everything is uploaded.`
        : settings && settings.server_url && settings.api_key
          ? "Connected when there's something to send."
          : "Add the server and an API key below.";
  $("recent").replaceChildren(
    ...s.recent.map((r) =>
      el(
        "div",
        {},
        el("span", { className: "grow", textContent: `${ago(r.started_at)}${r.app ? ` · ${r.app}` : ""}${r.minutes != null ? ` · ${r.minutes} min` : ""}` }),
        el("span", {
          className: `badge ${r.state === "recording" ? "rec" : r.state === "uploaded" ? "ok" : ""}`,
          textContent: r.state.startsWith("waiting") ? "waiting" : r.state,
          title: r.state,
        })
      )
    )
  );

  const known = (name) => settings?.rules.some((r) => r.app && name.toLowerCase().includes(r.app.toLowerCase()));
  const fresh = s.mic_users.filter((n) => !known(n));
  $("now-wrap").hidden = !fresh.length;
  $("now").replaceChildren(
    ...fresh.map((n) =>
      el("button", { className: "btn", textContent: `+ ${n}`, on: { click: () => (settings.rules.push({ app: n, action: "ask" }), renderRules(), markDirty(), poll()) } })
    )
  );
}

$("save").addEventListener("click", save);
$("rec-toggle").addEventListener("click", async () => {
  try {
    await invoke("toggle_recording");
  } catch (e) {
    alert(e);
  }
  poll();
});
$("open-folder").addEventListener("click", () => invoke("open_folder"));
$("show-key").addEventListener("click", () => {
  const k = $("api_key");
  k.type = k.type === "password" ? "text" : "password";
  $("show-key").textContent = k.type === "password" ? "Show" : "Hide";
});
$("add-rule").addEventListener("click", () => {
  settings.rules.push({ app: "", action: "ask" });
  renderRules();
  markDirty();
  $("rules").lastElementChild?.querySelector("input")?.focus();
});
$("default_action").addEventListener("click", (e) => {
  const v = e.target.dataset?.v;
  if (!v) return;
  settings.default_action = v;
  renderDefault();
  markDirty();
});
$("test").addEventListener("click", async () => {
  const r = $("test-result");
  r.className = "small grow muted";
  r.textContent = "Checking…";
  try {
    r.textContent = await invoke("test_connection", { serverUrl: $("server_url").value, apiKey: $("api_key").value, deviceName: $("device_name").value });
    r.className = "small grow note ok";
  } catch (e) {
    r.textContent = String(e);
    r.className = "small grow note err";
  }
});
for (const id of [...FIELDS, ...NUMS, ...BOOLS, "microphone"]) $(id).addEventListener("input", markDirty);
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "s") {
    e.preventDefault();
    save();
  }
});
window.addEventListener("beforeunload", (e) => dirty && e.preventDefault());

load().then(poll);
setInterval(poll, 1000);
