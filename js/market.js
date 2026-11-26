/* ============================================================
   market.js — 大盘环境四维打分 → 档位 → 仓位/只数
   趋势 30% / 广度 25% / 情绪 25% / 量能 20%
   ============================================================ */

import { maAt } from './indicators.js';

/** 档位定义 */
export const LEVELS = {
  attack: {
    key: 'attack',
    name: '进攻',
    badge: 'badge-attack',
    minScore: 70,
    position: 0.80,
    picks: 5,
    color: 'var(--up)',
    advice: '市场环境良好，可积极参与，按计划买入。',
  },
  neutral: {
    key: 'neutral',
    name: '中性',
    badge: 'badge-neutral',
    minScore: 50,
    position: 0.60,
    picks: 5,
    color: 'var(--blue)',
    advice: '市场震荡，控制仓位，优选主线强势股。',
  },
  defend: {
    key: 'defend',
    name: '防守',
    badge: 'badge-defend',
    minScore: 30,
    position: 0.35,
    picks: 4,
    color: 'var(--amber)',
    advice: '市场偏弱，降低仓位与只数，严格止损。',
  },
  frozen: {
    key: 'frozen',
    name: '冰点',
    badge: 'badge-frozen',
    minScore: -1,
    position: 0.20,
    picks: 3,
    color: 'var(--down)',
    advice: '市场极弱，建议空仓观望或极小仓位试错。',
  },
};

export function levelByScore(score) {
  if (score >= LEVELS.attack.minScore) return LEVELS.attack;
  if (score >= LEVELS.neutral.minScore) return LEVELS.neutral;
  if (score >= LEVELS.defend.minScore) return LEVELS.defend;
  return LEVELS.frozen;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}
function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}

/**
 * 趋势分（基于上证指数日 K）
 * c > MA20 +12, c > MA60 +10, MA20 > MA60 +8，基准 50，叠加 5 日动量
 */
export function trendScore(indexKl) {
  if (!indexKl || !indexKl.n || indexKl.n < 60) {
    return { score: 50, detail: { reason: '指数数据不足' } };
  }
  const close = indexKl.close;
  const i = indexKl.n - 1;
  const c = close[i];
  const ma20 = maAt(close, 20, i);
  const ma60 = maAt(close, 60, i);
  const ma5 = maAt(close, 5, i);
  const mom5 = c / close[i - 5] - 1;
  const mom20 = c / close[i - 20] - 1;

  let s = 50;
  if (c > ma20) s += 12; else s -= 12;
  if (c > ma60) s += 10; else s -= 10;
  if (ma20 > ma60) s += 8; else s -= 8;
  s += clamp(mom5 * 400, -14, 14);

  return {
    score: clamp(s, 0, 100),
    detail: {
      close: c, ma5, ma20, ma60, mom5, mom20,
      aboveMa20: c > ma20,
      aboveMa60: c > ma60,
      bullAlign: ma20 > ma60,
    },
  };
}

/**
 * 广度分（全市场上涨家数占比）
 * 50 + (ratio - 0.5) * 100，再叠加涨停/跌停差的修正
 */
export function breadthScore(snapshot) {
  let up = 0;
  let dn = 0;
  let flat = 0;
  let limitUp = 0;
  let limitDown = 0;
  let total = 0;

  for (const x of snapshot || []) {
    if (!x || typeof x.f3 !== 'number') continue;
    total++;
    if (x.f3 > 0) up++;
    else if (x.f3 < 0) dn++;
    else flat++;
    if (x.f3 >= 9.8) limitUp++;
    if (x.f3 <= -9.8) limitDown++;
  }

  const active = up + dn;
  const ratio = active > 0 ? up / active : 0.5;
  let s = 50 + (ratio - 0.5) * 100;
  // 涨停/跌停差修正（最多 ±12）
  const netLimit = limitUp - limitDown;
  s += clamp(netLimit * 0.35, -12, 12);

  return {
    score: clamp(s, 0, 100),
    detail: { up, dn, flat, total, ratio, limitUp, limitDown, netLimit },
  };
}

/**
 * 情绪分：涨停数 vs 跌停数 + 最高连板高度
 */
