/* ============================================================
   universe.js — 全市场快照 → 股票池过滤（基础链，所有策略共用）
   ------------------------------------------------------------
   基础过滤条件已「数据化」：默认值见 filters.js 的 BASE_RULE_DEFAULTS，
   用户可在设置页逐条开关 / 改阈值 / 追加自定义条件，
   保存进 settings.filterConfig，由 resolveFilterConfig 解析后在这里执行。
   策略专属过滤在 strategy.js，从本链末端续接。
   全部已用真实数据实测
   ============================================================ */

import { withDefaults } from './config.js';
import {
  resolveFilterConfig, runRules, ruleLabel, isST, isSuspended, marketOf,
  limitPct, isChiNext,
} from './filters.js';

// 以下判定统一由 filters.js 提供，这里原样转出，保持既有 import 路径可用
export { limitPct, isST, isSuspended, marketOf };

/** 一行快照 → 标准化的股票对象 */
export function normalizeStock(row) {
  const code = String(row.f12 || '');
  return {
    code,
    name: String(row.f14 || ''),
    price: typeof row.f2 === 'number' ? row.f2 : NaN,
    chgPct: typeof row.f3 === 'number' ? row.f3 : NaN,
    vol: typeof row.f5 === 'number' ? row.f5 : NaN,      // 手
    amount: typeof row.f6 === 'number' ? row.f6 : NaN,    // 元
    turnover: typeof row.f8 === 'number' ? row.f8 : NaN,  // %
    pe: typeof row.f9 === 'number' ? row.f9 : NaN,
    volRatio: typeof row.f10 === 'number' ? row.f10 : NaN,
    high: typeof row.f15 === 'number' ? row.f15 : NaN,
    low: typeof row.f16 === 'number' ? row.f16 : NaN,
    open: typeof row.f17 === 'number' ? row.f17 : NaN,
    prevClose: typeof row.f18 === 'number' ? row.f18 : NaN,
    mktCap: typeof row.f20 === 'number' ? row.f20 : NaN,      // 元
    floatCap: typeof row.f21 === 'number' ? row.f21 : NaN,    // 元
    pb: typeof row.f23 === 'number' ? row.f23 : NaN,
    mainInflow: typeof row.f62 === 'number' ? row.f62 : NaN,  // 元
    industry: String(row.f100 || ''),
    concepts: String(row.f103 || ''),
    market: marketOf(code),
  };
}

/**
 * 过滤统计器：记录每道过滤剔除了多少只，便于 UI 展示
 */
export class FilterStats {
  constructor() {
    this.steps = [];
    this.input = 0;
    this._section = '';
  }
  setInput(n) { this.input = n; }
  /** 切换分组标题：其后 add() 的每一步都会带上 section 标记，UI 据此插入小标题行 */
  section(title) {
    this._section = String(title || '');
    return this;
  }
  add(label, before, after) {
    this.steps.push({
      label,
      removed: before - after,
      remain: after,
      section: this._section,
    });
    return after;
  }
  get output() {
    for (let i = this.steps.length - 1; i >= 0; i--) {
      if (this.steps[i].label) return this.steps[i].remain;
    }
    return this.input;
  }
  clone() {
    const c = new FilterStats();
    c.input = this.input;
    c._section = this._section;
    c.steps = this.steps.map((s) => ({ ...s }));
    return c;
  }
}

/**
 * 复制一份过滤统计（能复制就复制，拿到的不是 FilterStats 时退化为新建）。
 * 策略专属过滤链从基础链的末尾续写，所以需要克隆而不是重算。
 */
export function cloneStats(stats) {
  if (stats && typeof stats.clone === 'function') return stats.clone();
  const s = new FilterStats();
  if (stats && typeof stats.input === 'number') s.setInput(stats.input);
  if (stats && Array.isArray(stats.steps)) s.steps = stats.steps.map((x) => ({ ...x }));
  return s;
}

/**
 * 构建股票池。
 * @param {Array} rawRows  快照原始行
 * @param {object} settings 设置（本金 / 只数 / filterConfig）
 * @returns {{ pool: Array, stats: FilterStats, budgetPerStock: number, filterConfig: object }}
 */
export function buildUniverse(rawRows, settings = {}) {
  const cfg = withDefaults(settings);
  const stats = new FilterStats();
  const rows = Array.isArray(rawRows) ? rawRows : [];
  stats.setInput(rows.length);
  stats.section('基础过滤（所有策略共用）');

  // 用户可配置的基础过滤链（默认值与顺序见 filters.js 的 BASE_RULE_DEFAULTS）
  const filterConfig = resolveFilterConfig(cfg.filterConfig, cfg);

  // 单只预算按「进攻档 80% 仓位 / 最多 N 只」的宽松上限估算，
  // 实际下单时再按当日档位精确计算。科创板（688）一手至少 200 股。
  const budgetPerStock = (cfg.capital * 0.80) / Math.max(1, cfg.maxPicks);
  const ctx = { budgetPerStock, topN: filterConfig.mainline.topN };

  // 1. 标准化（停牌 / 无报价的行无法标准化，必须先剔除且不可关闭）
  let cur = [];
  for (const r of rows) {
    if (!r || !r.f12) continue;
    if (isSuspended(r)) continue;
    cur.push(normalizeStock(r));
  }
  stats.add('剔除停牌/无报价', rows.length, cur.length);

  // 2. 逐条跑用户配置的基础过滤条件
  cur = runRules(cur, filterConfig.base, ctx, stats);

  return { pool: cur, stats, budgetPerStock, filterConfig };
}

/** 把池子转成 Map 便于查找 */
export function poolToMap(pool) {
  const m = new Map();
  for (const s of pool) m.set(s.code, s);
  return m;
}

/** 涨停价 / 跌停价（四舍五入到分） */
export function limitPrices(prevClose, code) {
  const lim = limitPct(code);
  const up = Math.round(prevClose * (1 + lim) * 100) / 100;
  const dn = Math.round(prevClose * (1 - lim) * 100) / 100;
  return { up, dn, lim };
}

/** 单条基础规则的可读标签（设置页预览用，避免重复实现） */
export { ruleLabel, isChiNext };
