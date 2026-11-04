// Экспорт в DXF формата R12 (AC1009): его читают все версии AutoCAD.
// Единица чертежа = 1 см ($INSUNITS = 5). Текст кодируется в cp1251 ($DWGCODEPAGE = ANSI_1251).

const num = (v) => Number(v).toFixed(6);

export function buildDxf(entities) {
  const out = [];
  const p = (code, value) => out.push(String(code), String(value));

  p(0, "SECTION"); p(2, "HEADER");
  p(9, "$ACADVER"); p(1, "AC1009");
  p(9, "$INSUNITS"); p(70, 5);
  p(9, "$DWGCODEPAGE"); p(3, "ANSI_1251");
  p(0, "ENDSEC");

  p(0, "SECTION"); p(2, "ENTITIES");
  for (const e of entities) {
    if (e.type === "poly") {
      p(0, "POLYLINE"); p(8, "0"); p(66, 1);
      p(10, "0.000000"); p(20, "0.000000"); p(70, e.closed ? 1 : 0);
      e.pts.forEach((pt, i) => {
        p(0, "VERTEX"); p(8, "0");
        p(10, num(pt.x)); p(20, num(pt.y));
        p(42, num((e.bulges && e.bulges[i]) || 0));
      });
      p(0, "SEQEND"); p(8, "0");
    } else if (e.type === "seg") {
      p(0, "LINE"); p(8, "0"); p(62, e.color === "red" ? 1 : 5);
      p(10, num(e.a.x)); p(20, num(e.a.y)); p(11, num(e.b.x)); p(21, num(e.b.y));
    } else if (e.type === "circle") {
      p(0, "CIRCLE"); p(8, "0");
      p(10, num(e.c.x)); p(20, num(e.c.y)); p(40, num(e.r));
    } else if (e.type === "text") {
      p(0, "TEXT"); p(8, "0");
      p(10, num(e.p.x)); p(20, num(e.p.y)); p(40, num(e.h));
      p(1, e.s);
    } else if (e.type === "dim") {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const L = Math.hypot(dx, dy) || 1;
      const mx = (e.a.x + e.b.x) / 2 + (-dy / L) * e.off;
      const my = (e.a.y + e.b.y) / 2 + (dx / L) * e.off;
      p(0, "LINE"); p(8, "0");
      p(10, num(e.a.x)); p(20, num(e.a.y)); p(11, num(e.b.x)); p(21, num(e.b.y));
      p(0, "TEXT"); p(8, "0");
      p(10, num(mx)); p(20, num(my)); p(40, num(3));
      p(1, e.label);
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
