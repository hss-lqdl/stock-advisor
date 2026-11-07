/* ============================================================
   charts.js — 手写 Canvas 图表（零依赖）
   ============================================================ */

const CSS = {
  up: '#ef4444',
  down: '#22c55e',
  grid: 'rgba(148,163,184,0.14)',
  text: '#94a3b8',
  textStrong: '#e2e8f0',
  line: '#38bdf8',
  line2: '#f59e0b',
  fill: 'rgba(56,189,248,0.14)',
  bg: 'transparent',
};

/** 高清屏适配 */
function setupCanvas(canvas, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  return ctx;
}

/**
 * K 线图（含 MA5/MA20 与成交量）
 * @param {HTMLCanvasElement} canvas
 * @param {object} kl { dates, open, close, high, low, vol, n }
 * @param {object} opt { bars, height }
 */
export function drawKline(canvas, kl, opt = {}) {
  if (!canvas || !kl || !kl.n) return;
  const bars = Math.min(opt.bars || 60, kl.n);
  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const cssH = opt.height || 200;
  const ctx = setupCanvas(canvas, cssW, cssH);

  const padL = 4;
  const padR = 46;
  const padT = 8;
  const volH = Math.round(cssH * 0.24);
  const priceH = cssH - padT - volH - 6;

  const start = kl.n - bars;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = start; i < kl.n; i++) {
    if (kl.high[i] > hi) hi = kl.high[i];
    if (kl.low[i] < lo) lo = kl.low[i];
  }
  if (!isFinite(hi) || !isFinite(lo) || hi <= lo) return;
  const range = hi - lo;
  hi += range * 0.06;
  lo -= range * 0.06;

  const plotW = cssW - padL - padR;
  const step = plotW / bars;
  const bodyW = Math.max(1.2, step * 0.62);

  const yOf = (p) => padT + ((hi - p) / (hi - lo)) * priceH;

  // 网格 + 价格刻度
  ctx.font = '10px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (let g = 0; g <= 4; g++) {
    const p = hi - ((hi - lo) * g) / 4;
    const y = yOf(p);
    ctx.strokeStyle = CSS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(cssW - padR, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = CSS.text;
    ctx.fillText(p.toFixed(2), cssW - padR + 5, y);
  }

  // K 线
  for (let i = 0; i < bars; i++) {
    const idx = start + i;
    const x = padL + step * i + step / 2;
    const o = kl.open[idx];
    const c = kl.close[idx];
    const h = kl.high[idx];
    const l = kl.low[idx];
    const isUp = c >= o;
    const col = isUp ? CSS.up : CSS.down;

    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, yOf(h));
    ctx.lineTo(x, yOf(l));
    ctx.stroke();

    const y1 = yOf(Math.max(o, c));
    const y2 = yOf(Math.min(o, c));
    const hh = Math.max(1, y2 - y1);
    ctx.fillStyle = col;
    if (isUp) {
      ctx.fillRect(x - bodyW / 2, y1, bodyW, hh);
    } else {
      ctx.fillRect(x - bodyW / 2, y1, bodyW, hh);
    }
  }

  // MA5 / MA20
  const drawMA = (n, color) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < bars; i++) {
      const idx = start + i;
      if (idx < n - 1) continue;
      let s = 0;
      for (let k = idx - n + 1; k <= idx; k++) s += kl.close[k];
      const v = s / n;
      const x = padL + step * i + step / 2;
      const y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };
  drawMA(5, CSS.line2);
  drawMA(20, CSS.line);

  // 成交量
  let vmax = 0;
  for (let i = start; i < kl.n; i++) if (kl.vol[i] > vmax) vmax = kl.vol[i];
  const volTop = cssH - volH;
  if (vmax > 0) {
    for (let i = 0; i < bars; i++) {
      const idx = start + i;
      const x = padL + step * i + step / 2;
      const vh = (kl.vol[idx] / vmax) * (volH - 4);
      const isUp = kl.close[idx] >= kl.open[idx];
      ctx.fillStyle = isUp ? 'rgba(239,68,68,0.55)' : 'rgba(34,197,94,0.55)';
      ctx.fillRect(x - bodyW / 2, volTop + (volH - 4 - vh) + 2, bodyW, vh);
    }
  }

  // 图例
  ctx.textAlign = 'left';
  ctx.fillStyle = CSS.line2;
  ctx.fillText('MA5', padL + 2, padT + 6);
  ctx.fillStyle = CSS.line;
  ctx.fillText('MA20', padL + 34, padT + 6);
}

/**
 * 主线得分横向条形图
 * @param {HTMLCanvasElement} canvas
 * @param {Array} boards [{name, score, f3, f109}]
 * @param {object} opt { height }
 */
