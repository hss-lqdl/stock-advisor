/* ============================================================
   views/picks.js — Tab 3 推荐：完整买入计划卡片 + 条件单 + 复制
   ============================================================ */

import {
  el, esc, fmtPctRaw, fmtMoney, fmtInt, updown, skeletonCards,
  emptyState, errorBox, openSheet, copyText, toast, fmtPct,
} from '../ui.js';
import {
  buildCopyText, buildConditionText, buildConditionOrders,
} from '../plan.js';
import { FACTOR_LABELS, factorLabel, getStrategy, strategyWeightText } from '../strategy.js';
import { TAIL_HHMM, CLOSE_HHMM, CLOSE_AUCTION_HHMM } from '../constants.js';

/** 因子分位条（因子名按当前策略标注「反向」） */
function factorRows(factors, strategyKey) {
  const keys = Object.keys(FACTOR_LABELS);
  const wrap = el('div', { class: 'factor-list' });
  for (const k of keys) {
    const v = factors[k];
    if (!isFinite(v)) continue;
    wrap.append(el('div', { class: 'factor-row' }, [
      el('div', { class: 'k', text: factorLabel(k, strategyKey) }),
      el('div', { class: 'bar' }, [
        el('div', { class: 'fill', style: { width: Math.max(2, Math.min(100, v)) + '%' } }),
      ]),
      el('div', { class: 'v', text: v.toFixed(0) }),
    ]));
  }
  return wrap;
}

/** 单张推荐卡 */
function pickCard(it, index, ctx) {
  const rank = index + 1;
  const card = el('div', { class: 'pick' + (rank <= 3 ? ' rank-' + rank : '') });
  const stName = getStrategy((ctx && ctx.result && ctx.result.strategy) || 'balanced').name;

  // 头部
  card.append(el('div', { class: 'pick-hd' }, [
    el('div', {}, [
      el('div', { class: 'pick-name' }, [
        el('span', { class: 'nm', text: it.name }),
        el('span', { class: 'cd', text: it.code }),
      ]),
      el('div', { class: 'pick-price' }, [
        el('span', { class: 'p mono', text: it.price.toFixed(2) }),
        el('span', {
          class: 'c ' + updown(it.chgPct),
          text: fmtPctRaw(it.chgPct),
        }),
      ]),
    ]),
    el('div', { class: 'pick-score' }, [
      el('div', { class: 's', text: it.score.toFixed(1) }),
      el('div', { class: 'l', text: `综合评分 · ${stName}` }),
    ]),
  ]));

  // 标签
  if (it.mainNames && it.mainNames.length) {
    const tags = el('div', { class: 'tags' });
    it.mainNames.slice(0, 3).forEach((n) => {
      tags.append(el('span', { class: 'tag', text: n }));
    });
    card.append(tags);
  }

  // 买入参数网格
  const grid = el('div', { class: 'pick-grid' });
  const rows = [
    ['委托价', it.bid.toFixed(2) + ' 元', true],
    ['买入股数', it.shares + ' 股', false],
    ['买入金额', fmtInt(it.amount) + ' 元', false],
    ['止损价', it.stop.toFixed(2) + ' (' + it.stopPct + '%)', false],
    ['止盈①', it.tp1.toFixed(2) + ' (+6%)', false],
    ['止盈②', it.tp2.toFixed(2) + ' (+12%)', false],
    ['盈亏比', '1 : ' + it.rr.toFixed(2), false],
    ['最大亏损', fmtInt(it.maxLoss) + ' 元', false],
  ];
  for (const [k, v, big] of rows) {
    grid.append(el('div', { class: 'pg-item' }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v' + (big ? ' big' : '') + ' mono', text: v }),
    ]));
  }
  card.append(grid);

  // 理由
  if (it.reason) {
    card.append(el('div', { class: 'pick-reason', html: it.reason }));
  }

  // 操作按钮
  card.append(el('div', { class: 'pick-actions' }, [
    el('button', {
      class: 'btn btn-primary btn-sm',
      text: '买入清单',
      onclick: () => showSingleOrder(it, ctx),
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: 'K线详情',
      onclick: () => document.dispatchEvent(new CustomEvent('open-stock', { detail: { code: it.code } })),
    }),
  ]));

  return card;
}

