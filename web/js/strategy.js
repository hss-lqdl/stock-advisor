/* ============================================================
   strategy.js — 四策略定义 + 策略专属股票池过滤 + 打分 + 组合约束
   ------------------------------------------------------------
   设计要点：
   1. 每个策略有自己的「股票池过滤链」（STRATEGY_FILTERS），
      分 stage1（只用快照字段）/ stage2（需要 K 线因子）两段，
      从 universe.js 的基础池末端续接，因此四个策略的候选池互不相同。
   2. 过滤链带保底：若筛完不足 minKeep 只，逐级放宽，绝不给空结果。
   3. dragon（龙头战法）额外用 leader 因子 —— 同行业相对强度分位。
   ============================================================ */

import { crossSectionNormalize } from './indicators.js';

/** 策略定义：因子权重（每行和为 1.0）
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
  dragon: {
    key: 'dragon',
    name: '龙头战法',
    desc: '只在最强主线里买板块龙头：趋势与相对强度优先，要求趋势完好、放量、同板块领先',
    // 波动率越低越好；动量/趋势/龙头度均为越大越好
    reverseKeys: ['atrp'],
    weights: {
      mom20: 0.15,
      mom5: 0.10,
      dd: 0.10,
      trend: 0.20,
      rsi: 0.05,
      atrp: 0.05,
      vr: 0.10,
      main: 0.05,
      leader: 0.20,
    },
  },
};

export function getStrategy(key) {
  return STRATEGIES[key] || STRATEGIES.balanced;
}

export const STRATEGY_KEYS = Object.keys(STRATEGIES);

/** 需要反向（越小越好）的因子 —— 默认集合（均衡/动量策略使用） */
export const REVERSE_KEYS = ['rsi', 'atrp'];

/** 因子中文名（中性，不含「反向」；反向标注由 factorLabel 按策略动态拼接） */
export const FACTOR_LABELS = {
  mom20: '20日动量',
  mom5: '5日动量',
  dd: '距高回撤',
  trend: '趋势强度',
  rsi: 'RSI',
  atrp: '波动率',
  vr: '量比',
  main: '主线强度',
  leader: '板块龙头度',
};

/** 带策略语境的因子名：该策略下反向的因子补上「(反向)」 */
export function factorLabel(key, strategyKey) {
  const base = FACTOR_LABELS[key] || key;
  const st = getStrategy(strategyKey);
  return (st.reverseKeys || []).includes(key) ? base + '(反向)' : base;
}

/* ============================================================
   策略专属股票池过滤链
   ------------------------------------------------------------
   stage1 只用快照字段：amount(成交额,元) / turnover(换手率,%) /
     volRatio(量比) / mktCap(总市值,元) / chgPct(当日涨幅,%) / price
   stage2 需要 K 线因子：mom20 / mom5(动量,小数) / dd(距60日高,小数,≤0) /
     rsi(0~100) / atrp(ATR%,小数) / maAlign(0~3) / vr(量比)
   约定：字段缺失时一律「放行」（fail-open），避免上游缺数据把池子清空；
   真正兜底的是 applyStrategyFilters 的 minKeep 逐级放宽。
   ============================================================ */

const isNum = (v) => typeof v === 'number' && isFinite(v);
/** 缺失即放行 */
const ok = (v, fn) => !isNum(v) || fn(v);

