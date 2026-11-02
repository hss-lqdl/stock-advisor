/* ============================================================
   engine.js — 编排层：拉数据 → 建池 → 主线 → 大盘 → 因子 → 打分 → 计划
   ============================================================ */

import {
  fetchSnapshot, fetchBoards, fetchIndexKline, fetchLimitPool,
  fetchQuotes, fetchKlines, ymd, klineQuality, F_SNAP_LITE,
} from './api.js';
import {
  buildUniverse, poolToMap, limitPrices,
} from './universe.js';
import { analyzeMainline, annotatePool, mainlineTrend } from './mainline.js';
import { analyzeMarket, levelByScore } from './market.js';
import { computeFactors } from './indicators.js';
import { scoreCandidates, applyPortfolioConstraints, buildReason } from './strategy.js';
import { buildDailyPlan } from './plan.js';
import {
  settingsLoad, snapshotSaveAll, snapshotLoadAll, boardsSaveAll, boardsLoadAll,
  klinesSaveMany, klinesGetMany, klinesCount, klineAppendToday,
  boardDailySave, planSave, metaGet, metaSet,
} from './store.js';

/** 拉 K 线的候选上限（平衡流量与覆盖面） */
export const KLINE_CAP = 180;
/**
 * 单次拉 K 线根数。
 * 用 250 而不是 130：push2his 一次就返回完整一年窗口，多要 120 根只多约 3 KB gzip，
 * 但让 MA60 / 60 日回撤 / 20 日动量 / 回测（需要 refKl.n ≥ 90）都有充足样本。
 */
export const KLINE_LEN = 250;
/** 缓存里少于这个根数就视为旧版残缺缓存，强制重拉 */
const KLINE_MIN_ACCEPT = 200;

/** 判断是否交易时段 */
export function marketPhase(now = new Date()) {
  const d = now.getDay();
  if (d === 0 || d === 6) return 'weekend';
  const m = now.getHours() * 60 + now.getMinutes();
  if (m < 9 * 60 + 15) return 'pre';
  if (m < 9 * 60 + 30) return 'auction';
  if (m < 11 * 60 + 30) return 'morning';
  if (m < 13 * 60) return 'lunch';
  if (m < 14 * 60 + 55) return 'afternoon';
  if (m < 15 * 60) return 'tail';        // 14:55-15:00 尾盘集合竞价
  return 'closed';
}

/** 距离尾盘窗口开始的毫秒数（负数表示已进入/已过） */
export function msToTail(now = new Date()) {
  const t = new Date(now);
  t.setHours(14, 55, 0, 0);
  return t.getTime() - now.getTime();
}

/* ---------------- 数据加载 ---------------- */

/**
 * 全量刷新（冷启动 / 手动刷新）。
 * @param {object} opt { onProgress, forceBoards, settings }
 */