export function drawMainlineBars(canvas, boards, opt = {}) {
  if (!canvas || !boards || !boards.length) return;
  const list = boards.slice(0, opt.count || 8);
  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const rowH = 30;
  const cssH = opt.height || list.length * rowH + 8;
  const ctx = setupCanvas(canvas, cssW, cssH);

  const labelW = 78;
  const valW = 52;
  const barW = cssW - labelW - valW - 8;

  const maxAbs = Math.max(...list.map((b) => Math.abs(b.score)), 1);

  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  list.forEach((b, i) => {
    const y = 4 + i * rowH;
    const cy = y + rowH / 2;

    // 名称
    ctx.textAlign = 'left';
    ctx.fillStyle = CSS.textStrong;
    let name = String(b.name || '');
    if (name.length > 6) name = name.slice(0, 6);
    ctx.fillText(name, 0, cy);

    // 条形（负分向左、正分向右，中线居中）
    const zeroX = labelW + barW / 2;
    const w = (Math.abs(b.score) / maxAbs) * (barW / 2);
    const positive = b.score >= 0;
    ctx.fillStyle = positive
      ? (b.f109 >= 3 ? 'rgba(239,68,68,0.85)' : 'rgba(239,68,68,0.55)')
      : 'rgba(34,197,94,0.6)';
    const x0 = positive ? zeroX : zeroX - w;
    ctx.fillRect(x0, cy - 7, Math.max(1.5, w), 14);

    // 分数
    ctx.textAlign = 'right';
    ctx.fillStyle = positive ? '#fca5a5' : '#86efac';
    ctx.fillText(b.score.toFixed(1), cssW - 2, cy);
  });

  // 中线
  const zeroX = labelW + barW / 2;
  ctx.strokeStyle = 'rgba(148,163,184,0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(zeroX + 0.5, 2);
  ctx.lineTo(zeroX + 0.5, cssH - 2);
  ctx.stroke();
}

/**
 * 主线 5 日热度折线（用 f109 反推）
 * @param {HTMLCanvasElement} canvas
 * @param {Array} series [{name, score, chg5, points}]
 */