/** 单只下单清单弹层 */
function showSingleOrder(it, ctx) {
  const node = el('div');
  node.append(el('div', { class: 'sheet-title' }, [
    it.name,
    el('span', { class: 'cd', text: it.code }),
  ]));

  const lines = [
    `【${it.name} ${it.code}】`,
    `委托价：${it.bid.toFixed(2)} 元（现价 ${it.price.toFixed(2)}，涨停 ${it.upLimit.toFixed(2)}）`,
    `买入：${it.shares} 股 ≈ ${fmtInt(it.amount)} 元`,
    `止损：${it.stop.toFixed(2)} 元（${it.stopPct}%）`,
    `止盈①：${it.tp1.toFixed(2)} 元（+6%，减半仓）`,
    `止盈②：${it.tp2.toFixed(2)} 元（+12%，全清）`,
    `盈亏比：1 : ${it.rr.toFixed(2)}   最大亏损 ${fmtInt(it.maxLoss)} 元`,
  ];
  if (it.mainNames && it.mainNames.length) {
    lines.push(`主线：${it.mainNames.join('、')}`);
  }

  node.append(el('pre', { class: 'code-block', text: lines.join('\n') }));

  node.append(el('div', { class: 'pick-actions mt14' }, [
    el('button', {
      class: 'btn btn-primary btn-sm',
      text: '复制',
      onclick: async () => {
        const ok = await copyText(lines.join('\n'));
        toast(ok ? '已复制' : '复制失败');
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '条件单参数',
      onclick: () => showConditions(it),
    }),
  ]));

  // 因子分位（因子名按当前策略标注反向）
  if (it.factors && Object.keys(it.factors).length) {
    const sk = (ctx && ctx.result && ctx.result.strategy) || null;
    node.append(el('div', { class: 'sec-title', text: '因子分位（0–100）' }));
    node.append(factorRows(it.factors, sk));
  }

  openSheet(node);
}

/** 条件单弹层 */
function showConditions(it) {
  const fakePlan = {
    items: [{
      code: it.code, name: it.name, bid: it.bid, shares: it.shares,
      stop: it.stop, stopPct: it.stopPct, tp1: it.tp1, tp2: it.tp2,
    }],
  };
  const rows = buildConditionOrders(fakePlan);

  const node = el('div');
  node.append(el('div', { class: 'sheet-title', text: '同花顺条件单参数' }));

  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, [el('tr', {}, [
    el('th', { text: '类型' }),
    el('th', { text: '触发条件' }),
    el('th', { text: '委托' }),
  ])]));
  const tb = el('tbody');
  for (const r of rows) {
    tb.append(el('tr', {}, [
      el('td', { text: r.type }),
      el('td', { style: { textAlign: 'left' }, text: r.condition }),
      el('td', { style: { textAlign: 'left' }, text: r.action }),
    ]));
  }
  tbl.append(tb);
  node.append(tbl);

  node.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>设置路径：</b>同花顺 App → 交易 → 条件单 → 新建条件单 → 选择该股票 → ' +
      '按上表填写触发价与委托量。<br><b>注意：</b>条件单由券商服务器监控触发，' +
      '手机断网也能执行；但开盘集合竞价期间（9:15–9:25）不触发。',
  }));

  node.append(el('button', {
    class: 'btn btn-primary btn-sm mt14',
    text: '复制条件单文本',
    onclick: async () => {
      const txt = buildConditionText(fakePlan);
      const ok = await copyText(txt);
      toast(ok ? '已复制' : '复制失败');
    },
  }));

  openSheet(node);
}

/** 全部条件单 */
function showAllConditions(result) {
  const plan = result.plan;
  if (!plan.items.length) { toast('今日无推荐'); return; }

  const node = el('div');
  node.append(el('div', { class: 'sheet-title', text: '全部条件单参数' }));
  node.append(el('pre', { class: 'code-block', text: buildConditionText(plan) }));
  node.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>三种下单路径：</b><br>' +
      '<b>A. 条件单（推荐）</b> — 在同花顺一次性设置好，之后自动触发，无需盯盘。<br>' +
      '<b>B. 照单下单</b> — 复制清单，尾盘 ' + TAIL_HHMM + ' 手动逐只下单（涨停板战法的排板单在封板后尽早挂）。<br>' +
      '<b>C. 模拟盘</b> — 在「持仓」页记录，系统跟踪盈亏并提示止损止盈。',
  }));
  node.append(el('button', {
    class: 'btn btn-primary btn-sm mt14',
    text: '复制全部条件单',
    onclick: async () => {
      const ok = await copyText(buildConditionText(plan));
      toast(ok ? '已复制' : '复制失败');
    },
  }));
  openSheet(node);
}

/**
 * 渲染推荐 Tab
 * @param {HTMLElement} root
 * @param {object} ctx { result, loading, error, onReload }
 */
