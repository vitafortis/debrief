const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const $ = (id) => document.getElementById(id);
let timer = null;

function link(text, answer, title) {
  const b = document.createElement("button");
  b.className = "link";
  b.textContent = text;
  b.title = title;
  b.addEventListener("click", () => send(answer));
  return b;
}
function dot() {
  const s = document.createElement("span");
  s.className = "muted";
  s.textContent = "·";
  return s;
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

let current = null;

function show(p) {
  if (!p) return;
  current = p;
  const start = p.kind === "start";
  $("title").textContent = start ? "Start recording?" : p.kind === "stopped" ? "Recording finished" : "Debrief Recorder";
  $("title").title = $("title").textContent;
  $("message").textContent = p.message;
  $("message").style.webkitLineClamp = start ? 2 : 6;
  $("start-ui").hidden = !start;
  $("close").title = start ? "Not now (Esc)" : "Close";
  if (start) {
    $("foot").replaceChildren(
      link("Always record", "always", `Record ${p.app} from now on without asking`),
      dot(),
      link("Never ask", "never", `Leave ${p.app} alone from now on`)
    );
  } else {
    const ok = document.createElement("button");
    ok.className = "btn btn-sm";
    ok.textContent = "OK";
    ok.addEventListener("click", () => send("close"));
    $("foot").replaceChildren(ok);
  }
  countdown(start ? 60 : p.kind === "stopped" ? 8 : 20, start ? "not_now" : "close");
}

$("start-ui").addEventListener("submit", (e) => {
  e.preventDefault();
  send("record");
});
$("close").addEventListener("click", () => send(current?.kind === "start" ? "not_now" : "close"));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") send($("start-ui").hidden ? "close" : "not_now");
});
listen("prompt", (e) => show(e.payload));
invoke("current_prompt").then(show);
