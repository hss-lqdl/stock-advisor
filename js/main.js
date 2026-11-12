/* ============================================================
   main.js — 应用编排：启动 / 数据刷新 / Tab 切换 / 尾盘轮询 /
             个股详情弹层 / Service Worker 注册
   这是唯一的「有状态」模块，其余模块都是纯函数或纯视图。
   ============================================================ */

import { fetchIndexes, fetchQuotes, ymd } from './api.js';
import {
  loadAll, refreshPoolOnly, analyze, rebuildPool, marketPhase, isTradingDate, msToTail,
} from './engine.js';
import { settingsLoad, metaGet, metaSet, klinesGet } from './store.js';
import { computeFactors } from './indicators.js';
import {
  $, el, toast, showProgress, hideProgress, openSheet, closeSheet,
  copyText, nowHHMMSS, fmtInt, fmtPctRaw, updown,
} from './ui.js';
import { drawKline } from './charts.js';
import { FACTOR_LABELS, factorLabel, getStrategy } from './strategy.js';
import { TAIL_WINDOW_TEXT } from './constants.js';
import { renderToday } from './views/today.js';
import { renderMainline } from './views/mainline.js';
import { renderPicks } from './views/picks.js';
import { renderPositions } from './views/positions.js';
import { renderSettings } from './views/settings.js';

/* ---------------- 全局状态 ---------------- */

const S = {
  state: null,          // engine 的原始 state（含 klines Map）
  result: null,         // analyze() 的结果
  indexes: [],          // 指数行情
  settings: null,
  loading: false,
  error: '',
  tab: 'today',
  quotes: new Map(),    // 持仓 Tab 用的实时行情
  tailTimer: null,
  tailRefreshing: false,
  lastTailAt: 0,
  booted: false,
};

const SLIM_KEY = 'slimResult';
const IDX_KEY = 'slimIndexes';

/* ---------------- 启动 ---------------- */

async function boot() {
  setClock();
  setInterval(setClock, 1000);

  // 0) Service Worker 立刻注册：与数据加载无关。
  //    早期放在 reload() 之后，首次冷启动（无缓存 + 上游慢）时 SW 要等全量
  //    行情拉完才注册，期间既不能离线打开也无法「添加到主屏幕」，实测踩过。
  registerSW();

  try {
    S.settings = await settingsLoad();
  } catch (e) {
    S.settings = null;
  }

  // 1) 先用本地缓存秒开（A2：冷启动 ≤8 秒出首屏）
  const restored = await restoreSlim();
  if (restored) {
    render();
    updateBadge();
    hideBoot('已载入上次结果，正在后台刷新…');
  }

  // 2) 后台全量刷新
  //    网络极差时（实测东财限流会连续失败数百次）全量刷新可能拖过几分钟。
  //    不能让启动屏一直挡着：超时后先放行首屏，刷新继续在后台跑完。
  //    宁可先给用户一个可交互的界面，也不要让他盯着永远转不完的启动屏。
  const BOOT_GATE_MS = 45000;
  let gateTimer = null;
  const gate = new Promise((res) => {
    gateTimer = setTimeout(() => res('timeout'), BOOT_GATE_MS);
  });
  const done = await Promise.race([
    reload({ silent: !!restored }).then(() => 'done'),
    gate,
  ]);
  clearTimeout(gateTimer);

  if (done === 'timeout') {
    // 启动屏先撤掉，界面照常可用（骨架屏 + 顶部进度条仍在提示在加载）
    hideBoot('网络较慢，数据仍在后台加载…');
    if (!S.result) render();
    toast('网络较慢，数据仍在后台加载…');
  }

  setupTail();
}

