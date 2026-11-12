/* ============================================================
   views/settings.js — Tab 5 设置：本金/策略/参数/回测/数据管理/说明
   ============================================================ */

import {
  el, esc, fmtInt, fmtPctRaw, fmtMoney, fmtPct, toast, switchRow,
  openSheet, closeSheet, copyText, timeAgo, fmtDuration,
} from '../ui.js';
import { drawEquityCurve } from '../charts.js';
import {
  settingsLoad, settingsSave, clearCache, storageEstimate,
  klinesCount, positionsClear, DEFAULT_SETTINGS,
} from '../store.js';
import { STRATEGIES, strategyFilter } from '../strategy.js';
import { TAIL_HHMM } from '../constants.js';
import { resolveFilterConfig, serializeConfig, setRule } from '../filters.js';
import { runBacktest, runBacktestMatrix } from '../backtest.js';
import { buildFilterEditorCard } from './settings-filter.js';

const renderVersions = new WeakMap();

/** 输入项 */
function field(label, hint, inputNode) {
  return el('div', { class: 'field' }, [
    el('label', { text: label }),
    inputNode,
    hint ? el('div', { class: 'hint', text: hint }) : null,
  ]);
}

/**
 * 取「基础过滤」那一段结束时的剩余只数 —— 即股票池规模（不含主线/策略门槛）。
 * 兼容旧版数据：旧版 steps 没有 section 字段，此时全部步骤同属一段，取最后一步。
 */
function baseSectionOutput(steps, input) {
  const n = Number(input) || 0;
  if (!Array.isArray(steps) || !steps.length) return n;
  const first = steps[0].section || '';
  let out = n;
  for (const st of steps) {
    if ((st.section || '') !== first) break;
    if (st.label) out = st.remain;
  }
  return out;
}

/** 回测结果弹层 */
function showBacktest(r) {
  const node = el('div');
  node.append(el('div', { class: 'sheet-title' }, [
    '回测结果',
    el('span', { class: 'cd', text: r.dateRange ? r.dateRange.join(' → ') : '' }),
  ]));

  if (r.error) {
    node.append(el('div', { class: 'err-box', text: r.error }));
    openSheet(node);
    return;
  }

  const stats = el('div', { class: 'stats' });
  const items = [
    ['交易次数', String(r.tradeCount)],
    ['平均收益', fmtPctRaw(r.avgRet * 100)],
    ['胜率', (r.winRate * 100).toFixed(1) + '%'],
    ['盈亏比', r.profitFactor.toFixed(2)],
    ['最大回撤', (r.maxDD * 100).toFixed(1) + '%'],
    ['累计收益', fmtPctRaw(r.totalReturn * 100)],
  ];
  for (const [k, v] of items) {
    stats.append(el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v small', text: v }),
    ]));
  }
  node.append(stats);

  // 净值曲线
  if (r.equity && r.equity.length > 2) {
    node.append(el('div', { class: 'sec-title', text: '净值曲线' }));
    const box = el('div', { class: 'chart-box' });
    const canvas = el('canvas');
    box.append(canvas);
    node.append(box);
    requestAnimationFrame(() => drawEquityCurve(canvas, r.equity, { height: 160 }));
  }

  // 最近交易
  if (r.recent && r.recent.length) {
    node.append(el('div', { class: 'sec-title', text: '最近交易' }));
    const tbl = el('table', { class: 'tbl' });
    tbl.append(el('thead', {}, [el('tr', {}, [
      el('th', { text: '股票' }),
      el('th', { text: '买入' }),
      el('th', { text: '卖出' }),
      el('th', { text: '收益' }),
    ])]));
    const tb = el('tbody');
    for (const t of r.recent) {
      tb.append(el('tr', {}, [
        el('td', {}, [
          el('div', { class: 'nm', text: t.name }),
          el('div', { class: 'cd', text: t.code }),
        ]),
        el('td', { class: 'mono', text: t.buyPrice.toFixed(2) }),
        el('td', { class: 'mono', text: t.sellPrice.toFixed(2) }),
        el('td', { class: 'mono ' + (t.ret > 0 ? 'up' : 'down'), text: fmtPctRaw(t.ret * 100) }),
      ]));
    }
    tbl.append(tb);
    node.append(tbl);
  }

  node.append(el('div', { class: 'disclaimer mt14', text: r.warning }));
  openSheet(node);
}

