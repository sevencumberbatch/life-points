/* 人生积分系统 · Service Worker
   策略：network-first（仅同源请求）
   - 在线：始终从网络拿最新版（线上更新立即生效，不会被缓存挡住）
   - 离线：用上次成功加载的缓存兜底
   - 跨域请求（Supabase 等）一律不拦截
   更新：新 sw.js 部署后自动接管（skipWaiting），旧缓存版本在激活时清理 */
const CACHE = 'lp-cache-v1';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req);
      if (hit) return hit;
      throw err;
    }
  })());
});
