/* ============================================================
   strategy.js — 五策略定义 + 策略专属股票池过滤 + 打分 + 组合约束
   ------------------------------------------------------------
   设计要点：
   1. 每个策略有自己的「股票池过滤链」（STRATEGY_FILTERS），
      分 stage1（只用快照字段）/ stage2（需要 K 线因子）两段，
      从 universe.js 的基础池末端续接，因此五个策略的候选池互不相同。
   2. 过滤链带保底：若筛完不足 minKeep 只，逐级放宽，绝不给空结果。
   3. dragon（龙头战法）额外用全市场关注度、活跃度因子。
   ============================================================ */

import { crossSectionNormalize } from './indicators.js';
import { resolveFilterConfig, ruleLabel, evalRule } from './filters.js';

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
    desc: '全市场识别龙头：综合市场关注度与活跃度，兼顾趋势、成交量和换手率',
    // 波动率越低越好；其余因子均为越大越好
    reverseKeys: ['atrp'],
    weights: {
      mom20: 0.10,
      mom5: 0.05,
      dd: 0.05,
      trend: 0.15,
      rsi: 0.05,
      atrp: 0.05,
      vr: 0.10,
      main: 0.05,
      attention: 0.20,
      activity: 0.20,
    },
  },
  limitup: {
    key: 'limitup',
    name: '涨停板战法',
    desc: '只看高参与、高活跃的强势股：换手与成交额放大，已封板可排板买入，重点看早盘快速封板与尾盘异动',
    reverseKeys: ['atrp'],
    weights: {
      mom5: 0.05,
      trend: 0.05,
      vr: 0.05,
      main: 0.05,
      activity: 0.25,
      ztSeal: 0.15,
      ztTiming: 0.25,
      ztStreak: 0.10,
      atrp: 0.05,
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
  attention: '市场关注度',
  activity: '市场活跃度',
  leader: '全市场龙头度',
  ztSeal: '封板强度',
  ztTiming: '早盘/尾盘异动',
  ztStreak: '连板高度',
  ztHeat: '涨停热度',
};

/** 带策略语境的因子名：该策略下反向的因子补上「(反向)」 */
export function factorLabel(key, strategyKey) {
  const base = FACTOR_LABELS[key] || key;
  const st = getStrategy(strategyKey);
  return (st.reverseKeys || []).includes(key) ? base + '(反向)' : base;
}

/**
 * 按因子权重自动生成「本次评分策略」说明（唯一真值源：STRATEGIES[key].weights）。
 * 策略权重一旦调整，说明文字自动跟着变，不会出现文字与实际打分不一致。
 * @param {string} strategyKey
 * @returns {string} 例如「均衡多因子：20日动量20% + 趋势强度20% + …。适合震荡与结构市」
 */
export function strategyWeightText(strategyKey) {
  const st = getStrategy(strategyKey);
  const w = st.weights || {};
  const parts = Object.keys(w)
    .sort((a, b) => (w[b] || 0) - (w[a] || 0))
    .map((k) => `${factorLabel(k, st.key)}${Math.round((w[k] || 0) * 100)}%`);
  return `${st.name}：${parts.join(' + ')}。${st.desc || ''}`;
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

/** 默认上下文：单只预算按 5 万本金 / 最多 5 只 / 进攻档 80% 仓位估算 */
const DEFAULT_CTX = { budgetPerStock: 8000, topN: 20 };

/** 默认配置（单一定义源：filters.js 的 STAGE_RULE_DEFAULTS） */
const DEFAULT_FILTER_CFG = resolveFilterConfig(null, {});

/** 把声明式规则编译成旧的 {label, test} 形式，runFilterChain 直接可用 */
function rulesToFilters(rules, ctx) {
  const c = ctx || DEFAULT_CTX;
  return (rules || [])
    .filter((r) => r.on !== false)
    .map((r) => ({ label: ruleLabel(r, c), test: (s) => evalRule(r, s, c) }));
}

function compileDefaults(key) {
  const list = DEFAULT_FILTER_CFG.strategies[key] || DEFAULT_FILTER_CFG.strategies.balanced;
  return {
    stage1: rulesToFilters(list.stage1, DEFAULT_CTX),
    stage2: rulesToFilters(list.stage2, DEFAULT_CTX),
  };
}

/**
 * 各策略「默认」专属过滤链（由 filters.js 的默认规则编译而来）。
 * 保持 {stage1:[{label,test}], stage2:[...]} 的既有形状，供自测与外部读取。
 * 用户改过设置后，实际生效的是 strategyFilter(key, filterConfig, ctx) 的返回值。
 */
export const STRATEGY_FILTERS = {
  balanced: compileDefaults('balanced'),
  momentum: compileDefaults('momentum'),
  reversal: compileDefaults('reversal'),
  dragon: compileDefaults('dragon'),
  limitup: compileDefaults('limitup'),
};

/**
 * 取某策略的专属过滤链。
 * @param {string} key 策略 key
 * @param {object} [cfg] 已解析的 filterConfig（filters.js resolveFilterConfig 的输出）；
 *                       省略时返回代码默认值，与旧行为完全一致
 * @param {object} [ctx] { budgetPerStock, topN }
 * @returns {{stage1:Array, stage2:Array}} 每项为 {label, test}
 */
export function strategyFilter(key, cfg, ctx) {
  const k = STRATEGY_FILTERS[key] ? key : 'balanced';
  if (!cfg || !cfg.strategies) return STRATEGY_FILTERS[k];
  const list = cfg.strategies[k] || cfg.strategies.balanced;
  if (!list) return STRATEGY_FILTERS[k];
  const c = ctx || DEFAULT_CTX;
  return {
    stage1: rulesToFilters(list.stage1, c),
    stage2: rulesToFilters(list.stage2, c),
  };
}

/** 某策略当前生效的规则清单（设置页编辑器用，返回规则对象而非编译后的闭包） */
export function strategyRules(key, cfg) {
  const k = STRATEGY_FILTERS[key] ? key : 'balanced';
  const src = cfg && cfg.strategies ? cfg.strategies[k] || cfg.strategies.balanced : null;
  const fallback = DEFAULT_FILTER_CFG.strategies[k] || DEFAULT_FILTER_CFG.strategies.balanced;
  const list = src || fallback;
  return { stage1: list.stage1 || [], stage2: list.stage2 || [] };
}

/** 候选不足这个数就逐级放宽过滤，保证任何行情下都能给出推荐 */
export const STRATEGY_MIN_KEEP = 5;

/**
 * 按完整市场快照计算关注度、活跃度和综合龙头度；rows 只包含需要返回分数的候选。
 * 关注度由主线排名、主线强度和主力净流入构成；活跃度由换手率、成交额和量比构成。
 * @param {Array} rows 需评分的候选
 * @param {Array} [marketRows=rows] 全市场快照（需含主线标注与快照字段）
 * @returns {Array} 新数组（每只带 attention / activity / leader），不修改入参
 */
export function computeLeader(rows, marketRows = rows) {
  const distributions = {
    mainRank: marketRows.map((r) => r.mainRank)
      .filter((v) => isNum(v) && v > 0 && v < 9999).sort((a, b) => a - b),
    mainScore: marketRows.map((r) => r.mainScore)
      .filter((v) => isNum(v) && v > -999).sort((a, b) => a - b),
    mainInflow: marketRows.map((r) => r.mainInflow).filter(isNum).sort((a, b) => a - b),
    turnover: marketRows.map((r) => r.turnover).filter(isNum).sort((a, b) => a - b),
    amount: marketRows.map((r) => r.amount).filter(isNum).sort((a, b) => a - b),
    volRatio: marketRows.map((r) => r.volRatio).filter(isNum).sort((a, b) => a - b),
  };
  const rank = (row, key, invert = false) => {
    const value = row[key];
    if (!isNum(value)
      || (key === 'mainRank' && (value <= 0 || value >= 9999))
      || (key === 'mainScore' && value <= -999)) return 50;
    const score = pctRank(distributions[key], value);
    return invert ? 100 - score : score;
  };

  return rows.map((r) => {
    const attention = rank(r, 'mainRank', true) * 0.35
      + rank(r, 'mainScore') * 0.35
      + rank(r, 'mainInflow') * 0.30;
    const activity = rank(r, 'turnover') * 0.35
      + rank(r, 'amount') * 0.35
      + rank(r, 'volRatio') * 0.30;
    return {
      ...r,
      attention: Math.round(attention * 10) / 10,
      activity: Math.round(activity * 10) / 10,
      leader: Math.round((attention * 0.55 + activity * 0.45) * 10) / 10,
    };
  });
}

/** 东财涨停池时间字段（如 93000 / 145512）→ HHMM 数值 */
function hhmmOf(t) {
  const n = Number(t);
  if (!isNum(n) || n <= 0) return NaN;
  return Math.floor(n / 100);
}

/**
 * 早盘 / 尾盘异动打分（0~100）。
 *   早盘：首次封板越早越强（9:30~10:00 满分，10:30 前较强，之后递减）
 *   尾盘：最后封板或尾盘拉升在 14:30 以后视为尾盘异动
 *   未封板：当日涨幅 ≥ 7% 且量比放大，按「临近涨停的异动」给中等分
 */
export function ztTimingScore(s) {
  const first = hhmmOf(s.ztFirst);
  const last = hhmmOf(s.ztLast);
  let early = 0;
  if (isNum(first)) {
    if (first <= 1000) early = 100;
    else if (first <= 1030) early = 85;
    else if (first <= 1130) early = 60;
    else if (first <= 1400) early = 40;
    else early = 30;
  }
  let tail = 0;
  if (isNum(last) && last >= 1430) tail = 90;
  if (isNum(first) && first >= 1430) tail = 100; // 尾盘直线封板
  let near = 0;
  if (!s.sealed && isNum(s.chgPct) && s.chgPct >= 7) {
    near = 50 + Math.min(30, (isNum(s.volRatio) ? s.volRatio - 1 : 0) * 15);
  }
  // 封板后多次炸板说明分歧大，扣分
  const breaks = isNum(Number(s.ztBreaks)) ? Number(s.ztBreaks) : 0;
  return Math.max(0, Math.max(early, tail, near) - breaks * 10);
}

/**
 * 涨停板战法因子：活跃度（换手/成交额/量比全市场分位）、封板强度、早尾盘异动、连板高度。
 * @param {Array} rows 待评分候选
 * @param {Array} marketRows 全市场快照（做分位基准）
 * @param {object} ztPool fetchLimitPool('up') 的结果
 * @returns {Array} 新数组
 */
export function computeLimitUp(rows, marketRows = rows, ztPool = null) {
  const zt = new Map();
  for (const p of (ztPool && ztPool.pool) || []) if (p && p.c) zt.set(String(p.c), p);
  const withAct = computeLeader(rows, marketRows);
  return withAct.map((r) => {
    const p = zt.get(r.code);
    const s = {
      ...r,
      sealed: !!p || !!r.sealed,
      ztFirst: p ? p.fbt : r.ztFirst,
      ztLast: p ? p.lbt : r.ztLast,
      ztBreaks: p ? Number(p.zbc) || 0 : 0,
      ztStreak: p ? Number(p.lbc) || 1 : 0,
    };
    // 封单额 / 流通市值（‰），无封单数据时按是否封板给中性分
    const fund = p ? Number(p.fund) : NaN;
    const cap = isNum(r.floatCap) ? r.floatCap : (p ? Number(p.ltsz) : NaN);
    s.ztSeal = isNum(fund) && isNum(cap) && cap > 0
      ? Math.min(100, (fund / cap) * 1000 * 20)
      : (s.sealed ? 50 : 0);
    s.ztTiming = ztTimingScore(s);
    s.ztHeat = Math.round((s.activity * 0.5 + s.ztTiming * 0.3 + s.ztSeal * 0.2) * 10) / 10;
    return s;
  });
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
  let end = lo;
  while (end < n && sorted[end] === v) end++;
  const rank = end > lo ? (lo + end - 1) / 2 : lo;
  return n > 1 ? (rank / (n - 1)) * 100 : 50;
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
export function applyStage1(rows, key, stats, cfg, ctx) {
  return runFilterChain(rows, strategyFilter(key, cfg, ctx).stage1, stats);
}

/** 只跑 stage2（K 线因子） */
export function applyStage2(rows, key, stats, cfg, ctx) {
  return runFilterChain(rows, strategyFilter(key, cfg, ctx).stage2, stats);
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

  // 构造 main 字段别名（mainScore → main）；快照因子缺失时补中性 50
  const prepared = rows.map((r) => ({
    ...r,
    main: isFinite(r.mainScore) ? r.mainScore : 0,
    leader: isFinite(r.leader) ? r.leader : 50,
    attention: isFinite(r.attention) ? r.attention : 50,
    activity: isFinite(r.activity) ? r.activity : 50,
    ztSeal: isFinite(r.ztSeal) ? r.ztSeal : 0,
    ztTiming: isFinite(r.ztTiming) ? r.ztTiming : 0,
    ztStreak: isFinite(r.ztStreak) ? r.ztStreak : 0,
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
    parts.push(`全市场龙头度 <b>${stock.leader.toFixed(0)}</b>`);
  }
  if (isFinite(stock.attention) && stock.attention >= 75) {
    parts.push(`市场关注度 <b>${stock.attention.toFixed(0)}</b>`);
  }
  if (isFinite(stock.activity) && stock.activity >= 75) {
    parts.push(`市场活跃度 <b>${stock.activity.toFixed(0)}</b>`);
  }
  if (stock.sealed) {
    const st = stock.ztStreak > 1 ? `${stock.ztStreak} 连板` : '首板';
    parts.push(`已封板（<b>${st}</b>），可排板买入`);
  }
  if (isFinite(stock.ztTiming) && stock.ztTiming >= 80) {
    parts.push(`<b>${hhmmOf(stock.ztFirst) >= 1430 || hhmmOf(stock.ztLast) >= 1430 ? '尾盘' : '早盘'}异动</b>`);
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
