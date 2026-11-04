/* ============================================================
   views/today.js — Tab 1 今日：大盘环境 + 档位建议 + 今日计划摘要
   ============================================================ */

import {
  el, esc, fmtPctRaw, fmtMoney, fmtInt, updown, skeletonCards,
  emptyState, errorBox, openSheet, copyText, toast,
} from '../ui.js';
import { drawDimBars, drawKline } from '../charts.js';
import { buildCopyText } from '../plan.js';

const IDX_NAMES = {
  '000001': '上证指数',
  '399001': '深证成指',
  '399006': '创业板指',
  '000688': '科创50',
  '399905': '中证500',
};

/** 渲染大盘指数卡片 */
function renderIndexes(indexes) {
  const cells = [];
  const order = ['000001', '399001', '399006'];
  for (const code of order) {
    const it = (indexes || []).find((x) => String(x.f12) === code);
    if (!it) continue;
    const chg = typeof it.f3 === 'number' ? it.f3 : NaN;
    cells.push(el('div', { class: 'idx-cell' }, [
      el('div', { class: 'n', text: IDX_NAMES[code] || code }),
      el('div', { class: 'v ' + updown(chg), text: isFinite(it.f2) ? it.f2.toFixed(2) : '--' }),
      el('div', { class: 'c ' + updown(chg), text: fmtPctRaw(chg) }),
    ]));
  }
  if (!cells.length) return null;
  return el('div', { class: 'mkt-idx' }, cells);
}

/** 大盘卡 */
function renderMarketCard(result, indexes) {
  const m = result.market;
  const lv = m.level;

  const card = el('div', { class: 'card' });

  card.append(el('div', { class: 'mkt-top' }, [
    el('div', {}, [
      el('div', { class: 'card-sub', text: '大盘环境评分' }),
      el('div', { class: 'mkt-score' }, [
        /* 评分是「环境强弱」而非涨跌，用档位色避免与红涨绿跌语义混淆 */
        el('span', { class: 'num', style: { color: lv.color }, text: m.score.toFixed(1) }),
        el('span', { class: 'unit', text: '/100' }),
      ]),
    ]),
    el('div', { class: 'mkt-level' }, [
      el('div', { class: 'lv', style: { color: lv.color }, text: lv.name }),
      el('div', { class: 'pos', text: `建议仓位 ${(lv.position * 100).toFixed(0)}%` }),
    ]),
  ]));

  // 四维条形
  const dimsNode = el('div', { class: 'dims' });
  for (const k of ['trend', 'breadth', 'sentiment', 'volume']) {
    const d = m.dims[k];
    const pct = Math.max(0, Math.min(100, d.score));
    const color = pct >= 70 ? 'var(--up)' : pct >= 50 ? 'var(--blue)'
      : pct >= 30 ? 'var(--amber)' : 'var(--down)';
    dimsNode.append(el('div', { class: 'dim-row' }, [
      el('div', { class: 'dim-name', text: d.name }),
      el('div', { class: 'dim-bar' }, [
        el('div', { class: 'dim-fill', style: { width: pct + '%', background: color } }),
      ]),
      el('div', { class: 'dim-val', text: pct.toFixed(0) }),
    ]));
  }
  card.append(dimsNode);

  const idxNode = renderIndexes(indexes);
  if (idxNode) card.append(idxNode);

  // 一句话解读
  const b = m.dims.breadth.detail;
  const parts = [];
  if (b && b.total) {
    parts.push(`全市场 ${b.up} 涨 / ${b.dn} 跌（上涨占比 ${(b.ratio * 100).toFixed(0)}%）`);
  }
  if (b && (b.limitUp || b.limitDown)) {
    parts.push(`涨停 ${b.limitUp} / 跌停 ${b.limitDown}`);
  }
  if (parts.length) {
    card.append(el('div', {
      class: 'card-sub mt10',
      style: { lineHeight: '1.6' },
      text: parts.join(' · '),
    }));
  }

  return card;
}

/** 档位建议卡 */
function renderAdvice(result) {
  const lv = result.level;
  const plan = result.plan;
  const card = el('div', { class: 'card' });

  // poolStats 从 IndexedDB 恢复后 output getter 会丢失，这里做一次兜底推导，
  // 避免首屏出现「候选标的 -- 只」。
  const ps = result.poolStats || {};
  const poolOut = Number.isFinite(ps.output)
    ? ps.output
    : (Array.isArray(ps.steps) && ps.steps.length
      ? Number(ps.steps[ps.steps.length - 1].remain) || 0
      : Number(ps.input) || 0);

  card.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '今日操作建议' }),
    el('div', { class: 'badge ' + lv.badge }, [
      el('span', { class: 'dot' }),
      el('span', { text: lv.name }),
    ]),
  ]));

  const stats = el('div', { class: 'stats' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '建议仓位' }),
      el('div', { class: 'v accent', text: (lv.position * 100).toFixed(0) + '%' }),
      el('div', { class: 's', text: fmtInt(result.capital * lv.position) + ' 元' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '推荐只数' }),
      el('div', { class: 'v', text: String(plan.items.length || lv.picks) }),
      el('div', { class: 's', text: `单只约 ${fmtInt(plan.perStockBudget || 0)} 元` }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '计划买入' }),
      el('div', { class: 'v small accent', text: fmtInt(plan.totalAmount || 0) }),
      el('div', { class: 's', text: `剩余 ${fmtInt(plan.cashLeft || 0)} 元` }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '候选标的' }),
      el('div', { class: 'v small', text: fmtInt(poolOut) + ' 只' }),
      el('div', { class: 's', text: `${result.strategyName || '策略'} · 过主线 ${result.qualifiedCount} 只` }),
    ]),
  ]);
  card.append(stats);

  card.append(el('div', {
    class: 'disclaimer mt14',
    html: `<b>操作节奏：</b>${esc(lv.advice)}<br>` +
      `<b>买入时点：</b>尾盘 14:55–15:00 挂单（收盘集合竞价前），价格可挂高 0.5%~1% 确保成交。<br>` +
      `<b>止损纪律：</b>跌破止损价无条件离场，不加仓不摊平。`,
  }));

  return card;
}

