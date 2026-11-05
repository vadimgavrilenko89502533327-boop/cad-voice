import { parse } from "./parser.js";
import { newState, snapshot, execute, metrics, polySegments, sampleSegment, removeSegments } from "./cad.js";
import { buildDxf, toCp1251 } from "./dxf.js";
import { buildPdf } from "./pdf.js";

const DB_KEY = "cadvoice-projects-v1";
const LEGACY_KEY = "cadvoice-state-v1";
const $ = (id) => document.getElementById(id);
const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------- состояние ----------
let db = loadDb();
let state = db.projects[db.current].state;
let undoStack = [];
let redoStack = [];

const canvas = $("canvas");
const ctx = canvas.getContext("2d");
const view = { zoom: 1, panX: 0, panY: 0 };
let lastNodes = [];
let lastTr = null;
let lastInv = null;
let tool = "idle";          // idle | pickA | pickB
let pendA = null;           // первая точка линии A–B
let sel = [];
let pivot = null;        // выбранный сегмент {ent, seg}

// ---------- проекты и слои ----------
function ensureLayers(s) {
  if (!s.layers) s.layers = {};
  if (!s.layers["0"]) s.layers["0"] = { visible: true };
  if (!s.curLayer || !s.layers[s.curLayer]) s.curLayer = "0";
  return s;
}

function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(DB_KEY));
    if (d && d.projects && d.projects[d.current]) {
      for (const p of Object.values(d.projects)) ensureLayers(p.state);
      return d;
    }
  } catch (e) { /* нет данных */ }
  let legacy = null;
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch (e) { /* нет данных */ }
  const id = newId();
  const st = legacy && Array.isArray(legacy.entities) ? legacy : newState();
  return {
    current: id,
    projects: { [id]: { id, name: "Проект 1", created: Date.now(), updated: Date.now(), state: ensureLayers(st) } },
  };
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

function resetTools() {
  undoStack = [];
  redoStack = [];
  tool = "idle";
  pendA = null;
  pivot = null;
  sel = [];
}

