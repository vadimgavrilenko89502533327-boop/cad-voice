import { parse } from "./parser.js";
import { newState, snapshot, execute, metrics, polySegments, sampleSegment, buildDxf } from "./cad.js";

const DB_KEY = "cadvoice-projects-v1";
const LEGACY_KEY = "cadvoice-state-v1";
const $ = (id) => document.getElementById(id);
const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

let db = loadDb();
let state = db.projects[db.current].state;
let undoStack = [];
let redoStack = [];
let model = null;
let recognizer = null;
let audio = null;
let listening = false;

const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const view = { zoom: 1, panX: 0, panY: 0 };

// Угол поворота текста вдоль линии, чтобы текст не был вверх ногами
function readableAngle(dx, dy) {
  let a = Math.atan2(dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a < -Math.PI / 2) a += Math.PI;
  return a;
}

// ---------- проекты (хранятся в памяти телефона/браузера) ----------
function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(DB_KEY));
    if (d && d.projects && d.projects[d.current]) return d;
  } catch (e) { /* нет данных */ }
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch (e) { /* нет данных */ }
  const id = newId();
  const project = {
    id, name: "Проект 1", created: Date.now(), updated: Date.now(),
    state: legacy && Array.isArray(legacy.entities) ? legacy : newState(),
  };
  return { current: id, projects: { [id]: project } };
}

function persist() {
  const p = db.projects[db.current];
  p.state = state;
  p.updated = Date.now();
  try {
    localStorage.setItem(DB_KEY, JSON.stringify(db));
  } catch (e) {
    setStatus("Не хватает памяти для сохранения", "idle");
  }
}

function openProject(id) {
  persist();
  db.current = id;
  state = db.projects[id].state;
  undoStack = [];
  redoStack = [];
  persist();
  refresh();
}

function createProject() {
  const name = (prompt("Название нового проекта:", "Проект " + (Object.keys(db.projects).length + 1)) || "").trim();
  if (!name) return;
  persist();
  const id = newId();
  db.projects[id] = { id, name, created: Date.now(), updated: Date.now(), state: newState() };
  db.current = id;
  state = db.projects[id].state;
  undoStack = [];
  redoStack = [];
  persist();
  refresh();
}

function renameProject(id) {
  const p = db.projects[id];
  const name = (prompt("Новое название:", p.name) || "").trim();
  if (!name) return;
  p.name = name;
  persist();
  refresh();
}

function deleteProject(id) {
  if (Object.keys(db.projects).length <= 1) {
    alert("Нельзя удалить единственный проект. Очистите его вместо этого.");
    return;
  }
  if (!confirm(`Удалить проект «${db.projects[id].name}»?`)) return;
  delete db.projects[id];
  if (db.current === id) {
    const next = Object.values(db.projects).sort((a, b) => b.updated - a.updated)[0];
    db.current = next.id;
    state = next.state;
    undoStack = [];
  redoStack = [];
  }
  persist();
  refresh();
}

function renderProjects() {
  const list = $("projList");
  list.innerHTML = "";
  Object.values(db.projects)
    .sort((a, b) => b.updated - a.updated)
    .forEach((p) => {
      const li = document.createElement("li");
      if (p.id === db.current) li.className = "cur";
      const info = document.createElement("div");
      info.className = "pinfo";
      const name = document.createElement("b");
      name.textContent = p.name;
      const date = document.createElement("small");
      date.textContent = new Date(p.updated).toLocaleString("ru-RU", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
      info.append(name, date);
      info.addEventListener("click", () => openProject(p.id));
      const actions = document.createElement("div");
      actions.className = "pacts";
      for (const [label, fn] of [["Переименовать", renameProject], ["Удалить", deleteProject]]) {
        const b = document.createElement("button");
        b.textContent = label;
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(p.id); });
        actions.appendChild(b);
      }
      li.append(info, actions);
      list.appendChild(li);
    });
}

function refresh() {
  $("projName").textContent = db.projects[db.current].name;
  renderProjects();
  draw();
}

// ---------- команды ----------
const MUTATING = new Set(["forward", "turn_right", "turn_left", "set_angle", "arc", "circle",
  "rect", "text", "dim", "new_polyline", "end_polyline", "close", "reset", "window", "door"]);

