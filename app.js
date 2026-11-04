import { parse } from "./parser.js";
import { newState, snapshot, execute, metrics, polySegments, sampleSegment, buildDxf } from "./cad.js";

const STORE_KEY = "cadvoice-state-v1";
const $ = (id) => document.getElementById(id);

let state = loadState();
let undoStack = [];
let model = null;
let recognizer = null;
let audio = null;
let listening = false;

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

// ---------- состояние и сохранение ----------
function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    if (saved && Array.isArray(saved.entities)) return saved;
  } catch (e) { /* пусто */ }
  return newState();
}

function saveState() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { /* переполнение */ }
}

// ---------- команды ----------
const MUTATING = new Set(["forward", "turn_right", "turn_left", "set_angle", "arc", "circle",
  "rect", "text", "dim", "new_polyline", "end_polyline", "close", "reset"]);

function runText(text) {
  if (!text || !text.trim()) return;
  const parsed = parse(text);
  let msg;
  if (parsed.intent === "undo") {
    if (undoStack.length) { state = undoStack.pop(); msg = "Отменено."; }
    else msg = "Нечего отменять.";
  } else if (parsed.intent === "save") {
    exportDxf();
    return;
  } else {
    const before = MUTATING.has(parsed.intent) ? snapshot(state) : null;
    const res = execute(state, parsed);
    msg = res.msg;
    if (before) {
      if (res.changed) undoStack.push(before);
    }
  }
  addHistory(msg);
  saveState();
  draw();
  setStatus(msg, "idle");
}

// ---------- статус и история ----------
function setStatus(text, kind) {
  $("status").textContent = text;
  $("status").className = "status " + (kind || "idle");
}

function addHistory(msg) {
  const li = document.createElement("li");
  const t = new Date().toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  li.innerHTML = `<span></span><time></time>`;
  li.querySelector("span").textContent = msg;
  li.querySelector("time").textContent = t;
  const list = $("history");
  list.prepend(li);
  while (list.children.length > 30) list.removeChild(list.lastChild);
}

// ---------- рисование ----------
function draw() {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth, H = canvas.clientHeight;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#fbfbfb";
  ctx.fillRect(0, 0, W, H);

  const pts = [];
  for (const e of state.entities) {
    if (e.type === "poly") pts.push(...e.pts);
    else if (e.type === "circle") pts.push({ x: e.c.x - e.r, y: e.c.y - e.r }, { x: e.c.x + e.r, y: e.c.y + e.r });
    else if (e.type === "text") pts.push(e.p);
    else if (e.type === "dim") pts.push(e.a, e.b);
  }

  if (pts.length < 2) {
    ctx.fillStyle = "#8a8a8a";
    ctx.font = "16px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Скажите, например: «прямо 500»", W / 2, H / 2);
    updateMetrics();
    return;
  }

  const minx = Math.min(...pts.map((p) => p.x)), maxx = Math.max(...pts.map((p) => p.x));
  const miny = Math.min(...pts.map((p) => p.y)), maxy = Math.max(...pts.map((p) => p.y));
  const m = 50;
  const bw = Math.max(maxx - minx, 1e-6), bh = Math.max(maxy - miny, 1e-6);
  const s = Math.min((W - 2 * m) / bw, (H - 2 * m - 30) / bh);
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const tr = (p) => ({ x: W / 2 + (p.x - cx) * s, y: (H - 30) / 2 - (p.y - cy) * s });

  ctx.strokeStyle = "#1c1c1c";
  ctx.fillStyle = "#1c1c1c";
  ctx.lineWidth = 4;
  ctx.lineJoin = "miter";
  ctx.font = "13px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const e of state.entities) {
    if (e.type === "poly") {
      const segs = polySegments(e);
      if (!segs.length) continue;
      ctx.beginPath();
      const start = tr(segs[0][0]);
      ctx.moveTo(start.x, start.y);
      for (const [p, q, b] of segs) {
        for (const sp of sampleSegment(p, q, b)) {
          const t = tr(sp);
          ctx.lineTo(t.x, t.y);
        }
      }
      ctx.stroke();
      for (const [p, q] of segs) {
        const a = tr(p), bq = tr(q);
        const dx = bq.x - a.x, dy = bq.y - a.y;
        const L = Math.hypot(dx, dy) || 1;
        const lenM = Math.hypot(q.x - p.x, q.y - p.y) / 100;
        ctx.fillText(lenM.toFixed(2), (a.x + bq.x) / 2 - (dy / L) * 14, (a.y + bq.y) / 2 + (dx / L) * 14);
      }
    } else if (e.type === "circle") {
      const c = tr(e.c);
      ctx.beginPath();
      ctx.arc(c.x, c.y, e.r * s, 0, Math.PI * 2);
      ctx.stroke();
    } else if (e.type === "text") {
      const t = tr(e.p);
      ctx.textAlign = "left";
      ctx.font = `${Math.max(10, e.h * s)}px system-ui`;
      ctx.fillText(e.s, t.x, t.y);
      ctx.font = "13px system-ui";
      ctx.textAlign = "center";
    } else if (e.type === "dim") {
      const a = tr(e.a), b = tr(e.b);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
      ctx.lineWidth = 4;
      ctx.fillText(e.label, (a.x + b.x) / 2, (a.y + b.y) / 2 - 10);
    }
  }

  const ox = 30, oy = H - 30;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 50); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + 50, oy); ctx.stroke();
  ctx.fillText("Y", ox - 8, oy - 58);
  ctx.fillText("X", ox + 60, oy);

  updateMetrics();
}

