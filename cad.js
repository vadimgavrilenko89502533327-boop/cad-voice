// Геометрия чертежа и команды (порт cad/geometry.py и cad/controller.py)
// Единица чертежа = 1 см. В DXF это указано через $INSUNITS = 5 (сантиметры).

export const DEFAULT_TEXT_H = 10;
export const DIM_OFFSET = 5;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;
const norm360 = (a) => ((a % 360) + 360) % 360;
const f1 = (v) => (Math.abs(v) < 0.05 ? 0 : Number(v)).toFixed(1);

export function newState() {
  return { pos: { x: 0, y: 0 }, angle: 0, entities: [], active: null };
}

export function snapshot(s) {
  return JSON.parse(JSON.stringify(s));
}

function ensurePoly(s) {
  if (s.active === null) {
    s.entities.push({ type: "poly", pts: [{ ...s.pos }], bulges: [], closed: false });
    s.active = s.entities.length - 1;
  }
  return s.entities[s.active];
}

function lastPoly(s) {
  for (let i = s.entities.length - 1; i >= 0; i--) {
    if (s.entities[i].type === "poly") return s.entities[i];
  }
  return null;
}

function turn(s, delta) {
  s.angle = norm360(s.angle + delta);
}

function forward(s, cm) {
  const poly = ensurePoly(s);
  const a = rad(s.angle);
  const np = { x: s.pos.x + cm * Math.cos(a), y: s.pos.y + cm * Math.sin(a) };
  poly.pts.push(np);
  poly.bulges.push(0);
  s.pos = np;
  return np;
}

function arc(s, r, angDeg, direction) {
  const poly = ensurePoly(s);
  const left = direction === "left";
  const th = (left ? 1 : -1) * rad(Math.abs(angDeg));
  const a = rad(s.angle);
  const [nx, ny] = left ? [-Math.sin(a), Math.cos(a)] : [Math.sin(a), -Math.cos(a)];
  const cx = s.pos.x + r * nx;
  const cy = s.pos.y + r * ny;
  const start = Math.atan2(s.pos.y - cy, s.pos.x - cx);
  const end = start + th;
  const np = { x: cx + r * Math.cos(end), y: cy + r * Math.sin(end) };
  poly.pts.push(np);
  poly.bulges.push(Math.tan(th / 4));
  s.pos = np;
  s.angle = norm360(deg(end + (left ? Math.PI / 2 : -Math.PI / 2)));
}

// Сегменты полилинии: [p, q, bulge]
export function polySegments(poly) {
  const n = poly.pts.length;
  const segs = [];
  for (let i = 0; i < n - 1; i++) segs.push([poly.pts[i], poly.pts[i + 1], poly.bulges[i] || 0]);
  if (poly.closed && n >= 3) segs.push([poly.pts[n - 1], poly.pts[0], 0]);
  return segs;
}

// Точки дуги между p и q для рисования (включая q, без p)
export function sampleSegment(p, q, b) {
  if (!b) return [q];
  const dx = q.x - p.x, dy = q.y - p.y;
  const L = Math.hypot(dx, dy);
  if (L === 0) return [q];
  const t = 4 * Math.atan(Math.abs(b));
  const sg = Math.sign(b);
  const h = (L / 2) / Math.tan(t / 2);
  const mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2;
  const cx = mx + sg * (-dy / L) * h;
  const cy = my + sg * (dx / L) * h;
  const R = L / (2 * Math.sin(t / 2));
  const th = sg * t;
  const a0 = Math.atan2(p.y - cy, p.x - cx);
  const n = Math.max(3, Math.ceil(t * 10));
  const pts = [];
  for (let k = 1; k <= n; k++) {
    const a = a0 + (th * k) / n;
    pts.push({ x: cx + R * Math.cos(a), y: cy + R * Math.sin(a) });
  }
  return pts;
}

function segLength(p, q, b) {
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  if (!b) return L;
  const R = (L * (1 + b * b)) / (4 * Math.abs(b));
  return R * 4 * Math.atan(Math.abs(b));
}