function runText(text) {
  if (!text || !text.trim()) return;
  const parsed = parse(text);
  let msg;
  if (parsed.intent === "undo") {
    if (undoStack.length) {
      redoStack.push(snapshot(state));
      state = undoStack.pop();
      msg = "Отменено.";
    } else msg = "Нечего отменять.";
  } else if (parsed.intent === "redo") {
    if (redoStack.length) {
      undoStack.push(snapshot(state));
      state = redoStack.pop();
      msg = "Возвращено.";
    } else msg = "Нечего возвращать.";
  } else if (parsed.intent === "save") {
    persist();
    exportDxf();
    return;
  } else {
    const before = MUTATING.has(parsed.intent) ? snapshot(state) : null;
    const res = execute(state, parsed);
    msg = res.msg;
    if (before && res.changed) {
      undoStack.push(before);
      redoStack = [];
    }
  }
  addHistory(msg);
  persist();
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
    else if (e.type === "seg") pts.push(e.a, e.b);
  }

  if (pts.length < 2) {
    ctx.fillStyle = "#8a8a8a";
    ctx.font = "16px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Скажите или напишите, например: «прямо 500»", W / 2, H / 2);
    updateMetrics();
    return;
  }

  const minx = Math.min(...pts.map((p) => p.x)), maxx = Math.max(...pts.map((p) => p.x));
  const miny = Math.min(...pts.map((p) => p.y)), maxy = Math.max(...pts.map((p) => p.y));
  const m = 50;
  const bw = Math.max(maxx - minx, 1e-6), bh = Math.max(maxy - miny, 1e-6);
  const fit = Math.min((W - 2 * m) / bw, (H - 2 * m - 30) / bh);
  const s = fit * view.zoom;
  const cx = (minx + maxx) / 2, cy = (miny + maxy) / 2;
  const tr = (p) => ({
    x: W / 2 + view.panX + (p.x - cx) * s,
    y: (H - 30) / 2 + view.panY - (p.y - cy) * s,
  });

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
        ctx.save();
        ctx.translate((a.x + bq.x) / 2, (a.y + bq.y) / 2);
        ctx.rotate(readableAngle(dx, dy));
        ctx.fillText(lenM.toFixed(2), 0, -12);
        ctx.restore();
      }
    } else if (e.type === "seg") {
      const a = tr(e.a), b = tr(e.b);
      ctx.save();
      ctx.strokeStyle = e.color === "red" ? "#d32f2f" : "#1e5fd0";
      ctx.lineWidth = 7;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
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
      ctx.save();
      ctx.translate((a.x + b.x) / 2, (a.y + b.y) / 2);
      ctx.rotate(readableAngle(b.x - a.x, b.y - a.y));
      ctx.fillText(e.label, 0, -10);
      ctx.restore();
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

// ---------- экспорт ----------
function fileName(ext) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const base = db.projects[db.current].name.replace(/[^\w-]+/g, "") || "drawing";
  return `${base}-${stamp}.${ext}`;
}

function shareFile(blob, name, type) {
  const file = new File([blob], name, { type });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    setStatus("Готово: выберите «Сохранить в Файлы»", "idle");
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    setStatus("Сохранено: " + name, "idle");
  }
  addHistory("Экспорт: " + name);
}

function exportDxf() {
  const dxf = buildDxf(state.entities);
  shareFile(new Blob([dxf], { type: "application/dxf" }), fileName("dxf"), "application/dxf");
}

function exportPng() {
  draw();
  canvas.toBlob((blob) => shareFile(blob, fileName("png"), "image/png"), "image/png");
}

// ---------- голос (Vosk в браузере, офлайн) ----------
async function loadModel() {
  if (model) return true;
  setStatus("Проверка голосовой модели...", "busy");
  try {
    if (!window.Vosk) throw new Error("не загрузилась библиотека vendor/vosk.js");
    const res = await fetch("model/model.tar.gz");
    if (!res.ok) throw new Error("файл модели не найден (код " + res.status + ")");
    if (res.body && res.body.cancel) res.body.cancel();
    setStatus("Загрузка голосовой модели (до минуты)...", "busy");
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("время ожидания вышло")), 180000));
    model = await Promise.race([window.Vosk.createModel("model/model.tar.gz"), timeout]);
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
    return true;
  } catch (e) {
    model = null;
    recognizer = null;
    const reason = e && e.message ? e.message : "библиотека не смогла открыть модель (возможно, мало памяти)";
    setStatus("Модель не загрузилась: " + reason + ". Нажмите ● ещё раз.", "idle");
    return false;
  }
}

