#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py — A股每日买入计划 · 本地静态服务器 + 局域网二维码

作用：
  1. 把 web/ 目录作为静态站点在 0.0.0.0:8765 上提供
  2. 自动探测本机局域网 IP，打印可访问地址
  3. 生成二维码（在线 API，失败则打印大字号 URL）
  4. 自动打开本机浏览器

用法：
  双击 启动.bat            （推荐）
  或 python server.py
  或 python server.py --port 8765 --no-browser

纯标准库，零第三方依赖。
"""

import argparse
import http.server
import io
import mimetypes
import os
import socket
import socketserver
import sys
import threading
import urllib.parse
import urllib.request
import webbrowser

# ----------------------------------------------------------------------------
# 常量
# ----------------------------------------------------------------------------

APP_TITLE = "A股每日买入计划"
DEFAULT_PORT = 8765
WEB_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")

# 需要强制覆盖的 MIME（mimetypes 在部分 Windows 上可能不准）
MIME_OVERRIDE = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".webmanifest": "application/manifest+json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8",
}

# 不缓存的文件（方便改代码后刷新即生效）
NO_CACHE_EXT = {".html", ".htm", ".js", ".mjs", ".css", ".webmanifest", ".json"}


# ----------------------------------------------------------------------------
# 工具函数
# ----------------------------------------------------------------------------

def get_lan_ip():
    """
    探测本机在局域网中的 IPv4 地址。
    用 UDP connect 技巧（不实际发包），无需管理员权限，比遍历网卡更可靠。
    """
    candidates = []
    for probe in ("8.8.8.8", "114.114.114.114", "223.5.5.5"):
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(0.3)
            s.connect((probe, 53))
            ip = s.getsockname()[0]
            s.close()
            if ip and not ip.startswith("127.") and ip not in candidates:
                candidates.append(ip)
        except Exception:
            try:
                s.close()
            except Exception:
                pass

    # 兜底：解析主机名
    if not candidates:
        try:
            for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
                ip = info[4][0]
                if ip and not ip.startswith("127.") and ip not in candidates:
                    candidates.append(ip)
        except Exception:
            pass

    return candidates[0] if candidates else "127.0.0.1"


def qr_ascii(text):
    """
    在终端用半块字符渲染二维码（纯在线 API 拿点阵过于复杂，这里用本地
    "打开图片" 为主；本函数仅在无法联网时给出替代方案，故不实现完整 QR 编码，
    直接返回 None 表示不可用）。
    """
    return None


def fetch_qr_png(text, timeout=6.0):
    """
    从在线 API 取二维码 PNG（已实测可用）。
    返回 bytes 或 None。
    """
    urls = [
        "https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=12&data="
        + urllib.parse.quote(text, safe=""),
        "https://quickchart.io/qr?size=420&margin=2&text="
        + urllib.parse.quote(text, safe=""),
    ]
    for u in urls:
        try:
            req = urllib.request.Request(u, headers={
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept": "image/png,image/*;q=0.8,*/*;q=0.5",
            })
            with urllib.request.urlopen(req, timeout=timeout) as r:
                data = r.read()
            if data[:8] == b"\x89PNG\r\n\x1a\n" and len(data) > 200:
                return data
        except Exception:
            continue
    return None


def make_qr_html(text, url, out_path):
    """
    生成一个本地 HTML 展示二维码（图片走在线 API），作为兜底展示方式。
    """
    safe_url = url.replace("&", "&amp;").replace("<", "&lt;").replace('"', "&quot;")
    q = urllib.parse.quote(url, safe="")
    html = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<title>{APP_TITLE} · 扫码访问</title>
<style>
  body{{margin:0;min-height:100vh;display:flex;flex-direction:column;
       align-items:center;justify-content:center;gap:18px;
       background:#0b0f17;color:#e2e8f0;
       font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif}}
  h1{{font-size:20px;margin:0;font-weight:600}}
  .box{{background:#fff;padding:14px;border-radius:16px;line-height:0}}
  img{{width:300px;height:300px;display:block}}
  .url{{font-family:ui-monospace,Consolas,monospace;font-size:17px;
        background:#161e2e;padding:12px 20px;border-radius:10px;
        border:1px solid #243044;word-break:break-all;max-width:80vw;text-align:center}}
  .tip{{color:#94a3b8;font-size:13px;max-width:520px;text-align:center;line-height:1.7}}
  b{{color:#34d399}}
</style></head>
<body>
  <h1>📱 用 iPhone 扫码打开</h1>
  <div class="box"><img src="https://api.qrserver.com/v1/create-qr-code/?size=420x420&margin=10&data={q}" alt="QR"></div>
  <div class="url">{safe_url}</div>
  <div class="tip">
    手机需与本电脑连<b>同一个 WiFi</b>。<br>
    用 <b>Safari</b> 打开后，点「分享 → 添加到主屏幕」，即可像 App 一样使用。
  </div>
  <div class="tip" style="font-size:12px;color:#64748b">
    若二维码不显示，请手动在手机浏览器输入上面的地址。
  </div>
</body></html>"""
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(html)


