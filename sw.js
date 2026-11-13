// РћС„Р»Р°Р№РЅ-РєСЌС€: РїСЂРё РїРµСЂРІРѕРј РѕС‚РєСЂС‹С‚РёРё (СЃ СЃРµС‚СЊСЋ) СЃРєР°С‡РёРІР°РµС‚ РІСЃС‘ РїСЂРёР»РѕР¶РµРЅРёРµ Рё РјРѕРґРµР»СЊ,
// РґР°Р»СЊС€Рµ СЂР°Р±РѕС‚Р°РµС‚ Р±РµР· РёРЅС‚РµСЂРЅРµС‚Р°.
const CACHE = "cad-voice-v19";
const ASSETS = [
  "./",
  "index.html",
  "app.js",
  "parser.js",
  "cad.js",
  "dxf.js",
  "pdf.js",
  "ruler.js",
  "manifest.webmanifest",
  "vendor/vosk.js",
  "model/model.tar.gz",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request))
  );
});
