// Офлайн-кэш. Файлы приложения берутся из сети, если она есть (чтобы обновления
// сразу попадали на телефон), иначе из кэша. Модель распознавания берётся из кэша.
const CACHE = "cad-voice-v20";
const ASSETS = [
  "./",
  "index.html",
  "app.js",
  "parser.js",
  "cad.js",
  "dxf.js",
  "pdf.js",
  "ruler.js",
  "fonts/DejaVuSans.ttf",
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
  const url = new URL(event.request.url);
  if (url.pathname.includes("/model/")) {
    event.respondWith(caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)));
    return;
  }
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
