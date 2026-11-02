/* ============================================================
   indicators.js — 技术指标计算
   全部基于 Float64Array，单次计算 ~1-2ms
   ============================================================ */

/**
 * 简单移动平均（取最后一个点）
 */
export function maAt(arr, n, idx) {
  const end = idx === undefined ? arr.length - 1 : idx;
  if (end < n - 1) return NaN;
  let s = 0;
  for (let i = end - n + 1; i <= end; i++) s += arr[i];
  return s / n;
}

/** 序列版 MA（返回 Float64Array，前 n-1 个为 NaN） */
export function maSeries(arr, n) {
  const len = arr.length;
  const out = new Float64Array(len).fill(NaN);
  let sum = 0;
  for (let i = 0; i < len; i++) {
    sum += arr[i];
    if (i >= n) sum -= arr[i - n];
    if (i >= n - 1) out[i] = sum / n;
  }
  return out;
}

/** RSI（Wilder 平滑，默认 14） */
export function rsiAt(close, period = 14, idx) {
  const end = idx === undefined ? close.length - 1 : idx;
  if (end < period) return NaN;
  let up = 0;
  let dn = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) up += d;
    else dn -= d;
  }
  if (dn === 0) return 100;
  const rs = up / dn;
  return 100 - 100 / (1 + rs);
}

/** ATR（真实波幅均值，默认 14） */
export function atrAt(high, low, close, period = 14, idx) {
  const end = idx === undefined ? close.length - 1 : idx;
  if (end < period) return NaN;
  let sum = 0;
  for (let i = end - period + 1; i <= end; i++) {
    const tr = Math.max(
      high[i] - low[i],
      Math.abs(high[i] - close[i - 1]),
      Math.abs(low[i] - close[i - 1])
    );
    sum += tr;
  }
  return sum / period;
}

/** N 日动量（涨幅） */
export function momentum(close, n, idx) {
  const end = idx === undefined ? close.length - 1 : idx;
  if (end < n) return NaN;
  const base = close[end - n];
  if (!base) return NaN;
  return close[end] / base - 1;
}

/** 距 N 日最高价的回撤（负值） */
export function drawdownFromHigh(high, n, idx) {
  const end = idx === undefined ? high.length - 1 : idx;
  if (end < n - 1) return NaN;
  let hi = -Infinity;
  for (let i = end - n + 1; i <= end; i++) if (high[i] > hi) hi = high[i];
  if (!isFinite(hi) || hi <= 0) return NaN;
  return high[end] / hi - 1;
}

/** 量比：当日成交量 / 过去 n 日均量 */
export function volumeRatio(vol, n = 5, idx) {
  const end = idx === undefined ? vol.length - 1 : idx;
  if (end < n) return NaN;
  let sum = 0;
  for (let i = end - n + 1; i <= end; i++) sum += vol[i];
  const avg = sum / n;
  if (!avg) return NaN;
  return vol[end] / avg;
}

/** 线性回归斜率（归一化到「每日涨跌%」） */
export function slopePct(close, n, idx) {
  const end = idx === undefined ? close.length - 1 : idx;
  if (end < n - 1) return NaN;
  const start = end - n + 1;
  const xMean = (n - 1) / 2;
  let yMean = 0;
  for (let i = start; i <= end; i++) yMean += close[i];
  yMean /= n;
  let num = 0;
  let den = 0;
  for (let k = 0; k < n; k++) {
    const dx = k - xMean;
    num += dx * (close[start + k] - yMean);
    den += dx * dx;
  }
  if (!den || !yMean) return NaN;
  return (num / den / yMean) * 100;
}

/**
 * 计算一只股票的全部技术因子。
 * @param {object} kl { open, close, high, low, vol, n }
 * @returns {object|null}
 */
export function computeFactors(kl) {
  if (!kl || !kl.n || kl.n < 70) return null;
  const { close, high, low, vol } = kl;
  const i = kl.n - 1;

  const c = close[i];
  if (!isFinite(c) || c <= 0) return null;

  const ma5 = maAt(close, 5, i);
  const ma10 = maAt(close, 10, i);
  const ma20 = maAt(close, 20, i);
  const ma60 = maAt(close, 60, i);

  const rsi = rsiAt(close, 14, i);
  const atr = atrAt(high, low, close, 14, i);
  const mom5 = momentum(close, 5, i);
  const mom10 = momentum(close, 10, i);
  const mom20 = momentum(close, 20, i);
  const dd = drawdownFromHigh(high, 60, i);
  const vr = volumeRatio(vol, 5, i);
  const slope20 = slopePct(close, 20, i);

  const trend = (c / ma20 - 1) + (c / ma60 - 1);
  const atrp = c > 0 ? atr / c : NaN;

  // 波动率（20 日收益率标准差）
  let retSum = 0;
  let retSq = 0;
  const rn = 20;
  for (let k = i - rn + 1; k <= i; k++) {
    const r = close[k] / close[k - 1] - 1;
    retSum += r;
    retSq += r * r;
  }
  const retMean = retSum / rn;
  const vol20 = Math.sqrt(Math.max(0, retSq / rn - retMean * retMean));

  // 均线多头排列程度
  const maAlign =
    (ma5 > ma10 ? 1 : 0) + (ma10 > ma20 ? 1 : 0) + (ma20 > ma60 ? 1 : 0);

  return {
    price: c,
    ma5, ma10, ma20, ma60,
    rsi, atr, atrp, vol20,
    mom5, mom10, mom20,
    dd, vr, slope20, trend, maAlign,
    maAlignPct: maAlign / 3,
    // 短期是否强于中期（用于趋势过滤）
    aboveMa20: c > ma20,
    aboveMa60: c > ma60,
  };
}

/** 横截面分位标准化：返回 0~100 的分位值 */
export function percentileRank(values, value, reverse = false) {
  const n = values.length;
  if (!n) return 50;
  let cnt = 0;
  for (let i = 0; i < n; i++) {
    if (values[i] < value) cnt++;
  }
  const pct = (cnt / Math.max(1, n - 1)) * 100;
  return reverse ? 100 - pct : pct;
}

/**
 * 批量横截面标准化：对每个因子返回 Map<code, 0~100>
 * @param {Array} rows 含 code 与因子字段的对象数组
 * @param {string[]} keys 因子字段名
 * @param {object} reverseKeys 需要反向的因子（如 rsi、atrp）
 * @returns {Map<string, object>}
 */
export function crossSectionNormalize(rows, keys, reverseKeys = []) {
  const revSet = new Set(reverseKeys);
  const out = new Map();
  const n = rows.length;

  for (const r of rows) {
    out.set(r.code, {});
  }
  if (!n) return out;

  for (const key of keys) {
    const vals = rows.map((r) => {
      const v = r[key];
      return isFinite(v) ? v : NaN;
    });
    const valid = vals.filter((v) => isFinite(v)).sort((a, b) => a - b);
    const m = valid.length;

    for (let i = 0; i < n; i++) {
      const v = vals[i];
      const code = rows[i].code;
      const bucket = out.get(code);
      if (!isFinite(v) || m === 0) {
        bucket[key] = 50;   // 缺失给中位分
        continue;
      }
      // 二分查找排名
      let lo = 0;
      let hi = m;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (valid[mid] < v) lo = mid + 1;
        else hi = mid;
      }
      let pct = m > 1 ? (lo / (m - 1)) * 100 : 50;
      if (revSet.has(key)) pct = 100 - pct;
      bucket[key] = pct;
    }
  }
  return out;
}
