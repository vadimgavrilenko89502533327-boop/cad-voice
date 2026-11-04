// Разбор голосовых команд (порт nlp/parser.py)

const NUM_WORDS = {
  "ноль": 0, "нуль": 0, "один": 1, "одна": 1, "одно": 1, "два": 2, "две": 2, "три": 3,
  "четыре": 4, "пять": 5, "шесть": 6, "семь": 7, "восемь": 8, "девять": 9, "десять": 10,
  "одиннадцать": 11, "двенадцать": 12, "тринадцать": 13, "четырнадцать": 14,
  "пятнадцать": 15, "шестнадцать": 16, "семнадцать": 17, "восемнадцать": 18,
  "девятнадцать": 19, "двадцать": 20, "тридцать": 30, "сорок": 40, "пятьдесят": 50,
  "шестьдесят": 60, "семьдесят": 70, "восемьдесят": 80, "девяносто": 90,
  "сто": 100, "двести": 200, "триста": 300, "четыреста": 400, "пятьсот": 500,
  "шестьсот": 600, "семьсот": 700, "восемьсот": 800, "девятьсот": 900,
};
const NUM_THOUSAND = new Set(["тысяча", "тысячи", "тысяч"]);

// Границы слов без lookbehind (он не поддерживается в Safari старше iOS 16.4)
const W = (s) => new RegExp(`(^|[^а-яa-z0-9])(?:${s})(?![а-яa-z0-9])`, "g");

const SYNONYMS = [
  [W("прямо на"), "прямо"],
  [W("вперед|дальше|далее|иди|пройди|продолжай|продолжить|протяни"), "прямо"],
  [W("вправо|право|правее"), "направо"],
  [W("влево|лево|левее"), "налево"],
  [W("поверни|повернуть|поворот|разверни|развернись"), ""],
  [W("нарисуй|построй|создай|начерти|проведи|сделай"), ""],
  [W("закрой контур|замкни контур"), "замкнуть"],
  [W("отмени|отменить|убери"), "отмена"],
  [W("сохрани|запиши"), "сохранить"],
  [W("кружок|круг"), "окружность"],
  [W("полтора"), "1.5"],
  [W("полметра"), "0.5 метра"],
];

const FILLERS = new Set([
  "ну", "вот", "короче", "так", "давай", "пожалуйста", "эм", "э", "ээ", "мне",
  "надо", "нужно", "сейчас", "теперь", "еще", "ещё", "потом", "значит", "типа",
  "ок", "окей", "хорошо", "будь", "добры", "мол",
]);

const SIMPLE = [
  ["повтори", "redo"], ["вернуть", "redo"],
  ["начать", "new_polyline"], ["начни", "new_polyline"],
  ["прервать", "end_polyline"], ["прерви", "end_polyline"],
  ["новая полилиния", "new_polyline"], ["новый контур", "new_polyline"],
  ["начать заново", "new_polyline"], ["новая линия", "new_polyline"],
  ["завершить", "end_polyline"], ["конец", "end_polyline"], ["закончить", "end_polyline"],
  ["стоп", "stop"], ["пауза", "stop"],
  ["отмена", "undo"], ["undo", "undo"], ["назад", "undo"],
  ["сброс", "reset"], ["сбросить", "reset"],
  ["статус", "status"], ["где я", "status"],
  ["сохранить", "save"], ["save", "save"],
  ["размер", "dim"], ["поставить размер", "dim"], ["размер последнего", "dim"],
  ["увеличить масштаб", "zoom_extents"], ["экран", "zoom_extents"],
  ["помощь", "help"], ["help", "help"], ["команды", "help"],
  ["замкнуть", "close"], ["замкни", "close"], ["замыкание", "close"],
];

