/* ============================================================
   sw.js — Service Worker
   作用：把 App 外壳（HTML/CSS/JS/图标）缓存到本地，
        断网或弱网时仍能打开界面。
   注意：行情数据来自东方财富接口，不走本 SW，永远实时。

   【缓存策略：网络优先（重要）】
   本 App 是局域网/托管型工具，网络几乎总是可用。
   若采用「缓存优先」，用户一旦把 PWA 装到主屏，
   后续所有代码更新都会被旧缓存挡住，永远跑旧版本（实测踩过此坑）。
   因此统一采用 network-first：先取网络最新版并回写缓存，
   网络失败时才回退到缓存（离线兜底）。

   生效条件：仅在 https 或 localhost/127.0.0.1 下注册成功
            （局域网 http://192.168.x.x 不是 secure context，无法注册）
   ============================================================ */

const VERSION = 'v1.4.0';
const CACHE = 'stock-advisor-' + VERSION;

/* 预缓存清单：App 外壳全部静态资源 */
const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './style.css',

  './js/main.js',
  './js/api.js',
  './js/store.js',
  './js/universe.js',
  './js/mainline.js',
  './js/market.js',
  './js/indicators.js',
  './js/strategy.js',
  './js/plan.js',
  './js/backtest.js',
  './js/charts.js',
  './js/ui.js',
  './js/engine.js',

  './js/views/today.js',
  './js/views/mainline.js',
  './js/views/picks.js',
  './js/views/positions.js',
  './js/views/settings.js',

  './icons/icon.svg',
  './icons/favicon-64.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
  './icons/icon-1024.png',
];

/* ---------------- 安装：预缓存 ---------------- */

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 逐个添加，单个失败不影响整体（避免 addAll 全失败）
    await Promise.all(PRECACHE.map(async (url) => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (e) {
        // 忽略单个资源失败（例如某些浏览器不支持 cache: 'reload'）
      }
    }));
    await self.skipWaiting();
  })());
});

/* ---------------- 激活：清理旧版本 ---------------- */

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith('stock-advisor-') && k !== CACHE)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

/* ---------------- 请求拦截 ---------------- */

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // 只处理 GET
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 只处理同源请求（东方财富接口是跨域的，直接放行给网络）
  if (url.origin !== self.location.origin) return;

  // 导航请求：网络优先，失败回退缓存（保证能更新到新版本）
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        const fresh = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put('./index.html', fresh.clone()).catch(() => {});
        return fresh;
      } catch (e) {
        const cache = await caches.open(CACHE);
        const hit = (await cache.match('./index.html')) || (await cache.match('./'));
        return hit || new Response('离线且无缓存', {
          status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        });
      }
    })());
    return;
  }

  // 静态资源：网络优先，失败回退缓存。
  // 不用「缓存优先」的原因见文件头注释：会把旧 JS 永久钉死在用户设备上。
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.status === 200 && fresh.type === 'basic') {
        cache.put(req, fresh.clone()).catch(() => {});
      }
      return fresh;
    } catch (e) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      return new Response('离线', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
  })());
});

/* ---------------- 消息：手动清缓存 / 查询版本 ---------------- */

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  } else if (data.type === 'GET_VERSION') {
    event.source && event.source.postMessage({ type: 'VERSION', version: VERSION });
  } else if (data.type === 'CLEAR_CACHE') {
    event.waitUntil((async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
      event.source && event.source.postMessage({ type: 'CLEARED' });
    })());
  }
});
