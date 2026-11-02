# -*- coding: utf-8 -*-
"""生成 PWA 全套图标。一次性运行，产物提交到 web/icons/。

用法: python tools/make_icons.py
"""
import math
import os

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "web", "icons")

BG = (16, 22, 34, 255)        # 深色底
GRID = (30, 41, 59, 255)      # 网格线
UP = (52, 211, 153, 255)      # 涨 绿
DOWN = (248, 113, 113, 255)   # 跌 红
ACCENT = (96, 165, 250, 255)  # 蓝


def _font(size):
    """优先找系统中文字体，失败则退默认字体。"""
    cands = [
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
    ]
    for c in cands:
        if os.path.exists(c):
            try:
                return ImageFont.truetype(c, size)
            except Exception:
                pass
    return ImageFont.load_default()


def draw_icon(size, maskable=False):
    """画一个 涨跌K线 + 向上箭头 的图标。maskable 时内容缩到中间 80%。"""
    s = size
    img = Image.new("RGBA", (s, s), BG)
    d = ImageDraw.Draw(img)

    # 背景网格
    step = max(4, s // 8)
    for x in range(0, s, step):
        d.line([(x, 0), (x, s)], fill=GRID, width=1)
    for y in range(0, s, step):
        d.line([(0, y), (s, y)], fill=GRID, width=1)

    # 安全区：maskable 需要内容落在中心 80% 圆内
    pad = s * 0.19 if maskable else s * 0.14
    inner = s - 2 * pad
    base = pad + inner * 0.98  # K 线基线

    # 趋势箭头（放在最上方，独占一行高度）
    ax0 = pad + inner * 0.02
    ax1 = pad + inner * 0.86
    ay0 = pad + inner * 0.20
    ay1 = pad + inner * 0.02
    lw = max(3, int(s * 0.030))
    d.line([(ax0, ay0), (ax1, ay1)], fill=UP, width=lw)
    head = s * 0.095
    d.polygon(
        [(ax1 + head * 0.60, ay1 - head * 0.06),
         (ax1 - head * 0.58, ay1 + head * 0.56),
         (ax1 - head * 0.04, ay1 + head * 0.90)],
        fill=UP,
    )

    # 三根 K 线（左低右高，代表上行趋势），占下半部分
    n = 3
    slot = inner / (n * 2 + 1)
    body_w = slot * 1.25
    candle_top = pad + inner * 0.34   # K 线最高只能到这
    for i in range(n):
        cx = pad + slot * (2 * i + 1)
        h_frac = (0.36, 0.58, 0.86)[i]
        body_h = (base - candle_top) * h_frac
        top = base - body_h
        col = UP if i == n - 1 else (ACCENT if i == 1 else DOWN)
        wick_top = top - (base - candle_top) * 0.13
        wick_bot = base + (base - candle_top) * 0.06
        d.line([(cx, wick_top), (cx, wick_bot)], fill=col, width=max(2, int(s * 0.017)))
        d.rectangle([cx - body_w / 2, top, cx + body_w / 2, base], fill=col)

    return img


def rounded(img, radius_ratio=0.22):
    """iOS 会自动加圆角，这里只给非 apple-touch 的图标做轻微圆角美观处理。"""
    s = img.size[0]
    r = int(s * radius_ratio)
    mask = Image.new("L", (s, s), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, s - 1, s - 1], radius=r, fill=255)
    out = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    targets = [
        ("icon-180.png", 180, False, False),      # apple-touch-icon 必须直角
        ("icon-192.png", 192, False, True),
        ("icon-512.png", 512, False, True),
        ("icon-1024.png", 1024, False, True),
        ("maskable-512.png", 512, True, False),   # maskable 必须满幅不透明
        ("favicon-64.png", 64, False, True),
    ]
    for name, size, maskable, do_round in targets:
        img = draw_icon(size, maskable=maskable)
        if do_round:
            img = rounded(img)
        path = os.path.join(OUT, name)
        img.save(path, "PNG", optimize=True)
        print(f"  {name:20s} {size:>5d}px  {os.path.getsize(path):>8d} B")

    # 顺带生成一个 SVG 版 favicon（矢量，体积极小）
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
<rect width="100" height="100" rx="22" fill="#101622"/>
<g stroke="#1e293b" stroke-width="1">
<path d="M0 12.5H100M0 25H100M0 37.5H100M0 50H100M0 62.5H100M0 75H100M0 87.5H100"/>
<path d="M12.5 0V100M25 0V100M37.5 0V100M50 0V100M62.5 0V100M75 0V100M87.5 0V100"/>
</g>
<g stroke-width="2">
<line x1="26" y1="52" x2="26" y2="82" stroke="#f87171"/>
<line x1="50" y1="40" x2="50" y2="78" stroke="#60a5fa"/>
<line x1="74" y1="24" x2="74" y2="70" stroke="#34d399"/>
</g>
<rect x="21" y="60" width="10" height="22" fill="#f87171"/>
<rect x="45" y="46" width="10" height="32" fill="#60a5fa"/>
<rect x="69" y="30" width="10" height="40" fill="#34d399"/>
<polyline points="18,44 34,32 50,34 66,20 82,14" fill="none" stroke="#34d399" stroke-width="3.2" stroke-linecap="round"/>
<circle cx="82" cy="14" r="5" fill="#34d399"/>
</svg>
"""
    svg_path = os.path.join(OUT, "icon.svg")
    with open(svg_path, "w", encoding="utf-8") as f:
        f.write(svg)
    print(f"  {'icon.svg':20s} 矢量     {os.path.getsize(svg_path):>8d} B")


if __name__ == "__main__":
    main()
