// Офлайн-кэш: при первом открытии (с сетью) скачивает всё приложение и модель,
// дальше работает без интернета.
const CACHE = "cad-voice-v1";
const ASSETS = [
  "./",
  "index.html",
  "app.js",
  "parser.js",
  "cad.js",
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
