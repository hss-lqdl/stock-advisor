#!/usr/bin/env node
/* ============================================================
   server.mjs — A股每日买入计划 · 本地静态服务器 + 局域网二维码
   零依赖，只需 Node.js（本机已装 v24）。

   作用：
     1. 把 web/ 作为静态站点在 0.0.0.0:8765 上提供
     2. 探测本机局域网 IP，打印手机可访问地址
     3. 生成二维码并打开（在线 API，失败则打印大字号 URL）
     4. 自动打开电脑浏览器

   用法：
     双击 启动.bat            推荐
     node server.mjs          等价
     node server.mjs --port 9000 --no-browser
   ============================================================ */

import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(__dirname, 'web');
const APP_TITLE = 'A股每日买入计划';
const DEFAULT_PORT = 8765;

/* ---------------- MIME ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
};

/** 这些扩展不缓存，改代码后刷新即生效 */
const NO_CACHE = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.webmanifest', '.json']);

/* ---------------- 工具 ---------------- */

/** 探测局域网 IPv4（排除回环 / 虚拟网卡 / APIPA） */
function getLanIp() {
  const ifaces = os.networkInterfaces();
  const prefer = [];
  const fallback = [];

  for (const [name, list] of Object.entries(ifaces)) {
    for (const it of list || []) {
      if (it.family !== 'IPv4' || it.internal) continue;
      if (it.address.startsWith('169.254.')) continue;   // APIPA
      const isVirtual = /vmware|virtualbox|vethernet|hyper-v|loopback|docker|wsl|tailscale|tap|tun/i.test(name);
      const isWifi = /wi-?fi|wlan|wireless|以太网|ethernet/i.test(name);
      const rec = { name, ip: it.address, isVirtual, isWifi };
      (isVirtual ? fallback : prefer).push(rec);
    }
  }

  // 优先非虚拟 + WiFi/以太网 + 常见家庭网段
  const score = (r) => {
    let s = 0;
    if (r.isWifi) s += 10;
    if (/^192\.168\./.test(r.ip)) s += 5;
    else if (/^10\./.test(r.ip)) s += 4;
    else if (/^172\.(1[6-9]|2\d|3[01])\./.test(r.ip)) s += 3;
    return s;
  };

  const pool = prefer.length ? prefer : fallback;
  pool.sort((a, b) => score(b) - score(a));
  return pool.length ? pool[0].ip : '127.0.0.1';
}

/** 取在线二维码 PNG（已实测可用），失败返回 null */
async function fetchQrPng(text, timeoutMs = 6000) {
  const urls = [
    'https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data=' + encodeURIComponent(text),
    'https://quickchart.io/qr?size=420&margin=2&text=' + encodeURIComponent(text),
  ];
  for (const u of urls) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const r = await fetch(u, {
        signal: ac.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
          Accept: 'image/png,image/*;q=0.8,*/*;q=0.5',
        },
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 200 && buf[0] === 0x89 && buf[1] === 0x50) return buf;
    } catch (e) {
      /* 试下一个 */
    }
  }
  return null;
}

/** 用系统默认程序打开文件/URL（不等待、不捕获输出） */
function openExternal(target) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', target], {
        stdio: 'ignore', detached: true, windowsHide: true,
      }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [target], { stdio: 'ignore', detached: true }).unref();
    } else {
      spawn('xdg-open', [target], { stdio: 'ignore', detached: true }).unref();
    }
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 二维码展示页（兜底） ---------------- */

