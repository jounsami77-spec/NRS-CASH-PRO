const CACHE_NAME = 'nrs-cash-pro-shell-v1';
const SHELL = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/icons/nrs-icon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key.startsWith('nrs-cash-pro-shell-') && key !== CACHE_NAME)
            .map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Do not intercept APIs, admin pages, login, or dynamic business data.
  if (url.pathname.startsWith('/api/') ||
      url.pathname === '/admin' ||
      url.pathname.startsWith('/admin/')) return;

  const allowed = new Set(SHELL);
  if (!allowed.has(url.pathname)) return;

  if (request.mode === 'navigate' || url.pathname === '/' ||
      url.pathname === '/index.html') {
    event.respondWith(
      fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put('/index.html', copy));
        }
        return response;
      }).catch(async () => {
        return (await caches.match('/index.html')) ||
               (await caches.match('/')) ||
               Response.error();
      })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