function segArea(p, q, b) {
  if (!b) return 0;
  const L = Math.hypot(q.x - p.x, q.y - p.y);
  const R = (L * (1 + b * b)) / (4 * Math.abs(b));
  const t = 4 * Math.atan(Math.abs(b));
  return (R * R / 2) * (t - Math.sin(t)) * Math.sign(b);
}

// Площадь (м²) и периметр (м) активного или последнего контура
export function metrics(s) {
  const poly = s.active !== null ? s.entities[s.active] : lastPoly(s);
  if (!poly) return { area: 0, perim: 0 };
  let perim = 0, shoe = 0, bulgeArea = 0;
  for (const [p, q, b] of polySegments(poly)) {
    perim += segLength(p, q, b);
    shoe += p.x * q.y - q.x * p.y;
    bulgeArea += segArea(p, q, b);
  }
  const area = poly.closed ? Math.abs(shoe / 2 + bulgeArea) : 0;
  return { area: area / 10000, perim: perim / 100 };
}

const ok = (msg, changed = true) => ({ msg, changed });
const fail = (msg) => ({ msg, changed: false });

// Выполняет разобранную команду, меняя состояние s. Возвращает {msg, changed}.
export function execute(s, parsed) {
  const a = parsed.args;
  switch (parsed.intent) {
    case "forward": {
      const np = forward(s, a.dist_cm);
      return ok(`Прямо ${f1(a.dist_cm)} см -> (${f1(np.x)}, ${f1(np.y)})`);
    }
    case "turn_right":
      turn(s, -a.angle);
      return ok(`Поворот направо ${f1(a.angle)}°. Текущий угол ${f1(s.angle)}°.`);
    case "turn_left":
      turn(s, a.angle);
      return ok(`Поворот налево ${f1(a.angle)}°. Текущий угол ${f1(s.angle)}°.`);
    case "set_angle":
      s.angle = norm360(a.angle);
      return ok(`Угол установлен ${f1(s.angle)}°.`);
    case "arc":
      arc(s, a.radius_cm, a.angle_deg, a.direction);
      return ok(`Дуга R=${f1(a.radius_cm)} см, угол=${f1(a.angle_deg)}°, ${a.direction === "right" ? "направо" : "налево"}`);
    case "circle":
      s.entities.push({ type: "circle", c: { ...s.pos }, r: a.radius_cm });
      return ok(`Окружность R=${f1(a.radius_cm)} см в (${f1(s.pos.x)}, ${f1(s.pos.y)})`);
    case "rect": {
      const x0 = s.pos.x, y0 = s.pos.y, w = a.w_cm, h = a.h_cm;
      s.entities.push({
        type: "poly",
        pts: [{ x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h }],
        bulges: [0, 0, 0],
        closed: true,
      });
      s.pos = { x: x0 + w, y: y0 + h };
      return ok(`Прямоугольник ${f1(w)} x ${f1(h)} см`);
    }
    case "text": {
      const h = a.height_cm || DEFAULT_TEXT_H;
      s.entities.push({ type: "text", p: { ...s.pos }, s: a.text, h });
      return ok(`Текст «${a.text}» добавлен.`);
    }
    case "dim": {
      const poly = s.active !== null ? s.entities[s.active] : null;
      if (!poly || poly.pts.length < 2) return fail("Недостаточно точек для размера.");
      const p1 = poly.pts[poly.pts.length - 2], p2 = poly.pts[poly.pts.length - 1];
      const len = Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1;
      s.entities.push({ type: "dim", a: p1, b: p2, off: DIM_OFFSET, label: f1(len) + " см" });
      return ok(`Размер ${f1(len)} см поставлен.`);
    }
    case "window":
    case "door": {
      const from = { ...s.pos };
      const np = forward(s, a.dist_cm);
      const isWindow = parsed.intent === "window";
      s.entities.push({ type: "seg", a: from, b: np, color: isWindow ? "red" : "blue" });
      return ok(`${isWindow ? "Окно" : "Дверь"} ${f1(a.dist_cm)} см`);
    }
    case "new_polyline":
      s.entities.push({ type: "poly", pts: [{ ...s.pos }], bulges: [], closed: false });
      s.active = s.entities.length - 1;
      return ok("Новая полилиния начата.");
    case "end_polyline":
      if (s.active === null) return fail("Активной полилинии нет.");
      s.active = null;
      return ok("Полилиния завершена.");
    case "close": {
      const poly = s.active !== null ? s.entities[s.active] : null;
      if (!poly || poly.pts.length < 3) return fail("Для замыкания нужно минимум 3 точки.");
      poly.closed = true;
      s.active = null;
      return ok("Контур замкнут.");
    }
    case "reset":
      Object.assign(s, newState());
      return ok("Состояние сброшено.");
    case "status":
      return fail(
        `Позиция: (${f1(s.pos.x)}, ${f1(s.pos.y)}), угол ${f1(s.angle)}°, ` +
        `активная полилиния: ${s.active !== null ? "да" : "нет"}`
      );
    case "zoom_extents":
      return fail("Масштаб по объектам.");
    case "stop":
      return fail("Пауза.");
    case "help":
      return fail(HELP);
    default:
      return fail(`Не понял команду: ${parsed.raw}`);
  }
}

