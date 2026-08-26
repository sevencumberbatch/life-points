/* 人生积分系统 · Service Worker
   策略：network-first（仅同源请求）
   - 在线：强制绕过浏览器 HTTP 缓存（cache:'no-cache'）取网络最新版，
     线上改完立刻生效，绝不会被旧 index.html 挡住（防止新旧代码分裂 / 改了看不到）
   - 离线：用上次成功加载的缓存兜底
   - 跨域请求（Supabase 等）一律不拦截
   更新：新 sw.js 部署后自动接管（skipWaiting），旧缓存版本在激活时清理 */
const CACHE = 'lp-cache-v2';
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
      // 关键：cache:'no-cache' 绕过浏览器/CDN 缓存，永远拿最新 index.html，避免旧代码残留
      const res = await fetch(req, { cache: 'no-cache' });
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
