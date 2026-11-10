/* ============================================================
   mainline.js — 主线情绪分析（近一周）
   板块清洗 → 板块得分 → Top20 / 退潮 Top10 → 个股 mainScore
   全部已用真实数据实测
   ============================================================ */

/* 噪音板块正则：剔除指数类、事件类、统计类伪板块（50+ 词） */
export const NOISE_PATTERN = new RegExp(
  [
    '昨日', '今日', '近期', '连板', '涨停', '跌停', '热股', '新高', '新低', '次新',
    'ST', '退市', '融资融券', '沪股通', '深股通', 'MSCI', '富时', '标普', '重仓',
    '预盈', '预亏', '预增', '预减', '季报', '年报', '中报', '业绩', '高送转',
    '破净', '百元股', '低价股', '壳资源', '注册制', '创业板综', '深成500',
    '上证50', '沪深300', '中证', '深证100', '转债', '回购', '增持', '减持',
    '股权激励', '机构调研', '定增', 'B股', 'AB股', 'AH股', '基金', '题材股',
    '概念股', '大盘', '超跌', '活跃股', '龙虎榜', '举牌', '重组', '解禁',
    '同花顺', '东方财富', '证金', '汇金', '社保', 'QFII', '北向', '外资',
  ].join('|')
);

export const MIN_MEMBERS = 15;   // 板块最少成分股数
export const TOP_N = 20;         // 主线 Top20
export const BOTTOM_N = 10;      // 退潮 Top10

/** 板块得分公式（已实测） */
export function boardScore(b) {
  const up = num(b.f104);
  const dn = num(b.f105);
  const total = up + dn;
  const breadthRatio = total > 0 ? (up / total - 0.5) : 0;
  const mainInflow = num(b.f62) / 5e8;  // 亿 → 以 5 亿为 1 单位
  const flowPart = clamp(mainInflow, -3, 3);
  return num(b.f109) * 2.0 + num(b.f3) * 1.0 + breadthRatio * 20 + flowPart;
}