export const STRATEGY_FILTERS = {
  /* 均衡：门槛最宽，覆盖面优先 —— 只要「流动性够、波动不离谱」即可 */
  balanced: {
    stage1: [
      { label: '成交额 ≥ 1.5 亿', test: (s) => ok(s.amount, (v) => v >= 1.5e8) },
      { label: '换手率 1%~18%', test: (s) => ok(s.turnover, (v) => v >= 1 && v <= 18) },
      { label: '量比 ≥ 0.8', test: (s) => ok(s.volRatio, (v) => v >= 0.8) },
      { label: '市值 ≤ 600 亿', test: (s) => ok(s.mktCap, (v) => v <= 600e8) },
    ],
    stage2: [
      { label: '20日动量 > -10%', test: (s) => ok(s.mom20, (v) => v > -0.10) },
      { label: '均线多头 ≥ 1/3', test: (s) => ok(s.maAlign, (v) => v >= 1) },
      { label: 'ATR ≤ 12%（波动可控）', test: (s) => ok(s.atrp, (v) => v <= 0.12) },
    ],
  },

  /* 趋势动量：只买「已经走强」的 —— 站上均线、当日有量、不追已过热 */
  momentum: {
    stage1: [
      { label: '成交额 ≥ 2 亿', test: (s) => ok(s.amount, (v) => v >= 2e8) },
      { label: '换手率 ≥ 2%', test: (s) => ok(s.turnover, (v) => v >= 2) },
      { label: '量比 ≥ 1.0（放量）', test: (s) => ok(s.volRatio, (v) => v >= 1.0) },
      { label: '当日涨幅 > 0', test: (s) => ok(s.chgPct, (v) => v > 0) },
      { label: '市值 ≤ 800 亿', test: (s) => ok(s.mktCap, (v) => v <= 800e8) },
    ],
    stage2: [
      { label: '均线多头 = 3/3', test: (s) => isNum(s.maAlign) && s.maAlign >= 3 },
      { label: '20日动量 > 0', test: (s) => ok(s.mom20, (v) => v > 0) },
      { label: '距60日高回撤 ≤ 18%', test: (s) => ok(s.dd, (v) => v >= -0.18) },
      { label: 'RSI ≤ 82（不追过热）', test: (s) => ok(s.rsi, (v) => v <= 82) },
    ],
  },

  /* 超跌反弹：只买「跌透且出现异动」的 —— 小盘弹性、跌幅可观、RSI 低 */
  reversal: {
    stage1: [
      { label: '成交额 ≥ 1.2 亿', test: (s) => ok(s.amount, (v) => v >= 1.2e8) },
      { label: '市值 ≤ 300 亿（小盘弹性）', test: (s) => ok(s.mktCap, (v) => v <= 300e8) },
      { label: '当日涨幅 -8%~+3%', test: (s) => ok(s.chgPct, (v) => v >= -8 && v <= 3) },
      { label: '量比 ≥ 0.8', test: (s) => ok(s.volRatio, (v) => v >= 0.8) },
    ],
    stage2: [
      { label: '20日动量 < 0（确实跌过）', test: (s) => ok(s.mom20, (v) => v < 0) },
      { label: '距60日高回撤 ≥ 15%', test: (s) => ok(s.dd, (v) => v <= -0.15) },
      { label: 'RSI ≤ 50（超卖区）', test: (s) => ok(s.rsi, (v) => v <= 50) },
      { label: 'ATR ≤ 15%（不接崩盘股）', test: (s) => ok(s.atrp, (v) => v <= 0.15) },
    ],
  },

  /* 龙头战法：先限定在最强主线内部，再要求趋势完好 + 板块内领先 */
  dragon: {
    stage1: [
      { label: '所属主线排名 ≤ 10', test: (s) => ok(s.mainRank, (v) => v <= 10) },
      { label: '成交额 ≥ 2 亿', test: (s) => ok(s.amount, (v) => v >= 2e8) },
      { label: '换手率 ≥ 2%', test: (s) => ok(s.turnover, (v) => v >= 2) },
      { label: '市值 ≤ 800 亿', test: (s) => ok(s.mktCap, (v) => v <= 800e8) },
    ],
    stage2: [
      { label: '同行业龙头度 ≥ 60', test: (s) => ok(s.leader, (v) => v >= 60) },
      { label: '均线多头 = 3/3', test: (s) => isNum(s.maAlign) && s.maAlign >= 3 },
      { label: '20日动量 > 0', test: (s) => ok(s.mom20, (v) => v > 0) },
      { label: '量比 ≥ 1.0（放量）', test: (s) => ok(s.vr, (v) => v >= 1.0) },
      { label: '距60日高回撤 ≤ 15%', test: (s) => ok(s.dd, (v) => v >= -0.15) },
    ],
  },
};

export function strategyFilter(key) {
  return STRATEGY_FILTERS[key] || STRATEGY_FILTERS.balanced;
}

/** 候选不足这个数就逐级放宽过滤，保证任何行情下都能给出推荐 */
export const STRATEGY_MIN_KEEP = 5;

/**
 * 计算「同行业龙头度」：在同行业内按 20 日动量与量比做横截面分位，取均值 0~100。
 * 龙头战法用它区分「板块里最强的那只」与「板块里的跟风股」。
 * 调用前提：rows 必须已经合并过 K 线因子（mom20 / vr），否则一律中性 50。
 * 行业成分少于 5 只时不计算（分位无意义），统一给中性 50。
 * @param {Array} rows 股票数组（需含 code / industry / mom20 / vr）
 * @returns {Array} 新数组（每只带 leader），不修改入参
 */
