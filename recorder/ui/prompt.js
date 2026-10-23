const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
let timer = null;

function button(text, cls, answer) {
  const b = document.createElement("button");
  b.className = `btn ${cls}`;
  b.textContent = text;
  b.addEventListener("click", () => send(answer));
  return b;
}
function link(text, answer) {
  const b = document.createElement("button");
  b.className = "link";
  b.textContent = text;
  b.addEventListener("click", () => send(answer));
  return b;
}

async function send(answer) {
  clearInterval(timer);
  const title = $("name").value.trim() || null;
  $("name").value = "";
  try {
    await invoke("answer_prompt", { answer, title });
  } catch (e) {
    show({ kind: "error", app: "", message: String(e) });
  }
}

// Unanswered, it goes away on its own: a meeting question means "not now".
function countdown(secs, answer) {
  clearInterval(timer);
  let left = secs;
  const bar = $("bar");
  bar.style.transition = "none";
  bar.style.width = "100%";
  requestAnimationFrame(() => (bar.style.transition = "width 1s linear"));
  timer = setInterval(() => {
    left -= 1;
    bar.style.width = `${(left / secs) * 100}%`;
    if (left <= 0) send(answer);
  }, 1000);
}

function show(p) {
  if (!p) return;
  const start = p.kind === "start";
  $("title").textContent = start ? "Record this meeting?" : p.kind === "stopped" ? "Recording finished" : "Debrief Recorder";
  $("message").textContent = p.message;
  $("start-ui").hidden = !start;
  $("buttons").replaceChildren(...(start ? [button("Record", "btn-primary", "record"), button("Not now", "", "not_now")] : [button("OK", "", "close")]));
  $("more").replaceChildren(...(start ? [link(`Always record ${p.app}`, "always"), link(`Never for ${p.app}`, "never")] : []));
  countdown(start ? 60 : p.kind === "stopped" ? 8 : 20, start ? "not_now" : "close");
  if (start) setTimeout(() => $("buttons").firstChild?.focus(), 50);
}

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") send($("start-ui").hidden ? "close" : "not_now");
  if (e.key === "Enter" && !$("start-ui").hidden) send("record");
});
listen("prompt", (e) => show(e.payload));
invoke("current_prompt").then(show);
