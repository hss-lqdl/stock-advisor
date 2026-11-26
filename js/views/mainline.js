/* ============================================================
   views/mainline.js — Tab 2 主线：Top20 / 退潮 / 热度走势
   ============================================================ */

import {
  el, esc, fmtPctRaw, fmtMoney, skeletonCards, emptyState, errorBox, toast, openSheet,
} from '../ui.js';
import { drawMainlineBars, drawTrendLine } from '../charts.js';
import { boardTypeLabel } from '../mainline.js';

/** 单个板块行 */
function boardRow(b, rank, cold) {
  const maxScore = 20;
  const pct = Math.min(100, (Math.abs(b.score) / maxScore) * 100);
  return el('div', { class: 'ml-row' + (cold ? ' cold' : ' hot') }, [
    el('div', { class: 'ml-rank', text: String(rank) }),
    el('div', { class: 'ml-body' }, [
      el('div', { class: 'ml-name', text: b.name }),
      el('div', { class: 'ml-meta' }, [
        el('span', { text: `今日 ${fmtPctRaw(b.f3)}` }),
        el('span', { text: `5日 ${fmtPctRaw(b.f109)}` }),
        el('span', { text: `10日 ${fmtPctRaw(b.f160)}` }),
        el('span', { text: b.up != null ? `涨${b.up}/跌${b.dn}` : '' }),
        el('span', { text: fmtMoney(b.mainInflow) }),
      ]),
      el('div', { class: 'ml-bar-wrap' }, [
        el('div', { class: 'ml-bar', style: { width: pct + '%' } }),
      ]),
    ]),
    el('div', { class: 'ml-score', text: (b.score > 0 ? '+' : '') + b.score.toFixed(1) }),
  ]);
}

/** 板块详情弹层 */
function showBoardDetail(b, stocks) {
  const node = el('div');
  node.append(el('div', { class: 'sheet-title' }, [
    b.name,
    el('span', { class: 'cd', text: boardTypeLabel(b) }),
  ]));

  const kv = el('div', { class: 'det-kv' });
  const items = [
    ['主线得分', (b.score > 0 ? '+' : '') + b.score.toFixed(2)],
    ['今日涨幅', fmtPctRaw(b.f3)],
    ['5日涨幅', fmtPctRaw(b.f109)],
    ['10日涨幅', fmtPctRaw(b.f160)],
    ['主力净流入', fmtMoney(b.mainInflow)],
    ['涨跌家数', b.up != null ? `${b.up} / ${b.dn}` : '--'],
  ];
  for (const [k, v] of items) {
    kv.append(el('div', { class: 'it' }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v', text: v }),
    ]));
  }
  node.append(kv);

  // 板块内个股
  if (stocks && stocks.length) {
    node.append(el('div', { class: 'sec-title', text: `板块内个股（${stocks.length}）` }));
    const tbl = el('table', { class: 'tbl' });
    tbl.append(el('thead', {}, [el('tr', {}, [
      el('th', { text: '股票' }),
      el('th', { text: '现价' }),
      el('th', { text: '涨幅' }),
      el('th', { text: '市值' }),
    ])]));
    const tb = el('tbody');
    for (const s of stocks.slice(0, 30)) {
      tb.append(el('tr', {
        onclick: () => {
          document.dispatchEvent(new CustomEvent('open-stock', { detail: { code: s.code } }));
        },
      }, [
        el('td', {}, [
          el('div', { class: 'nm', text: s.name }),
          el('div', { class: 'cd', text: s.code }),
        ]),
        el('td', { class: 'mono', text: isFinite(s.price) ? s.price.toFixed(2) : '--' }),
        el('td', { class: 'mono ' + (s.chgPct > 0 ? 'up' : s.chgPct < 0 ? 'down' : 'flat'), text: fmtPctRaw(s.chgPct) }),
        el('td', { class: 'mono', text: fmtMoney(s.mktCap) }),
      ]));
    }
    tbl.append(tb);
    node.append(tbl);
  } else {
    node.append(el('div', { class: 'dim tiny mt14', text: '暂无该板块的池内个股（受市值与流动性过滤影响）' }));
  }

  node.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>说明：</b>主线得分 = 5日涨幅×2 + 今日涨幅×1 + (上涨占比−0.5)×20 + 主力净流入(亿/5，限±3)。' +
      '得分越高代表近一周资金与情绪越集中。',
  }));

  openSheet(node);
}

/**
 * 渲染主线 Tab
 * @param {HTMLElement} root
 * @param {object} ctx { result, loading, error, onReload }
 */