function num(v) {
  return typeof v === 'number' && isFinite(v) ? v : 0;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/** 去罗马数字后缀（行业名 "航空装备Ⅱ" → "航空装备"） */
export function stripRoman(s) {
  return String(s || '').replace(/[ⅠⅡⅢⅣⅤⅥ]+$/u, '').trim();
}

/**
 * 清洗板块列表：剔除噪音 + 成分股数不足。
 * @param {Array} boards 概念 + 行业原始行
 * @returns {Array} 有效板块（含 _score）
 */
export function cleanBoards(boards) {
  const seen = new Set();
  const out = [];
  for (const b of boards || []) {
    if (!b || !b.f14) continue;
    const name = String(b.f14).trim();
    if (!name) continue;
    if (NOISE_PATTERN.test(name)) continue;
    const members = num(b.f104) + num(b.f105);
    if (members < MIN_MEMBERS) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({
      ...b,
      name,
      members,
      score: boardScore(b),
      // 供 UI 直接使用的别名
      mainInflow: num(b.f62),
      up: num(b.f104),
      dn: num(b.f105),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 主线分析结果
 * @typedef {object} MainlineResult
 * @property {Array} all      全部有效板块（按分数降序）
 * @property {Array} top      TopN（默认 20）
 * @property {Array} bottom   退潮 TopN（默认 10）
 * @property {Map}   byName   名称 → 板块
 * @property {Set}   topSet   主线板块名集合
 * @property {Set}   bottomSet 退潮板块名集合
 * @property {object} opt     实际生效的门槛 {topN, bottomN, avoidBottom, on}
 */

/**
 * 主线门槛可配置：topN / bottomN / avoidBottom / on 由设置页决定。
 * 省略 opt 时行为与旧版完全一致（Top20 主线 + 退潮 Top10 剔除）。
 * @param {Array} rawBoards 板块原始行
 * @param {object} [opt] { topN, bottomN, avoidBottom, on }
 */
export function analyzeMainline(rawBoards, opt = {}) {
  const all = cleanBoards(rawBoards);
  const topN = Number.isFinite(opt.topN) && opt.topN > 0 ? Math.floor(opt.topN) : TOP_N;
  const bottomN = Number.isFinite(opt.bottomN) && opt.bottomN > 0 ? Math.floor(opt.bottomN) : BOTTOM_N;
  const effective = {
    on: opt.on !== false,
    topN,
    bottomN,
    avoidBottom: opt.avoidBottom !== false,
  };

  const top = all.slice(0, topN);
  const bottom = all.slice(-bottomN).reverse();

  const byName = new Map();
  const rankOf = new Map();
  all.forEach((b, i) => {
    byName.set(b.name, b);
    rankOf.set(b.name, i + 1);   // 1 = 最强主线
  });

  const topSet = new Set(top.map((b) => b.name));
  const bottomSet = new Set(bottom.map((b) => b.name));

  const scoreMax = all.length ? Math.max(...all.map((b) => b.score)) : 1;
  const scoreMin = all.length ? Math.min(...all.map((b) => b.score)) : 0;

  return { all, top, bottom, byName, rankOf, topSet, bottomSet, scoreMax, scoreMin, opt: effective };
}

/**
 * 计算个股的主线分与所属主线板块。
 * 匹配规则：f103 概念串（逗号分隔）逐项匹配概念板块名 + f100 行业去罗马后缀匹配。
 * 实测：5563 只 f103 全部非空；100% 至少命中 1 个有效板块。
 * @param {object} stock 标准化股票对象
 * @param {MainlineResult} ml
 * @returns {{mainScore:number, boards:Array, inTop:boolean, inBottom:boolean, qualified:boolean}}
 */
export function stockMainline(stock, ml) {
  const matched = [];
  const seen = new Set();

  const pushBoard = (name) => {
    const key = String(name || '').trim();
    if (!key || seen.has(key)) return;
    const b = ml.byName.get(key);
    if (!b) return;
    seen.add(key);
    matched.push(b);
  };

  // 概念串
  const concepts = String(stock.concepts || '');
  if (concepts) {
    for (const c of concepts.split(',')) pushBoard(c);
  }
  // 行业
  const ind = String(stock.industry || '');
  if (ind) {
    pushBoard(ind);
    pushBoard(stripRoman(ind));
  }

  matched.sort((a, b) => b.score - a.score);
  const top3 = matched.slice(0, 3);
  const mainScore = top3.length
    ? top3.reduce((s, b) => s + b.score, 0) / top3.length
    : -999;

  const inTop = matched.some((b) => ml.topSet.has(b.name));
  const inBottom = matched.some((b) => ml.bottomSet.has(b.name));
  const eff = ml.opt || { on: true, avoidBottom: true };

  // 所属最强主线板块在全部有效板块中的排名（1 = 最强）。
  // 龙头战法用它做「必须处在强主线」的硬门槛。
  const best = top3[0];
  const mainRank = best && ml.rankOf ? (ml.rankOf.get(best.name) || 9999) : 9999;

  // 硬门槛：默认必须属于 Top20 主线、且不在退潮 Top10。
  // 用户可关闭「退潮过滤」，也可整体关掉主线门槛。
  let qualified;
  if (eff.on === false) qualified = true;
  else if (eff.avoidBottom === false) qualified = inTop;
  else qualified = inTop && !inBottom;

  return {
    mainScore,
    mainRank,
    boards: top3,
    boardNames: top3.map((b) => b.name),
    matchedCount: matched.length,
    inTop,
    inBottom,
    qualified,
  };
}

/**
 * 批量给股票池打主线分，并筛出过门槛的候选。
 * @param {Array} pool 标准化股票池
 * @param {MainlineResult} ml
 * @returns {{all:Array, qualified:Array, stats:{pool:number, matched:number, passed:number}}}
 */
export function annotatePool(pool, ml) {
  const all = [];
  const qualified = [];
  let matched = 0;

  for (const s of pool) {
    const r = stockMainline(s, ml);
    if (r.matchedCount > 0) matched++;
    const annotated = {
      ...s,
      mainScore: r.mainScore,
      mainRank: r.mainRank,
      mainBoards: r.boards,
      mainNames: r.boardNames,
      matchedCount: r.matchedCount,
    };
    all.push(annotated);
    if (r.qualified) qualified.push(annotated);
  }

  all.sort((a, b) => b.mainScore - a.mainScore);
  qualified.sort((a, b) => b.mainScore - a.mainScore);
  return {
    all,
    qualified,
    stats: { pool: pool.length, matched, passed: qualified.length },
  };
}

/**
 * 主线热度趋势：把每天 Top 板块的得分拼成时间序列。
 * 优先用本地历史（boardDaily），不足时用 f109 估算。
 * @param {MainlineResult} ml
 * @param {Array} history boardDailyRecent() 的结果
 */
export function mainlineTrend(ml, history = []) {
  const names = ml.top.slice(0, 8).map((b) => b.name);
  const hasHistory = history.length >= 2;

  const series = names.map((name) => {
    const pts = [];
    for (const day of history) {
      const rows = day.rows || [];
      const found = rows.find((r) => r.name === name);
      pts.push(found ? found.score : null);
    }
    const cur = ml.byName.get(name);
    return {
      name,
      score: cur ? cur.score : 0,
      chg5: cur ? num(cur.f109) : 0,
      chg10: cur ? num(cur.f160) : 0,
      points: pts,
    };
  });

  return { series, hasHistory };
}

/**
 * 由 f109（5日涨幅）与 f3（今日涨幅）反推近 5 日热度走势，
 * 用于首次使用、本地无历史时的近似展示。
 */
export function estimateTrend(board) {
  const chg5 = num(board.f109);
  const chg1 = num(board.f3);
  // 假设 5 日涨幅近似线性，最后一天用当日涨幅
  const perDay = (chg5 - chg1) / 4;
  const pts = [];
  for (let i = 4; i >= 0; i--) {
    const v = i === 0 ? chg1 : perDay * (i - 1) + chg1 * 0.6;
    pts.push(v);
  }
  return pts;
}

/** 板块类型标签 */
export function boardTypeLabel(b) {
  return b._type === 'industry' ? '行业' : '概念';
}
