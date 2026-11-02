/* ============================================================
   strategy.js — 三策略权重表 + 横截面分位标准化 + 组合约束
   ============================================================ */

import { crossSectionNormalize } from './indicators.js';

/** 策略定义：8 因子权重（每行和为 1.0）
 *  reverseKeys 为该策略下「越小越好」的因子；未列出的因子均为「越大越好」。
 */
export const STRATEGIES = {
  balanced: {
    key: 'balanced',
    name: '均衡多因子',
    desc: '动量、趋势、主线并重，回撤与量能辅助，适合震荡与结构市',
    reverseKeys: ['rsi', 'atrp'],
    weights: {
      mom20: 0.20,
      mom5: 0.10,
      dd: 0.10,
      trend: 0.20,
      rsi: 0.05,
      atrp: 0.05,
      vr: 0.10,
      main: 0.20,
    },
  },
  momentum: {
    key: 'momentum',
    name: '趋势动量',
    desc: '强化趋势与中期动量，追强势主线，适合单边上行市',
    reverseKeys: ['rsi', 'atrp'],
    weights: {
      mom20: 0.25,
      mom5: 0.15,
      dd: 0.05,
      trend: 0.30,
      rsi: 0.05,
      atrp: 0.05,
      vr: 0.10,
      main: 0.05,
    },
  },
  reversal: {
    key: 'reversal',
    name: '超跌反弹',
    desc: '偏好回撤深、RSI 低、量能异动的标的，适合急跌后的修复行情',
    // 反转策略：回撤越深越好（dd 反向）、RSI 越低越好（rsi 反向）
    reverseKeys: ['dd', 'rsi', 'atrp'],
    weights: {
      mom20: 0.10,
      mom5: 0.05,
      dd: 0.25,
      trend: 0.10,
      rsi: 0.15,
      atrp: 0.05,
      vr: 0.10,
      main: 0.20,
    },
  },
};

export function getStrategy(key) {
  return STRATEGIES[key] || STRATEGIES.balanced;
}

/** 需要反向（越小越好）的因子 —— 默认集合（均衡/动量策略使用） */
export const REVERSE_KEYS = ['rsi', 'atrp'];

/** 因子中文名 */
export const FACTOR_LABELS = {
  mom20: '20日动量',
  mom5: '5日动量',
  dd: '距高回撤',
  trend: '趋势强度',
  rsi: 'RSI(反向)',
  atrp: '波动率(反向)',
  vr: '量比',
  main: '主线强度',
};

/**
 * 对候选池做横截面标准化并打分。
 * @param {Array} rows 含 code + 因子字段（mom20/mom5/dd/trend/rsi/atrp/vr/mainScore）
 * @param {string} strategyKey
 * @returns {Array} 每只带 score 与 factors(0~100)
 */
export function scoreCandidates(rows, strategyKey = 'balanced') {
  const strategy = getStrategy(strategyKey);
  const W = strategy.weights;
  const keys = Object.keys(W);

  // 构造 main 字段别名（mainScore → main）
  const prepared = rows.map((r) => ({
    ...r,
    main: isFinite(r.mainScore) ? r.mainScore : 0,
  }));

  const norm = crossSectionNormalize(prepared, keys, strategy.reverseKeys || REVERSE_KEYS);

  const scored = prepared.map((r) => {
    const f = norm.get(r.code) || {};
    let s = 0;
    for (const k of keys) s += (f[k] || 0) * W[k];
    return {
      ...r,
      score: s,
      factors: f,
      strategyKey: strategy.key,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored;
}

/**
 * 组合约束：同一行业 ≤ 2 只、同一主线板块 ≤ 2 只。
 * 贪心地按分数从高到低挑选，跳过违反约束的。
 * @param {Array} scored 已按 score 降序
 * @param {number} n 目标只数
 * @param {object} opt { maxPerIndustry, maxPerBoard }
 * @returns {Array}
 */
export function applyPortfolioConstraints(scored, n, opt = {}) {
  const maxInd = opt.maxPerIndustry ?? 2;
  const maxBoard = opt.maxPerBoard ?? 2;

  const picked = [];
  const indCount = new Map();
  const boardCount = new Map();
  const usedCodes = new Set();

  for (const r of scored) {
    if (picked.length >= n) break;
    if (usedCodes.has(r.code)) continue;

    const ind = String(r.industry || '').trim();
    const indKey = ind || '__none__';
    if (ind && (indCount.get(indKey) || 0) >= maxInd) continue;

    const boards = Array.isArray(r.mainNames) ? r.mainNames : [];
    // 只要任一主线板块已满额，就跳过（避免主线过度集中）
    let boardFull = false;
    for (const b of boards) {
      if ((boardCount.get(b) || 0) >= maxBoard) { boardFull = true; break; }
    }
    if (boardFull) continue;

    // 采纳
    picked.push(r);
    usedCodes.add(r.code);
    if (ind) indCount.set(indKey, (indCount.get(indKey) || 0) + 1);
    for (const b of boards) boardCount.set(b, (boardCount.get(b) || 0) + 1);
  }

  // 如果约束导致不足 n 只，放宽到只保证不重复（保底）
  if (picked.length < n) {
    for (const r of scored) {
      if (picked.length >= n) break;
      if (usedCodes.has(r.code)) continue;
      picked.push(r);
      usedCodes.add(r.code);
    }
  }

  return picked;
}

/**
 * 生成入选理由（用于 UI 展示）
 */
export function buildReason(stock) {
  const parts = [];
  const f = stock.factors || {};

  if (Array.isArray(stock.mainNames) && stock.mainNames.length) {
    parts.push(`主线：<b>${stock.mainNames.slice(0, 2).join('、')}</b>`);
  }
  if (isFinite(stock.mom20) && stock.mom20 > 0.05) {
    parts.push(`20日动量 <b>+${(stock.mom20 * 100).toFixed(1)}%</b>`);
  } else if (isFinite(stock.mom20) && stock.mom20 < -0.08) {
    parts.push(`20日跌幅 ${(stock.mom20 * 100).toFixed(1)}%（超跌）`);
  }
  if (isFinite(stock.maAlign)) {
    parts.push(`均线多头排列 <b>${stock.maAlign}/3</b>`);
  }
  if (isFinite(stock.rsi)) {
    const tag = stock.rsi > 75 ? '偏高' : stock.rsi < 40 ? '偏低' : '健康';
    parts.push(`RSI ${stock.rsi.toFixed(0)}（${tag}）`);
  }
  if (isFinite(stock.vr) && stock.vr > 1.2) {
    parts.push(`量比 <b>${stock.vr.toFixed(2)}</b> 放量`);
  }
  if (isFinite(stock.dd) && stock.dd > -0.03) {
    parts.push('接近 <b>60日新高</b>');
  }
  if (isFinite(f.main)) {
    parts.push(`主线分位 <b>${f.main.toFixed(0)}</b>`);
  }
  return parts.join('，') || '多因子综合评分靠前';
}
