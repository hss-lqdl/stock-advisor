/* ============================================================
   plan.js — 买入计划生成：委托价 / 股数 / 止损止盈 / 费用 / 条件单参数
   全部公式均已在真实数据上验证
   ============================================================ */

import { limitPrices } from './universe.js';
import { TAIL_WINDOW_TEXT, TAIL_HHMM } from './constants.js';

/** 佣金费率（万分之2.5，最低 5 元） */
export const COMMISSION_RATE = 0.00025;
export const COMMISSION_MIN = 5;
/** 过户费（万分之0.1，双向） */
export const TRANSFER_RATE = 0.00001;
/** 印花税（千分之0.5，仅卖出） */
export const STAMP_RATE = 0.0005;

/** 买入费用 */
export function buyFee(amount) {
  const comm = Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);
  const transfer = amount * TRANSFER_RATE;
  return { commission: comm, transfer, total: comm + transfer };
}

/** 卖出费用（含印花税） */
export function sellFee(amount) {
  const comm = Math.max(COMMISSION_MIN, amount * COMMISSION_RATE);
  const transfer = amount * TRANSFER_RATE;
  const stamp = amount * STAMP_RATE;
  return { commission: comm, transfer, stamp, total: comm + transfer + stamp };
}

/** 四舍五入到分 */
function r2(v) {
  return Math.round(v * 100) / 100;
}

/**
 * 计算委托价：在最新价基础上上浮 0.8% 以确保成交，但不超过涨停价下方。
 * @param {number} price 最新价
 * @param {number} prevClose 昨收
 * @param {string} code
 * @returns {{bid:number, upLimit:number, downLimit:number, lim:number}}
 */
export function calcBid(price, prevClose, code) {
  const { up, dn, lim } = limitPrices(prevClose, code);
  let bid = Math.min(r2(price * 1.008), r2(up * 0.995));
  bid = Math.max(bid, r2(dn * 1.005));
  // 不低于最新价（避免挂到下方）
  bid = Math.max(bid, r2(price));
  return { bid, upLimit: up, downLimit: dn, lim };
}

/** 排板单的止损上限：委托价挂在涨停价、次日容易低开，止损必须比普通单更紧 */
export const QUEUE_MAX_LOSS = 0.04;

/**
 * 计算止损价：取「5% 止损 / 近 5 日最低下方 2% / ATR×2」三者最宽（最低价），
 * 但最大亏损不超过 maxLossPct（普通单 8%，排板单 4%）。
 */
export function calcStop(bid, low5, atr, maxLossPct = 0.08) {
  const candidates = [bid * 0.95];
  if (isFinite(low5) && low5 > 0) candidates.push(low5 * 0.98);
  if (isFinite(atr) && atr > 0) candidates.push(bid - atr * 2);
  let stop = Math.min(...candidates);            // 最宽
  stop = Math.max(stop, bid * (1 - maxLossPct)); // 亏损上限
  stop = Math.min(stop, bid * 0.985);            // 至少 -1.5%（避免贴脸止损）
  return r2(stop);
}

/** 计算股数（100 股一手，科创板 688 为 200 股起） */
export function calcShares(perStockBudget, bid, code) {
  if (!isFinite(bid) || bid <= 0) return 0;
  const lotSize = String(code).startsWith('688') ? 200 : 100;
  const raw = perStockBudget / bid;
  const lots = Math.floor(raw / lotSize);
  return Math.max(0, lots * lotSize);
}

/**
 * 生成单只股票的完整买入计划。
 * @param {object} stock 含 code/name/price/prevClose 及因子
 * @param {object} opt { perStockBudget, atr, low5, level, capital }
 * @returns {object}
 */