# ----------------------------------------------------------------------------
# HTTP 请求处理
# ----------------------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    """静态文件处理器，根目录固定为 web/"""

    server_version = "StockAdvisor/1.0"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=WEB_DIR, **kwargs)

    # ---------- 日志：只打印错误，避免刷屏 ----------
    def log_message(self, fmt, *args):
        code = args[1] if len(args) > 1 else ""
        if str(code).startswith(("4", "5")):
            sys.stderr.write("  [%s] %s\n" % (self.log_date_time_string(), fmt % args))

    # ---------- 响应头 ----------
    def end_headers(self):
        path = urllib.parse.urlparse(self.path).path
        ext = os.path.splitext(path)[1].lower()

        if ext in NO_CACHE_EXT:
            self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        else:
            self.send_header("Cache-Control", "public, max-age=86400")

        # PWA 相关
        self.send_header("X-Content-Type-Options", "nosniff")
        if ext == ".webmanifest":
            self.send_header("Access-Control-Allow-Origin", "*")

        # 允许手机端跨域访问本机静态资源（便于调试）
        self.send_header("Access-Control-Allow-Origin", "*")

        super().end_headers()

    # ---------- MIME ----------
    def guess_type(self, path):
        ext = os.path.splitext(path)[1].lower()
        if ext in MIME_OVERRIDE:
            return MIME_OVERRIDE[ext]
        return super().guess_type(path)

    # ---------- GET ----------
    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 健康检查
        if path == "/__ping":
            body = b"ok"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        # 根路径 → index.html
        if path in ("", "/"):
            self.path = "/index.html"

        super().do_GET()

    def do_HEAD(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path in ("", "/"):
            self.path = "/index.html"
        super().do_HEAD()


class ThreadingServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


# ----------------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------------

def banner(local_url, lan_url, port):
    line = "=" * 62
    print()
    print(line)
    print("  " + APP_TITLE + "  ·  本地服务器已启动")
    print(line)
    print()
    print("  本机访问（电脑浏览器）:")
    print("    " + local_url)
    print()
    print("  手机访问（同一 WiFi）:")
    print("    " + lan_url)
    print()
    print("  端口: %d      按 Ctrl+C 停止服务" % port)
    print(line)
    print()


def open_qr(lan_url):
    """生成并打开二维码"""
    png = fetch_qr_png(lan_url)
    if png:
        try:
            import tempfile
            fd, path = tempfile.mkstemp(suffix=".png", prefix="stock_qr_")
            with os.fdopen(fd, "wb") as f:
                f.write(png)
            print("  二维码已生成: " + path)
            try:
                os.startfile(path)  # Windows
                print("  已用图片查看器打开，可直接用 iPhone 相机扫码。")
                return
            except Exception:
                pass
        except Exception:
            pass

    # 兜底：本地 HTML 展示二维码
    try:
        path = os.path.join(WEB_DIR, "_qrcode.html")
        make_qr_html("", lan_url, path)
        webbrowser.open("file:///" + path.replace("\\", "/"))
        print("  已打开二维码页面（如二维码不显示，请手动输入上面的地址）。")
    except Exception:
        print("  二维码不可用，请手动在手机浏览器输入上面的地址。")


def main():
    ap = argparse.ArgumentParser(description=APP_TITLE + " 本地服务器")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help="端口，默认 8765")
    ap.add_argument("--no-browser", action="store_true", help="不自动打开浏览器")
    ap.add_argument("--no-qr", action="store_true", help="不生成二维码")
    ap.add_argument("--host", default="0.0.0.0", help="监听地址，默认 0.0.0.0")
    args = ap.parse_args()

    if not os.path.isdir(WEB_DIR):
        print("[错误] 找不到 web 目录: " + WEB_DIR)
        print("       请确认 server.py 与 web/ 在同一目录下。")
        sys.exit(1)

    lan_ip = get_lan_ip()
    local_url = "http://127.0.0.1:%d/" % args.port
    lan_url = "http://%s:%d/" % (lan_ip, args.port)

    # 端口被占用时自动往后找
    port = args.port
    srv = None
    for _ in range(20):
        try:
            srv = ThreadingServer((args.host, port), Handler)
            break
        except OSError:
            port += 1
    if srv is None:
        print("[错误] 端口 %d~%d 全部被占用，请用 --port 指定其他端口" % (args.port, port))
        sys.exit(1)

    if port != args.port:
        local_url = "http://127.0.0.1:%d/" % port
        lan_url = "http://%s:%d/" % (lan_ip, port)
        print("[提示] 端口 %d 被占用，已改用 %d" % (args.port, port))

    banner(local_url, lan_url, port)

    # 写一个地址文件，方便其他脚本读取
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".server_url"), "w",
                  encoding="utf-8") as f:
            f.write(lan_url)
    except Exception:
        pass

    if not args.no_qr:
        threading.Thread(target=open_qr, args=(lan_url,), daemon=True).start()

    if not args.no_browser:
        threading.Timer(0.8, lambda: webbrowser.open(local_url)).start()

    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  已停止服务。")
    finally:
        srv.server_close()


if __name__ == "__main__":
    # 确保工作目录无关
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    main()
