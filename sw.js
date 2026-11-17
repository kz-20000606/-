const CACHE_NAME='smart-schedule-pwa-v41';
const APP_SHELL=[
  './smart-schedule-v3.html',
  './index.html',
  './styles-v34.css',
  './app-v56.js',
  './manifest.webmanifest',
  './icon-192-v3.svg',
  './icon-512-v3.svg',
  './icon-maskable-v3.svg'
];

self.addEventListener('install',event=>{
  event.waitUntil(caches.open(CACHE_NAME).then(cache=>cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate',event=>{
  event.waitUntil(
    caches.keys().then(keys=>Promise.all(
      keys.filter(key=>key!==CACHE_NAME).map(key=>caches.delete(key))
    ))
  );
  self.clients.claim();
});

self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET')return;

  const url=new URL(event.request.url);
  const isLegacyLaunch =
    event.request.mode==='navigate' &&
    (url.pathname.endsWith('/smart-schedule-v2.html') || url.pathname.endsWith('/index.html') || url.pathname.endsWith('/-/' ));

  if(isLegacyLaunch){
    event.respondWith(
      fetch('./smart-schedule-v3.html',{cache:'no-store'})
        .then(response=>{
          const copy=response.clone();
          caches.open(CACHE_NAME).then(cache=>cache.put('./smart-schedule-v3.html',copy));
          return response;
        })
        .catch(()=>caches.match('./smart-schedule-v3.html'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then(response=>{
        const copy=response.clone();
        caches.open(CACHE_NAME).then(cache=>cache.put(event.request,copy));
        return response;
      })
      .catch(()=>caches.match(event.request).then(cached=>cached||caches.match('./smart-schedule-v3.html')))
  );
});