export function buildPlan(stock, opt = {}) {
  const code = String(stock.code);
  const price = stock.price;
  const prevClose = stock.prevClose;

  if (!isFinite(price) || price <= 0 || !isFinite(prevClose) || prevClose <= 0) {
    return null;
  }

  const { up, dn, lim } = limitPrices(prevClose, code);
  const isQueue = Boolean(
    stock.sealed ||
    (price >= up * 0.998) ||
    (opt.strategyKey === 'limitup' && (stock.sealed || (isFinite(stock.chgPct) && stock.chgPct >= lim * 100 - 0.5)))
  );

  let bid = isQueue ? up : Math.min(r2(price * 1.008), r2(up * 0.995));
  if (!isQueue) {
    bid = Math.max(bid, r2(dn * 1.005));
    bid = Math.max(bid, r2(price));
  }
  const upLimit = up;
  const downLimit = dn;
  const stop = calcStop(bid, opt.low5, opt.atr, isQueue ? QUEUE_MAX_LOSS : 0.08);
  const tp1 = r2(bid * 1.06);
  const tp2 = r2(bid * 1.12);

  const budget = opt.perStockBudget || 0;
  const shares = calcShares(budget, bid, code);
  const amount = r2(shares * bid);
  const fee = buyFee(amount);

  // 风险收益比
  const riskPerShare = bid - stop;
  const rewardPerShare = tp1 - bid;
  const rr = riskPerShare > 0 ? rewardPerShare / riskPerShare : 0;

  // 最大亏损（含费用）
  const maxLoss = r2(shares * riskPerShare + fee.total);

  return {
    code,
    name: stock.name,
    price,
    prevClose,
    bid,
    upLimit,
    downLimit,
    lim,
    shares,
    lots: Math.floor(shares / (code.startsWith('688') ? 200 : 100)),
    amount,
    fee: r2(fee.total),
    feeDetail: fee,
    stop,
    stopPct: r2(((stop - bid) / bid) * 100),
    tp1,
    tp1Pct: r2(((tp1 - bid) / bid) * 100),
    tp2,
    tp2Pct: r2(((tp2 - bid) / bid) * 100),
    rr: Math.round(rr * 100) / 100,
    maxLoss,
    affordable: shares > 0,
    queue: isQueue,
    queueNote: isQueue ? '涨停排板，封单靠前才可能成交' : '',
    // 用于 UI 的衍生信息
    score: stock.score,
    mainNames: stock.mainNames || [],
    industry: stock.industry || '',
    factors: stock.factors || {},
    reason: stock.reason || '',
    // 预期盈亏（到止盈1）
    expectProfit: r2(shares * rewardPerShare - fee.total - sellFee(r2(shares * tp1)).total),
  };
}

/**
 * 根据大盘档位与本金，生成整份买入计划。
 * @param {Array} picks 已排序并过约束的候选（含因子）
 * @param {object} ctx { capital, level, market, klines(Map) }
 */
export function buildDailyPlan(picks, ctx = {}) {
  const capital = ctx.capital || 50000;
  const level = ctx.level;
  const n = picks.length;
  if (!n) return { items: [], totalAmount: 0, cashLeft: capital };

  const totalBudget = capital * (level ? level.position : 0.6);
  const perStockBudget = totalBudget / n;

  const items = [];
  for (const p of picks) {
    const kl = ctx.klines ? ctx.klines.get(String(p.code)) : null;
    let atr = p.atr;
    let low5 = NaN;
    if (kl && kl.n >= 6) {
      if (!isFinite(atr)) atr = p.atr;
      let lo = Infinity;
      for (let i = kl.n - 5; i < kl.n; i++) if (kl.low[i] < lo) lo = kl.low[i];
      low5 = lo;
    }
    const item = buildPlan(p, { perStockBudget, atr, low5, level, capital, strategyKey: ctx.strategyKey });
    if (item) {
      item.perStockBudget = perStockBudget;
      items.push(item);
    }
  }

  // 剔除买不起的（股数 0）
  const affordable = items.filter((x) => x.affordable);
  const totalAmount = affordable.reduce((s, x) => s + x.amount, 0);
  const totalFee = affordable.reduce((s, x) => s + x.fee, 0);

  return {
    items: affordable,
    unaffordable: items.filter((x) => !x.affordable),
    totalAmount: r2(totalAmount),
    totalFee: r2(totalFee),
    cashLeft: r2(capital - totalAmount - totalFee),
    positionPct: r2(((totalAmount + totalFee) / capital) * 100),
    perStockBudget: r2(perStockBudget),
    totalBudget: r2(totalBudget),
    capital,
    level: level ? level.key : 'neutral',
  };
}

/* ---------------- 一键复制清单（同花顺/券商 App 照单下单） ---------------- */

/**
 * 生成纯文本下单清单，可直接粘贴到微信/备忘录，对照同花顺手动下单。
 */
