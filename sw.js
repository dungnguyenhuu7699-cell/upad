/* Service worker — cho phép mở & dùng app hoàn toàn offline.
 * Mỗi lần sửa file giao diện, hãy tăng số phiên bản bên dưới để máy người dùng nhận bản mới. */
const VERSION = 'v6';
const CACHE_NAME = 'ke-hoach-' + VERSION;
const SHELL = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // tải mới từ mạng (bỏ qua cache HTTP); 1 file lỗi không làm hỏng cả quá trình cài
      Promise.all(SHELL.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => {})))
    )
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Firebase/API đi thẳng ra mạng, không cache

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req, { ignoreSearch: true });

    const network = fetch(req).then((res) => {
      if (res && res.status === 200 && res.type === 'basic') cache.put(req, res.clone());
      return res;
    });

    if (cached) {                                           // có cache → trả ngay, cập nhật ngầm cho lần sau
      event.waitUntil(network.catch(() => {}));
      return cached;
    }
    try {
      return await network;
    } catch (err) {
      if (req.mode === 'navigate') {                        // offline + mở trang → luôn ra app
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
      return Response.error();
    }
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      if (list.length) return list[0].focus();
      return self.clients.openWindow('./');
    })
  );
});