/** 回测矩阵对比 */
function showBacktestMatrix(list) {
  const node = el('div');
  node.append(el('div', { class: 'sheet-title', text: '参数对比' }));

  const tbl = el('table', { class: 'tbl' });
  tbl.append(el('thead', {}, [el('tr', {}, [
    el('th', { text: '参数' }),
    el('th', { text: '次数' }),
    el('th', { text: '胜率' }),
    el('th', { text: '均收益' }),
    el('th', { text: '回撤' }),
  ])]));
  const tb = el('tbody');
  for (const r of list) {
    if (r.error) {
      tb.append(el('tr', {}, [
        el('td', { text: r.label }),
        el('td', { colspan: '4', class: 'dim', text: r.error }),
      ]));
      continue;
    }
    tb.append(el('tr', {}, [
      el('td', { text: r.label }),
      el('td', { class: 'mono', text: String(r.tradeCount) }),
      el('td', { class: 'mono', text: (r.winRate * 100).toFixed(1) + '%' }),
      el('td', { class: 'mono ' + (r.avgRet > 0 ? 'up' : 'down'), text: fmtPctRaw(r.avgRet * 100) }),
      el('td', { class: 'mono down', text: (r.maxDD * 100).toFixed(1) + '%' }),
    ]));
  }
  tbl.append(tb);
  node.append(tbl);
  node.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>如何看回测：</b>胜率 45%~60% 属正常区间，关键看<b>盈亏比</b>与<b>最大回撤</b>。' +
      '若均收益为正且回撤可控，说明策略有正期望；若胜率很高但均收益接近 0，说明被手续费吃掉了。',
  }));
  openSheet(node);
}

/**
 * 渲染设置 Tab
 * @param {HTMLElement} root
 * @param {object} ctx { result, state, onReload, onAnalyze }
 */