export function renderMainline(root, ctx) {
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
  if (!r || !r.ml) {
    root.append(emptyState('还没有数据', '立即加载', ctx.onReload));
    return;
  }

  const ml = r.ml;
  const pool = (r.scored && r.scored.length ? r.scored : []);

  // 板块 → 池内个股映射
  const byBoard = new Map();
  for (const s of pool) {
    for (const name of (s.mainNames || [])) {
      if (!byBoard.has(name)) byBoard.set(name, []);
      byBoard.get(name).push(s);
    }
  }

  // ---- 概览卡 ----
  const overview = el('div', { class: 'card' });
  overview.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '主线概览' }),
    el('div', { class: 'card-sub', text: `${ml.all.length} 个有效板块` }),
  ]));

  const topScore = ml.top[0] ? ml.top[0].score : 0;
  const bottomScore = ml.bottom[0] ? ml.bottom[0].score : 0;
  overview.append(el('div', { class: 'stats' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '最强主线' }),
      el('div', { class: 'v small up', text: ml.top[0] ? ml.top[0].name : '--' }),
      el('div', { class: 's', text: '+' + topScore.toFixed(1) + ' 分' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '最弱板块' }),
      el('div', { class: 'v small down', text: ml.bottom[0] ? ml.bottom[0].name : '--' }),
      el('div', { class: 's', text: bottomScore.toFixed(1) + ' 分' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '过门槛个股' }),
      el('div', { class: 'v small', text: String(r.qualifiedCount) }),
      el('div', { class: 's', text: '属于Top20主线' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '参与评分' }),
      el('div', { class: 'v small', text: String(r.factorCount) }),
      el('div', { class: 's', text: '因子齐备' }),
    ]),
  ]));
  overview.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>筛选规则：</b>个股必须属于 <b>Top20 主线板块</b>，且不属于 <b>退潮 Top10</b>，' +
      '才进入打分池。这样保证推荐标的站在近一周的资金主线上。',
  }));
  root.append(overview);

  // ---- 得分条形图 ----
  const chartCard = el('div', { class: 'card' });
  chartCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '主线强度排行' }),
    el('div', { class: 'card-sub', text: 'Top 8' }),
  ]));
  const chartBox = el('div', { class: 'chart-box', style: { background: 'transparent' } });
  const canvas = el('canvas');
  chartBox.append(canvas);
  chartCard.append(chartBox);
  root.append(chartCard);

  requestAnimationFrame(() => {
    drawMainlineBars(canvas, ml.top, { count: 8 });
  });

  // ---- 近一周热度走势 ----
  const trendCard = el('div', { class: 'card' });
  trendCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '近一周主线热度走势' }),
    el('div', { class: 'card-sub', text: '按 5 日涨幅推演' }),
  ]));
  const trendBox = el('div', { class: 'chart-box', style: { background: 'transparent' } });
  const trendCanvas = el('canvas');
  trendBox.append(trendCanvas);
  trendCard.append(trendBox);

  const legend = el('div', { class: 'tags mt10' });
  trendCard.append(legend);
  root.append(trendCard);

  requestAnimationFrame(() => {
    const series = (r.trend && r.trend.series) || [];
    const colors = drawTrendLine(trendCanvas, series, { height: 130 });
    if (colors) {
      colors.forEach((c) => {
        legend.append(el('span', {
          class: 'tag',
          style: { background: 'transparent', color: c.color, borderColor: c.color + '44' },
          text: c.name,
        }));
      });
    }
  });

  // ---- Top 20 列表 ----
  const topCard = el('div', { class: 'card' });
  topCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '主线板块 Top 20' }),
    el('div', { class: 'card-sub', text: '点击查看板块内个股' }),
  ]));
  ml.top.forEach((b, i) => {
    const row = boardRow(b, i + 1, false);
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => showBoardDetail(b, byBoard.get(b.name) || []));
    topCard.append(row);
  });
  root.append(topCard);

  // ---- 退潮 Top 10 ----
  const bottomCard = el('div', { class: 'card' });
  bottomCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '退潮板块 Top 10（回避）' }),
    el('div', { class: 'card-sub', text: '个股若属这些板块则剔除' }),
  ]));
  ml.bottom.forEach((b, i) => {
    const row = boardRow(b, i + 1, true);
    row.style.cursor = 'pointer';
    row.addEventListener('click', () => showBoardDetail(b, byBoard.get(b.name) || []));
    bottomCard.append(row);
  });
  root.append(bottomCard);

  root.append(el('div', {
    class: 'disclaimer',
    html: '<b>为什么用近一周而不是今天？</b>单日涨幅容易被情绪与消息扰动，' +
      '5 日强度（f109）更能反映资金是否持续流入。主线得分把 5 日涨幅权重设为今日的 2 倍，' +
      '并要求个股必须落在 Top20 主线内，从而避免追逐一日游行情。',
  }));
}