/** 从 IndexedDB 恢复上次的精简结果 */
async function restoreSlim() {
  try {
    const slim = await metaGet(SLIM_KEY, null);
    if (!slim || !slim.plan) return false;
    // poolStats 原本是 FilterStats 实例，output 是原型上的 getter，
    // 经 IndexedDB 结构化克隆后 getter 会丢失 → 首屏会显示「股票池 -- 只」。
    // 这里按 steps 末项补回 output，恢复失败时退回 input。
    const ps = slim.poolStats;
    if (ps && typeof ps.output !== 'number') {
      const steps = Array.isArray(ps.steps) ? ps.steps : [];
      ps.output = steps.length
        ? Number(steps[steps.length - 1].remain) || 0
        : Number(ps.input) || 0;
    }
    S.result = slim;
    S.indexes = (await metaGet(IDX_KEY, [])) || [];
    return true;
  } catch (e) {
    return false;
  }
}

/** 保存精简结果（去掉 Map/Set 与全量 scored，控制体积） */
function saveSlim() {
  const r = S.result;
  if (!r) return;
  try {
    const slim = {
      dateStr: r.dateStr,
      market: r.market,
      level: r.level,
      ml: {
        all: (r.ml.all || []).slice(0, 80),
        top: r.ml.top || [],
        bottom: r.ml.bottom || [],
      },
      mlStats: r.mlStats,
      poolStats: r.poolStats,
      universeSize: r.universeSize,
      strategyName: r.strategyName,
      strategyPoolCounts: r.strategyPoolCounts,
      qualifiedCount: r.qualifiedCount,
      factorCount: r.factorCount,
      candidateCount: r.candidateCount,
      relaxed: r.relaxed,
      plan: r.plan,
      trend: r.trend,
      strategy: r.strategy,
      capital: r.capital,
      loadedAt: r.loadedAt,
      refreshedAt: r.refreshedAt,
      picks: (r.picks || []).slice(0, 60).map((x) => ({
        code: x.code, name: x.name, score: x.score, factors: x.factors,
        mainNames: x.mainNames, industry: x.industry, price: x.price,
        chgPct: x.chgPct, prevClose: x.prevClose, mktCap: x.mktCap,
        turnover: x.turnover, amount: x.amount, rsi: x.rsi,
        mom20: x.mom20, dd: x.dd, atr: x.atr,
      })),
      cached: true,
    };
    metaSet(SLIM_KEY, slim).catch(() => {});
    metaSet(IDX_KEY, S.indexes || []).catch(() => {});
  } catch (e) { /* 忽略配额错误 */ }
}

/* ---------------- 数据刷新 ---------------- */

/**
 * 全量刷新。
 * @param {object} opt { silent 静默模式（不显示骨架屏，只显示顶部进度条） }
 */
async function reload(opt = {}) {
  if (S.loading) return;
  S.loading = true;
  S.error = '';

  const hasData = !!S.result;
  if (!hasData) render();          // 显示骨架屏
  showProgress(1, '准备中…');

  try {
    const settings = await settingsLoad();
    S.settings = settings;

    const state = await loadAll({
      settings,
      onProgress: (p) => {
        showProgress(p.pct, p.text);
        setBootBar(p.pct, p.text);
      },
    });

    S.state = state;
    S.result = analyze(state, { settings });
    S.indexes = await fetchIndexes().catch(() => []);
    S.quotes = buildQuotesFromPool();

    saveSlim();

    const n = S.result.plan.items.length;
    if (!opt.silent) {
      toast(n ? `已生成今日计划：${n} 只` : '今日无符合条件标的，建议观望');
    } else {
      toast(`数据已刷新 · ${n} 只推荐`);
    }
  } catch (e) {
    S.error = '数据加载失败：' + (e && e.message ? e.message : String(e));
    if (!S.result) render();
    else toast('刷新失败，继续显示上次结果');
    console.error(e);
  } finally {
    S.loading = false;
    hideProgress();
    hideBoot();
    render();
    updateBadge();
  }
}

