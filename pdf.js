// Векторный PDF (A4 альбом): линии, полилинии, окружности и текст — отдельными объектами,
// которые можно выделять и редактировать в Acrobat и других редакторах PDF.
// Шрифт DejaVu Sans вшивается в файл, поэтому кириллица отображается и копируется.
import { polySegments, sampleSegment } from "./cad.js";

const PAGE_W = 842, PAGE_H = 595, MARGIN = 40;
const K = 0.5523; // коэффициент окружности Безье

function u16(d, o) { return (d[o] << 8) | d[o + 1]; }
function s16(d, o) { const v = u16(d, o); return v >= 0x8000 ? v - 0x10000 : v; }
function u32(d, o) { return ((d[o] << 24) >>> 0) + (d[o + 1] << 16) + (d[o + 2] << 8) + d[o + 3]; }

// Разбор TrueType: метрики, ширины глифов и таблица cmap (Unicode -> номер глифа)
function parseFont(d) {
  const n = u16(d, 4);
  const t = {};
  for (let i = 0; i < n; i++) {
    const r = 12 + i * 16;
    t[String.fromCharCode(d[r], d[r + 1], d[r + 2], d[r + 3])] = { off: u32(d, r + 8) };
  }
  const head = t.head.off, hhea = t.hhea.off;
  const upem = u16(d, head + 18);
  const bbox = [s16(d, head + 36), s16(d, head + 38), s16(d, head + 40), s16(d, head + 42)];
  const ascent = s16(d, hhea + 4), descent = s16(d, hhea + 6);
  const nHM = u16(d, hhea + 34);
  const widths = [];
  for (let g = 0; g < nHM; g++) widths.push(u16(d, t.hmtx.off + g * 4));

  const cm = t.cmap.off;
  const nSub = u16(d, cm + 2);
  let sub = -1;
  for (let i = 0; i < nSub; i++) {
    const pid = u16(d, cm + 4 + i * 8), eid = u16(d, cm + 6 + i * 8), off = u32(d, cm + 8 + i * 8);
    if (pid === 3 && (eid === 1 || eid === 10) && u16(d, cm + off) === 4) sub = cm + off;
  }
  if (sub < 0) throw new Error("в шрифте нет таблицы cmap формата 4");
  const segX2 = u16(d, sub + 6);
  const endO = sub + 14, startO = endO + segX2 + 2, deltaO = startO + segX2, rangeO = deltaO + segX2;
  const map = new Map();
  for (let s = 0; s < segX2 / 2; s++) {
    const end = u16(d, endO + s * 2), start = u16(d, startO + s * 2);
    const delta = s16(d, deltaO + s * 2), ro = u16(d, rangeO + s * 2);
    for (let c = start; c <= end && c !== 0xffff; c++) {
      let g;
      if (ro === 0) g = (c + delta) & 0xffff;
      else {
        const gi = u16(d, rangeO + s * 2 + ro + (c - start) * 2);
        g = gi === 0 ? 0 : (gi + delta) & 0xffff;
      }
      if (g) map.set(c, g);
    }
  }
  const os2 = t["OS/2"];
  const capH = os2 && u16(d, os2.off) >= 2 ? s16(d, os2.off + 88) : 700;
  const gw = (g) => widths[Math.min(g, nHM - 1)];
  return { upem, bbox, ascent, descent, capH, map, gw };
}

