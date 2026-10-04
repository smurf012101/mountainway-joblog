/* Service worker: lets the app open with no signal.
 * App files are served from the cache and refreshed in the background,
 * so a new version arrives the next time the app is opened.
 * Requests to Google (the back end) are never cached here. */
var CACHE = 'mw-joblog-v3';
var SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest',
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE && k.indexOf('mw-joblog-') === 0; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  var isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (!sameOrigin && !isFont) return;

  e.respondWith(caches.open(CACHE).then(function (cache) {
    var key = req.mode === 'navigate' ? './index.html' : req;
    return cache.match(key, { ignoreSearch: req.mode === 'navigate' }).then(function (cached) {
      var fresh = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(key, res.clone());
        return res;
      }).catch(function () { return cached; });
      return cached || fresh;
    });
  }));
});