/** 用 state.pool 里的最新价构造持仓 Tab 用的 quotes Map */
function buildQuotesFromPool() {
  const m = new Map();
  const pool = (S.state && S.state.pool) || [];
  for (const s of pool) {
    m.set(String(s.code), {
      f12: s.code, f2: s.price, f3: s.chgPct, f14: s.name,
    });
  }
  return m;
}

/* ---------------- 渲染 ---------------- */

function render() {
  const base = {
    result: S.result,
    loading: S.loading && !S.result,
    error: S.error,
    onReload: () => reload({}),
  };

  try {
    if (S.tab === 'today') {
      renderToday($('#todayContent'), { ...base, indexes: S.indexes });
    } else if (S.tab === 'mainline') {
      renderMainline($('#mainlineContent'), base);
    } else if (S.tab === 'picks') {
      renderPicks($('#picksContent'), base);
    } else if (S.tab === 'positions') {
      renderPositions($('#positionsContent'), {
        result: S.result,
        quotes: S.quotes,
        onReload: base.onReload,
        onChanged: () => { refreshPositionsTab(); },
      }).catch((e) => console.error(e));
    } else if (S.tab === 'settings') {
      renderSettings($('#settingsContent'), {
        result: S.result,
        state: S.state,
        onReload: () => reload({}),
        onAnalyze: reanalyze,
        onChanged: () => { refreshPositionsTab(); },
      }).catch((e) => console.error(e));
    }
  } catch (e) {
    console.error('render error', e);
  }
}

/** 仅重算（不重新拉网络数据）：改本金/策略/过滤条件后调用 */
async function reanalyze(opt = {}) {
  // 没有原始快照就无法重建股票池，退化为完整刷新，避免「改了条件但没生效」的假象
  if (!S.state || !S.state.rows || !S.state.rows.length) {
    return reload({ silent: true });
  }
  try {
    // 关键：设置可能刚在设置页被改过（过滤条件/策略/本金），必须重新读一次，
    // 否则会拿启动时缓存的旧设置重算，改了过滤条件却看不到变化。
    S.settings = await settingsLoad();
    // 过滤条件决定股票池，必须重建；analyze 再基于新池 + 新策略重算计划
    S.state = rebuildPool(S.state, S.settings);
    S.result = analyze(S.state, { settings: S.settings });
    S.quotes = buildQuotesFromPool();
    saveSlim();
    render();
    updateBadge();
    if (opt.silent !== true) {
      const name = S.result.strategyName || '当前策略';
      const n = S.result.plan.items.length;
      toast(n
        ? `已按「${name}」重算：${n} 只`
        : `已按「${name}」重算：暂无符合条件的标的`);
    }
    return S.result;
  } catch (e) {
    toast('重算失败：' + (e && e.message ? e.message : String(e)));
    return null;
  }
}

/** 持仓 Tab：切换到该页时刷新行情 */
async function refreshPositionsTab() {
  if (S.tab !== 'positions') { render(); return; }
  try {
    const { positionsLoadAll } = await import('./store.js');
    const list = await positionsLoadAll();
    const need = list.map((p) => String(p.code)).filter((c) => !S.quotes.has(c));
    if (need.length) {
      const qs = await fetchQuotes(need, 'f2,f3,f12,f14', { limit: 4 }).catch(() => []);
      for (const q of qs) S.quotes.set(String(q.f12), q);
    }
  } catch (e) { /* 忽略 */ }
  render();
}

/* ---------------- Tab 切换 ---------------- */

function switchTab(tab) {
  if (!tab) return;
  S.tab = tab;
  for (const btn of document.querySelectorAll('#tabbar .tab-btn')) {
    btn.classList.toggle('active', btn.dataset.tab === tab);
  }
  for (const sec of document.querySelectorAll('.tab-panel')) {
    sec.classList.toggle('hidden', sec.dataset.tab !== tab);
  }
  const main = $('#main');
  if (main) main.scrollTop = 0;
  window.scrollTo(0, 0);
  render();
}

/* ---------------- 顶栏 / 时钟 / 徽标 ---------------- */