function openProject(id) {
  persist();
  db.current = id;
  state = ensureLayers(db.projects[id].state);
  resetTools();
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
  resetTools();
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
    state = ensureLayers(next.state);
    resetTools();
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

function renderLayers() {
  const list = $("layerList");
  list.innerHTML = "";
  for (const [name, info] of Object.entries(state.layers)) {
    const li = document.createElement("li");
    if (name === state.curLayer) li.className = "cur";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = info.visible;
    cb.title = "Показывать слой";
    cb.addEventListener("change", () => {
      state.layers[name].visible = cb.checked;
      persist();
      draw();
    });
    const label = document.createElement("span");
    label.className = "lname";
    label.textContent = name + (name === state.curLayer ? "  (текущий)" : "");
    label.addEventListener("click", () => {
      state.curLayer = name;
      persist();
      renderLayers();
      setStatus(`Текущий слой: ${name}`, "idle");
    });
    li.append(cb, label);
    list.appendChild(li);
  }
}

function addLayer() {
  const name = (prompt("Название слоя (например: Стены, Окна, Мебель):", "") || "").trim();
  if (!name) return;
  if (state.layers[name]) {
    alert("Слой с таким названием уже есть.");
    return;
  }
  state.layers[name] = { visible: true };
  state.curLayer = name;
  persist();
  renderLayers();
  setStatus(`Создан слой «${name}». Новые объекты пойдут на него.`, "idle");
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
    const countBefore = state.entities.length;
    const res = execute(state, parsed);
    for (let i = countBefore; i < state.entities.length; i++) {
      if (!state.entities[i].layer) state.entities[i].layer = state.curLayer;
    }
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

// Угол поворота текста вдоль линии, чтобы текст не был вверх ногами
function readableAngle(dx, dy) {
  let a = Math.atan2(dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a < -Math.PI / 2) a += Math.PI;
  return a;
}

const isShown = (e) => ((state.layers[e.layer || "0"]) || { visible: true }).visible;

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

  const shown = state.entities.filter(isShown);
  const pts = [];
  const nodes = [];
  for (const e of shown) {
    if (e.type === "poly") { pts.push(...e.pts); nodes.push(...e.pts); }
    else if (e.type === "circle") pts.push({ x: e.c.x - e.r, y: e.c.y - e.r }, { x: e.c.x + e.r, y: e.c.y + e.r });
    else if (e.type === "text") pts.push(e.p);
    else if (e.type === "dim") pts.push(e.a, e.b);
    else if (e.type === "seg") { pts.push(e.a, e.b); nodes.push(e.a, e.b); }
  }
  lastNodes = nodes;

  if (pts.length < 2) {
    lastTr = null;
    lastInv = (p) => ({ x: (p.x - W / 2 - view.panX) / view.zoom, y: -(p.y - (H - 30) / 2 - view.panY) / view.zoom });
    ctx.fillStyle = "#8a8a8a";
    ctx.font = "16px system-ui";
    ctx.textAlign = "center";
    ctx.fillText("Скажите или напишите, например: «200»", W / 2, H / 2);
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
  lastTr = tr;
  lastInv = (p) => ({
    x: cx + (p.x - (W / 2 + view.panX)) / s,
    y: cy - (p.y - ((H - 30) / 2 + view.panY)) / s,
  });

  ctx.strokeStyle = "#1c1c1c";
  ctx.fillStyle = "#1c1c1c";
  ctx.lineWidth = 4;
  ctx.lineJoin = "miter";
  ctx.font = "13px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  for (const e of shown) {
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

  ctx.save();
  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#8a8a8a";
  ctx.lineWidth = 1.5;
  for (const n of nodes) {
    const q = tr(n);
    ctx.beginPath();
    ctx.arc(q.x, q.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  }
  const pen = tr(state.pos);
  ctx.fillStyle = "#c0392b";
  ctx.beginPath();
  ctx.arc(pen.x, pen.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  drawOverlays(tr);

  const ox = 30, oy = H - 30;
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 50); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + 50, oy); ctx.stroke();
  ctx.fillText("Y", ox - 8, oy - 58);
  ctx.fillText("X", ox + 60, oy);

  updateMetrics();
}

// Заметки к сегментам, выбранный сегмент, первая точка линии A–B
function drawOverlays(tr) {
  ctx.save();
  ctx.fillStyle = "#b9770e";
  ctx.font = "italic 13px system-ui";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const e of state.entities) {
    if (e.type !== "poly" || !e.notes || !isShown(e)) continue;
    polySegments(e).forEach(([a, b], i) => {
      const note = e.notes[i];
      if (!note) return;
      const A = tr(a), B = tr(b);
      ctx.save();
      ctx.translate((A.x + B.x) / 2, (A.y + B.y) / 2);
      ctx.rotate(readableAngle(B.x - A.x, B.y - A.y));
      ctx.fillText(note, 0, 14);
      ctx.restore();
    });
  }
  for (const s of sel) {
    const e = state.entities[s.ent];
    const seg = e && e.type === "poly" ? polySegments(e)[s.seg] : null;
    if (!seg) continue;
    const A = tr(seg[0]), B = tr(seg[1]);
    ctx.strokeStyle = "#f39c12";
    ctx.lineWidth = 9;
    ctx.beginPath();
    ctx.moveTo(A.x, A.y);
    ctx.lineTo(B.x, B.y);
    ctx.stroke();
  }
  if (pivot) {
    const q = tr(pivot);
    ctx.strokeStyle = "#f39c12";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(q.x, q.y, 9, 0, Math.PI * 2);
    ctx.stroke();
  }
  if (pendA) {
    const q = tr(pendA);
    ctx.strokeStyle = "#1e5fd0";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(q.x - 7, q.y - 7); ctx.lineTo(q.x + 7, q.y + 7);
    ctx.moveTo(q.x + 7, q.y - 7); ctx.lineTo(q.x - 7, q.y + 7);
    ctx.stroke();
  }
  ctx.restore();
}

function updateMetrics() {
  const { area, perim } = metrics(state);
  $("area").textContent = area.toFixed(2) + " м²";
  $("perim").textContent = perim.toFixed(2) + " м";
}

// ---------- касания: точка, линия A–B, выбор сегмента, продолжение от узла ----------
function nodeAt(p, radius = 24) {
  if (!lastTr) return null;
  let best = null, bestD = radius;
  for (const n of lastNodes) {
    const q = lastTr(n);
    const d = Math.hypot(q.x - p.x, q.y - p.y);
    if (d < bestD) { bestD = d; best = n; }
  }
  return best;
}

function snapPoint(p) {
  const node = nodeAt(p);
  if (node) return { x: node.x, y: node.y };
  const w = lastInv(p);
  return { x: w.x, y: w.y };
}

function distToSeg(p, A, B) {
  const dx = B.x - A.x, dy = B.y - A.y;
  const L2 = dx * dx + dy * dy || 1;
  let t = ((p.x - A.x) * dx + (p.y - A.y) * dy) / L2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (A.x + t * dx), p.y - (A.y + t * dy));
}

