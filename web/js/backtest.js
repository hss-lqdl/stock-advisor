/* ============================================================
   backtest.js — 回测：最近 N 个交易日逐日滚动，T+1 开盘买入，持有 3/5 日
   注意：股票池来自当前快照，存在幸存者偏差，结果仅作参考
   ============================================================ */

import { computeFactors } from './indicators.js';
import { scoreCandidates, applyPortfolioConstraints } from './strategy.js';

/**
 * 在「历史某一天」上重算因子。
 * @param {object} kl 完整 K 线
 * @param {number} idx 该天的下标
 */
function factorsAt(kl, idx) {
  if (idx < 70) return null;
  const sub = {
    dates: kl.dates,
    open: kl.open,
    close: kl.close,
    high: kl.high,
    low: kl.low,
    vol: kl.vol,
    amt: kl.amt,
    n: idx + 1,
  };
  const f = computeFactors(sub);
  if (!f) return null;
  return f;
}

/**
 * 运行回测。
 * @param {object} opt
 *   { klines: Map<code, kl>, stocks: Array（含 code/name/industry/concepts/mainScore/mainNames）,
 *     days: 回测交易日数, holdDays: 持有天数, topN: 每日选股数, strategy }
 * @returns {object}
 */
export function runBacktest(opt = {}) {
  const klines = opt.klines || new Map();
  const stocks = opt.stocks || [];
  const days = Math.min(opt.days || 60, 120);
  const holdDays = opt.holdDays || 3;
  const topN = opt.topN || 5;
  const strategy = opt.strategy || 'balanced';

  if (!klines.size || !stocks.length) {
    return { error: '数据不足，无法回测' };
  }

  // 用任意一只票的 K 线确定日期轴
  let refKl = null;
  for (const [, kl] of klines) { refKl = kl; break; }
  if (!refKl || refKl.n < 90) return { error: 'K 线长度不足' };

  const n = refKl.n;
  const startIdx = Math.max(70, n - days - holdDays - 1);
  const endIdx = n - holdDays - 1;

  const trades = [];
  const equity = [{ idx: 0, equity: 1 }];
  let cum = 1;

  for (let d = startIdx; d <= endIdx; d++) {
    const dateStr = refKl.dates[d];

    // 1. 构造当天的候选（因子）
    const rows = [];
    for (const s of stocks) {
      const kl = klines.get(String(s.code));
      if (!kl || kl.n <= d + holdDays) continue;
      const f = factorsAt(kl, d);
      if (!f) continue;
      // 当天必须有成交（vol > 0）
      if (!(kl.vol[d] > 0)) continue;
      rows.push({ ...s, ...f, main: isFinite(s.mainScore) ? s.mainScore : 0 });
    }
    if (rows.length < topN * 3) continue;

    // 2. 打分
    const scored = scoreCandidates(rows, strategy);
    const picks = applyPortfolioConstraints(scored, topN, {
      maxPerIndustry: 2,
      maxPerBoard: 2,
    });

    // 3. 模拟 T+1 开盘买入，持有 holdDays 后开盘卖出
    for (const p of picks) {
      const kl = klines.get(String(p.code));
      const buyIdx = d + 1;
      const sellIdx = buyIdx + holdDays;
      if (sellIdx >= kl.n) continue;
      const buyPrice = kl.open[buyIdx];
      const sellPrice = kl.open[sellIdx];
      if (!(buyPrice > 0) || !(sellPrice > 0)) continue;

      // 涨停无法买入（T+1 开盘涨停）
      const prevClose = kl.close[d];
      const limitUp = Math.round(prevClose * 1.1 * 100) / 100;
      if (buyPrice >= limitUp * 0.998) continue;

      const ret = sellPrice / buyPrice - 1;
      trades.push({
        date: dateStr,
        code: p.code,
        name: p.name,
        buyDate: kl.dates[buyIdx],
        sellDate: kl.dates[sellIdx],
        buyPrice,
        sellPrice,
        ret,
        score: p.score,
        mainNames: p.mainNames || [],
      });
    }

    // 4. 当日组合收益（等权）
    const dayTrades = trades.filter((t) => t.date === dateStr);
    if (dayTrades.length) {
      const avgRet = dayTrades.reduce((s, t) => s + t.ret, 0) / dayTrades.length;
      cum *= 1 + avgRet * (1 / Math.max(1, Math.ceil(holdDays / 1))) * 0.9;
      equity.push({ idx: d - startIdx + 1, equity: cum, date: dateStr });
    }
  }

  if (!trades.length) return { error: '无有效交易，请增加回测天数' };

  // 统计
  const rets = trades.map((t) => t.ret);
  const wins = rets.filter((r) => r > 0);
  const losses = rets.filter((r) => r <= 0);
  const avg = rets.reduce((a, b) => a + b, 0) / rets.length;
  const winRate = wins.length / rets.length;
  const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((a, b) => a + b, 0) / losses.length : 0;
  const profitFactor = avgLoss !== 0 ? Math.abs((avgWin * wins.length) / (avgLoss * losses.length)) : 0;

  // 最大回撤（基于 equity）
  let peak = 1;
  let maxDD = 0;
  for (const p of equity) {
    if (p.equity > peak) peak = p.equity;
    const dd = (p.equity - peak) / peak;
    if (dd < maxDD) maxDD = dd;
  }

  // 胜率按持有天数分组
  const byHold = {};
  for (const t of trades) {
    const k = holdDays;
    byHold[k] = byHold[k] || { n: 0, sum: 0 };
    byHold[k].n++;
    byHold[k].sum += t.ret;
  }

  // 最近交易
  const recent = trades.slice(-20).reverse();

  return {
    ok: true,
    days: endIdx - startIdx + 1,
    holdDays,
    topN,
    tradeCount: trades.length,
    avgRet: avg,
    winRate,
    avgWin,
    avgLoss,
    profitFactor,
    maxDD,
    finalEquity: cum,
    totalReturn: cum - 1,
    equity,
    recent,
    dateRange: [refKl.dates[startIdx], refKl.dates[endIdx]],
    warning: '股票池来自当前快照，历史上已退市/被剔除的股票未参与，存在幸存者偏差；未计交易成本。',
  };
}

/**
 * 多组参数对比（持有 3 / 5 日，选股 3 / 5 只）
 */
export function runBacktestMatrix(opt = {}) {
  const configs = [
    { holdDays: 3, topN: 5, label: '持有3日·选5只' },
    { holdDays: 5, topN: 5, label: '持有5日·选5只' },
    { holdDays: 3, topN: 3, label: '持有3日·选3只' },
    { holdDays: 5, topN: 3, label: '持有5日·选3只' },
  ];
  const out = [];
  for (const c of configs) {
    const r = runBacktest({ ...opt, ...c });
    out.push({ label: c.label, ...r });
  }
  return out;
}