function setClock() {
  const node = $('#clockLine');
  if (!node) return;
  const now = new Date();
  let phase = marketPhase(now);
  if (S.state && ['morning', 'lunch', 'afternoon', 'tail'].includes(phase)
    && !isTradingDate(S.state.indexKl, now)) {
    phase = 'closed';
  }
  const label = {
    weekend: '休市', pre: '盘前', auction: '集合竞价', morning: '交易中',
    lunch: '午间休市', afternoon: '交易中', tail: '尾盘', closed: '已收盘',
  }[phase] || '';
  node.textContent = nowHHMMSS() + (label ? ' · ' + label : '');
}

function updateBadge() {
  const badge = $('#marketBadge');
  const txt = $('#marketBadgeText');
  if (!badge || !txt) return;
  const r = S.result;
  if (!r || !r.level) {
    badge.className = 'badge badge-idle';
    txt.textContent = S.loading ? '加载中' : '未加载';
    return;
  }
  badge.className = 'badge ' + (r.level.badge || 'badge-idle');
  txt.textContent = r.level.name + ' ' + (r.market ? r.market.score.toFixed(0) : '--');
}

/* ---------------- 尾盘模式 ---------------- */

function setupTail() {
  if (S.tailTimer) clearInterval(S.tailTimer);
  S.tailTimer = setInterval(tailTick, 1000);
  tailTick();
}

function tailTick() {
  const bar = $('#tailBar');
  const txt = $('#tailText');
  if (!bar) return;

  const enabled = !S.settings || S.settings.tailMode !== false;
  if (!enabled) { bar.classList.add('hidden'); return; }

  const now = new Date();
  const phase = marketPhase(now);
  if (!S.state || !isTradingDate(S.state.indexKl, now)) {
    bar.classList.add('hidden');
    return;
  }
  const ms = msToTail(now);            // 距 14:55 的毫秒数

  // 只在「14:30 之后」到「15:05」之间显示
  const show = (phase === 'afternoon' && ms > 0 && ms <= 25 * 60000) || phase === 'tail';
  if (!show) { bar.classList.add('hidden'); return; }

  bar.classList.remove('hidden');

  if (phase === 'tail') {
    bar.classList.add('locked');
    const last = S.lastTailAt ? new Date(S.lastTailAt).toLocaleTimeString('zh-CN') : '--';
    if (txt) txt.textContent = S.tailRefreshing ? '刷新中…' : `窗口已开启 · 上次刷新 ${last}`;
    // 每 10 秒刷新一次
    if (!S.tailRefreshing && Date.now() - S.lastTailAt > 10000 && S.state) {
      tailRefresh();
    }
  } else {
    bar.classList.remove('locked');
    const min = Math.floor(ms / 60000);
    const sec = Math.floor((ms % 60000) / 1000);
    if (txt) txt.textContent = `距尾盘窗口 ${min} 分 ${String(sec).padStart(2, '0')} 秒`;
  }
}

async function tailRefresh() {
  if (!S.state || S.tailRefreshing || !isTradingDate(S.state.indexKl)) return;
  S.tailRefreshing = true;
  try {
    showProgress(30, '尾盘刷新行情…');
    const next = await refreshPoolOnly(S.state, {
      onProgress: (p) => showProgress(p.pct, p.text),
    });
    S.state = next;
    S.result = analyze(next, { settings: S.settings || {} });
    S.quotes = buildQuotesFromPool();
    S.lastTailAt = Date.now();
    S.error = '';
    saveSlim();
    render();
    updateBadge();
  } catch (e) {
    S.error = '尾盘行情刷新失败：' + (e && e.message ? e.message : String(e));
    console.error('尾盘刷新失败', e);
    render();
  } finally {
    S.tailRefreshing = false;
    hideProgress();
  }
}

/* ---------------- 个股详情弹层 ---------------- */

