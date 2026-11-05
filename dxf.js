// Экспорт в DXF формата R12 (AC1009): его читают все версии AutoCAD.
// В приложении координаты в сантиметрах, в файле — в метрах ($INSUNITS = 6): 600 см → 6.0.
// Текст кодируется в cp1251 ($DWGCODEPAGE = ANSI_1251).
import { polySegments } from "./cad.js";

const K = 0.01;              // сантиметры -> метры
const TEXT_H = 10 * K;       // высота подписей, 0.10 м
const LABEL_OFF = 12 * K;    // отступ подписи от линии, 0.12 м

const n = (v) => (Number(v) * K).toFixed(6);

function readableDeg(dx, dy) {
  let a = Math.atan2(dy, dx);
  if (a > Math.PI / 2) a -= Math.PI;
  else if (a < -Math.PI / 2) a += Math.PI;
  return ((a * 180) / Math.PI).toFixed(4);
}

export function buildDxf(entities, layers = { "0": { visible: true } }) {
  const out = [];
  const p = (code, value) => out.push(String(code), String(value));

  p(0, "SECTION"); p(2, "HEADER");
  p(9, "$ACADVER"); p(1, "AC1009");
  p(9, "$INSUNITS"); p(70, 6);
  p(9, "$DWGCODEPAGE"); p(3, "ANSI_1251");
  p(0, "ENDSEC");

  const names = Object.keys(layers);
  if (!names.includes("0")) names.unshift("0");
  p(0, "SECTION"); p(2, "TABLES");
  p(0, "TABLE"); p(2, "LAYER"); p(70, names.length);
  for (const name of names) {
    p(0, "LAYER"); p(2, name); p(70, 0); p(62, 7); p(6, "CONTINUOUS");
  }
  p(0, "ENDTAB");
  p(0, "ENDSEC");

  p(0, "SECTION"); p(2, "ENTITIES");
  for (const e of entities) {
    const L = e.layer || "0";
    if (e.type === "poly") {
      p(0, "POLYLINE"); p(8, L); p(66, 1);
      p(10, "0.000000"); p(20, "0.000000"); p(70, e.closed ? 1 : 0);
      e.pts.forEach((pt, i) => {
        p(0, "VERTEX"); p(8, L);
        p(10, n(pt.x)); p(20, n(pt.y));
        p(42, ((e.bulges && e.bulges[i]) || 0).toFixed(6));
      });
      p(0, "SEQEND"); p(8, L);
      for (const [i, [a, b]] of polySegments(e).entries()) {
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        const mx = (a.x + b.x) / 2 + (-dy / len) * (LABEL_OFF / K);
        const my = (a.y + b.y) / 2 + (dx / len) * (LABEL_OFF / K);
        p(0, "TEXT"); p(8, L);
        p(10, n(mx)); p(20, n(my)); p(40, TEXT_H.toFixed(6));
        p(1, (len / 100).toFixed(2));
        p(50, readableDeg(dx, dy));
        if (e.notes && e.notes[i]) {
          p(0, "TEXT"); p(8, L);
          p(10, n((a.x + b.x) / 2 - (-dy / len) * (LABEL_OFF / K)));
          p(20, n((a.y + b.y) / 2 - (dx / len) * (LABEL_OFF / K)));
          p(40, TEXT_H.toFixed(6));
          p(1, e.notes[i]);
          p(50, readableDeg(dx, dy));
        }
      }
    } else if (e.type === "seg") {
      p(0, "LINE"); p(8, L); p(62, e.color === "red" ? 1 : 5);
      p(10, n(e.a.x)); p(20, n(e.a.y)); p(11, n(e.b.x)); p(21, n(e.b.y));
    } else if (e.type === "circle") {
      p(0, "CIRCLE"); p(8, L);
      p(10, n(e.c.x)); p(20, n(e.c.y)); p(40, n(e.r));
    } else if (e.type === "text") {
      p(0, "TEXT"); p(8, L);
      p(10, n(e.p.x)); p(20, n(e.p.y)); p(40, n(e.h));
      p(1, e.s);
    } else if (e.type === "dim") {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const len = Math.hypot(dx, dy) || 1;
      const mx = (e.a.x + e.b.x) / 2 + (-dy / len) * e.off;
      const my = (e.a.y + e.b.y) / 2 + (dx / len) * e.off;
      p(0, "LINE"); p(8, L);
      p(10, n(e.a.x)); p(20, n(e.a.y)); p(11, n(e.b.x)); p(21, n(e.b.y));
      p(0, "TEXT"); p(8, L);
      p(10, n(mx)); p(20, n(my)); p(40, TEXT_H.toFixed(6));
      p(1, (len / 100).toFixed(2));
      p(50, readableDeg(dx, dy));
    }
  }
  p(0, "ENDSEC");
  p(0, "EOF");
  return out.join("\r\n") + "\r\n";
}

// Строку в байты cp1251 (кириллица попадает в DXF без искажений)
export function toCp1251(str) {
  const bytes = new Uint8Array(str.length);
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    let b = 63;
    if (c < 128) b = c;
    else if (c >= 0x410 && c <= 0x44f) b = c - 0x410 + 0xc0;
    else if (c === 0x401) b = 0xa8;
    else if (c === 0x451) b = 0xb8;
    bytes[i] = b;
  }
  return bytes;
}
