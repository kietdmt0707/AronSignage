// ARON Signage v2 – Service Worker: mở được app khi mất mạng (chỉ hoạt động qua https)
const CACHE = 'aron-signage-v2.3.0';
const SHELL = ['./player.html', './admin.html', './signage-core.js', './signage.css', './config.js', './vendor/qrcode.js'];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k.startsWith('aron-signage-') && k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
// Ưu tiên mạng (luôn lấy bản mới), mất mạng thì dùng bản đã lưu
self.addEventListener('fetch', e => {
  const r = e.request;
  if (r.method !== 'GET') return;
  const u = new URL(r.url);
  const isShell = u.origin === self.location.origin;
  const isLib = u.hostname === 'cdn.jsdelivr.net';
  if (!isShell && !isLib) return;
  e.respondWith(
    fetch(r).then(res => {
      if (res.ok) { const cp = res.clone(); caches.open(CACHE).then(c => c.put(r, cp)); }
      return res;
    }).catch(() => caches.match(r, { ignoreSearch: isShell }))
  );
});