async function openStock(code) {
  const codeStr = String(code || '');
  if (!codeStr) return;

  const r = S.result;
  let stock = null;
  if (r && Array.isArray(r.scored)) stock = r.scored.find((x) => x.code === codeStr);
  if (!stock && r && Array.isArray(r.picks)) stock = r.picks.find((x) => x.code === codeStr);
  if (!stock && S.state) stock = (S.state.pool || []).find((x) => x.code === codeStr);
  if (!stock && r && r.plan) {
    const it = r.plan.items.find((x) => x.code === codeStr);
    if (it) stock = { code: it.code, name: it.name, price: it.price, mainNames: it.mainNames };
  }
  if (!stock) { toast('未找到该股票数据'); return; }

  // K 线
  let kl = null;
  if (S.state && S.state.klines) kl = S.state.klines.get(codeStr) || null;
  if (!kl) kl = await klinesGet(codeStr).catch(() => null);

  // 当前生效的策略：评分口径、因子反向标注、评分标题都跟着它走
  const stKey = (r && r.strategy) || (S.settings && S.settings.strategy) || 'balanced';
  const stName = getStrategy(stKey).name;

  // 因子（若缓存里没有则现算；反向因子按当前策略标注，口径与打分一致）
  let factors = stock.factors;
  if ((!factors || !Object.keys(factors).length) && kl) {
    const raw = computeFactors(kl);
    if (raw) {
      const rev = getStrategy(stKey).reverseKeys || [];
      factors = {};
      for (const k of Object.keys(FACTOR_LABELS)) {
        const v = raw[k];
        const clamped = isFinite(v) ? Math.max(0, Math.min(100, v)) : null;
        factors[k] = clamped === null ? 50 : (rev.includes(k) ? 100 - clamped : clamped);
      }
    }
  }

  const planItem = r && r.plan ? r.plan.items.find((x) => x.code === codeStr) : null;

  const node = el('div');
  const chg = isFinite(stock.chgPct) ? stock.chgPct : NaN;

  // 标题
  node.append(el('div', { class: 'sheet-title' }, [
    stock.name || codeStr,
    el('span', { class: 'cd', text: codeStr }),
    el('span', { class: 'cd ' + updown(chg), style: { marginLeft: 'auto' }, text: fmtPctRaw(chg) }),
  ]));

  // 现价
  if (isFinite(stock.price)) {
    node.append(el('div', { class: 'row-between', style: { marginTop: '6px' } }, [
      el('div', { class: 'mono', style: { fontSize: '22px', fontWeight: '800' }, text: stock.price.toFixed(2) }),
      el('div', { class: 'tiny dim', text: stock.industry || '' }),
    ]));
  }

  // K 线图
  if (kl && kl.n) {
    const box = el('div', { class: 'chart-box' });
    const cv = el('canvas', {});
    box.append(cv);
    node.append(box);
    requestAnimationFrame(() => {
      try { drawKline(cv, kl, { bars: 90, height: 210 }); } catch (e) { console.error(e); }
    });
  }

  // 关键指标
  const kv = el('div', { class: 'det-kv' });
  const put = (k, v, cls) => kv.append(el('div', { class: 'it' }, [
    el('div', { class: 'k', text: k }),
    el('div', { class: 'v ' + (cls || ''), text: v }),
  ]));
  if (isFinite(stock.mktCap)) put('总市值', (stock.mktCap / 1e8).toFixed(0) + ' 亿');
  if (isFinite(stock.turnover)) put('换手率', stock.turnover.toFixed(2) + '%');
  if (isFinite(stock.amount)) put('成交额', (stock.amount / 1e8).toFixed(2) + ' 亿');
  if (isFinite(stock.rsi)) put('RSI(14)', stock.rsi.toFixed(1));
  if (isFinite(stock.mom20)) put('20日动量', fmtPctRaw(stock.mom20 * 100), updown(stock.mom20));
  if (isFinite(stock.dd)) put('距60日高', fmtPctRaw(stock.dd * 100), updown(stock.dd));
  if (isFinite(stock.score)) put(`综合评分 · ${stName}`, stock.score.toFixed(1));
  if (kv.children.length) node.append(kv);

  // 主线标签
  if (stock.mainNames && stock.mainNames.length) {
    const tags = el('div', { class: 'tags mt10' });
    for (const n of stock.mainNames.slice(0, 4)) tags.append(el('span', { class: 'tag', text: n }));
    node.append(tags);
  }

  // 因子分位（标签按当前生效策略标注「反向」，与打分口径一致）
  if (factors && Object.keys(factors).length) {
    const list = el('div', { class: 'factor-list' });
    for (const k of Object.keys(FACTOR_LABELS)) {
      const v = factors[k];
      if (!isFinite(v)) continue;
      list.append(el('div', { class: 'factor-row' }, [
        el('div', { class: 'k', text: factorLabel(k, stKey) }),
        el('div', { class: 'bar' }, [
          el('div', { class: 'fill', style: { width: Math.max(2, Math.min(100, v)) + '%' } }),
        ]),
        el('div', { class: 'v', text: v.toFixed(0) }),
      ]));
    }
    node.append(el('div', { class: 'sec-title mt14', text: `因子分位（同池横向对比 · ${stName}）` }));
    node.append(list);
  }

  // 买入计划
  if (planItem) {
    node.append(el('div', { class: 'sec-title mt14', text: '今日买入计划' }));
    const g = el('div', { class: 'pick-grid' });
    const rows = [
      ['委托价', planItem.bid.toFixed(2) + ' 元'],
      ['买入股数', planItem.shares + ' 股'],
      ['买入金额', fmtInt(planItem.amount) + ' 元'],
      ['止损价', planItem.stop.toFixed(2) + ' (' + planItem.stopPct + '%)'],
      ['止盈①', planItem.tp1.toFixed(2) + ' (+6%)'],
      ['止盈②', planItem.tp2.toFixed(2) + ' (+12%)'],
      ['最大亏损', fmtInt(planItem.maxLoss) + ' 元'],
      ['盈亏比', '1 : ' + planItem.rr.toFixed(2)],
    ];
    for (const [k, v] of rows) {
      g.append(el('div', { class: 'pg-item' }, [
        el('span', { class: 'k', text: k }),
        el('span', { class: 'v mono', text: v }),
      ]));
    }
    node.append(g);

    node.append(el('div', { class: 'pick-actions mt14' }, [
      el('button', {
        class: 'btn btn-primary btn-sm',
        text: '复制下单清单',
        onclick: async () => {
          const lines = [
            `【${planItem.name} ${planItem.code}】`,
            `委托价 ${planItem.bid.toFixed(2)} 元（现价 ${planItem.price.toFixed(2)}，涨停 ${planItem.upLimit.toFixed(2)}）`,
            `买入 ${planItem.shares} 股 ≈ ${fmtInt(planItem.amount)} 元`,
            `止损 ${planItem.stop.toFixed(2)}（${planItem.stopPct}%）`,
            `止盈 ${planItem.tp1.toFixed(2)}（+6%）/ ${planItem.tp2.toFixed(2)}（+12%）`,
            `窗口：${TAIL_WINDOW_TEXT} 挂单（涨停排板单宜封板后尽早挂）`,
          ];
          const ok = await copyText(lines.join('\n'));
          toast(ok ? '已复制' : '复制失败');
        },
      }),
    ]));
  }

  // 关闭
  node.append(el('div', { class: 'pick-actions mt14' }, [
    el('button', { class: 'btn btn-ghost btn-sm', text: '关闭', onclick: closeSheet }),
  ]));

  openSheet(node, { onClose: () => {} });
}