function hitSegment(p) {
  if (!lastTr) return null;
  let best = null, bestD = 10;
  state.entities.forEach((e, ent) => {
    if (e.type !== "poly" || !isShown(e)) return;
    polySegments(e).forEach(([a, b], seg) => {
      const d = distToSeg(p, lastTr(a), lastTr(b));
      if (d < bestD) { bestD = d; best = { ent, seg }; }
    });
  });
  return best;
}

function pickNode(p) {
  const best = nodeAt(p);
  if (!best) return false;
  undoStack.push(snapshot(state));
  redoStack = [];
  state.pos = { x: best.x, y: best.y };
  state.active = null;
  addHistory(`Продолжение от точки (${best.x.toFixed(0)}, ${best.y.toFixed(0)})`);
  persist();
  draw();
  setStatus("Точка выбрана. Следующая линия пойдёт отсюда.", "idle");
  return true;
}

function createLine(a, b) {
  undoStack.push(snapshot(state));
  redoStack = [];
  state.entities.push({
    type: "poly",
    pts: [{ x: a.x, y: a.y }, { x: b.x, y: b.y }],
    bulges: [0],
    closed: false,
    notes: {},
    layer: state.curLayer,
  });
  const L = Math.hypot(b.x - a.x, b.y - a.y) / 100;
  addHistory(`Линия ${L.toFixed(2)} м (от точки до точки)`);
  persist();
  draw();
}

function handleTap(p) {
  if (tool === "pickA") {
    pendA = snapPoint(p);
    tool = "idle";
    $("lineBtn").disabled = false;
    setStatus("Точка указана. Нажмите «Построить линию» и отметьте вторую точку.", "idle");
    draw();
    return;
  }
  if (tool === "pickB") {
    const b = snapPoint(p);
    createLine(pendA, b);
    pendA = null;
    tool = "idle";
    $("lineBtn").disabled = true;
    setStatus("Линия построена.", "idle");
    return;
  }
  if (tool === "pickPivot") {
    pivot = snapPoint(p);
    tool = "idle";
    draw();
    openRotate();
    return;
  }
  if (pickNode(p)) return;
  const hit = hitSegment(p);
  if (hit) {
    const i = sel.findIndex((s) => s.ent === hit.ent && s.seg === hit.seg);
    if (i >= 0) sel.splice(i, 1);
    else sel.push(hit);
  } else {
    sel = [];
  }
  updateSelBar();
  if (sel.length) setStatus("Выберите ещё сегменты или нажмите «Удалить», «Заметка», «Повернуть».", "idle");
  draw();
}

function updateSelBar() {
  $("selbar").hidden = sel.length === 0;
  $("selCount").textContent = `Выбрано сегментов: ${sel.length}`;
}

