/* ============================================================
   views/positions.js — Tab 4 持仓：模拟盘记录 + 盈亏跟踪 + 止损止盈提醒
   ============================================================ */

import {
  el, esc, fmtPctRaw, fmtMoney, fmtInt, updown, skeletonCards,
  emptyState, errorBox, openSheet, closeSheet, toast, copyText, fmtPct,
} from '../ui.js';
import { positionPnl, sellFee } from '../plan.js';
import { positionsLoadAll, positionAdd, positionUpdate, positionRemove } from '../store.js';

const renderVersions = new WeakMap();

/** 从计划一键导入持仓 */
async function importFromPlan(result) {
  const plan = result.plan;
  if (!plan || !plan.items.length) { toast('今日无推荐可导入'); return; }
  let n = 0;
  for (const it of plan.items) {
    await positionAdd({
      code: it.code,
      name: it.name,
      shares: it.shares,
      cost: it.bid,
      stop: it.stop,
      tp1: it.tp1,
      tp2: it.tp2,
      date: result.dateStr,
      source: 'plan',
      mainNames: it.mainNames || [],
    });
    n++;
  }
  toast(`已导入 ${n} 只到模拟持仓`);
}

/** 手动新增持仓弹层 */
function showAddPosition(onDone) {
  const node = el('div');
  node.append(el('div', { class: 'sheet-title', text: '新增持仓' }));

  const fields = {};
  const mk = (label, key, placeholder, type = 'text') => {
    const input = el('input', {
      class: 'input',
      type,
      placeholder,
      inputmode: type === 'number' ? 'decimal' : 'text',
    });
    fields[key] = input;
    return el('div', { class: 'field' }, [
      el('label', { text: label }),
      input,
    ]);
  };

  node.append(mk('股票代码', 'code', '如 600519', 'text'));
  node.append(mk('股票名称', 'name', '如 贵州茅台', 'text'));
  node.append(mk('买入价', 'cost', '如 11.50', 'number'));
  node.append(mk('股数', 'shares', '如 500', 'number'));
  node.append(mk('止损价（可空）', 'stop', '如 10.93', 'number'));
  node.append(mk('止盈价（可空）', 'tp1', '如 12.19', 'number'));

  node.append(el('div', { class: 'pick-actions mt14' }, [
    el('button', {
      class: 'btn btn-primary btn-sm',
      text: '保存',
      onclick: async () => {
        const code = fields.code.value.trim();
        const name = fields.name.value.trim();
        const cost = parseFloat(fields.cost.value);
        const shares = parseInt(fields.shares.value, 10);
        if (!code || !name) { toast('请填写代码与名称'); return; }
        if (!(cost > 0) || !(shares > 0)) { toast('请填写正确的买入价与股数'); return; }
        await positionAdd({
          code, name, cost, shares,
          stop: parseFloat(fields.stop.value) || null,
          tp1: parseFloat(fields.tp1.value) || null,
          date: new Date().toISOString().slice(0, 10),
          source: 'manual',
        });
        closeSheet();
        toast('已添加');
        if (onDone) onDone();
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '取消',
      onclick: closeSheet,
    }),
  ]));

  openSheet(node);
}

/** 单条持仓卡 */
function positionCard(pos, price, onChanged) {
  const pnl = positionPnl(pos, price);
  const card = el('div', { class: 'card position-card' });

  card.append(el('div', { class: 'row-between' }, [
    el('div', {}, [
      el('div', { class: 'pick-name' }, [
        el('span', { class: 'nm', style: { fontSize: '15px' }, text: pos.name }),
        el('span', { class: 'cd', text: pos.code }),
      ]),
      el('div', { class: 'dim tiny mt6', text: `成本 ${pos.cost.toFixed(2)} × ${pos.shares} 股` }),
    ]),
    el('div', { style: { textAlign: 'right' } }, [
      el('div', {
        class: 'mono ' + (pnl ? (pnl.pnl >= 0 ? 'up' : 'down') : 'flat'),
        style: { fontSize: '17px', fontWeight: '800' },
        text: pnl ? (pnl.pnl >= 0 ? '+' : '') + fmtInt(pnl.pnl) : '--',
      }),
      el('div', {
        class: 'mono tiny ' + (pnl ? (pnl.pnl >= 0 ? 'up' : 'down') : 'flat'),
        text: pnl ? fmtPctRaw(pnl.pnlPct) : '--',
      }),
    ]),
  ]));

  if (pnl && pnl.advice) {
    card.append(el('div', {
      class: 'err-box mt10',
      style: { marginBottom: '0', background: pnl.hitStop ? 'var(--down-bg)' : 'var(--amber-bg)', borderColor: 'transparent' },
      html: `<b>提醒：</b>${esc(pnl.advice)}（现价 ${pnl.price.toFixed(2)}）`,
    }));
  }

  const grid = el('div', { class: 'pick-grid' });
  const rows = [
    ['现价', pnl ? pnl.price.toFixed(2) : '--'],
    ['市值', pnl ? fmtInt(pnl.amount) : '--'],
    ['止损', pos.stop ? pos.stop.toFixed(2) : '未设'],
    ['止盈①', pos.tp1 ? pos.tp1.toFixed(2) : '未设'],
  ];
  for (const [k, v] of rows) {
    grid.append(el('div', { class: 'pg-item' }, [
      el('span', { class: 'k', text: k }),
      el('span', { class: 'v mono', text: v }),
    ]));
  }
  card.append(grid);

  card.append(el('div', { class: 'pick-actions' }, [
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '卖出',
      onclick: async () => {
        const amount = pos.shares * (price || pos.cost);
        const fee = sellFee(amount);
        const p = (price || pos.cost) - pos.cost;
        const txt = `【卖出】${pos.name} ${pos.code}\n` +
          `价格 ${(price || pos.cost).toFixed(2)} × ${pos.shares} 股\n` +
          `成交额 ${fmtInt(amount)} 元，费用约 ${fee.total.toFixed(2)} 元\n` +
          `盈亏 ${(p * pos.shares - fee.total >= 0 ? '+' : '') + fmtInt(p * pos.shares - fee.total)} 元`;
        const ok = await copyText(txt);
        toast(ok ? '卖出清单已复制' : '复制失败');
      },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '删除',
      onclick: async () => {
        await positionRemove(pos.id);
        toast('已删除');
        if (onChanged) onChanged();
      },
    }),
  ]));

  return card;
}