export function sentimentScore(ztPool, dtPool, breadthDetail) {
  const zt = ztPool && ztPool.pool ? ztPool.pool.length : (breadthDetail ? breadthDetail.limitUp : 0);
  const dt = dtPool && dtPool.pool ? dtPool.pool.length : (breadthDetail ? breadthDetail.limitDown : 0);

  let s = 50;
  const sum = zt + dt;
  if (sum > 0) s += ((zt - dt) / sum) * 40;
  else s += 0;

  // 涨停绝对数量修正（市场有赚钱效应）
  if (zt >= 80) s += 8;
  else if (zt >= 50) s += 4;
  else if (zt <= 15) s -= 8;
  else if (zt <= 30) s -= 4;

  // 最高连板高度（涨停池 lbc 字段）
  let maxStreak = 0;
  if (ztPool && Array.isArray(ztPool.pool)) {
    for (const p of ztPool.pool) {
      const v = Number(p && p.lbc) || 0;
      if (v > maxStreak) maxStreak = v;
    }
  }
  if (maxStreak >= 5) s += 6;
  else if (maxStreak >= 3) s += 3;
  else if (maxStreak <= 1 && zt < 40) s -= 3;

  return {
    score: clamp(s, 0, 100),
    detail: { limitUp: zt, limitDown: dt, maxStreak, net: zt - dt },
  };
}

/**
 * 量能分：两市成交额 / 20 日均额
 * @param {number} amountToday 今日两市成交额（元）
 * @param {object} indexKl 上证指数 K 线（用 amt 字段）
 */
export function volumeScore(amountToday, indexKl) {
  if (!indexKl || !indexKl.n || indexKl.n < 21 || !amountToday) {
    return { score: 50, detail: { reason: '量能数据不足' } };
  }
  const amt = indexKl.amt;
  const i = indexKl.n - 1;
  let sum = 0;
  for (let k = i - 20; k <= i - 1; k++) sum += amt[k];
  const avg20 = sum / 20;
  if (!avg20) return { score: 50, detail: { reason: '量能基准为 0' } };

  // 指数成交额只反映沪市，这里用比值（不需要绝对值）
  const ratio = amountToday / 2 / avg20;   // 两市 ≈ 沪市 × 2 的粗估
  let s = 50 + (ratio - 1) * 60;
  s = clamp(s, 0, 100);

  return {
    score: s,
    detail: { amountToday, avg20, ratio },
  };
}

/**
 * 综合大盘分析
 * @param {object} input
 *   { indexKl, snapshot, ztPool, dtPool, amountToday }
 * @returns {object}
 */
export function analyzeMarket(input = {}) {
  const trend = trendScore(input.indexKl);
  const breadth = breadthScore(input.snapshot);
  const sentiment = sentimentScore(input.ztPool, input.dtPool, breadth.detail);

  // 量能优先用快照汇总，其次用参数
  let amountToday = input.amountToday;
  if (!amountToday && input.snapshot) {
    amountToday = input.snapshot.reduce((s, x) => s + (typeof x.f6 === 'number' ? x.f6 : 0), 0);
  }
  const volume = volumeScore(amountToday, input.indexKl);

  const W = { trend: 0.30, breadth: 0.25, sentiment: 0.25, volume: 0.20 };
  const total =
    trend.score * W.trend +
    breadth.score * W.breadth +
    sentiment.score * W.sentiment +
    volume.score * W.volume;

  const level = levelByScore(total);

  return {
    score: Math.round(total * 10) / 10,
    level,
    dims: {
      trend: { name: '趋势', weight: W.trend, score: trend.score, detail: trend.detail },
      breadth: { name: '广度', weight: W.breadth, score: breadth.score, detail: breadth.detail },
      sentiment: { name: '情绪', weight: W.sentiment, score: sentiment.score, detail: sentiment.detail },
      volume: { name: '量能', weight: W.volume, score: volume.score, detail: volume.detail },
    },
    amountToday: amountToday || 0,
  };
}

/**
 * 根据档位与本金，计算单只预算
 */
export function budgetPerStock(capital, level, picksOverride) {
  const picks = picksOverride || level.picks;
  const total = capital * level.position;
  return { perStock: total / picks, total, picks };
}