function qrHtml(url) {
  const q = encodeURIComponent(url);
  const safe = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${APP_TITLE} · 扫码访问</title>
<style>
  body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;
       justify-content:center;gap:18px;background:#0b0f17;color:#e2e8f0;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;padding:24px;box-sizing:border-box}
  h1{font-size:20px;margin:0;font-weight:600}
  .box{background:#fff;padding:14px;border-radius:16px;line-height:0}
  img{width:min(300px,72vw);height:auto;display:block}
  .url{font-family:ui-monospace,Consolas,monospace;font-size:17px;background:#161e2e;
       padding:12px 20px;border-radius:10px;border:1px solid #243044;
       word-break:break-all;max-width:80vw;text-align:center;user-select:all}
  .tip{color:#94a3b8;font-size:13px;max-width:520px;text-align:center;line-height:1.7}
  b{color:#34d399}
</style></head>
<body>
  <h1>📱 用 iPhone 扫码打开</h1>
  <div class="box"><img src="https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=10&data=${q}" alt="二维码"></div>
  <div class="url">${safe}</div>
  <div class="tip">手机需与本电脑连 <b>同一个 WiFi</b>。<br>
    用 <b>Safari</b> 打开后，点「分享 → 添加到主屏幕」，即可像 App 一样使用。</div>
  <div class="tip" style="font-size:12px;color:#64748b">
    若二维码不显示，请手动在手机浏览器输入上面的地址。</div>
</body></html>`;
}

async function showQr(lanUrl) {
  // 1) 尝试下载 PNG 到临时目录并直接打开图片
  const png = await fetchQrPng(lanUrl);
  if (png) {
    try {
      const out = path.join(os.tmpdir(), 'stock_advisor_qr.png');
      await fsp.writeFile(out, png);
      console.log('  二维码图片: ' + out);
      if (openExternal(out)) {
        console.log('  已打开二维码图片，请用 iPhone 相机扫码。');
        return;
      }
    } catch (e) { /* 继续兜底 */ }
  }

  // 2) 兜底：本地 HTML 展示页
  try {
    const out = path.join(WEB_DIR, '_qrcode.html');
    await fsp.writeFile(out, qrHtml(lanUrl), 'utf8');
    if (openExternal(out)) {
      console.log('  已打开二维码页面（若图片不显示，请手动输入上面的地址）。');
      return;
    }
  } catch (e) { /* 忽略 */ }

  console.log('  二维码不可用，请手动在手机浏览器输入上面的地址。');
}

/* ---------------- 静态服务器 ---------------- */

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

function safeJoin(root, reqPath) {
  // 防目录穿越
  const decoded = decodeURIComponent(reqPath.split('?')[0].split('#')[0]);
  const joined = path.join(root, decoded);
  const resolved = path.resolve(joined);
  if (!resolved.startsWith(path.resolve(root))) return null;
  return resolved;
}

function createServer() {
  return http.createServer(async (req, res) => {
    const url = req.url || '/';
    const pathname = url.split('?')[0];

    // 健康检查
    if (pathname === '/__ping') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('ok');
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8', Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    let rel = pathname === '/' ? '/index.html' : pathname;
    let filePath = safeJoin(WEB_DIR, rel);

    if (!filePath) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Bad Request');
      return;
    }

    let stat = null;
    try {
      stat = await fsp.stat(filePath);
    } catch (e) {
      stat = null;
    }

    // 目录 → index.html
    if (stat && stat.isDirectory()) {
      filePath = path.join(filePath, 'index.html');
      try {
        stat = await fsp.stat(filePath);
      } catch (e) {
        stat = null;
      }
    }

    if (!stat || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found: ' + rel);
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const headers = {
      'Content-Type': contentType(filePath),
      'Content-Length': String(stat.size),
      'Cache-Control': NO_CACHE.has(ext)
        ? 'no-cache, no-store, must-revalidate'
        : 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    };

    if (ext === '.webmanifest') {
      headers['Access-Control-Allow-Origin'] = '*';
    }

    res.writeHead(200, headers);

    if (req.method === 'HEAD') {
      res.end();
      return;
    }

    const stream = fs.createReadStream(filePath);
    stream.on('error', () => {
      try { res.destroy(); } catch (e) { /* 忽略 */ }
    });
    stream.pipe(res);
  });
}

/* ---------------- 启动 ---------------- */

function parseArgs(argv) {
  const o = { port: DEFAULT_PORT, browser: true, qr: true, host: '0.0.0.0' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port' || a === '-p') o.port = parseInt(argv[++i], 10) || DEFAULT_PORT;
    else if (a === '--no-browser') o.browser = false;
    else if (a === '--no-qr') o.qr = false;
    else if (a === '--host') o.host = argv[++i] || '0.0.0.0';
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function banner(localUrl, lanUrl, port) {
  const line = '='.repeat(62);
  console.log('');
  console.log(line);
  console.log('  ' + APP_TITLE + '  ·  本地服务器已启动');
  console.log(line);
  console.log('');
  console.log('  电脑访问:');
  console.log('    ' + localUrl);
  console.log('');
  console.log('  手机访问（需同一 WiFi）:');
  console.log('    ' + lanUrl);
  console.log('');
  console.log('  端口 ' + port + '    按 Ctrl+C 停止');
  console.log(line);
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    console.log(`
${APP_TITLE} · 本地服务器

用法:
  node server.mjs [选项]

选项:
  --port, -p <n>   端口号，默认 ${DEFAULT_PORT}（被占用会自动 +1）
  --host <ip>      监听地址，默认 0.0.0.0（允许手机访问）
  --no-browser     不自动打开电脑浏览器
  --no-qr          不生成二维码
  --help, -h       显示帮助
`);
    return;
  }

  if (!fs.existsSync(WEB_DIR)) {
    console.error('[错误] 找不到 web 目录: ' + WEB_DIR);
    console.error('       请确认 server.mjs 与 web/ 在同一目录下。');
    process.exit(1);
  }

  const lanIp = getLanIp();
  const server = createServer();

  // 端口被占用则自动顺延
  let port = args.port;
  let bound = false;
  for (let i = 0; i < 20 && !bound; i++) {
    try {
      await new Promise((resolve, reject) => {
        const onErr = (e) => { server.removeListener('error', onErr); reject(e); };
        server.once('error', onErr);
        server.listen(port, args.host, () => {
          server.removeListener('error', onErr);
          resolve();
        });
      });
      bound = true;
    } catch (e) {
      if (e && e.code === 'EADDRINUSE') { port += 1; continue; }
      console.error('[错误] 启动失败: ' + (e && e.message ? e.message : e));
      process.exit(1);
    }
  }

  if (!bound) {
    console.error('[错误] 端口 ' + args.port + '~' + port + ' 全部被占用，请用 --port 指定其他端口。');
    process.exit(1);
  }

  if (port !== args.port) {
    console.log('[提示] 端口 ' + args.port + ' 被占用，已改用 ' + port);
  }

  const localUrl = 'http://127.0.0.1:' + port + '/';
  const lanUrl = 'http://' + lanIp + ':' + port + '/';

  banner(localUrl, lanUrl, port);

  // 写地址文件，供其他脚本读取
  try {
    fs.writeFileSync(path.join(__dirname, '.server_url'), lanUrl, 'utf8');
  } catch (e) { /* 忽略 */ }

  if (args.qr) {
    showQr(lanUrl).catch(() => {});
  }
  if (args.browser) {
    setTimeout(() => openExternal(localUrl), 800);
  }

  const shutdown = () => {
    console.log('\n  已停止服务。');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1200);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[错误] ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