/* ---------------- 启动画面 ---------------- */

function setBootBar(pct, text) {
  const bar = $('#bootBar');
  const sub = $('#bootSub');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (sub && text) sub.textContent = text;
}

function hideBoot(hint) {
  const boot = $('#bootScreen');
  if (!boot) return;
  if (hint) {
    const h = $('#bootHint');
    if (h) h.textContent = hint;
  }
  setTimeout(() => boot.classList.add('hide'), 260);
  S.booted = true;
}

/* ---------------- Service Worker ---------------- */

/**
 * 注册 SW 并处理版本更新。
 *
 * 【为什么需要这段】PWA 安装到 iPhone 主屏后，用户几乎不会主动「关掉再打开」，
 * 旧 Service Worker 会一直活着。若新版本不主动接管，用户会长期运行旧代码，
 * 任何 bug 修复都到不了他手上（本项目实测踩过：旧 api.js 被缓存，
 * 导致接口全部指向已失效主机，App 看起来「坏了」）。
 *
 * 做法：发现 waiting 中的新 SW → 立刻 SKIP_WAITING → 在 controllerchange 时
 * 自动 reload 一次。用 sessionStorage 标记防止 reload 死循环。
 */
function registerSW() {
  const isSecure = location.protocol === 'https:' ||
    location.hostname === 'localhost' ||
    location.hostname === '127.0.0.1';
  if (!isSecure) return;   // 局域网 http 不是 secure context，SW 无法注册
  if (!('serviceWorker' in navigator)) return;

  // 新 SW 接管后自动刷新一次（每个会话最多一次）
  // 只在「原本已有 SW 控制」时刷新，避免首次安装时多刷一次页面
  const hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadController) return;
    if (sessionStorage.getItem('sw-reloaded') === '1') return;
    sessionStorage.setItem('sw-reloaded', '1');
    location.reload();
  });

  navigator.serviceWorker.register('./sw.js').then((reg) => {
    // 已有 waiting 的新版本：直接让它接管
    if (reg.waiting) {
      reg.waiting.postMessage({ type: 'SKIP_WAITING' });
    }
    // 本次会话内又发现更新
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', () => {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          sw.postMessage({ type: 'SKIP_WAITING' });
        }
      });
    });
  }).catch((e) => {
    console.warn('SW 注册失败', e);
  });
}