export async function loadAll(opt = {}) {
  const onProgress = opt.onProgress || (() => {});
  const settings = opt.settings || (await settingsLoad());
  const dateStr = ymd();

  const t0 = Date.now();

  // 1. 全市场快照
  onProgress({ phase: 'snapshot', pct: 2, text: '拉取全市场行情…' });
  const rows = await fetchSnapshot({
    fields: F_SNAP_LITE + ',f9,f10,f23,f21,f62,f100,f103',
    limit: 6,
    onPage: (done, total) => {
      onProgress({
        phase: 'snapshot',
        pct: 2 + (done / total) * 38,
        text: `拉取全市场行情 ${done}/${total} 页`,
      });
    },
  });
  if (!rows.length) throw new Error('全市场行情为空，请检查网络');
  onProgress({ phase: 'snapshot', pct: 40, text: `已获取 ${rows.length} 只股票` });

  // 2. 板块
  onProgress({ phase: 'boards', pct: 42, text: '拉取概念与行业板块…' });
  const boards = await fetchBoards({ limit: 6 });
  onProgress({ phase: 'boards', pct: 56, text: `已获取 ${boards.length} 个板块` });

  // 3. 指数 K 线 + 涨跌停池（并行）
  onProgress({ phase: 'index', pct: 58, text: '拉取指数与涨跌停数据…' });
  const [indexKl, ztPool, dtPool] = await Promise.all([
    fetchIndexKline('1.000001', 250).catch(() => null),
    fetchLimitPool('up', dateStr).catch(() => ({ total: 0, pool: [] })),
    fetchLimitPool('down', dateStr).catch(() => ({ total: 0, pool: [] })),
  ]);
  onProgress({ phase: 'index', pct: 64, text: '指数与涨跌停数据就绪' });

  // 4. 建池
  const { pool, stats } = buildUniverse(rows, settings);
  onProgress({ phase: 'pool', pct: 66, text: `股票池 ${pool.length} 只` });

  // 5. 主线
  const ml = analyzeMainline(boards);
  const { qualified, stats: mlStats } = annotatePool(pool, ml);
  onProgress({
    phase: 'mainline', pct: 70,
    text: `主线 ${ml.top.length} 个，过门槛 ${qualified.length} 只`,
  });

  // 6. 拉 K 线（优先按主线分排序，限制上限）
  const want = qualified.slice(0, KLINE_CAP);
  const codes = want.map((s) => s.code);
  const cachedRaw = await klinesGetMany(codes);

  // 旧版缓存里可能是 push2test 的残缺 K 线（缺 bar / 根数不足），必须淘汰重拉，
  // 否则用户升级后看到的仍是算错的 MA60 与回撤。
  const cached = new Map();
  const stale = [];
  for (const [code, kl] of cachedRaw) {
    const q = klineQuality(kl);
    if (q.ok) cached.set(code, kl);
    else stale.push(code);
  }
  const missing = codes.filter((c) => !cached.has(c));

  onProgress({
    phase: 'kline', pct: 72,
    text: missing.length
      ? `补拉 K 线 ${missing.length} 只${stale.length ? `（淘汰残缺缓存 ${stale.length} 只）` : ''}…`
      : `K 线全部命中缓存 ${cached.size} 只`,
  });

  if (missing.length) {
    const fetched = await fetchKlines(missing, KLINE_LEN, {
      limit: 6,
      onProgress: (done, total) => {
        onProgress({
          phase: 'kline',
          pct: 72 + (done / total) * 20,
          text: `拉取 K 线 ${done}/${total}`,
        });
      },
    });
    // 只接受质量合格的 K 线，残缺的宁可不入库也不污染因子计算
    const good = new Map();
    for (const [k, v] of fetched) {
      if (klineQuality(v).ok) good.set(k, v);
    }
    if (good.size) {
      await klinesSaveMany(good);
      for (const [k, v] of good) cached.set(k, v);
    }
  }

  // 7. 用当日快照补齐今日未完成 bar
  const poolMap = poolToMap(pool);
  for (const [code, kl] of cached) {
    const s = poolMap.get(code);
    if (!s || !isFinite(s.open) || !isFinite(s.price)) continue;
    klineAppendToday(kl, dateStr, s.open, s.high, s.low, s.price, s.vol);
  }
  onProgress({ phase: 'kline', pct: 92, text: 'K 线就绪' });

  // 8. 落库
  const state = {
    dateStr,
    rows,
    pool,
    poolStats: stats,
    boards,
    ml,
    mlStats,
    indexKl,
    ztPool,
    dtPool,
    klines: cached,
    settings,
    loadedAt: Date.now(),
    elapsed: Date.now() - t0,
  };

  // 异步保存，不阻塞
  snapshotSaveAll(rows).catch(() => {});
  boardsSaveAll(boards).catch(() => {});
  boardDailySave(dateStr, ml.top.map((b) => ({
    name: b.name, score: b.score, f3: b.f3, f109: b.f109,
  }))).catch(() => {});
  metaSet('lastLoad', { dateStr, at: Date.now(), pool: pool.length }).catch(() => {});

  onProgress({ phase: 'done', pct: 100, text: '数据加载完成' });
  return state;
}

/**
 * 轻量刷新：只刷候选池行情（尾盘模式用），K 线走缓存。
 * @param {object} state 上一次的 state
 */
