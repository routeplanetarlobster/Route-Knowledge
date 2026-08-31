const CACHE_VERSION = 'route-knowledge-pwa-v25';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/route-data.js',
  './js/study-data.js',
  './js/map-data.js',
  './js/map-restrictions.js',
  './js/storage.js',
  './js/progress-sync.js',
  './js/coverage-recovery.js',
  './images/speed-boards/outer-harbor-shared-down-80-km-6-050.jpg',
  './images/speed-boards/outer-harbor-shared-down-80-km-6-050-full.jpg',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png'
];

const RUNTIME_HOSTS = new Set([
  'unpkg.com',
  'www.gstatic.com',
  'fonts.googleapis.com',
  'fonts.gstatic.com'
]);

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(APP_SHELL);

    // Large optional dependencies are cached on first use. This keeps install
    // fast while retaining offline access after Map or Account has been opened.
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('route-knowledge-pwa-') && n !== CACHE_VERSION).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if(event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if(req.method !== 'GET') return;

  const url = new URL(req.url);

  // Do not cache Firebase API traffic or live map tiles. Firebase/cloud sync
  // should always reflect the network; map providers manage their own caching.
  if(
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('firebaseio.com') ||
    url.hostname.includes('firestore.googleapis.com') ||
    url.hostname.includes('arcgisonline.com') ||
    url.hostname.includes('openstreetmap.org')
  ){
    return;
  }

  if(req.mode === 'navigate'){
    event.respondWith((async () => {
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        cache.put('./index.html', fresh.clone()).catch(()=>{});
        return fresh;
      }catch(e){
        return (await caches.match('./index.html')) || (await caches.match('./'));
      }
    })());
    return;
  }

  if(url.origin === self.location.origin || RUNTIME_HOSTS.has(url.hostname)){
    event.respondWith((async () => {
      const cached = await caches.match(req);
      if(cached) return cached;
      try{
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE_VERSION);
        if(fresh && (fresh.ok || fresh.type === 'opaque')) cache.put(req, fresh.clone()).catch(()=>{});
        return fresh;
      }catch(e){
        return cached || Response.error();
      }
    })());
  }
});