export function renderPicks(root, ctx) {
  root.innerHTML = '';

  if (ctx.loading) { root.append(skeletonCards(4)); return; }
  if (ctx.error) { root.append(errorBox(ctx.error, ctx.onReload)); return; }

  const r = ctx.result;
  if (!r || !r.plan) {
    root.append(emptyState('还没有推荐结果', '立即加载', ctx.onReload));
    return;
  }

  const plan = r.plan;

  if (!plan.items.length) {
    root.append(el('div', { class: 'card' }, [
      el('div', { class: 'card-title', text: '今日无推荐' }),
      el('div', { class: 'dim mt10', style: { lineHeight: '1.7' }, text: r.level.advice }),
      el('div', {
        class: 'disclaimer mt14',
        html: '<b>为什么空仓？</b>当前市场档位为「' + r.level.name + '」，' +
          '或没有个股同时满足「主线 Top20 + 因子齐备 + 一手成本 ≤ 单只预算」。' +
          '空仓也是一种仓位，弱市不勉强交易。',
      }),
    ]));
    return;
  }

  // 顶部汇总
  const summary = el('div', { class: 'card' });
  summary.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '今日买入计划' }),
    el('div', { class: 'badge ' + r.level.badge }, [
      el('span', { class: 'dot' }),
      el('span', { text: r.level.name }),
    ]),
  ]));

  summary.append(el('div', { class: 'stats' }, [
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '本金' }),
      el('div', { class: 'v small', text: fmtInt(plan.capital) }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '计划仓位' }),
      el('div', { class: 'v small', text: plan.positionPct + '%' }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '合计买入' }),
      el('div', { class: 'v small up', text: fmtInt(plan.totalAmount) }),
    ]),
    el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '手续费' }),
      el('div', { class: 'v small', text: fmtInt(plan.totalFee) }),
    ]),
  ]));

  if (plan.unaffordable && plan.unaffordable.length) {
    summary.append(el('div', {
      class: 'dim tiny mt10',
      text: `注：另有 ${plan.unaffordable.length} 只因「一手成本超过单只预算」未纳入计划（可提高本金或减少只数）。`,
    }));
  }

  summary.append(el('div', { class: 'pick-actions mt14' }, [
    el('button', {
      class: 'btn btn-primary btn-sm',
      text: '复制全部下单清单',
      onclick: async () => {
        const txt = buildCopyText(plan, {
          date: r.dateStr, levelName: r.level.name, score: r.market.score,
        });
        const ok = await copyText(txt);
        toast(ok ? '已复制全部清单' : '复制失败');
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '条件单参数',
      onclick: () => showAllConditions(r),
    }),
  ]));

  root.append(summary);

  // 说明
  root.append(el('div', {
    class: 'disclaimer',
    html: `<b>买入窗口：</b>尾盘 <b>${TAIL_HHMM}–${CLOSE_HHMM}</b>（${CLOSE_AUCTION_HHMM} 后进入收盘集合竞价）；涨停板战法的排板单在封板后尽早挂涨停价。` +
      `<br><b>委托价：</b>已按「现价 × 1.008，且不高于涨停价 × 0.995」计算，挂此价基本可成交。` +
      `<br><b>数据说明：</b>涨停池的首次/最后封板时间与炸板次数是<b>刷新时刻的累计值</b>，` +
      '盘中会随每一次封板、炸板变化；收盘后刷新即为全天最终值，尾盘下单前建议再刷新一次。' +
      `<br><b>纪律：</b>单只亏损达到止损价立即离场；到止盈①减半仓，到止盈②清仓。`,
  }));

  // 推荐卡列表
  plan.items.forEach((it, i) => {
    // 补充实时涨幅
    const src = (r.picks || []).find((p) => p.code === it.code);
    if (src && isFinite(src.chgPct)) it.chgPct = src.chgPct;
    root.append(pickCard(it, i, ctx));
  });

  // 策略说明（按当前生效策略的因子权重自动生成，切换策略后随之变化）
  const stKey = r.strategy || 'balanced';
  const stDef = getStrategy(stKey);
  root.append(el('div', { class: 'card' }, [
    el('div', { class: 'card-hd' }, [
      el('div', { class: 'card-title', text: '本次评分策略' }),
      el('div', { class: 'card-sub', text: stDef.name }),
    ]),
    el('div', { class: 'dim mt10', style: { lineHeight: '1.7' }, text: strategyWeightText(stKey) }),
    el('div', {
      class: 'dim tiny mt6',
      text: `专属门槛：快照 ${(r.strategyFilters && r.strategyFilters.stage1 || []).join('、') || '无'}`
        + `；因子 ${(r.strategyFilters && r.strategyFilters.stage2 || []).join('、') || '无'}`,
    }),
  ]));
}