const RE = {
  forward: /(?:прямо|впер[её]д|идти|движение|шаг(?:ать)?|продолж(?:ить|ай)?|forward)\s*(?<dist>[\d.,]+)\s*(?<unit>см|мм|м|метр(?:а|ов)?|м\.?)?/i,
  turnRight: /(?:направо|вправо|повернуть\s+направо|поворот\s+направо|right|поверни\s+направо)(?:\s+на)?\s*(?<ang>[\d.,]+)\s*(?:градус(?:а|ов)?|°|deg)?/i,
  turnLeft: /(?:налево|влево|повернуть\s+налево|поворот\s+налево|left|поверни\s+налево)(?:\s+на)?\s*(?<ang>[\d.,]+)\s*(?:градус(?:а|ов)?|°|deg)?/i,
  setAngle: /(?:угол|направление|курс|angle)\s*(?:=|:)?\s*(?<ang>[\d.,]+)/i,
  arc: /(?:дуга|скругление|arc|radius\s*arc)\s*(?<dir>направо|налево|вправо|влево|right|left)?\s*(?:радиус|r)\s*(?<r>[\d.,]+)\s*(?:угол|angle)?\s*(?<a>[\d.,]+)?\s*(?:градус(?:а|ов)?|°|deg)?/i,
  arc2: /(?:дуга|скругление)\s*радиус\s*(?<r>[\d.,]+)\s*угол\s*(?<a>[\d.,]+)\s*(?<dir>направо|налево|вправо|влево)?/i,
  circle: /(?:окружность|круг|circle)\s*(?:радиус|r)?\s*(?<r>[\d.,]+)\s*(?<unit>см|мм|м)?/i,
  rect: /(?:прямоугольник|rect(?:angle)?)\s*(?<w>[\d.,]+)\s*(?:на|x|х|по)\s*(?<h>[\d.,]+)\s*(?<unit>см|мм|м)?/i,
  text: /(?:текст|подпись|надпись|text|label)\s+(?<txt>.+)/i,
  bare: /^(?<dist>[\d.,]+)\s*(?<unit>см|мм|м|метр(?:а|ов)?|м\.?)?$/i,
  window: /(?:окно|окна|окошко)\s*(?:длин[а-я]*\s*)?(?<dist>[\d.,]+)\s*(?<unit>см|мм|м|метр(?:а|ов)?|м\.?)?/i,
  door: /(?:дверь|двери)\s*(?:длин[а-я]*\s*)?(?<dist>[\d.,]+)\s*(?<unit>см|мм|м|метр(?:а|ов)?|м\.?)?/i,
  height: /высота\s*(?<h>[\d.,]+)/gi,
};
const TEXT_CMD = /^\s*(текст|подпись|надпись)(?![а-яa-z])/i;

function wordsToNumbers(tokens) {
  const out = [];
  let i = 0;
  const isNum = (w) => w in NUM_WORDS || NUM_THOUSAND.has(w);
  while (i < tokens.length) {
    if (!isNum(tokens[i])) { out.push(tokens[i]); i++; continue; }
    let total = 0, cur = 0;
    while (i < tokens.length && isNum(tokens[i])) {
      const w = tokens[i];
      if (NUM_THOUSAND.has(w)) { total += Math.max(cur, 1) * 1000; cur = 0; }
      else cur += NUM_WORDS[w];
      i++;
    }
    out.push(String(total + cur));
  }
  return out;
}

export function normalize(text) {
  let t = text.toLowerCase().replace(/ё/g, "е");
  t = t.replace(/[!?;:]+/g, " ");
  for (const [re, repl] of SYNONYMS) {
    t = t.replace(re, (match, pre) => pre + repl);
  }
  let tokens = t.match(/[а-яa-z]+|\d+(?:[.,]\d+)?|°/g) || [];
  tokens = tokens.filter((w) => !FILLERS.has(w));
  tokens = wordsToNumbers(tokens);
  let s = tokens.join(" ");
  s = s.replace(/(\d+(?:[.,]\d+)?)\s+(метр[а-я]*|сантиметр[а-я]*|см|мм|м)\s+(прямо|направо|налево)(?![а-яa-z])/g, "$3 $1 $2");
  s = s.replace(/(прямо|направо|налево)\s+(метр[а-я]*|сантиметр[а-я]*|см|мм|м)\s+(\d+(?:[.,]\d+)?)/g, "$1 $3 $2");
  return s;
}