export async function renderSettings(root, ctx) {
  const renderVersion = (renderVersions.get(root) || 0) + 1;
  renderVersions.set(root, renderVersion);
  const scrollY = window.scrollY;
  root.innerHTML = '';

  const s = await settingsLoad();
  if (renderVersions.get(root) !== renderVersion) return;

  /* ---------- 基本设置 ---------- */
  const basic = el('div', { class: 'card settings-basic' });
  basic.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '交易设置' }),
  ]));

  const capitalInput = el('input', {
    class: 'input', type: 'number', inputmode: 'decimal',
    value: String(s.capital),
  });
  capitalInput.addEventListener('change', async () => {
    const v = parseFloat(capitalInput.value);
    if (!(v >= 1000)) { toast('本金至少 1000 元'); capitalInput.value = String(s.capital); return; }
    await settingsSave({ capital: v });
    toast('已保存，重新分析后生效');
    if (ctx.onAnalyze) ctx.onAnalyze();
  });
  basic.append(field('本金（元）',
    '用于计算每只股票的买入股数。5 万元在 60% 仓位下每只约 6000 元。', capitalInput));

  const stratSel = el('select', { class: 'select' });
  for (const [k, v] of Object.entries(STRATEGIES)) {
    const opt = el('option', { value: k, text: v.name });
    if (k === s.strategy) opt.selected = true;
    stratSel.append(opt);
  }

  // 策略专属过滤链的可读描述（切换策略时即时更新；反映用户自定义后的实际条件）
  const stratHintNode = el('div', { class: 'hint' });
  const refreshStratHint = (key) => {
    const cfg = resolveFilterConfig(s.filterConfig, s);
    const def = strategyFilter(key, cfg, {
      budgetPerStock: (s.capital * 0.8) / Math.max(1, s.maxPicks),
      topN: cfg.mainline.topN,
    });
    const desc = STRATEGIES[key] ? STRATEGIES[key].desc : '';
    const s1 = (def.stage1 || []).map((f) => f.label).join('、') || '无';
    const s2 = (def.stage2 || []).map((f) => f.label).join('、') || '无';
    stratHintNode.innerHTML =
      esc(desc) +
      '<br><b>快照门槛：</b>' + esc(s1) +
      '<br><b>因子门槛：</b>' + esc(s2) +
      '<br><span class="dim">可在下方「过滤条件设置」里逐条开关或修改。</span>';
  };
  refreshStratHint(s.strategy);

  stratSel.addEventListener('change', async () => {
    s.strategy = stratSel.value;
    refreshStratHint(s.strategy);
    await settingsSave({ strategy: stratSel.value });
    // 立即按新策略重算：股票池、专属门槛、打分、计划一次性同步
    if (ctx.onAnalyze) await ctx.onAnalyze();
    else toast('策略已切换，重新分析后生效');
  });
  basic.append(el('div', { class: 'field' }, [
    el('label', { text: '选股策略' }),
    stratSel,
    stratHintNode,
  ]));

  const picksSel = el('select', { class: 'select' });
  for (const n of [3, 4, 5]) {
    const opt = el('option', { value: String(n), text: n + ' 只' });
    if (n === s.maxPicks) opt.selected = true;
    picksSel.append(opt);
  }
  picksSel.addEventListener('change', async () => {
    await settingsSave({ maxPicks: parseInt(picksSel.value, 10) });
    toast('已保存');
    if (ctx.onAnalyze) ctx.onAnalyze();
  });
  basic.append(field('最多推荐只数',
    '实际只数还会受大盘档位限制（冰点档最多 3 只）。', picksSel));

  const capInput = el('input', {
    class: 'input', type: 'number', inputmode: 'decimal',
    value: String(s.maxMarketCap),
  });
  capInput.addEventListener('change', async () => {
    const v = parseFloat(capInput.value);
    if (!(v > 0)) return;
    // 市值上限现在是「基础过滤」里的一条可编辑条件，这里同步写进 filterConfig，
    // 否则一旦用户动过过滤条件，旧的 maxMarketCap 字段就不再被读取。
    const cfg = resolveFilterConfig(s.filterConfig, s);
    cfg.base = setRule(cfg.base, 'marketCap', { value2: v });
    await settingsSave({ maxMarketCap: v, filterConfig: serializeConfig(cfg) });
    toast('已保存，重新分析后生效');
    if (ctx.onAnalyze) ctx.onAnalyze();
  });
  basic.append(field('市值上限（亿元）',
    '只保留总市值不超过该值的股票。也可在下方「过滤条件设置」里精细调整。', capInput));

  root.append(basic);

  /* ---------- 过滤条件设置（可开关 / 可编辑 / 可自定义） ---------- */
  root.append(buildFilterEditorCard(s, ctx));

  /* ---------- 开关 ---------- */
  const toggleCard = el('div', { class: 'card settings-toggles' });
  toggleCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '功能开关' }),
  ]));
  toggleCard.append(switchRow('尾盘模式', TAIL_HHMM + ' 自动进入尾盘刷新，实时重算推荐', s.tailMode, async (v) => {
    await settingsSave({ tailMode: v });
    toast(v ? '尾盘模式已开启' : '尾盘模式已关闭');
  }));
  toggleCard.append(switchRow('计算手续费', '买入清单中显示佣金与过户费', s.costModel, async (v) => {
    await settingsSave({ costModel: v });
  }));
  toggleCard.append(switchRow('显示风险提示', '在每个推荐页底部显示风险说明', s.showDisclaimer, async (v) => {
    await settingsSave({ showDisclaimer: v });
  }));
  root.append(toggleCard);

  /* ---------- 回测 ---------- */
  const btCard = el('div', { class: 'card settings-backtest' });
  btCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '策略回测' }),
    el('div', { class: 'card-sub', text: '验证历史表现' }),
  ]));
  btCard.append(el('div', {
    class: 'dim',
    style: { lineHeight: '1.7', fontSize: '12.5px' },
    text: '用本地缓存的 K 线，逐日滚动回放最近 60 个交易日：每天按当日因子打分选出 TOP N，T+1 开盘买入，持有 N 日后开盘卖出。',
  }));

  const btBtnRow = el('div', { class: 'pick-actions mt14' });
  const btSingle = el('button', { class: 'btn btn-primary btn-sm', text: '单次回测' });
  const btMatrix = el('button', { class: 'btn btn-ghost btn-sm', text: '参数对比' });
  btBtnRow.append(btSingle, btMatrix);
  btCard.append(btBtnRow);

  const doBacktest = async (matrix) => {
    if (!ctx.state || !ctx.state.klines || !ctx.state.klines.size) {
      toast('请先加载数据');
      return;
    }
    toast('回测计算中…');
    await new Promise((r) => setTimeout(r, 60));
    try {
      const stocks = (ctx.state.pool || []).map((x) => ({
        code: x.code, name: x.name, industry: x.industry,
        mainScore: x.mainScore, mainNames: x.mainNames,
      }));
      const opt = {
        klines: ctx.state.klines,
        stocks,
        days: 60,
        holdDays: 3,
        topN: s.maxPicks,
        strategy: s.strategy,
      };
      if (matrix) {
        showBacktestMatrix(runBacktestMatrix(opt));
      } else {
        showBacktest(runBacktest(opt));
      }
    } catch (e) {
      toast('回测失败：' + e.message);
    }
  };
  btSingle.addEventListener('click', () => doBacktest(false));
  btMatrix.addEventListener('click', () => doBacktest(true));

  btCard.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>回测局限：</b>股票池来自当前快照，历史上已退市或被剔除的股票未参与，存在<b>幸存者偏差</b>；' +
      '未计入滑点与冲击成本。回测结果仅用于验证逻辑，不代表未来收益。',
  }));
  root.append(btCard);

  /* ---------- 数据管理 ---------- */
  const dataCard = el('div', { class: 'card settings-data' });
  dataCard.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '数据管理' }),
  ]));

  let est = null;
  let klCount = 0;
  try {
    est = await storageEstimate();
    klCount = await klinesCount();
  } catch (e) { /* ignore */ }

  // poolStats 从 IndexedDB 恢复后 output getter 会丢失，两处都要兜底推导
  const rps = (ctx.result && ctx.result.poolStats) || {};
  const poolOut = Number.isFinite(rps.output)
    ? rps.output
    : (Array.isArray(rps.steps) && rps.steps.length
      ? Number(rps.steps[rps.steps.length - 1].remain) || 0
      : Number(rps.input) || 0);
  const universeSize = Number.isFinite(ctx.result && ctx.result.universeSize)
    ? ctx.result.universeSize
    : baseSectionOutput(rps.steps, rps.input);

  const dataStats = el('div', { class: 'stats' });
  dataStats.append(el('div', { class: 'stat' }, [
    el('div', { class: 'k', text: 'K线缓存' }),
    el('div', { class: 'v small', text: fmtInt(klCount) + ' 只' }),
  ]));
  dataStats.append(el('div', { class: 'stat' }, [
    el('div', { class: 'k', text: '占用空间' }),
    el('div', { class: 'v small', text: est ? fmtMoney(est.usage) + 'B' : '--' }),
  ]));
  if (ctx.result) {
    dataStats.append(el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '股票池' }),
      el('div', { class: 'v small', text: fmtInt(universeSize) + ' 只' }),
      el('div', { class: 's', text: '基础过滤后' }),
    ]));
    dataStats.append(el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '候选标的' }),
      el('div', { class: 'v small', text: fmtInt(poolOut) + ' 只' }),
      el('div', { class: 's', text: ctx.result.strategyName || '策略过滤后' }),
    ]));
    dataStats.append(el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: '数据时间' }),
      el('div', { class: 'v small', text: timeAgo(ctx.result.loadedAt) }),
    ]));
  }
  dataCard.append(dataStats);

  const dataBtns = el('div', { class: 'pick-actions mt14' }, [
    el('button', {
      class: 'btn btn-primary btn-sm',
      text: '立即全量刷新',
      onclick: () => { if (ctx.onReload) ctx.onReload(true); },
    }),
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '清空缓存',
      onclick: async () => {
        if (!confirm('确认清空所有缓存数据？（持仓记录不受影响）')) return;
        await clearCache();
        toast('缓存已清空');
        if (ctx.onReload) ctx.onReload(true);
      },
    }),
  ]);
  dataCard.append(dataBtns);

  dataCard.append(el('div', { class: 'pick-actions mt10' }, [
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '清空持仓记录',
      onclick: async () => {
        if (!confirm('确认清空所有模拟持仓？')) return;
        await positionsClear();
        toast('持仓已清空');
        if (ctx.onChanged) ctx.onChanged();
      },
    }),
  ]));
  root.append(dataCard);

  /* ---------- 股票池过滤明细（按策略分组） ---------- */
  if (ctx.result && ctx.result.poolStats && ctx.result.poolStats.steps) {
    const ps = ctx.result.poolStats;
    const stName = ctx.result.strategyName || '当前策略';
    const filterCard = el('div', { class: 'card settings-filter-details' });
    filterCard.append(el('div', { class: 'card-hd' }, [
      el('div', { class: 'card-title', text: `股票池过滤明细 · ${stName}` }),
      el('div', { class: 'card-sub', text: `最终候选 ${fmtInt(poolOut)} 只` }),
    ]));

    const tbl = el('table', { class: 'tbl' });
    tbl.append(el('thead', {}, [el('tr', {}, [
      el('th', { text: '过滤条件' }),
      el('th', { text: '剔除' }),
      el('th', { text: '剩余' }),
    ])]));
    const tb = el('tbody');
    tb.append(el('tr', {}, [
      el('td', { text: '全市场' }),
      el('td', { class: 'mono dim', text: '--' }),
      el('td', { class: 'mono', text: fmtInt(ps.input) }),
    ]));

    let lastSection = '';
    for (const st of ps.steps) {
      const sec = st.section || '';
      if (sec && sec !== lastSection) {
        lastSection = sec;
        tb.append(el('tr', { class: 'row-sec' }, [
          el('td', { colspan: '3', text: sec }),
        ]));
      }
      // removed < 0 表示保底放宽（把门槛撤掉后池子变大），显示成 +N 更直观
      const delta = st.removed > 0 ? '-' + st.removed
        : st.removed < 0 ? '+' + (-st.removed) : '0';
      tb.append(el('tr', {}, [
        el('td', { text: st.label }),
        el('td', {
          class: 'mono ' + (st.removed > 0 ? 'down' : st.removed < 0 ? 'up' : 'dim'),
          text: delta,
        }),
        el('td', { class: 'mono', text: fmtInt(st.remain) }),
      ]));
    }
    tbl.append(tb);
    filterCard.append(tbl);

    // 保底放宽提示
    if (ctx.result.relaxed) {
      filterCard.append(el('div', {
        class: 'disclaimer mt10',
        text: '本次因满足门槛的标的不足，已自动放宽部分门槛以保证有票可选。'
          + '这通常出现在普跌或极端缩量行情，此时应降低仓位、谨慎操作。',
      }));
    }

    // 五策略初筛候选对比
    const counts = ctx.result.strategyPoolCounts;
    if (counts && typeof counts === 'object') {
      filterCard.append(el('div', { class: 'sec-title mt14', text: '各策略初筛候选数对比' }));
      const cmp = el('table', { class: 'tbl' });
      cmp.append(el('thead', {}, [el('tr', {}, [
        el('th', { text: '策略' }),
        el('th', { text: '初筛候选' }),
      ])]));
      const ctb = el('tbody');
      for (const [k, v] of Object.entries(STRATEGIES)) {
        const cur = k === ctx.result.strategy;
        ctb.append(el('tr', {}, [
          el('td', {
            text: v.name + (cur ? '（当前）' : ''),
            style: cur ? { color: 'var(--accent, #4f8cff)', fontWeight: '600' } : null,
          }),
          el('td', { class: 'mono', text: fmtInt(counts[k] || 0) + ' 只' }),
        ]));
      }
      cmp.append(ctb);
      filterCard.append(cmp);
      filterCard.append(el('div', {
        class: 'dim tiny mt10',
        text: '初筛候选 = 基础池 → 主线门槛 → 该策略的快照级门槛（不含需要 K 线的因子门槛）。'
          + '切换策略后本表会按该策略重算。',
      }));
    }

    root.append(filterCard);
  }

  /* ---------- 关于与风险提示 ---------- */
  const about = el('div', { class: 'card settings-about' });
  about.append(el('div', { class: 'card-hd' }, [
    el('div', { class: 'card-title', text: '关于' }),
  ]));
  const stratNames = Object.values(STRATEGIES).map((v) => v.name).join(' / ');
  about.append(el('div', {
    style: { fontSize: '12.5px', lineHeight: '1.8', color: 'var(--txt-2)' },
    html:
      '<b>A股每日买入计划</b> · 版本 1.0<br>' +
      '数据来源：东方财富公开行情接口<br>' +
      '运行方式：本地 PWA，数据全部存在手机本地（IndexedDB），不上传任何信息<br>' +
      '分析范围：沪深 A 股（剔除 ST、退市、停牌、低流动性、创业板），总市值 20 亿–800 亿<br>' +
      '选股策略：' + esc(stratNames) + ' —— ' +
      '每个策略有各自的股票池过滤门槛与实际打分权重，可在上方「过滤条件设置」里逐条开关、改阈值或添加自定义条件',
  }));

  about.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>风险提示：</b>本工具仅提供基于公开数据的量化参考，<b>不构成投资建议</b>。' +
      '股市有风险，入市需谨慎。任何买卖决策及盈亏由使用者自行承担。' +
      '历史表现不代表未来收益。请勿将全部资金投入单一策略。',
  }));

  about.append(el('div', { class: 'pick-actions mt14' }, [
    el('button', {
      class: 'btn btn-ghost btn-sm',
      text: '安装到主屏幕说明',
      onclick: () => showInstallGuide(),
    }),
  ]));
  root.append(about);

  root.append(el('div', { class: 'center dim tiny', style: { padding: '8px 0 16px' }, text: 'v1.0 · 本地离线运行' }));
  requestAnimationFrame(() => window.scrollTo(0, scrollY));
}