export function buildCopyText(plan, meta = {}) {
  const lines = [];
  const d = meta.date || '';
  lines.push(`【A股买入计划】${d}`);
  if (meta.levelName) lines.push(`市场档位：${meta.levelName}（评分 ${meta.score ?? '--'}）`);
  lines.push(`本金 ${plan.capital} 元 · 计划仓位 ${plan.positionPct}% · 合计 ${plan.totalAmount} 元`);
  lines.push('—————————————');

  plan.items.forEach((it, i) => {
    lines.push(`${i + 1}. ${it.name} ${it.code}`);
    lines.push(`   委托价 ${it.bid.toFixed(2)} 元（现价 ${it.price.toFixed(2)}）${it.queue ? ' 【排板单】' : ''}`);
    lines.push(`   买入 ${it.shares} 股 ≈ ${it.amount.toFixed(0)} 元`);
    lines.push(`   止损 ${it.stop.toFixed(2)}（${it.stopPct}%）  止盈 ${it.tp1.toFixed(2)}（+6%）/ ${it.tp2.toFixed(2)}（+12%）`);
    if (it.mainNames && it.mainNames.length) {
      lines.push(`   主线：${it.mainNames.slice(0, 2).join('、')}`);
    }
  });

  lines.push('—————————————');
  lines.push(`合计买入 ${plan.totalAmount} 元，手续费约 ${plan.totalFee} 元，剩余 ${plan.cashLeft} 元`);
  if (plan.items.some((it) => it.queue)) {
    lines.push('提示：排板单以涨停价委托，封板后尽早挂单排队（早盘封板宜开盘即挂，尾盘回封宜回封瞬间挂），封单靠前才可能成交；炸板未成交请撤单。');
  }
  if (plan.items.some((it) => !it.queue)) {
    lines.push(`提示：普通单${TAIL_WINDOW_TEXT} 挂单；价格可挂高 0.5%~1% 确保成交。`);
  }
  return lines.join('\n');
}

/* ---------------- 条件单参数表（同花顺条件单照抄） ---------------- */

/**
 * 生成同花顺「条件单」可用的参数数组。
 * 同花顺支持的条件单类型：
 *  - 价格条件单：股价 ≥ / ≤ 某价格时委托
 *  - 止盈止损单：达到盈利%或亏损%时市价卖出
 */
export function buildConditionOrders(plan) {
  const rows = [];
  for (const it of plan.items) {
    rows.push({
      code: it.code,
      name: it.name,
      type: '买入',
      condition: it.queue ? `涨停价 ${it.bid.toFixed(2)} 元排板` : `股价 ≤ ${it.bid.toFixed(2)} 元`,
      action: `买入 ${it.shares} 股`,
      note: it.queue
        ? `封板后尽早以涨停价 ${it.bid.toFixed(2)} 挂单排队，炸板未成交撤单`
        : `尾盘 ${TAIL_HHMM} 后设置，委托价 ${it.bid.toFixed(2)}`,
    });
    rows.push({
      code: it.code,
      name: it.name,
      type: '止盈',
      condition: `盈利 ≥ 6%（${it.tp1.toFixed(2)} 元）`,
      action: `卖出 ${Math.floor(it.shares / 2)} 股`,
      note: '第一目标位减半仓',
    });
    rows.push({
      code: it.code,
      name: it.name,
      type: '止损',
      condition: `亏损 ≥ ${Math.abs(it.stopPct).toFixed(1)}%（${it.stop.toFixed(2)} 元）`,
      action: `卖出 ${it.shares} 股`,
      note: '跌破止损位无条件离场',
    });
  }
  return rows;
}

/**
 * 生成条件单纯文本
 */
export function buildConditionText(plan) {
  const rows = buildConditionOrders(plan);
  const lines = ['【同花顺条件单设置清单】'];
  let lastCode = '';
  for (const r of rows) {
    if (r.code !== lastCode) {
      lines.push('');
      lines.push(`■ ${r.name} ${r.code}`);
      lastCode = r.code;
    }
    lines.push(`  [${r.type}] ${r.condition} → ${r.action}`);
  }
  lines.push('');
  lines.push('操作路径：同花顺 → 交易 → 条件单 → 新建 → 选择股票 → 设置触发条件');
  return lines.join('\n');
}

/* ---------------- 持仓跟踪 ---------------- */

/**
 * 计算持仓的当前盈亏
 * @param {object} pos { code, name, shares, cost, stop, tp1, tp2 }
 * @param {number} price 最新价
 */
export function positionPnl(pos, price) {
  if (!pos || !isFinite(price)) return null;
  const cost = pos.cost;
  const shares = pos.shares;
  const amount = r2(shares * price);
  const feeSell = sellFee(amount).total;
  const pnl = r2((price - cost) * shares - feeSell);
  const pnlPct = cost > 0 ? r2(((price - cost) / cost) * 100) : 0;
  const hitStop = pos.stop && price <= pos.stop;
  const hitTp1 = pos.tp1 && price >= pos.tp1;
  const hitTp2 = pos.tp2 && price >= pos.tp2;
  return {
    price,
    amount,
    pnl,
    pnlPct,
    feeSell: r2(feeSell),
    hitStop: !!hitStop,
    hitTp1: !!hitTp1,
    hitTp2: !!hitTp2,
    advice: hitStop ? '已触发止损，立即离场' : hitTp2 ? '已达第二目标，可全清' : hitTp1 ? '已达第一目标，减半仓' : '',
  };
}