export function drawTrendLine(canvas, series, opt = {}) {
  if (!canvas || !series || !series.length) return;
  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const cssH = opt.height || 130;
  const ctx = setupCanvas(canvas, cssW, cssH);

  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 18;
  const W = cssW - padL - padR;
  const H = cssH - padT - padB;

  const colors = ['#38bdf8', '#f59e0b', '#a78bfa', '#34d399', '#f472b6'];
  const n = series.length;

  // 每个板块用 f109 反推 5 个点：从 5 日前到今日的线性插值
  let gMax = -Infinity;
  let gMin = Infinity;
  const allSeries = series.slice(0, 5).map((s, si) => {
    const chg5 = (s.chg5 || 0) / 100;
    const pts = [];
    for (let k = 0; k < 6; k++) {
      // k=0 表示 5 日前，k=5 表示今日
      const frac = k / 5;
      const v = (s.score || 0) - (s.chg5 || 0) * (1 - frac) * 1.6;
      pts.push(v);
      if (v > gMax) gMax = v;
      if (v < gMin) gMin = v;
    }
    return { name: s.name, pts, color: colors[si % colors.length] };
  });

  if (!isFinite(gMax) || !isFinite(gMin)) return;
  if (gMax === gMin) { gMax += 1; gMin -= 1; }
  const pad = (gMax - gMin) * 0.12;
  gMax += pad;
  gMin -= pad;

  const xOf = (k) => padL + (k / 5) * W;
  const yOf = (v) => padT + ((gMax - v) / (gMax - gMin)) * H;

  // 网格
  ctx.strokeStyle = CSS.grid;
  ctx.lineWidth = 1;
  for (let g = 0; g <= 3; g++) {
    const y = padT + (H * g) / 3;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(cssW - padR, y + 0.5);
    ctx.stroke();
  }

  // 折线
  allSeries.forEach((s) => {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    s.pts.forEach((v, k) => {
      const x = xOf(k);
      const y = yOf(v);
      if (k === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
    // 末点
    const lx = xOf(5);
    const ly = yOf(s.pts[5]);
    ctx.fillStyle = s.color;
    ctx.beginPath();
    ctx.arc(lx, ly, 2.6, 0, Math.PI * 2);
    ctx.fill();
  });

  // X 轴标签
  ctx.font = '9px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = CSS.text;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText('5日前', padL, cssH - 12);
  ctx.textAlign = 'right';
  ctx.fillText('今日', cssW - padR, cssH - 12);

  return allSeries.map((s) => ({ name: s.name, color: s.color }));
}

/**
 * 大盘四维雷达/条形
 */
export function drawDimBars(canvas, dims, opt = {}) {
  if (!canvas || !dims) return;
  const keys = ['trend', 'breadth', 'sentiment', 'volume'];
  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 300;
  const rowH = 26;
  const cssH = opt.height || keys.length * rowH + 6;
  const ctx = setupCanvas(canvas, cssW, cssH);

  const labelW = 34;
  const valW = 30;
  const barW = cssW - labelW - valW - 8;

  ctx.font = '11px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  keys.forEach((k, i) => {
    const d = dims[k];
    if (!d) return;
    const y = 3 + i * rowH;
    const cy = y + rowH / 2;

    ctx.textAlign = 'left';
    ctx.fillStyle = CSS.text;
    ctx.fillText(d.name, 0, cy);

    // 底槽
    ctx.fillStyle = 'rgba(148,163,184,0.14)';
    ctx.beginPath();
    ctx.roundRect(labelW, cy - 5, barW, 10, 5);
    ctx.fill();

    // 填充
    const s = Math.max(0, Math.min(100, d.score));
    const w = (s / 100) * barW;
    const col = s >= 70 ? '#ef4444' : s >= 50 ? '#38bdf8' : s >= 30 ? '#f59e0b' : '#22c55e';
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(labelW, cy - 5, Math.max(2, w), 10, 5);
    ctx.fill();

    ctx.textAlign = 'right';
    ctx.fillStyle = CSS.textStrong;
    ctx.fillText(s.toFixed(0), cssW - 2, cy);
  });
}

/**
 * 迷你走势线（用于列表内）
 */
export function drawSparkline(canvas, values, opt = {}) {
  if (!canvas || !values || values.length < 2) return;
  const cssW = opt.width || 64;
  const cssH = opt.height || 22;
  const ctx = setupCanvas(canvas, cssW, cssH);

  const valid = values.filter((v) => isFinite(v));
  if (valid.length < 2) return;
  let hi = Math.max(...valid);
  let lo = Math.min(...valid);
  if (hi === lo) { hi += 0.01; lo -= 0.01; }

  const up = valid[valid.length - 1] >= valid[0];
  ctx.strokeStyle = up ? CSS.up : CSS.down;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  valid.forEach((v, i) => {
    const x = (i / (valid.length - 1)) * (cssW - 2) + 1;
    const y = cssH - 2 - ((v - lo) / (hi - lo)) * (cssH - 4);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

/**
 * 回测净值曲线
 */
export function drawEquityCurve(canvas, points, opt = {}) {
  if (!canvas || !points || points.length < 2) return;
  const cssW = canvas.parentElement ? canvas.parentElement.clientWidth : 340;
  const cssH = opt.height || 160;
  const ctx = setupCanvas(canvas, cssW, cssH);

  const padL = 6;
  const padR = 42;
  const padT = 10;
  const padB = 18;
  const W = cssW - padL - padR;
  const H = cssH - padT - padB;

  let hi = -Infinity;
  let lo = Infinity;
  for (const p of points) {
    if (p.equity > hi) hi = p.equity;
    if (p.equity < lo) lo = p.equity;
  }
  const base = 1;
  hi = Math.max(hi, base);
  lo = Math.min(lo, base);
  const pad = (hi - lo) * 0.1 || 0.01;
  hi += pad;
  lo -= pad;

  const xOf = (i) => padL + (i / (points.length - 1)) * W;
  const yOf = (v) => padT + ((hi - v) / (hi - lo)) * H;

  // 基准线 1.0
  ctx.strokeStyle = 'rgba(148,163,184,0.35)';
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, yOf(base));
  ctx.lineTo(cssW - padR, yOf(base));
  ctx.stroke();
  ctx.setLineDash([]);

  // 网格 + 刻度
  ctx.font = '9px -apple-system, system-ui, sans-serif';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  for (let g = 0; g <= 3; g++) {
    const v = hi - ((hi - lo) * g) / 3;
    const y = yOf(v);
    ctx.strokeStyle = CSS.grid;
    ctx.beginPath();
    ctx.moveTo(padL, y + 0.5);
    ctx.lineTo(cssW - padR, y + 0.5);
    ctx.stroke();
    ctx.fillStyle = CSS.text;
    ctx.fillText(((v - 1) * 100).toFixed(1) + '%', cssW - padR + 4, y);
  }

  // 面积
  const grad = ctx.createLinearGradient(0, padT, 0, padT + H);
  grad.addColorStop(0, 'rgba(56,189,248,0.28)');
  grad.addColorStop(1, 'rgba(56,189,248,0.02)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(xOf(0), yOf(points[0].equity));
  for (let i = 1; i < points.length; i++) ctx.lineTo(xOf(i), yOf(points[i].equity));
  ctx.lineTo(xOf(points.length - 1), padT + H);
  ctx.lineTo(xOf(0), padT + H);
  ctx.closePath();
  ctx.fill();

  // 线
  ctx.strokeStyle = CSS.line;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  for (let i = 0; i < points.length; i++) {
    const x = xOf(i);
    const y = yOf(points[i].equity);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.stroke();
}