export function buildPdf(entities, layers, fontBytes) {
  const font = parseFont(new Uint8Array(fontBytes));
  const shown = (e) => ((layers && layers[e.layer || "0"]) || { visible: true }).visible;
  const vis = entities.filter(shown);

  // Границы чертежа в сантиметрах
  const pts = [];
  for (const e of vis) {
    if (e.type === "poly") pts.push(...e.pts);
    else if (e.type === "seg") pts.push(e.a, e.b);
    else if (e.type === "circle") pts.push({ x: e.c.x - e.r, y: e.c.y - e.r }, { x: e.c.x + e.r, y: e.c.y + e.r });
    else if (e.type === "text") pts.push(e.p);
    else if (e.type === "dim") pts.push(e.a, e.b);
  }
  if (!pts.length) pts.push({ x: 0, y: 0 }, { x: 100, y: 100 });
  const minx = Math.min(...pts.map((p) => p.x)), maxx = Math.max(...pts.map((p) => p.x));
  const miny = Math.min(...pts.map((p) => p.y)), maxy = Math.max(...pts.map((p) => p.y));
  const bw = Math.max(maxx - minx, 1), bh = Math.max(maxy - miny, 1);
  const s = Math.min((PAGE_W - 2 * MARGIN) / bw, (PAGE_H - 2 * MARGIN) / bh);
  const ox = (PAGE_W - bw * s) / 2, oy = (PAGE_H - bh * s) / 2;
  const P = (p) => [ox + (p.x - minx) * s, oy + (p.y - miny) * s];
  const f2 = (v) => Number(v).toFixed(2);

  // Текст: строка -> шестнадцатеричные номера глифов (Identity-H)
  const used = new Map();
  const hex = (str) => {
    let h = "";
    for (const ch of str) {
      const cp = ch.codePointAt(0);
      const g = font.map.get(cp) || 0;
      used.set(g, cp);
      h += g.toString(16).padStart(4, "0");
    }
    return "<" + h + ">";
  };
  const text = (str, x, y, size, angle, color) => {
    const c = Math.cos(angle), sn = Math.sin(angle);
    return `${color} BT /F1 ${f2(size)} Tf ${f2(c)} ${f2(sn)} ${f2(-sn)} ${f2(c)} ${f2(x)} ${f2(y)} Tm ${hex(str)} Tj ET`;
  };
  const readable = (dx, dy) => {
    let a = Math.atan2(dy, dx);
    if (a > Math.PI / 2) a -= Math.PI;
    else if (a < -Math.PI / 2) a += Math.PI;
    return a;
  };

  const BLACK = "0.10 0.10 0.10 RG 0.10 0.10 0.10 rg";
  const RED = "0.83 0.18 0.18 RG 0.83 0.18 0.18 rg";
  const BLUE = "0.12 0.37 0.82 RG 0.12 0.37 0.82 rg";
  const ops = [];

  for (const e of vis) {
    if (e.type === "poly") {
      const segs = polySegments(e);
      if (!segs.length) continue;
      ops.push(`${BLACK} 0.8 w`);
      const [sx, sy] = P(segs[0][0]);
      let path = `${f2(sx)} ${f2(sy)} m`;
      for (const [p, q, b] of segs) {
        for (const sp of sampleSegment(p, q, b)) {
          const [x, y] = P(sp);
          path += ` ${f2(x)} ${f2(y)} l`;
        }
      }
      ops.push(path + " S");
      segs.forEach(([p, q], i) => {
        const k = e.kinds && e.kinds[i];
        if (!k) return;
        const [ax, ay] = P(p), [bx, by] = P(q);
        ops.push(`${k === "window" ? RED : BLUE} 3 w ${f2(ax)} ${f2(ay)} m ${f2(bx)} ${f2(by)} l S`);
      });
      segs.forEach(([p, q], i) => {
        const [ax, ay] = P(p), [bx, by] = P(q);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
        const ang = readable(dx, dy);
        ops.push(text((Math.hypot(q.x - p.x, q.y - p.y) / 100).toFixed(2), mx - (dy / L) * 9, my + (dx / L) * 9, 9, ang, BLACK));
        if (e.notes && e.notes[i]) {
          ops.push(text(e.notes[i], mx + (dy / L) * 9, my - (dx / L) * 9, 9, ang, BLACK));
        }
      });
    } else if (e.type === "seg") {
      const [ax, ay] = P(e.a), [bx, by] = P(e.b);
      ops.push(`${e.color === "red" ? RED : BLUE} 3 w ${f2(ax)} ${f2(ay)} m ${f2(bx)} ${f2(by)} l S`);
    } else if (e.type === "circle") {
      const [cx, cy] = P(e.c);
      const R = e.r * s, kk = R * K;
      ops.push(`${BLACK} 0.8 w`);
      ops.push(
        `${f2(cx + R)} ${f2(cy)} m ` +
        `${f2(cx + R)} ${f2(cy + kk)} ${f2(cx + kk)} ${f2(cy + R)} ${f2(cx)} ${f2(cy + R)} c ` +
        `${f2(cx - kk)} ${f2(cy + R)} ${f2(cx - R)} ${f2(cy + kk)} ${f2(cx - R)} ${f2(cy)} c ` +
        `${f2(cx - R)} ${f2(cy - kk)} ${f2(cx - kk)} ${f2(cy - R)} ${f2(cx)} ${f2(cy - R)} c ` +
        `${f2(cx + kk)} ${f2(cy - R)} ${f2(cx + R)} ${f2(cy - kk)} ${f2(cx + R)} ${f2(cy)} c S`
      );
    } else if (e.type === "text") {
      const [x, y] = P(e.p);
      ops.push(text(e.s, x, y, Math.max(6, e.h * s), 0, BLACK));
    } else if (e.type === "dim") {
      const [ax, ay] = P(e.a), [bx, by] = P(e.b);
      ops.push(`${BLACK} 0.5 w ${f2(ax)} ${f2(ay)} m ${f2(bx)} ${f2(by)} l S`);
      const dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
      const len = Math.hypot(e.b.x - e.a.x, e.b.y - e.a.y) / 100;
      ops.push(text(len.toFixed(2), (ax + bx) / 2 - (dy / L) * 9, (ay + by) / 2 + (dx / L) * 9, 9, readable(dx, dy), BLACK));
    }
  }

  const content = ops.join("\n");
  const enc = new TextEncoder();
  const parts = [];
  const offs = [];
  let len = 0;
  const add = (x) => {
    const b = typeof x === "string" ? enc.encode(x) : x;
    parts.push(b);
    len += b.length;
  };
  const obj = (n, body) => {
    offs[n] = len;
    add(`${n} 0 obj\n${body}\nendobj\n`);
  };
  const stream = (n, dict, bytes) => {
    offs[n] = len;
    add(`${n} 0 obj\n<< ${dict} /Length ${bytes.length} >>\nstream\n`);
    add(bytes);
    add("\nendstream\nendobj\n");
  };

  const k1000 = (v) => Math.round((v * 1000) / font.upem);
  const gids = [...used.keys()].sort((a, b) => a - b);
  const W = gids.map((g) => `${g} [${k1000(font.gw(g))}]`).join(" ");
  const cmapEntries = gids.map((g) => `<${g.toString(16).padStart(4, "0")}> <${used.get(g).toString(16).padStart(4, "0")}>`);
  const toUnicode =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
    "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    `${cmapEntries.length} beginbfchar\n${cmapEntries.join("\n")}\nendbfchar\n` +
    "endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend";
  const bb = font.bbox.map(k1000).join(" ");

  add("%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n");
  obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>`);
  stream(4, "", enc.encode(content));
  obj(5, "<< /Type /Font /Subtype /Type0 /BaseFont /DejaVuSans /Encoding /Identity-H /DescendantFonts [6 0 R] /ToUnicode 7 0 R >>");
  obj(6, `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /DejaVuSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /FontDescriptor 8 0 R /DW 600 /W [${W}] /CIDToGIDMap /Identity >>`);
  stream(7, "", enc.encode(toUnicode));
  obj(8, `<< /Type /FontDescriptor /FontName /DejaVuSans /Flags 32 /FontBBox [${bb}] /ItalicAngle 0 /Ascent ${k1000(font.ascent)} /Descent ${k1000(font.descent)} /CapHeight ${k1000(font.capH)} /StemV 80 /FontFile2 9 0 R >>`);
  stream(9, `/Length1 ${fontBytes.byteLength}`, new Uint8Array(fontBytes));

  const xref = len;
  let table = "xref\n0 10\n0000000000 65535 f \n";
  for (let i = 1; i <= 9; i++) table += String(offs[i]).padStart(10, "0") + " 00000 n \n";
  add(table + `trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(len);
  let pos = 0;
  for (const c of parts) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}