function num(s) {
  if (s === undefined || s === null) return null;
  const v = Number(String(s).replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(v) ? v : null;
}

function toCm(v, unit) {
  if (!unit) return v;
  const u = unit.toLowerCase();
  if (["мм", "миллиметр", "миллиметра", "миллиметров"].includes(u)) return v / 10;
  if (["м", "метр", "метра", "метров", "м."].includes(u)) return v * 100;
  return v;
}

export function parse(text) {
  const orig = text.trim();
  const t = TEXT_CMD.test(orig) ? orig : normalize(orig);
  if (!t) return { intent: "unknown", args: {}, raw: text };
  const low = t.toLowerCase();
  const words = low.split(/\s+/);

  for (const [key, intent] of SIMPLE) {
    if (low === key || low.startsWith(key + " ") || words.includes(key)) {
      if (["отмена", "назад", "undo"].includes(key) && words.length > 1) continue;
      return { intent, args: {}, raw: text };
    }
  }

  let m = RE.turnRight.exec(t);
  if (m && num(m.groups.ang) !== null) return { intent: "turn_right", args: { angle: num(m.groups.ang) }, raw: text };
  m = RE.turnLeft.exec(t);
  if (m && num(m.groups.ang) !== null) return { intent: "turn_left", args: { angle: num(m.groups.ang) }, raw: text };

  m = RE.arc2.exec(t) || RE.arc.exec(t);
  if (m && /дуга|скругление|arc/.test(low) && num(m.groups.r) !== null) {
    const ang = m.groups.a ? num(m.groups.a) : 90;
    const d = (m.groups.dir || "").toLowerCase();
    const direction = ["направо", "вправо", "right"].includes(d) ? "right" : "left";
    return { intent: "arc", args: { radius_cm: num(m.groups.r), angle_deg: ang, direction }, raw: text };
  }

  m = RE.setAngle.exec(t);
  if (m && /угол|направление|курс/.test(low) && !low.includes("дуга") && num(m.groups.ang) !== null) {
    return { intent: "set_angle", args: { angle: num(m.groups.ang) }, raw: text };
  }

  m = RE.circle.exec(t);
  if (m && /окружность|круг|circle/.test(low) && num(m.groups.r) !== null) {
    return { intent: "circle", args: { radius_cm: toCm(num(m.groups.r), m.groups.unit) }, raw: text };
  }

  m = RE.rect.exec(t);
  if (m && /прямоугольник|rect/.test(low) && num(m.groups.w) !== null && num(m.groups.h) !== null) {
    return {
      intent: "rect",
      args: { w_cm: toCm(num(m.groups.w), m.groups.unit), h_cm: toCm(num(m.groups.h), m.groups.unit) },
      raw: text,
    };
  }

  m = RE.text.exec(t);
  if (m && /текст|подпись|надпись/.test(low)) {
    let txt = m.groups.txt.trim();
    let height = null;
    const hm = new RegExp(RE.height.source, "i").exec(txt);
    if (hm && num(hm.groups.h) !== null) {
      height = num(hm.groups.h);
      txt = txt.replace(new RegExp(RE.height.source, "gi"), "").trim();
    }
    return { intent: "text", args: { text: txt, height_cm: height }, raw: text };
  }

  m = RE.window.exec(t);
  if (m && num(m.groups.dist) !== null) {
    return { intent: "window", args: { dist_cm: toCm(num(m.groups.dist), m.groups.unit) }, raw: text };
  }

  m = RE.door.exec(t);
  if (m && num(m.groups.dist) !== null) {
    return { intent: "door", args: { dist_cm: toCm(num(m.groups.dist), m.groups.unit) }, raw: text };
  }

  m = RE.forward.exec(t);
  if (m && num(m.groups.dist) !== null) {
    return { intent: "forward", args: { dist_cm: toCm(num(m.groups.dist), m.groups.unit) }, raw: text };
  }

  m = RE.bare.exec(t);
  if (m && num(m.groups.dist) !== null) {
    return { intent: "forward", args: { dist_cm: toCm(num(m.groups.dist), m.groups.unit) }, raw: text };
  }

  if (low.includes("размер")) return { intent: "dim", args: {}, raw: text };
  return { intent: "unknown", args: {}, raw: text };
}

export const HELP_TEXT =
  "Команды: прямо <см>, направо <град>, налево <град>, угол <град>, " +
  "дуга радиус <см> угол <град> [направо/налево], окружность радиус <см>, " +
  "прямоугольник <см> на <см>, текст <текст>, размер, новая полилиния, завершить, " +
  "замкнуть, отмена, сброс, статус, сохранить, стоп, помощь.";