function deleteSelected() {
  if (!sel.length) return;
  const byEnt = new Map();
  for (const s of sel) {
    if (!byEnt.has(s.ent)) byEnt.set(s.ent, new Set());
    byEnt.get(s.ent).add(s.seg);
  }
  undoStack.push(snapshot(state));
  redoStack = [];
  const ents = [...byEnt.keys()].sort((a, b) => b - a);
  for (const ent of ents) {
    const e = state.entities[ent];
    const pieces = removeSegments(e, byEnt.get(ent)).map((piece) => ({ ...piece, layer: e.layer }));
    state.entities.splice(ent, 1, ...pieces);
  }
  const count = sel.length;
  state.active = null;
  sel = [];
  updateSelBar();
  addHistory(`Удалено сегментов: ${count}`);
  persist();
  draw();
}

function noteSelected() {
  if (!sel.length) return;
  const first = state.entities[sel[0].ent];
  const old = (first.notes && first.notes[sel[0].seg]) || "";
  const raw = prompt(`Заметка для выбранных сегментов (${sel.length}):`, old);
  if (raw === null) return;
  const text = raw.trim();
  undoStack.push(snapshot(state));
  redoStack = [];
  for (const s of sel) {
    const e = state.entities[s.ent];
    e.notes = e.notes || {};
    if (text) e.notes[s.seg] = text;
    else delete e.notes[s.seg];
  }
  addHistory(text ? `Заметка на ${sel.length} сегм.: ${text}` : "Заметки удалены");
  persist();
  draw();
}

function openRotate() {
  $("rotDeg").value = "90";
  $("rotSide").value = "right";
  $("rotModal").hidden = false;
}

function cancelRotate() {
  $("rotModal").hidden = true;
  pivot = null;
  tool = "idle";
  draw();
}

function applyRotate() {
  const deg = parseFloat($("rotDeg").value);
  if (!Number.isFinite(deg) || !sel.length || !pivot) {
    cancelRotate();
    return;
  }
  const side = $("rotSide").value === "left" ? 1 : -1;
  const th = (side * deg * Math.PI) / 180;
  const c = Math.cos(th), s = Math.sin(th);
  const verts = new Map();
  for (const { ent, seg } of sel) {
    const e = state.entities[ent];
    if (e.type !== "poly") continue;
    if (!verts.has(ent)) verts.set(ent, new Set());
    verts.get(ent).add(seg);
    verts.get(ent).add((seg + 1) % e.pts.length);
  }
  undoStack.push(snapshot(state));
  redoStack = [];
  for (const [ent, idxs] of verts) {
    const e = state.entities[ent];
    for (const i of idxs) {
      const p = e.pts[i];
      const dx = p.x - pivot.x, dy = p.y - pivot.y;
      e.pts[i] = { x: pivot.x + dx * c - dy * s, y: pivot.y + dx * s + dy * c };
    }
  }
  addHistory(`Поворот ${side > 0 ? "налево" : "направо"} на ${deg}° вокруг точки`);
  $("rotModal").hidden = true;
  pivot = null;
  tool = "idle";
  persist();
  draw();
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
  const dxf = buildDxf(state.entities, state.layers);
  shareFile(new Blob([toCp1251(dxf)], { type: "application/dxf" }), fileName("dxf"), "application/dxf");
}

function exportPng() {
  draw();
  canvas.toBlob((blob) => shareFile(blob, fileName("png"), "image/png"), "image/png");
}

function exportPdf() {
  draw();
  canvas.toBlob(async (jpg) => {
    const bytes = buildPdf(new Uint8Array(await jpg.arrayBuffer()), canvas.width, canvas.height);
    shareFile(new Blob([bytes], { type: "application/pdf" }), fileName("pdf"), "application/pdf");
  }, "image/jpeg", 0.92);
}

// ---------- голос: Safari (основной) и Vosk (офлайн, запасной) ----------
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let listening = false;
let webRec = null;
let lastStart = 0;
let quickEnds = 0;
let model = null;
let recognizer = null;
let audio = null;

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
  webRec.onspeechstart = () => setStatus("Слышу речь…", "rec");
  webRec.onnomatch = () => setStatus("Речь не распознана, повторите", "idle");
  webRec.onerror = (e) => {
    if (e.error === "no-speech") {
      setStatus("Не слышу речи. Говорите после нажатия ●", "rec");
      return;
    }
    if (e.error === "aborted") return;
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

async function startVosk() {
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

// ---------- сдвиг и масштаб ----------
const pointers = new Map();
let pinchDist = 0;
let tap = null;

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
  try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* нет активного указателя */ }
  const p = canvasPoint(e);
  pointers.set(e.pointerId, p);
  pinchDist = 0;
  tap = pointers.size === 1 ? { x: p.x, y: p.y, t: Date.now() } : null;
});