/** 今日计划摘要（带复制按钮） */
function renderPlanSummary(result) {
  const plan = result.plan;
  if (!plan.items || !plan.items.length) {
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title mb0', text: '今日买入计划' }),
      emptyState('当前无符合条件的标的（可能市场过弱或数据未加载）'),
    ]);
  }

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '今日买入计划' }),
    el('div', { class: 'card-sub', text: `合计 ${fmtInt(plan.totalAmount)} 元` }),
  ]));

  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, [el('tr', {}, [
    el('th', { text: '股票' }),
    el('th', { text: '委托价' }),
    el('th', { text: '股数' }),
    el('th', { text: '止损' }),
    el('th', { text: '止盈' }),
  ])]));

  const tbody = el('tbody');
  plan.items.forEach((it) => {
    tbody.append(el('tr', {
      onclick: () => {
        document.dispatchEvent(new CustomEvent('open-stock', { detail: { code: it.code } }));
      },
    }, [
      el('td', {}, [
        el('div', { class: 'nm', text: it.name }),
        el('div', { class: 'cd', text: it.code }),
      ]),
      el('td', { class: 'mono', text: it.bid.toFixed(2) }),
      el('td', { class: 'mono', text: String(it.shares) }),
      el('td', { class: 'mono down', text: it.stop.toFixed(2) }),
      el('td', { class: 'mono up', text: it.tp1.toFixed(2) }),
    ]));
  });
  tbl.append(tbody);
  card.append(tbl);

  card.append(el('div', { class: 'pick-actions' }, [
    el('button', {
      class: 'btn btn-primary btn-sm',
      text: '复制下单清单',
      onclick: async () => {
        const txt = buildCopyText(plan, {
          date: result.dateStr,
          levelName: result.level.name,
          score: result.market.score,
        });
        const ok = await copyText(txt);
        toast(ok ? '已复制，可直接对照下单' : '复制失败，请手动选择');
        if (!ok) openSheet(el('pre', { class: 'code-block', text: txt }));
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '查看全部',
      onclick: () => document.dispatchEvent(new CustomEvent('switch-tab', { detail: { tab: 'picks' } })),
    }),
  ]));

  return card;
}

/** 主线速览 */
function renderMainlineBrief(result) {
  const top = (result.ml && result.ml.top) || [];
  if (!top.length) return null;

  const card = el('div', { class: 'card' });
  card.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '近一周主线（Top 6）' }),
    el('div', { class: 'card-sub', text: '按 5 日强度' }),
  ]));

  const list = el('div');
  top.slice(0, 6).forEach((b, i) => {
    list.append(el('div', { class: 'ml-row hot' }, [
      el('div', { class: 'ml-rank', text: String(i + 1) }),
      el('div', { class: 'ml-body' }, [
        el('div', { class: 'ml-name', text: b.name }),
        el('div', { class: 'ml-meta' }, [
          el('span', { text: `今日 ${fmtPctRaw(b.f3)}` }),
          el('span', { text: `5日 ${fmtPctRaw(b.f109)}` }),
        ]),
      ]),
      el('div', { class: 'ml-score', text: b.score.toFixed(1) }),
    ]));
  });
  card.append(list);

  card.append(el('button', {
    class: 'btn btn-ghost btn-sm mt10',
    text: '查看主线全景',
    onclick: () => document.dispatchEvent(new CustomEvent('switch-tab', { detail: { tab: 'mainline' } })),
  }));

  return card;
}

/**
 * 渲染今日 Tab
 * @param {HTMLElement} root
 * @param {object} ctx { result, indexes, loading, error, onReload }
 */
export function renderToday(root, ctx) {
  root.innerHTML = '';

  if (ctx.loading) {
    root.append(skeletonCards(3));
    return;
  }

  if (ctx.error) {
    root.append(errorBox(ctx.error, ctx.onReload));
    return;
  }

  const r = ctx.result;
  if (!r) {
    root.append(emptyState('还没有数据，点右上角刷新或下拉刷新', '立即加载', ctx.onReload));
    return;
  }

  root.append(renderMarketCard(r, ctx.indexes));
  root.append(renderAdvice(r));
  root.append(renderPlanSummary(r));

  const ml = renderMainlineBrief(r);
  if (ml) root.append(ml);

  // 数据时间
  root.append(el('div', { class: 'center dim tiny', style: { padding: '8px 0 4px' } }, [
    `数据更新于 ${new Date(r.refreshedAt || r.loadedAt).toLocaleTimeString('zh-CN')} · 数据来源：东方财富`,
  ]));
}