function updateMetrics() {
  const { area, perim } = metrics(state);
  $("area").textContent = area.toFixed(2) + " м²";
  $("perim").textContent = perim.toFixed(2) + " м";
}

// ---------- DXF ----------
function exportDxf() {
  const dxf = buildDxf(state.entities);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const name = `drawing-${stamp}.dxf`;
  const blob = new Blob([dxf], { type: "application/dxf" });
  const file = new File([blob], name, { type: "application/dxf" });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    setStatus("DXF готов: выберите «Сохранить в Файлы»", "idle");
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus("DXF сохранён: " + name, "idle");
  }
  addHistory("Экспорт DXF: " + name);
}

// ---------- голос (Vosk в браузере, офлайн) ----------
async function loadModel() {
  if (model) return;
  setStatus("Загрузка голосовой модели...", "busy");
  try {
    model = await window.Vosk.createModel("model/model.tar.gz");
    recognizer = new model.KaldiRecognizer(16000);
    recognizer.on("result", (msg) => {
      const text = msg.result && msg.result.text;
      $("partial").textContent = "";
      if (text) {
        $("heard").textContent = "Вы сказали: " + text;
        runText(text);
      }
    });
    recognizer.on("partialresult", (msg) => {
      const p = msg.result && msg.result.partial;
      if (p) $("partial").textContent = p;
    });
    setStatus("Голос готов", "idle");
  } catch (e) {
    model = null;
    setStatus("Не удалось загрузить модель: " + e.message, "idle");
  }
}

async function startListening() {
  await loadModel();
  if (!recognizer) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 },
    });
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    await ac.resume();
    const src = ac.createMediaStreamSource(stream);
    const proc = ac.createScriptProcessor(4096, 1, 1);
    const mute = ac.createGain();
    mute.gain.value = 0;
    proc.onaudioprocess = (e) => {
      try { recognizer.acceptWaveform(e.inputBuffer); } catch (err) { /* пропускаем кадр */ }
    };
    src.connect(proc);
    proc.connect(mute);
    mute.connect(ac.destination);
    audio = { stream, ac, proc, src, mute };
    listening = true;
    $("mic").classList.add("on");
    setStatus("Слушаю", "rec");
  } catch (e) {
    setStatus("Нет доступа к микрофону: " + e.message, "idle");
  }
}

function stopListening() {
  if (audio) {
    audio.proc.disconnect();
    audio.src.disconnect();
    audio.stream.getTracks().forEach((t) => t.stop());
    audio.ac.close();
    audio = null;
  }
  listening = false;
  $("mic").classList.remove("on");
  $("partial").textContent = "";
  setStatus("Готов к работе", "idle");
}

// ---------- кнопки и ввод ----------
$("mic").addEventListener("click", () => (listening ? stopListening() : startListening()));
$("undo").addEventListener("click", () => runText("отмена"));
$("save").addEventListener("click", () => exportDxf());
$("clear").addEventListener("click", () => {
  if (!confirm("Очистить чертёж?")) return;
  undoStack.push(snapshot(state));
  state = newState();
  addHistory("Чертёж очищен");
  saveState();
  draw();
});
$("clearHistory").addEventListener("click", () => ($("history").innerHTML = ""));
$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("input").value;
  $("input").value = "";
  runText(v);
});
window.addEventListener("resize", draw);

// ---------- запуск ----------
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
setStatus(navigator.onLine ? "Готов к работе" : "Офлайн-режим", "idle");
draw();