canvas.addEventListener("pointermove", (e) => {
  if (!pointers.has(e.pointerId)) return;
  const prev = pointers.get(e.pointerId);
  const cur = canvasPoint(e);
  pointers.set(e.pointerId, cur);
  if (tap && Math.hypot(cur.x - tap.x, cur.y - tap.y) > 8) tap = null;
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
  const wasSingle = pointers.size === 1 && pointers.has(e.pointerId);
  if (e.type === "pointerup" && tap && wasSingle && Date.now() - tap.t < 500) {
    handleTap(canvasPoint(e));
  }
  pointers.delete(e.pointerId);
  pinchDist = 0;
  if (pointers.size === 0) tap = null;
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

// ---------- кнопки ----------
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

$("mic").addEventListener("click", () => {
  if (isIOS) {
    $("input").focus();
    setStatus("Нажмите микрофон на клавиатуре, скажите команду и нажмите Enter", "busy");
    return;
  }
  if (listening) stopListening();
  else if (SpeechRec) startWebSpeech();
  else startVosk();
});
$("startLine").addEventListener("click", () => runText("начать"));
$("breakLine").addEventListener("click", () => runText("прервать"));
$("left90").addEventListener("click", () => runText("налево 90"));
$("right90").addEventListener("click", () => runText("направо 90"));
$("pointBtn").addEventListener("click", () => {
  tool = "pickA";
  pendA = null;
  $("lineBtn").disabled = true;
  setStatus("Отметьте первую точку на чертеже.", "busy");
  draw();
});
$("lineBtn").addEventListener("click", () => {
  if (!pendA) return;
  tool = "pickB";
  setStatus("Отметьте вторую точку — линия соединит их.", "busy");
});
$("selNote").addEventListener("click", noteSelected);
$("selDel").addEventListener("click", deleteSelected);
$("selRot").addEventListener("click", () => {
  if (!sel.length) return;
  tool = "pickPivot";
  pivot = null;
  setStatus("Коснитесь точки, вокруг которой повернуть выбранные сегменты.", "busy");
  draw();
});
$("selClear").addEventListener("click", () => {
  sel = [];
  updateSelBar();
  draw();
});
$("rotOk").addEventListener("click", applyRotate);
$("rotCancel").addEventListener("click", cancelRotate);
$("undo").addEventListener("click", () => runText("отмена"));
$("redo").addEventListener("click", () => runText("повтори"));
$("save").addEventListener("click", () => exportDxf());
$("pdf").addEventListener("click", () => exportPdf());
$("png").addEventListener("click", () => exportPng());
$("clear").addEventListener("click", () => {
  if (!confirm("Очистить чертёж в этом проекте?")) return;
  undoStack.push(snapshot(state));
  redoStack = [];
  const layers = state.layers, curLayer = state.curLayer;
  state = newState();
  state.layers = layers;
  state.curLayer = curLayer;
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
$("layersBtn").addEventListener("click", () => {
  renderLayers();
  $("layerPanel").hidden = false;
});
$("layerClose").addEventListener("click", () => ($("layerPanel").hidden = true));
$("layerNew").addEventListener("click", addLayer);
$("helpBtn").addEventListener("click", () => ($("welcome").hidden = false));
$("welcomeNext").addEventListener("click", () => ($("welcome").hidden = true));
$("zin").addEventListener("click", () => zoomCenter(1.25));
$("zout").addEventListener("click", () => zoomCenter(1 / 1.25));
$("zfit").addEventListener("click", () => {
  view.zoom = 1; view.panX = 0; view.panY = 0;
  draw();
});
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
