const CACHE_VERSION = 'route-knowledge-pwa-v1';
const APP_SHELL = [
  './',
  './index.html',
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

    // Helpful offline dependencies. Failure of a third-party CDN must never
    // prevent the PWA itself from installing.
    const extras = [
      'https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.css',
      'https://unpkg.com/maplibre-gl@5.16.0/dist/maplibre-gl.js',
      'https://www.gstatic.com/firebasejs/12.17.1/firebase-app-compat.js',
      'https://www.gstatic.com/firebasejs/12.17.1/firebase-auth-compat.js',
      'https://www.gstatic.com/firebasejs/12.17.1/firebase-firestore-compat.js'
    ];
    await Promise.allSettled(extras.map(async url => {
      try{
        const response = await fetch(url, {mode:'cors'});
        if(response && response.ok) await cache.put(url, response.clone());
      }catch(e){}
    }));
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