/* ---------------- 事件绑定 ---------------- */

function bind() {
  // 底部 Tab
  for (const btn of document.querySelectorAll('#tabbar .tab-btn')) {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }

  // 刷新按钮
  const btnRefresh = $('#btnRefresh');
  if (btnRefresh) btnRefresh.addEventListener('click', () => reload({}));

  // 立即锁定（尾盘）
  const btnLock = $('#btnLock');
  if (btnLock) {
    btnLock.addEventListener('click', async () => {
      if (!S.state) { reload({}); return; }
      await tailRefresh();
      toast('已锁定最新推荐');
    });
  }

  // 视图发出的自定义事件
  document.addEventListener('open-stock', (e) => {
    const code = e && e.detail ? e.detail.code : null;
    openStock(code);
  });
  document.addEventListener('switch-tab', (e) => {
    const tab = e && e.detail ? e.detail.tab : null;
    switchTab(tab);
  });

  // 回到前台时：若跨过尾盘窗口则补刷
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = new Date();
    if (marketPhase(now) === 'tail' && S.state
      && isTradingDate(S.state.indexKl, now)
      && Date.now() - S.lastTailAt > 30000) {
      tailRefresh();
    }
  });

  // 双击顶栏回到顶部（小便利）
  const tb = $('#topbar');
  if (tb) {
    tb.addEventListener('dblclick', () => {
      const m = $('#main');
      if (m) m.scrollTop = 0;
      window.scrollTo(0, 0);
    });
  }
}

/* ---------------- 入口 ---------------- */

function start() {
  bind();
  boot().catch((e) => {
    console.error('启动失败', e);
    hideBoot();
    const sub = $('#bootSub');
    if (sub) sub.textContent = '启动失败：' + e.message;
    toast('启动失败：' + e.message);
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}