const HELP =
  "Число (например 200) — линия по текущему углу. Начать / прервать — начать или прервать линию. " +
  "Направо / налево <град> — поворот, угол <град>, окно <см>, дверь <см>, " +
  "дуга радиус <см> угол <град>, окружность радиус <см>, прямоугольник <см> на <см>, " +
  "текст <текст>, размер, замкнуть, отмена, сброс, статус, сохранить, стоп, помощь.";

// Текст в DXF: не-ASCII символы кодируются как \U+XXXX, чтобы кириллица читалась в любой версии AutoCAD
function dxfText(s) {
  let out = "";
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    out += code < 128 ? ch : "\\U+" + code.toString(16).toUpperCase().padStart(4, "0");
  }
  return out;
}

const num = (v) => Number(v).toFixed(6);

export function buildDxf(entities) {
  const out = [];
  const p = (code, value) => out.push(String(code), String(value));
  p(0, "SECTION"); p(2, "HEADER");
  p(9, "$ACADVER"); p(1, "AC1015");
  p(9, "$INSUNITS"); p(70, 5);
  p(9, "$DWGCODEPAGE"); p(3, "ANSI_1251");
  p(0, "ENDSEC");
  p(0, "SECTION"); p(2, "ENTITIES");
  for (const e of entities) {
    if (e.type === "poly") {
      p(0, "LWPOLYLINE"); p(8, "0");
      p(90, e.pts.length);
      p(70, e.closed ? 1 : 0);
      e.pts.forEach((pt, i) => {
        p(10, num(pt.x)); p(20, num(pt.y));
        p(42, num((e.bulges && e.bulges[i]) || 0));
      });
    } else if (e.type === "seg") {
      p(0, "LINE"); p(8, "0"); p(62, e.color === "red" ? 1 : 5);
      p(10, num(e.a.x)); p(20, num(e.a.y)); p(11, num(e.b.x)); p(21, num(e.b.y));
    } else if (e.type === "circle") {
      p(0, "CIRCLE"); p(8, "0");
      p(10, num(e.c.x)); p(20, num(e.c.y)); p(40, num(e.r));
    } else if (e.type === "text") {
      p(0, "TEXT"); p(8, "0");
      p(10, num(e.p.x)); p(20, num(e.p.y)); p(40, num(e.h));
      p(1, dxfText(e.s));
    } else if (e.type === "dim") {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const L = Math.hypot(dx, dy) || 1;
      const nx = (-dy / L) * e.off, ny = (dx / L) * e.off;
      const mx = (e.a.x + e.b.x) / 2 + nx, my = (e.a.y + e.b.y) / 2 + ny;
      p(0, "LINE"); p(8, "DIM");
      p(10, num(e.a.x)); p(20, num(e.a.y)); p(11, num(e.b.x)); p(21, num(e.b.y));
      p(0, "TEXT"); p(8, "DIM");
      p(10, num(mx)); p(20, num(my)); p(40, num(3));
      p(1, dxfText(e.label));
    }
  }
  p(0, "ENDSEC");
  p(0, "EOF");
  return out.join("\r\n") + "\r\n";
}