async function startListening() {
  if (!(await loadModel())) return;
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

// ---------- голос через Safari (Web Speech API) ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let webRec = null;
let lastStart = 0;
let quickEnds = 0;

function speechErrorText(code) {
  if (code === "not-allowed" || code === "service-not-allowed")
    return "Нет доступа к микрофону или распознаванию. Настройки → Safari → Микрофон → Разрешить.";
  if (code === "network") return "Нет связи с сервисом распознавания Apple. Нужен интернет.";
  if (code === "language-not-supported") return "Русский язык не поддерживается этим браузером.";
  return "Ошибка распознавания: " + code;
}

function startWebSpeech() {
  webRec = new SpeechRec();
  webRec.lang = "ru-RU";
  webRec.continuous = false;
  webRec.interimResults = true;
  webRec.maxAlternatives = 1;
  webRec.onresult = (e) => {
    let interim = "", final = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) final += r[0].transcript;
      else interim += r[0].transcript;
    }
    $("partial").textContent = interim;
    const text = final.trim();
    if (text) {
      $("partial").textContent = "";
      $("heard").textContent = "Вы сказали: " + text;
      runText(text);
    }
  };
  webRec.onerror = (e) => {
    if (e.error === "no-speech" || e.error === "aborted") return;
    setStatus(speechErrorText(e.error), "idle");
    if (e.error === "not-allowed" || e.error === "service-not-allowed") stopListening();
  };
  webRec.onend = () => {
    if (!listening || !webRec) return;
    const now = Date.now();
    quickEnds = now - lastStart < 1500 ? quickEnds + 1 : 0;
    if (quickEnds >= 3) {
      stopListening();
      setStatus("Safari не даёт слушать. Нажмите ● ещё раз.", "idle");
      return;
    }
    setTimeout(() => {
      if (!listening || !webRec) return;
      lastStart = Date.now();
      try {
        webRec.start();
      } catch (err) {
        stopListening();
        setStatus("Слушание остановлено. Нажмите ● ещё раз.", "idle");
      }
    }, 400);
  };
  lastStart = Date.now();
  quickEnds = 0;
  try {
    webRec.start();
  } catch (err) {
    setStatus("Не удалось запустить распознавание. Нажмите ● ещё раз.", "idle");
    return;
  }
  listening = true;
  $("mic").classList.add("on");
  setStatus("Слушаю", "rec");
}

function stopListening() {
  if (webRec) {
    const r = webRec;
    webRec = null;
    r.onend = null;
    try { r.stop(); } catch (e) { /* уже остановлен */ }
  }
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

// ---------- сдвиг и масштаб области чертежа ----------
const pointers = new Map();
let pinchDist = 0;

function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: e.clientX - r.left, y: e.clientY - r.top };
}

function zoomAt(px, py, ratio) {
  const W = canvas.clientWidth, H = canvas.clientHeight;
  const ox = W / 2, oy = (H - 30) / 2;
  const nz = Math.min(20, Math.max(0.2, view.zoom * ratio));
  const k = nz / view.zoom;
  view.panX = (px - ox) - ((px - ox) - view.panX) * k;
  view.panY = (py - oy) - ((py - oy) - view.panY) * k;
  view.zoom = nz;
}

canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, canvasPoint(e));
  pinchDist = 0;
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const cur = canvasPoint(e);
  pointers.set(e.pointerId, cur);
  if (pointers.size === 1) {
    view.panX += cur.x - prev.x;
    view.panY += cur.y - prev.y;
  } else if (pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (pinchDist > 0 && d > 0) zoomAt(mx, my, d / pinchDist);
    pinchDist = d;
  }
  draw();
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  pinchDist = 0;
}
canvas.addEventListener("pointerup", endPointer);
canvas.addEventListener("pointercancel", endPointer);

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = canvasPoint(e);
  zoomAt(p.x, p.y, e.deltaY < 0 ? 1.1 : 1 / 1.1);
  draw();
}, { passive: false });

function zoomCenter(ratio) {
  zoomAt(canvas.clientWidth / 2, (canvas.clientHeight - 30) / 2, ratio);
  draw();
}

// ---------- кнопки и ввод ----------
$("zin").addEventListener("click", () => zoomCenter(1.25));
$("zout").addEventListener("click", () => zoomCenter(1 / 1.25));
$("zfit").addEventListener("click", () => {
  view.zoom = 1; view.panX = 0; view.panY = 0;
  draw();
});
$("mic").addEventListener("click", () => {
  if (listening) stopListening();
  else if (SpeechRec) startWebSpeech();
  else startListening();
});
$("startLine").addEventListener("click", () => runText("начать"));
$("breakLine").addEventListener("click", () => runText("прервать"));
$("left90").addEventListener("click", () => runText("налево 90"));
$("right90").addEventListener("click", () => runText("направо 90"));
$("undo").addEventListener("click", () => runText("отмена"));
$("redo").addEventListener("click", () => runText("повтори"));
$("save").addEventListener("click", () => exportDxf());
$("png").addEventListener("click", () => exportPng());
$("clear").addEventListener("click", () => {
  if (!confirm("Очистить чертёж в этом проекте?")) return;
  undoStack.push(snapshot(state));
  redoStack = [];
  state = newState();
  db.projects[db.current].state = state;
  addHistory("Чертёж очищен");
  persist();
  draw();
});
$("clearHistory").addEventListener("click", () => ($("history").innerHTML = ""));
$("projBtn").addEventListener("click", () => {
  renderProjects();
  $("projPanel").hidden = false;
});
$("projClose").addEventListener("click", () => ($("projPanel").hidden = true));
$("projNew").addEventListener("click", createProject);
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
refresh();
