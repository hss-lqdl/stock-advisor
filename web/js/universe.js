/* ============================================================
   universe.js — 全市场快照 → 股票池过滤（基础链 10 道，所有策略共用）
   策略专属过滤在 strategy.js，从本链末端续接
   全部已用真实数据实测
   ============================================================ */

import { DEFAULT_SETTINGS } from './store.js';

/* 涨停幅度按代码前缀区分：300/301/688 = 20%，其余 10% */
export function limitPct(code) {
  const c = String(code);
  if (c.startsWith('300') || c.startsWith('301') || c.startsWith('688')) return 0.20;
  return 0.10;
}

/** 是否是 ST / 退市 / 风险警示股 */
export function isST(name) {
  const n = String(name || '');
  return /ST|退|\*/.test(n);
}

/** 是否停牌（f2 返回字符串 "-"） */
export function isSuspended(row) {
  return typeof row.f2 !== 'number' || !isFinite(row.f2);
}

/** 代码所属市场标签 */
export function marketOf(code) {
  const c = String(code);
  if (c.startsWith('688')) return '科创板';
  if (c.startsWith('300') || c.startsWith('301')) return '创业板';
  if (c.startsWith('6')) return '沪市';
  if (c.startsWith('0')) return '深市';
  return '其他';
}

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
 * @param {object} settings 设置（本金等）
 * @returns {{ pool: Array, stats: FilterStats }}
 */
export function buildUniverse(rawRows, settings = {}) {
  const cfg = { ...DEFAULT_SETTINGS, ...settings };
  const stats = new FilterStats();
  const rows = Array.isArray(rawRows) ? rawRows : [];
  stats.setInput(rows.length);
  stats.section('基础过滤（所有策略共用）');

  // 标准化 + 剔除停牌（f2 为字符串 "-"）
  let cur = [];
  for (const r of rows) {
    if (!r || !r.f12) continue;
    if (isSuspended(r)) continue;
    cur.push(normalizeStock(r));
  }
  stats.add('剔除停牌/无报价', rows.length, cur.length);

  // 1. 非 ST / 非退市
  let before = cur.length;
  cur = cur.filter((s) => s.name && !isST(s.name));
  stats.add('剔除 ST / 退市', before, cur.length);

  // 2. 价格 > 2 元
  before = cur.length;
  cur = cur.filter((s) => isFinite(s.price) && s.price > 2);
  stats.add('剔除价格 ≤ 2 元', before, cur.length);

  // 3. 市值区间 20亿 ~ 800亿（总市值 f20）
  before = cur.length;
  const minCap = cfg.minMarketCap * 1e8;
  const maxCap = cfg.maxMarketCap * 1e8;
  cur = cur.filter((s) => isFinite(s.mktCap) && s.mktCap >= minCap && s.mktCap <= maxCap);
  stats.add(`市值 ${cfg.minMarketCap}亿~${cfg.maxMarketCap}亿`, before, cur.length);

  // 4. 成交额 ≥ 1 亿
  before = cur.length;
  cur = cur.filter((s) => isFinite(s.amount) && s.amount >= 1e8);
  stats.add('成交额 ≥ 1 亿', before, cur.length);

  // 5. 换手率 ≥ 0.5%
  before = cur.length;
  cur = cur.filter((s) => isFinite(s.turnover) && s.turnover >= 0.5);
  stats.add('换手率 ≥ 0.5%', before, cur.length);

  // 6. 剔除当日已涨停 / 一字板（买不进）
  before = cur.length;
  cur = cur.filter((s) => {
    if (!isFinite(s.chgPct) || !isFinite(s.prevClose)) return true;
    const lim = limitPct(s.code) * 100;
    // 涨幅接近涨停（留 0.3% 余量）
    if (s.chgPct >= lim - 0.3) return false;
    // 一字板：开=高=低=收 且涨幅接近涨停
    if (isFinite(s.open) && isFinite(s.high) && isFinite(s.low)) {
      const oneWord = Math.abs(s.open - s.high) < 1e-6 &&
                      Math.abs(s.high - s.low) < 1e-6 &&
                      s.chgPct >= lim - 0.5;
      if (oneWord) return false;
    }
    return true;
  });
  stats.add('剔除涨停/一字板', before, cur.length);

  // 7. 剔除跌停（卖出流动性差，且通常有雷）
  before = cur.length;
  cur = cur.filter((s) => {
    if (!isFinite(s.chgPct)) return true;
    const lim = limitPct(s.code) * 100;
    return s.chgPct > -(lim - 0.3);
  });
  stats.add('剔除跌停', before, cur.length);

  // 7.5 剔除创业板（300/301 开头）—— 用户要求不选创业板股票
  if (cfg.excludeChiNext) {
    before = cur.length;
    cur = cur.filter((s) => {
      const c = s.code;
      return !(c.startsWith('300') || c.startsWith('301'));
    });
    stats.add('剔除创业板', before, cur.length);
  }

  // 8. 一手成本 ≤ 单只预算（关键：5万本金下必须能买得起）
  //    单只预算按「进攻档 80% 仓位 / 最多 5 只」的宽松上限估算，
  //    实际下单时再按当日档位精确计算。科创板（688开头）一手至少 200 股。
  const budgetPerStock = (cfg.capital * 0.80) / Math.max(1, cfg.maxPicks);
  before = cur.length;
  cur = cur.filter((s) => {
    if (!isFinite(s.price)) return false;
    const lotSize = String(s.code).startsWith('688') ? 200 : 100;
    return s.price * lotSize <= budgetPerStock;
  });
  stats.add(`一手成本 ≤ ${Math.round(budgetPerStock)} 元`, before, cur.length);

  // 9. 剔除北交所 / 非沪深标的（范围已由 fs 限制，这里兜底）
  before = cur.length;
  cur = cur.filter((s) => {
    const c = s.code;
    return c.startsWith('6') || c.startsWith('0') || c.startsWith('3');
  });
  stats.add('仅保留沪深标的', before, cur.length);

  return { pool: cur, stats, budgetPerStock };
}

/** 把池子转成 Map 便于查找 */
export function poolToMap(pool) {
  const m = new Map();
  for (const s of pool) m.set(s.code, s);
  return m;
}

/** 按代码前缀判断是否可 20% 涨跌 */
export function isStarOrGem(code) {
  const c = String(code);
  return c.startsWith('300') || c.startsWith('301') || c.startsWith('688');
}

/** 涨停价 / 跌停价（四舍五入到分） */
export function limitPrices(prevClose, code) {
  const lim = limitPct(code);
  const up = Math.round(prevClose * (1 + lim) * 100) / 100;
  const dn = Math.round(prevClose * (1 - lim) * 100) / 100;
  return { up, dn, lim };
}
