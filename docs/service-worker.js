// 只用于**离线缓存**我们的同源静态资源。
// ⚠️ 正式站点（on.tabsac.com）的跨源隔离头由 **nginx 直接下发**（COOP/COEP/CORP），
//    不再依赖这个 Service Worker 注入；这里保留注入只是为了老部署（GitHub Pages 镜像）还能用，
//    但要**跳过 `/api/**` 与 `/data/**`** —— 接口响应绝不能被缓存，也不能被改写头。
//
// GitHub Pages serves static files without configurable isolation headers.
// Only same-origin files inside this project's scope are intercepted.
const BYPASS = ['/api/', '/data/'];

self.addEventListener('install', event => event.waitUntil(self.skipWaiting()));
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;              // 跨源（含同源反代之外的 API）不管
  if (BYPASS.some(prefix => url.pathname.startsWith(prefix))) return;   // 接口一律直接走网络
  if (!event.request.url.startsWith(self.registration.scope)) return;
  event.respondWith((async () => {
    const response = await fetch(event.request);
    if (response.status === 0) return response;
    const headers = new Headers(response.headers);
    headers.set('Cross-Origin-Opener-Policy', 'same-origin');
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
  })());
});