/** 安装说明 */
export function showInstallGuide() {
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  const node = el('div');
  node.append(el('div', { class: 'sheet-title', text: '安装到手机主屏幕' }));

  if (isIOS) {
    node.append(el('div', {
      style: { fontSize: '13.5px', lineHeight: '2', color: 'var(--txt-1)' },
      html:
        '1. 用 <b>Safari</b> 打开本页（必须 Safari，微信内不支持）<br>' +
        '2. 点击底部中间的 <b>分享按钮</b>（方框向上箭头）<br>' +
        '3. 向下滑动，选择 <b>「添加到主屏幕」</b><br>' +
        '4. 点右上角「添加」<br>' +
        '5. 回到桌面，点「A股计划」图标即可像 App 一样全屏使用',
    }));
  } else {
    node.append(el('div', {
      style: { fontSize: '13.5px', lineHeight: '2', color: 'var(--txt-1)' },
      html:
        '1. 用 Chrome / Edge 打开本页<br>' +
        '2. 点击地址栏右侧的 <b>安装图标</b><br>' +
        '3. 或菜单 → <b>「安装应用」/「添加到主屏幕」</b>',
    }));
  }

  node.append(el('div', {
    class: 'disclaimer mt14',
    html: '<b>提示：</b>添加到主屏幕后，即使断网也能打开（已缓存），' +
      '但行情数据需要联网才能刷新。',
  }));

  openSheet(node);
}