export async function refreshPoolOnly(state, opt = {}) {
  const onProgress = opt.onProgress || (() => {});
  const dateStr = ymd();
  const pool = state.pool;
  if (!pool || !pool.length) throw new Error('股票池为空，请先全量刷新');

  onProgress({ phase: 'quotes', pct: 10, text: '刷新候选池行情…' });
  const codes = pool.map((s) => s.code);
  const quotes = await fetchQuotes(codes, F_SNAP_LITE + ',f9,f10,f62,f100,f103', {
    limit: 5,
    onProgress: (done, total) => {
      onProgress({
        phase: 'quotes',
        pct: 10 + (done / total) * 60,
        text: `刷新行情 ${done}/${total}`,
      });
    },
  });

  // 用新行情覆盖 pool 中的实时字段
  const qmap = new Map();
  for (const q of quotes) qmap.set(String(q.f12), q);

  const nextPool = [];
  for (const s of pool) {
    const q = qmap.get(s.code);
    if (!q) { nextPool.push(s); continue; }
    nextPool.push({
      ...s,
      price: typeof q.f2 === 'number' ? q.f2 : s.price,
      chgPct: typeof q.f3 === 'number' ? q.f3 : s.chgPct,
      vol: typeof q.f5 === 'number' ? q.f5 : s.vol,
      amount: typeof q.f6 === 'number' ? q.f6 : s.amount,
      turnover: typeof q.f8 === 'number' ? q.f8 : s.turnover,
      high: typeof q.f15 === 'number' ? q.f15 : s.high,
      low: typeof q.f16 === 'number' ? q.f16 : s.low,
      open: typeof q.f17 === 'number' ? q.f17 : s.open,
      prevClose: typeof q.f18 === 'number' ? q.f18 : s.prevClose,
      mktCap: typeof q.f20 === 'number' ? q.f20 : s.mktCap,
      mainInflow: typeof q.f62 === 'number' ? q.f62 : s.mainInflow,
      industry: q.f100 || s.industry,
      concepts: q.f103 || s.concepts,
    });
  }

  // 更新今日 bar
  const poolMap = poolToMap(nextPool);
  for (const [code, kl] of state.klines) {
    const s = poolMap.get(code);
    if (!s || !isFinite(s.open) || !isFinite(s.price)) continue;
    klineAppendToday(kl, dateStr, s.open, s.high, s.low, s.price, s.vol);
  }

  onProgress({ phase: 'done', pct: 100, text: '行情刷新完成' });

  return { ...state, pool: nextPool, dateStr, refreshedAt: Date.now() };
}

/* ---------------- 计算 ---------------- */

/**
 * 从 state 计算完整分析结果（纯计算，无网络）。
 * @param {object} state
 * @param {object} opt { strategy, capital, maxPicks }
 */
export function analyze(state, opt = {}) {
  const settings = { ...state.settings, ...(opt.settings || {}) };
  const strategy = opt.strategy || settings.strategy || 'balanced';
  const capital = opt.capital || settings.capital || 50000;

  // 1. 大盘
  const market = analyzeMarket({
    indexKl: state.indexKl,
    snapshot: state.rows,
    ztPool: state.ztPool,
    dtPool: state.dtPool,
  });
  const level = market.level;

  // 2. 主线
  const ml = state.ml;
  const { qualified, stats: mlStats } = annotatePool(state.pool, ml);

  // 3. 因子
  const withFactors = [];
  for (const s of qualified) {
    const kl = state.klines.get(s.code);
    if (!kl) continue;
    const f = computeFactors(kl);
    if (!f) continue;
    withFactors.push({
      ...s,
      ...f,
      mainScore: s.mainScore,
    });
  }

  // 4. 打分
  const scored = scoreCandidates(withFactors, strategy);

  // 5. 组合约束
  const maxPicks = Math.min(opt.maxPicks || settings.maxPicks || 5, level.picks);
  const picks = applyPortfolioConstraints(scored, maxPicks, {
    maxPerIndustry: 2,
    maxPerBoard: 2,
  });

  // 6. 买入计划
  const plan = buildDailyPlan(picks, {
    capital,
    level,
    klines: state.klines,
  });

  // 补入选理由
  for (const it of plan.items) {
    const src = picks.find((p) => p.code === it.code);
    if (src) it.reason = buildReason(src);
  }

  // 7. 主线趋势
  const trend = mainlineTrend(ml, []);

  return {
    dateStr: state.dateStr,
    market,
    level,
    ml,
    mlStats,
    poolStats: state.poolStats,
    qualifiedCount: qualified.length,
    factorCount: withFactors.length,
    scored,
    picks,
    plan,
    trend,
    strategy,
    capital,
    loadedAt: state.loadedAt,
    refreshedAt: state.refreshedAt || state.loadedAt,
  };
}

/**
 * 一键完整流程：加载 + 分析 + 落库计划
 */
export async function runFull(opt = {}) {
  const state = await loadAll(opt);
  const result = analyze(state, opt);
  if (result.plan && result.plan.items.length) {
    await planSave(state.dateStr, {
      items: result.plan.items.map((x) => ({
        code: x.code, name: x.name, bid: x.bid, shares: x.shares,
        stop: x.stop, tp1: x.tp1, tp2: x.tp2, price: x.price,
      })),
      level: result.level.key,
      score: result.market.score,
      totalAmount: result.plan.totalAmount,
      capital: result.capital,
    }).catch(() => {});
  }
  return { state, result };
}

/* ---------------- 离线恢复 ---------------- */

/** 尝试从 IndexedDB 恢复上次的数据（离线可用） */
export async function restoreFromCache() {
  const rows = await snapshotLoadAll();
  if (!rows || !rows.length) return null;
  const boards = await boardsLoadAll();
  const last = await metaGet('lastLoad', null);
  return { rows, boards, last };
}