export function computeLeader(rows) {
  const groups = new Map();
  for (const r of rows) {
    const ind = String(r.industry || '').trim();
    if (!ind) continue;
    let g = groups.get(ind);
    if (!g) { g = []; groups.set(ind, g); }
    g.push(r);
  }

  const leaderOf = new Map();
  for (const [, members] of groups) {
    if (members.length < 5) continue;
    const mom = members.map((m) => m.mom20).filter(isNum).sort((a, b) => a - b);
    const vr = members.map((m) => m.vr).filter(isNum).sort((a, b) => a - b);
    for (const m of members) {
      const a = pctRank(mom, m.mom20);
      const b = pctRank(vr, m.vr);
      leaderOf.set(m.code, Math.round(((a + b) / 2) * 10) / 10);
    }
  }

  return rows.map((r) => ({
    ...r,
    leader: leaderOf.has(r.code) ? leaderOf.get(r.code) : 50,
  }));
}

/** 升序数组里的百分位（0~100）；缺失返回 50 */
function pctRank(sorted, v) {
  const n = sorted.length;
  if (!n || !isNum(v)) return 50;
  let lo = 0;
  let hi = n;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  return n > 1 ? (lo / (n - 1)) * 100 : 50;
}

/** 依次跑一条过滤链，并把每一步记进 stats */
export function runFilterChain(rows, filters, stats) {
  let cur = rows;
  for (const f of filters || []) {
    const before = cur.length;
    cur = cur.filter(f.test);
    if (stats) stats.add(f.label, before, cur.length);
  }
  return cur;
}

/** 只跑 stage1（快照字段），供 K 线候选选样与「初筛候选」对比使用 */
export function applyStage1(rows, key, stats) {
  return runFilterChain(rows, strategyFilter(key).stage1, stats);
}

/** 只跑 stage2（K 线因子） */
export function applyStage2(rows, key, stats) {
  return runFilterChain(rows, strategyFilter(key).stage2, stats);
}

/**
 * stage2 保底放宽：因子门槛在极端行情下可能把池子清空。
 * 依次尝试 stage2 → stage1 → fallback（过主线的全集），取第一个满足 minKeep 的层级，
 * 并把「放宽」这一步如实记进过滤明细（removed 为负，UI 显示 +N）。
 * 宁可放宽也不给用户空结果。
 * @param {Array} stage2Rows 已过 stage2 的结果
 * @param {Array} stage1Rows 只过 stage1 的结果
 * @param {Array} fallbackRows 过主线门槛的全集
 * @returns {{rows:Array, relaxed:null|'stage2'|'stage1'}}
 */
export function relaxStage2(stage2Rows, stage1Rows, fallbackRows, stats, opt = {}) {
  const minKeep = opt.minKeep ?? STRATEGY_MIN_KEEP;
  if (stage2Rows.length >= minKeep) return { rows: stage2Rows, relaxed: null };

  if (stats) stats.add(`不足 ${minKeep} 只，放宽因子门槛`, stage2Rows.length, stage1Rows.length);
  if (stage1Rows.length >= minKeep) return { rows: stage1Rows, relaxed: 'stage2' };

  if (stats) stats.add(`仍不足 ${minKeep} 只，放宽策略门槛`, stage1Rows.length, fallbackRows.length);
  return { rows: fallbackRows, relaxed: 'stage1' };
}

/**
 * 对候选池做横截面标准化并打分。
 * @param {Array} rows 含 code + 因子字段（mom20/mom5/dd/trend/rsi/atrp/vr/mainScore[/leader]）
 * @param {string} strategyKey
 * @returns {Array} 每只带 score 与 factors(0~100)
 */
export function scoreCandidates(rows, strategyKey = 'balanced') {
  const strategy = getStrategy(strategyKey);
  const W = strategy.weights;
  const keys = Object.keys(W);

  // 构造 main 字段别名（mainScore → main）；leader 缺失时补中性 50
  const prepared = rows.map((r) => ({
    ...r,
    main: isFinite(r.mainScore) ? r.mainScore : 0,
    leader: isFinite(r.leader) ? r.leader : 50,
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
    const rk = isFinite(stock.mainRank) && stock.mainRank < 9999 ? `（第 ${stock.mainRank} 强）` : '';
    parts.push(`主线：<b>${stock.mainNames.slice(0, 2).join('、')}</b>${rk}`);
  }
  if (isFinite(stock.leader) && stock.leader >= 75) {
    parts.push(`同行业龙头度 <b>${stock.leader.toFixed(0)}</b>`);
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