/**
 * 渲染持仓 Tab
 * @param {HTMLElement} root
 * @param {object} ctx { result, positions, quotes, loading, onReload, onChanged }
 */
export async function renderPositions(root, ctx) {
  const renderVersion = (renderVersions.get(root) || 0) + 1;
  renderVersions.set(root, renderVersion);
  root.innerHTML = '';

  let positions = [];
  try {
    positions = await positionsLoadAll();
  } catch (e) {
    positions = [];
  }
  if (renderVersions.get(root) !== renderVersion) return;

  const quotes = ctx.quotes || new Map();
  const priceOf = (code) => {
    const q = quotes.get(String(code));
    return q && isFinite(q.f2) ? q.f2 : null;
  };

  // 顶部操作
  const head = el('div', { class: 'row-between positions-header' });
  head.append(el('div', {
    class: 'sec-title',
    style: { margin: '0' },
    text: `模拟持仓（${positions.length}）`,
  }));

  const btnWrap = el('div', { class: 'row' });
  btnWrap.append(el('button', {
    class: 'btn btn-primary btn-sm',
    text: '+ 新增',
    onclick: () => showAddPosition(ctx.onChanged),
  }));
  if (ctx.result && ctx.result.plan && ctx.result.plan.items.length) {
    btnWrap.append(el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '导入今日计划',
      onclick: async () => {
        await importFromPlan(ctx.result);
        if (ctx.onChanged) ctx.onChanged();
      },
    }));
  }
  head.append(btnWrap);
  root.append(head);

  if (!positions.length) {
    root.append(el('div', { class: 'card' }, [
      emptyState('还没有持仓记录。可以从今日计划一键导入，或手动添加。'),
    ]));
  } else {
    // 汇总
    let totalCost = 0;
    let totalValue = 0;
    for (const p of positions) {
      totalCost += p.cost * p.shares;
      const price = priceOf(p.code);
      totalValue += (price != null ? price : p.cost) * p.shares;
    }
    const totalPnl = totalValue - totalCost;
    const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

    const summary = el('div', { class: 'card positions-summary' });
    summary.append(el('div', { class: 'stats' }, [
      el('div', { class: 'stat' }, [
        el('div', { class: 'k', text: '总成本' }),
        el('div', { class: 'v small', text: fmtInt(totalCost) }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'k', text: '总市值' }),
        el('div', { class: 'v small', text: fmtInt(totalValue) }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'k', text: '浮动盈亏' }),
        el('div', { class: 'v small ' + (totalPnl >= 0 ? 'up' : 'down'), text: (totalPnl >= 0 ? '+' : '') + fmtInt(totalPnl) }),
      ]),
      el('div', { class: 'stat' }, [
        el('div', { class: 'k', text: '盈亏比例' }),
        el('div', { class: 'v small ' + (totalPnl >= 0 ? 'up' : 'down'), text: fmtPctRaw(totalPnlPct) }),
      ]),
    ]));
    root.append(summary);

    for (const p of positions) {
      root.append(positionCard(p, priceOf(p.code), ctx.onChanged));
    }
  }

  root.append(el('div', {
    class: 'disclaimer',
    html: '<b>说明：</b>此处为本地模拟盘，仅记录你的买入成本并跟踪盈亏，<b>不会真的下单</b>。' +
      '目的是帮你验证策略、复盘纪律。实际成交以券商账户为准。',
  }));
}
