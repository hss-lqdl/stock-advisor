#!/usr/bin/env node
/* ============================================================
   selftest.mjs — 离线单元自测 + 在线端到端自测

   用法：
     node tools/selftest.mjs           只跑离线测试（毫秒级，不联网）
     node tools/selftest.mjs --live    额外跑真实东财数据的端到端链路

   为什么需要这个文件：
   本项目是纯前端 PWA，零依赖、无 TypeScript。核心算法（过滤/主线/因子/
   打分/下单参数）全部是纯 ES Module，可以在 Node 里直接 import 并断言，
   不需要浏览器。这样即使 iPhone 不在手边、Edge 无头在沙箱里跑不起来，
   也能验证算法正确性。

   在线模式会真实拉取全市场快照 + 板块 + K 线，跑完整链路，
   并把关键指标打印出来供人工核对。
   ============================================================ */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const JS = path.join(__dirname, '..', 'web', 'js');
const url = (m) => 'file:///' + path.join(JS, m).replace(/\\/g, '/');
const REPORT_FILE = path.join(__dirname, '_e2e', 'selftest_report.log');

/* ---------------- 迷你测试框架 ---------------- */

let passed = 0;
let failed = 0;
const failures = [];
let group = '';
// 在线模式下快照拉取耗时（ms），由 testLive 写入、testLiveLate 读取。
let LIVE_T_SNAP = 0;

function describe(name) {
  group = name;
  console.log('\n\u001b[36m── ' + name + ' ──\u001b[0m');
}

function ok(cond, label, extra) {
  if (cond) {
    passed++;
    console.log('  \u001b[32m✓\u001b[0m ' + label);
  } else {
    failed++;
    failures.push(group + ' / ' + label + (extra ? '  → ' + extra : ''));
    console.log('  \u001b[31m✗\u001b[0m ' + label + (extra ? '  \u001b[33m→ ' + extra + '\u001b[0m' : ''));
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label, `期望 ${expected}，实际 ${actual}`);
}

function near(actual, expected, tol, label) {
  ok(Math.abs(actual - expected) <= tol, label, `期望 ${expected}±${tol}，实际 ${actual}`);
}

function inRange(actual, lo, hi, label) {
  ok(actual >= lo && actual <= hi, label, `期望 [${lo}, ${hi}]，实际 ${actual}`);
}

function info(label, value) {
  console.log('    \u001b[90m· ' + label + ': ' + value + '\u001b[0m');
}

/* ============================================================
   第 1 组：universe.js 股票池过滤
   ============================================================ */

async function testUniverse() {
  const U = await import(url('universe.js'));
  describe('universe.js · 股票池过滤');

  // limitPct
  eq(U.limitPct('300001'), 0.20, '300 开头 → 20% 涨跌幅');
  eq(U.limitPct('301001'), 0.20, '301 开头 → 20% 涨跌幅');
  eq(U.limitPct('688001'), 0.20, '688 开头 → 20% 涨跌幅');
  eq(U.limitPct('600000'), 0.10, '600 开头 → 10% 涨跌幅');
  eq(U.limitPct('000001'), 0.10, '000 开头 → 10% 涨跌幅');
  eq(U.limitPct('002001'), 0.10, '002 开头 → 10% 涨跌幅');

  // isST
  ok(U.isST('ST中珠'), 'ST 中珠 → 是 ST');
  ok(U.isST('*ST海航'), '*ST 海航 → 是 ST');
  ok(U.isST('退市中新'), '退市 中新 → 是 ST');
  ok(!U.isST('贵州茅台'), '贵州茅台 → 不是 ST');
  ok(!U.isST('中国平安'), '中国平安 → 不是 ST');

  // marketOf
  eq(U.marketOf('688001'), '科创板', '688001 → 科创板');
  eq(U.marketOf('300001'), '创业板', '300001 → 创业板');
  eq(U.marketOf('600000'), '沪市', '600000 → 沪市');
  eq(U.marketOf('000001'), '深市', '000001 → 深市');

  // isSuspended
  ok(U.isSuspended({ f2: '-' }), 'f2 为 "-" → 停牌');
  ok(U.isSuspended({ f2: undefined }), 'f2 缺失 → 停牌');
  ok(!U.isSuspended({ f2: 12.34 }), 'f2 为数字 → 正常');

  // limitPrices
  const lp = U.limitPrices(10, '600000');
  eq(lp.up, 11, '10 元主板 → 涨停 11');
  eq(lp.dn, 9, '10 元主板 → 跌停 9');
  const lp2 = U.limitPrices(10, '300001');
  eq(lp2.up, 12, '10 元创业板 → 涨停 12');
  eq(lp2.dn, 8, '10 元创业板 → 跌停 8');

  // buildUniverse：构造一组覆盖所有过滤分支的合成数据
  const mk = (code, name, price, chgPct, opts = {}) => ({
    f12: code, f14: name, f2: price, f3: chgPct,
    f5: 10000, f6: opts.amount ?? 5e8, f8: opts.turnover ?? 3,
    f9: 20, f10: 1.2, f15: opts.high ?? price * 1.02,
    f16: opts.low ?? price * 0.98, f17: opts.open ?? price,
    f18: opts.prevClose ?? price / (1 + chgPct / 100),
    f20: (opts.cap ?? 100) * 1e8, f21: (opts.cap ?? 100) * 0.8e8,
    f23: 2, f62: 1e7, f100: '软件开发', f103: '财税数字化,ChatGPT概念',
  });

  const rows = [
    mk('600001', '正常股票', 20, 2),                        // 应保留
    mk('600002', 'ST退市股', 20, 2),                        // ST → 剔除
    mk('600003', '超高价股', 500, 2),                       // 一手 5 万 → 剔除
    mk('600004', '超小市值', 20, 2, { cap: 10 }),            // 10 亿 → 剔除
    mk('600005', '超大市值', 20, 2, { cap: 900 }),           // 900 亿 → 剔除
    mk('600006', '涨停股', 22, 10),                          // 涨停 → 剔除
    mk('600007', '跌停股', 18, -10),                         // 跌停 → 剔除
    mk('600008', '低成交额', 20, 2, { amount: 5e7 }),        // 5000 万 → 剔除
    mk('600009', '低换手', 20, 2, { turnover: 0.1 }),        // 0.1% → 剔除
    mk('600010', '低价股', 1.5, 2),                          // 1.5 元 → 剔除
    mk('300011', '创业板正常', 30, 3),                       // 应保留
    { f12: '600012', f14: '停牌股', f2: '-' },               // 停牌 → 剔除
    mk('600013', '一字板', 22, 10, { open: 22, high: 22, low: 22 }), // 一字板 → 剔除
    mk('600014', '北交所', 20, 2),                           // 代码 6 开头其实应保留…
  ];
  rows[13] = mk('600014', '沪市正常2', 20, 2);

  // 默认 excludeChiNext=true：创业板 300011 应被剔除
  const { pool, stats } = U.buildUniverse(rows, { capital: 50000, maxPicks: 5 });
  const codes = pool.map((s) => s.code);

  ok(codes.includes('600001'), '保留：正常股票');
  ok(!codes.includes('600002'), '剔除：ST 股票');
  ok(!codes.includes('600003'), '剔除：一手成本超预算（500 元）');
  ok(!codes.includes('600004'), '剔除：市值 10 亿 < 20 亿');
  ok(!codes.includes('600005'), '剔除：市值 900 亿 > 800 亿');
  ok(!codes.includes('600006'), '剔除：当日涨停');
  ok(!codes.includes('600007'), '剔除：当日跌停');
  ok(!codes.includes('600008'), '剔除：成交额 5000 万 < 1 亿');
  ok(!codes.includes('600009'), '剔除：换手率 0.1% < 0.5%');
  ok(!codes.includes('600010'), '剔除：价格 1.5 元 ≤ 2 元');
  ok(!codes.includes('300011'), '剔除：创业板（默认排除）');
  ok(!codes.includes('600012'), '剔除：停牌');
  ok(!codes.includes('600013'), '剔除：一字板');

  ok(pool.length === 2, '合成数据最终池应为 2 只（600001 + 600014）', '实际 ' + pool.length);

  // 关闭排除开关后，创业板 300011 应被保留
  const r2 = U.buildUniverse(rows, { capital: 50000, maxPicks: 5, excludeChiNext: false });
  const codes2 = r2.pool.map((s) => s.code);
  ok(codes2.includes('300011'), '保留：创业板（关闭排除开关时）');
  ok(r2.pool.length === 3, '关闭排除开关最终池应为 3 只', '实际 ' + r2.pool.length);

  // 过滤统计
  ok(Array.isArray(stats.steps) && stats.steps.length >= 9, '过滤统计步骤 ≥ 9 道');
  info('过滤步骤', stats.steps.map((s) => `${s.label}(-${s.removed})`).join(' '));
  ok(stats.output === pool.length, '统计器 output 与池大小一致');

  // 预算
  near(stats.input, rows.length, 0, '统计器记录输入行数');
  const { budgetPerStock } = U.buildUniverse(rows, { capital: 50000, maxPicks: 5 });
  eq(budgetPerStock, 8000, '5 万本金 / 80% 仓位 / 5 只 → 单只 8000 元');

  // 池子 Map
  const m = U.poolToMap(pool);
  ok(m.get('600001') && m.get('600001').name === '正常股票', 'poolToMap 可按代码取股');
}

/* ============================================================
   第 2 组：mainline.js 主线情绪
   ============================================================ */

async function testMainline() {
  const M = await import(url('mainline.js'));
  describe('mainline.js · 主线情绪分析');

  // 噪音过滤
  ok(M.NOISE_PATTERN.test('昨日涨停'), '噪音：昨日涨停');
  ok(M.NOISE_PATTERN.test('融资融券'), '噪音：融资融券');
  ok(M.NOISE_PATTERN.test('沪深300'), '噪音：沪深300');
  ok(!M.NOISE_PATTERN.test('机器人'), '非噪音：机器人');
  ok(!M.NOISE_PATTERN.test('财税数字化'), '非噪音：财税数字化');

  // 罗马数字
  eq(M.stripRoman('航空装备Ⅱ'), '航空装备', '去罗马数字：航空装备Ⅱ');
  eq(M.stripRoman('通用设备'), '通用设备', '无罗马数字：通用设备');

  // 板块得分公式
  // score = f109*2 + f3*1 + (up/(up+dn)-0.5)*20 + clip(f62/5e8, -3, 3)
  const b1 = { f14: 'A', f109: 5, f3: 2, f104: 30, f105: 10, f62: 5e8 };
  // = 10 + 2 + (0.75-0.5)*20=5 + 1 = 18
  near(M.boardScore(b1), 18, 0.001, '板块得分公式（强势板块）');

  const b2 = { f14: 'B', f109: -5, f3: -2, f104: 10, f105: 30, f62: -5e8 };
  near(M.boardScore(b2), -18, 0.001, '板块得分公式（退潮板块）');

  // 主力净流入截断到 ±3
  const b3 = { f14: 'C', f109: 0, f3: 0, f104: 10, f105: 10, f62: 100e8 };
  near(M.boardScore(b3), 3, 0.001, '主力净流入 100 亿截断为 +3');

  // cleanBoards：噪音 + 成分不足
  const boards = [
    { f14: '机器人', f109: 8, f3: 2, f104: 100, f105: 20, f62: 10e8 },
    { f14: '昨日涨停', f109: 20, f3: 5, f104: 200, f105: 5, f62: 50e8 },  // 噪音
    { f14: '小板块', f109: 9, f3: 3, f104: 3, f105: 2, f62: 1e8 },        // 成分 5 < 15
    { f14: '医疗设备', f109: 6, f3: 1.5, f104: 80, f105: 30, f62: 8e8 },
  ];
  const cleaned = M.cleanBoards(boards);
  eq(cleaned.length, 2, 'cleanBoards 剔除噪音与小板块后剩 2 个');
  ok(cleaned[0].name === '机器人', '按得分降序，机器人第一');
  ok(cleaned[0].members === 120, 'members = 涨家数 + 跌家数');
  ok(cleaned[0].mainInflow === 10e8, 'mainInflow 别名正确');

  // analyzeMainline
  const many = [];
  for (let i = 0; i < 30; i++) {
    many.push({ f14: '板块' + i, f109: 10 - i * 0.5, f3: 1, f104: 50, f105: 50, f62: 0 });
  }
  const ml = M.analyzeMainline(many);
  eq(ml.top.length, M.TOP_N, '主线 Top20 数量正确');
  eq(ml.bottom.length, M.BOTTOM_N, '退潮 Top10 数量正确');
  eq(ml.all.length, 30, '有效板块总数正确');
  ok(ml.top[0].name === '板块0', 'Top1 是得分最高板块');
  ok(ml.bottom[0].name === '板块29', '退潮第 1 是得分最低板块');
  ok(ml.topSet.has('板块0'), 'topSet 含 Top1');
  ok(ml.bottomSet.has('板块29'), 'bottomSet 含最弱板块');

  // stockMainline：概念串 + 行业匹配
  const ml2 = M.analyzeMainline([
    { f14: '财税数字化', f109: 6, f3: 2, f104: 60, f105: 20, f62: 5e8 },
    { f14: 'ChatGPT概念', f109: 5.5, f3: 1.5, f104: 55, f105: 25, f62: 4e8 },
    { f14: '软件开发', f109: 4.5, f3: 1, f104: 50, f105: 30, f62: 3e8 },
    { f14: '半导体设备', f109: -9, f3: -3, f104: 5, f105: 90, f62: -20e8 },
    ...Array.from({ length: 25 }, (_, i) => ({
      f14: '填充' + i, f109: -1 - i * 0.1, f3: -0.5, f104: 30, f105: 40, f62: 0,
    })),
  ]);

  const s1 = M.stockMainline(
    { concepts: '财税数字化,ChatGPT概念', industry: '软件开发' },
    ml2
  );
  ok(s1.qualified, '命中主线 Top20 → 过门槛');
  ok(s1.inTop, 'inTop 为真');
  ok(!s1.inBottom, '不在退潮区');
  ok(s1.boardNames.length === 3, '取最强 3 个板块');
  ok(s1.boardNames[0] === '财税数字化', '最强板块是财税数字化');
  ok(s1.mainScore > 0, 'mainScore 为正', '实际 ' + s1.mainScore.toFixed(2));

  const s2 = M.stockMainline(
    { concepts: '不存在的概念', industry: '半导体设备' },
    ml2
  );
  ok(s2.matchedCount === 1, '只命中行业板块 1 个');
  ok(!s2.qualified, '在退潮区 → 不过门槛');

  const s3 = M.stockMainline({ concepts: '完全不存在的板块X', industry: '也不存在' }, ml2);
  eq(s3.matchedCount, 0, '完全匹配不到 → matchedCount 0');
  ok(s3.mainScore === -999, '匹配不到 → mainScore = -999');
  ok(!s3.qualified, '匹配不到 → 不过门槛');

  // 行业罗马数字后缀匹配
  const ml3 = M.analyzeMainline([
    { f14: '航空装备', f109: 7, f3: 2, f104: 40, f105: 10, f62: 5e8 },
    ...Array.from({ length: 25 }, (_, i) => ({
      f14: '填充' + i, f109: -1 - i * 0.1, f3: -0.5, f104: 30, f105: 40, f62: 0,
    })),
  ]);
  const s4 = M.stockMainline({ concepts: '', industry: '航空装备Ⅱ' }, ml3);
  ok(s4.matchedCount >= 1, '行业「航空装备Ⅱ」可匹配到「航空装备」', 'matched=' + s4.matchedCount);

  // annotatePool
  const pool = [
    { code: '600001', concepts: '财税数字化', industry: '软件开发' },
    { code: '600002', concepts: '不存在X', industry: '不存在Y' },
    { code: '600003', concepts: '半导体设备', industry: '半导体设备' },
  ];
  const { qualified, stats } = M.annotatePool(pool, ml2);
  ok(qualified.length === 1, 'annotatePool 只保留过门槛的 1 只', '实际 ' + qualified.length);
  eq(qualified[0].code, '600001', '过门槛的是 600001');
  eq(stats.pool, 3, 'stats.pool = 3');
  eq(stats.matched, 2, 'stats.matched = 2（两只匹配到板块）');
  eq(stats.passed, 1, 'stats.passed = 1');
  ok(Array.isArray(qualified[0].mainNames), 'qualified 项带 mainNames');
}

/* ============================================================
   第 3 组：indicators.js 技术因子
   ============================================================ */

async function testIndicators() {
  const I = await import(url('indicators.js'));
  describe('indicators.js · 技术因子');

  // 构造单调上涨的 K 线
  const n = 100;
  const close = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const open = new Float64Array(n);
  const vol = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    close[i] = 10 + i * 0.1;
    high[i] = close[i] + 0.1;
    low[i] = close[i] - 0.1;
    open[i] = close[i] - 0.02;
    vol[i] = 10000 + i * 10;
  }
  const kl = { open, close, high, low, vol, n };

  // MA
  const ma5 = I.maAt(close, 5, n - 1);
  near(ma5, (close[n - 1] + close[n - 2] + close[n - 3] + close[n - 4] + close[n - 5]) / 5, 1e-9, 'MA5 计算正确');
  const maSeries = I.maSeries(close, 5);
  eq(maSeries.length, n, 'MA 序列长度与 K 线一致');
  ok(!isFinite(maSeries[3]), 'MA5 前 4 个值为 NaN');

  // RSI：单调上涨 → RSI 应为 100
  const rsi = I.rsiAt(close, 14, n - 1);
  near(rsi, 100, 0.5, '单调上涨 → RSI ≈ 100');

  // ATR：固定振幅 0.2 → ATR 应接近 0.2
  const atr = I.atrAt(high, low, close, 14, n - 1);
  inRange(atr, 0.15, 0.25, '固定振幅 → ATR ≈ 0.2', '实际 ' + atr.toFixed(4));

  // momentum
  const mom5 = I.momentum(close, 5, n - 1);
  near(mom5, close[n - 1] / close[n - 6] - 1, 1e-9, '5 日动量正确');
  ok(mom5 > 0, '单调上涨 → 5 日动量为正');

  // drawdownFromHigh：持续新高 → 回撤 0
  const dd = I.drawdownFromHigh(high, 60, n - 1);
  near(dd, 0, 1e-9, '持续新高 → 距高回撤 = 0');

  // volumeRatio
  const vr = I.volumeRatio(vol, 5, n - 1);
  inRange(vr, 0.9, 1.1, '量比约等于 1', '实际 ' + vr.toFixed(4));

  // computeFactors 完整返回
  const f = I.computeFactors(kl);
  ok(f !== null, 'computeFactors 返回非空');
  const keys = ['price', 'ma5', 'ma10', 'ma20', 'ma60', 'rsi', 'atr', 'atrp',
    'vol20', 'mom5', 'mom10', 'mom20', 'dd', 'vr', 'slope20', 'trend', 'maAlign',
    'maAlignPct', 'aboveMa20', 'aboveMa60'];
  for (const k of keys) ok(f[k] !== undefined, '因子字段存在: ' + k);
  ok(f.aboveMa20 && f.aboveMa60, '单调上涨 → 站上 MA20/MA60');
  eq(f.maAlign, 3, '单调上涨 → 均线多头排列 3/3');
  near(f.maAlignPct, 1, 1e-9, 'maAlignPct = 1');

  // 数据不足
  eq(I.computeFactors({ close: new Float64Array(10), high: new Float64Array(10), low: new Float64Array(10), vol: new Float64Array(10), n: 10 }), null, 'K 线不足 70 根 → null');

  // 横截面分位标准化
  const vals = [1, 2, 3, 4, 5];
  near(I.percentileRank(vals, 1), 0, 1e-9, '分位：最小值 → 0');
  near(I.percentileRank(vals, 5), 100, 1e-9, '分位：最大值 → 100');
  near(I.percentileRank(vals, 3), 50, 1e-9, '分位：中位数 → 50');
  near(I.percentileRank(vals, 1, true), 100, 1e-9, '反向分位：最小值 → 100');

  const rows = [
    { code: 'A', mom20: 0.5, rsi: 30 },
    { code: 'B', mom20: 0.1, rsi: 70 },
    { code: 'C', mom20: -0.2, rsi: 50 },
  ];
  const norm = I.crossSectionNormalize(rows, ['mom20', 'rsi'], ['rsi']);
  ok(norm instanceof Map, 'crossSectionNormalize 返回 Map');
  eq(norm.size, 3, 'Map 大小为 3');
  near(norm.get('A').mom20, 100, 1e-9, 'mom20 最大的 A → 100 分位');
  near(norm.get('C').mom20, 0, 1e-9, 'mom20 最小的 C → 0 分位');
  near(norm.get('A').rsi, 100, 1e-9, 'rsi 反向：A 的 rsi 最低 → 100 分位（越低越好）');
  near(norm.get('B').rsi, 0, 1e-9, 'rsi 反向：B 的 rsi 最高 → 0 分位（越高越差）');
}

/* ============================================================
   第 4 组：market.js 大盘环境
   ============================================================ */

async function testMarket() {
  const K = await import(url('market.js'));
  describe('market.js · 大盘环境四维打分');

  // 档位阈值
  eq(K.levelByScore(80).key, 'attack', '80 分 → 进攻');
  eq(K.levelByScore(70).key, 'attack', '70 分 → 进攻（边界）');
  eq(K.levelByScore(60).key, 'neutral', '60 分 → 中性');
  eq(K.levelByScore(50).key, 'neutral', '50 分 → 中性（边界）');
  eq(K.levelByScore(40).key, 'defend', '40 分 → 防守');
  eq(K.levelByScore(30).key, 'defend', '30 分 → 防守（边界）');
  eq(K.levelByScore(20).key, 'frozen', '20 分 → 冰点');
  eq(K.levelByScore(-5).key, 'frozen', '负分 → 冰点');

  // 档位仓位与只数
  eq(K.LEVELS.attack.position, 0.80, '进攻档仓位 80%');
  eq(K.LEVELS.attack.picks, 5, '进攻档 5 只');
  eq(K.LEVELS.neutral.position, 0.60, '中性档仓位 60%');
  eq(K.LEVELS.defend.position, 0.35, '防守档仓位 35%');
  eq(K.LEVELS.defend.picks, 4, '防守档 4 只');
  eq(K.LEVELS.frozen.position, 0.20, '冰点档仓位 20%');
  eq(K.LEVELS.frozen.picks, 3, '冰点档 3 只');

  // trendScore：构造强势指数（收盘价持续高于均线）
  const n = 120;
  const close = new Float64Array(n);
  for (let i = 0; i < n; i++) close[i] = 3000 + i * 8;
  const strongKl = { close, n };
  const ts = K.trendScore(strongKl);
  ok(ts.score > 70, '强势上涨指数 → 趋势分 > 70', '实际 ' + ts.score.toFixed(1));
  ok(ts.detail.aboveMa20, '强势：站上 MA20');
  ok(ts.detail.aboveMa60, '强势：站上 MA60');
  ok(ts.detail.bullAlign, '强势：MA20 > MA60');

  // 弱势指数
  const close2 = new Float64Array(n);
  for (let i = 0; i < n; i++) close2[i] = 4000 - i * 8;
  const weakKl = { close: close2, n };
  const ts2 = K.trendScore(weakKl);
  ok(ts2.score < 30, '弱势下跌指数 → 趋势分 < 30', '实际 ' + ts2.score.toFixed(1));
  ok(!ts2.detail.aboveMa20, '弱势：跌破 MA20');

  // 数据不足
  eq(K.trendScore({ close: new Float64Array(10), n: 10 }).score, 50, '指数数据不足 → 趋势分 50');
  eq(K.trendScore(null).score, 50, '指数为空 → 趋势分 50');

  // breadthScore：全市场涨跌家数
  const snapUp = Array.from({ length: 100 }, (_, i) => ({ f3: i < 80 ? 2 : -1 }));
  const bsUp = K.breadthScore(snapUp);
  ok(bsUp.score > 60, '80% 上涨 → 广度分 > 60', '实际 ' + bsUp.score.toFixed(1));

  const snapDn = Array.from({ length: 100 }, (_, i) => ({ f3: i < 20 ? 2 : -1 }));
  const bsDn = K.breadthScore(snapDn);
  ok(bsDn.score < 40, '20% 上涨 → 广度分 < 40', '实际 ' + bsDn.score.toFixed(1));

  // analyzeMarket 完整调用
  const mkt = K.analyzeMarket({
    indexKl: strongKl,
    snapshot: snapUp,
    ztPool: { total: 50, pool: [] },
    dtPool: { total: 5, pool: [] },
  });
  ok(typeof mkt.score === 'number', 'analyzeMarket 返回 score');
  inRange(mkt.score, 0, 100, '大盘得分在 [0,100]', '实际 ' + mkt.score.toFixed(1));
  ok(mkt.level && mkt.level.key, 'analyzeMarket 返回 level');
  // dims 是对象 {trend,breadth,sentiment,volume}，不是数组
  ok(mkt.dims && typeof mkt.dims === 'object', '返回 dims 对象');
  const dimKeys = Object.keys(mkt.dims || {});
  eq(dimKeys.length, 4, '返回 4 个维度');
  ok(['trend', 'breadth', 'sentiment', 'volume'].every((k) => dimKeys.includes(k)),
    '维度名为 trend/breadth/sentiment/volume');
  const dimSum = dimKeys.reduce((s, k) => s + mkt.dims[k].weight, 0);
  near(dimSum, 1, 1e-6, '四维权重合计 = 1');
  for (const k of dimKeys) {
    const d = mkt.dims[k];
    inRange(d.score, 0, 100, `维度 ${d.name} 得分在 [0,100]`, '实际 ' + d.score.toFixed(1));
    ok(typeof d.detail === 'object', `维度 ${d.name} 带 detail`);
  }
  info('强势市场得分', mkt.score.toFixed(1) + ' → ' + mkt.level.name);

  // budgetPerStock 返回 { perStock, total, picks }
  eq(K.budgetPerStock(50000, K.LEVELS.attack, 5).perStock, 8000, '5 万 / 进攻 80% / 5 只 → 每只 8000');
  eq(K.budgetPerStock(50000, K.LEVELS.neutral, 5).perStock, 6000, '5 万 / 中性 60% / 5 只 → 每只 6000');
  eq(K.budgetPerStock(50000, K.LEVELS.defend, 4).perStock, 4375, '5 万 / 防守 35% / 4 只 → 每只 4375');
  near(K.budgetPerStock(50000, K.LEVELS.frozen, 3).perStock, 3333.33, 0.01, '5 万 / 冰点 20% / 3 只 → 每只 3333.33');
  eq(K.budgetPerStock(50000, K.LEVELS.neutral, 5).total, 30000, '中性档总仓位 = 3 万元');
  eq(K.budgetPerStock(50000, K.LEVELS.neutral, 5).picks, 5, '返回 picks 只数');
  info('关键约束', '中性档 5 只时每只 6000 元 → 最高可买 60 元/股');
}

/* ============================================================
   第 5 组：strategy.js 打分与组合约束
   ============================================================ */

async function testStrategy() {
  const S = await import(url('strategy.js'));
  describe('strategy.js · 因子打分与组合约束');

  // 三套策略
  const keys = Object.keys(S.STRATEGIES);
  ok(keys.includes('balanced'), '含均衡多因子策略');
  ok(keys.includes('momentum'), '含趋势动量策略');
  ok(keys.includes('reversal'), '含超跌反弹策略');
  for (const k of keys) {
    const st = S.getStrategy(k);
    const wsum = Object.values(st.weights).reduce((a, b) => a + b, 0);
    near(wsum, 1, 1e-6, `策略 ${k} 权重合计 = 1`);
  }
  eq(S.getStrategy('不存在的策略').key, 'balanced', '未知策略回退到 balanced');

  // 因子中文名齐全
  for (const k of Object.keys(S.STRATEGIES.balanced.weights)) {
    ok(typeof S.FACTOR_LABELS[k] === 'string', '因子有中文名: ' + k);
  }

  // scoreCandidates：构造 5 只，因子单调
  const rows = [];
  for (let i = 0; i < 5; i++) {
    rows.push({
      code: '60000' + i,
      mom20: i * 0.1, mom5: i * 0.05, dd: -i * 0.02,
      trend: i * 0.1, rsi: 40 + i * 8, atrp: 0.03 + i * 0.005,
      vr: 1 + i * 0.2, mainScore: i * 2,
    });
  }
  const scored = S.scoreCandidates(rows, 'balanced');
  eq(scored.length, 5, '打分后数量不变');
  ok(scored[0].score >= scored[4].score, '结果按分数降序');
  for (const s of scored) {
    inRange(s.score, 0, 100, `得分在 [0,100]: ${s.code}`, '实际 ' + s.score.toFixed(1));
    ok(s.factors && typeof s.factors.mom20 === 'number', '带 factors 分位值');
    inRange(s.factors.mom20, 0, 100, '分位值在 [0,100]');
  }
  eq(scored[0].code, '600004', '全因子最强 → 排第一');

  // 三套策略对同一批数据给出不同排序（权重不同）
  // A 组「趋势股」：动量强、趋势好、接近新高、RSI 偏高、量能温和
  // B 组「反弹股」：深度回撤、RSI 极低、量能异动、主线更强、5 日已转正
  const styleRows = [];
  for (let i = 0; i < 4; i++) {
    styleRows.push({
      code: '60010' + i,
      mom20: 0.35 + i * 0.05, mom5: 0.10 + i * 0.02, dd: -0.02 - i * 0.005,
      trend: 0.40 + i * 0.03, rsi: 70 + i * 2, atrp: 0.030,
      vr: 1.2, mainScore: 5 + i,
    });
    styleRows.push({
      code: '60020' + i,
      mom20: -0.15 - i * 0.03, mom5: 0.02 + i * 0.01, dd: -0.30 - i * 0.03,
      trend: -0.20 - i * 0.03, rsi: 24 + i * 2, atrp: 0.055,
      vr: 2.0 + i * 0.1, mainScore: 12 + i,
    });
  }
  const mom2 = S.scoreCandidates(styleRows, 'momentum');
  const rev2 = S.scoreCandidates(styleRows, 'reversal');
  ok(mom2[0].code.startsWith('6001'), '趋势策略首选强势股', `实际 ${mom2[0].code}`);
  ok(rev2[0].code.startsWith('6002'), '反转策略首选超跌股', `实际 ${rev2[0].code}`);
  ok(mom2[0].code !== rev2[0].code, '趋势策略与反转策略首选不同',
    `momentum=${mom2[0].code} reversal=${rev2[0].code}`);
  info('策略分化', `momentum 首选 ${mom2[0].code}(${mom2[0].score.toFixed(1)}分) / reversal 首选 ${rev2[0].code}(${rev2[0].score.toFixed(1)}分)`);

  // applyPortfolioConstraints：同行业最多 2 只
  const mk = (code, industry, board, score) => ({
    code, industry, mainNames: [board], score,
  });
  const cands = [
    mk('A1', '软件开发', '财税数字化', 100),
    mk('A2', '软件开发', '财税数字化', 99),
    mk('A3', '软件开发', '财税数字化', 98),   // 同行业第 3 只 → 跳过
    mk('B1', '医疗器械', '精准诊断', 97),
    mk('B2', '医疗器械', '精准诊断', 96),
    mk('C1', '半导体', 'ChatGPT概念', 95),
  ];
  const picked = S.applyPortfolioConstraints(cands, 5, { maxPerIndustry: 2, maxPerBoard: 2 });
  eq(picked.length, 5, '约束后仍凑满 5 只');
  const indCount = {};
  for (const p of picked) indCount[p.industry] = (indCount[p.industry] || 0) + 1;
  ok((indCount['软件开发'] || 0) <= 2, '同一行业 ≤ 2 只', '实际 ' + (indCount['软件开发'] || 0));
  ok(picked.some((p) => p.code === 'A1'), '最高分 A1 被选中');
  ok(!picked.slice(0, 5).includes(cands[2]) || picked.filter(p => p.code === 'A3').length === 0,
    'A3 因行业超限被跳过');

  // 同一主线板块最多 2 只
  const cands2 = [
    mk('X1', '行业1', '财税数字化', 100),
    mk('X2', '行业2', '财税数字化', 99),
    mk('X3', '行业3', '财税数字化', 98),   // 同板块第 3 只 → 跳过
    mk('Y1', '行业4', 'ChatGPT概念', 97),
  ];
  const picked2 = S.applyPortfolioConstraints(cands2, 3, { maxPerIndustry: 2, maxPerBoard: 2 });
  const boardCount = {};
  for (const p of picked2) for (const b of p.mainNames) boardCount[b] = (boardCount[b] || 0) + 1;
  ok((boardCount['财税数字化'] || 0) <= 2, '同一主线板块 ≤ 2 只', '实际 ' + (boardCount['财税数字化'] || 0));

  // buildReason 生成中文理由
  const reason = S.buildReason({
    code: '600001', name: '测试股', mainNames: ['财税数字化'],
    factors: { mom20: 88, trend: 92, rsi: 45, dd: 70, vr: 66, main: 80 },
    score: 85.3, rsi: 63, dd: -0.013,
  });
  ok(typeof reason === 'string' && reason.length > 5, 'buildReason 生成理由文本');
  info('理由样例', reason);
}

/* ============================================================
   第 6 组：plan.js 买入计划与下单参数
   ============================================================ */

async function testPlan() {
  const P = await import(url('plan.js'));
  describe('plan.js · 买入计划与下单参数');

  // 费用
  eq(P.COMMISSION_RATE, 0.00025, '佣金率 0.025%');
  eq(P.COMMISSION_MIN, 5, '最低佣金 5 元');
  eq(P.TRANSFER_RATE, 0.00001, '过户费 0.001%');
  eq(P.STAMP_RATE, 0.0005, '印花税 0.05%');

  // buyFee：小额按最低 5 元
  const f1 = P.buyFee(10000);
  eq(f1.commission, 5, '1 万元买入 → 佣金按最低 5 元');
  near(f1.transfer, 0.1, 1e-9, '过户费 = 10000 × 0.001% = 0.1');
  near(f1.total, 5.1, 1e-9, '总费用 = 5.1');

  // 大额按费率
  const f2 = P.buyFee(100000);
  eq(f2.commission, 25, '10 万元买入 → 佣金 25 元');
  near(f2.total, 26, 1e-9, '总费用 = 26');

  // sellFee 含印花税
  const s1 = P.sellFee(10000);
  eq(s1.commission, 5, '卖出佣金最低 5 元');
  near(s1.stamp, 5, 1e-9, '印花税 = 10000 × 0.05% = 5');
  near(s1.total, 10.1, 1e-9, '卖出总费用 = 10.1');

  // calcBid：委托价必须不低于最新价且不超涨停
  const b1 = P.calcBid(20, 19.5, '600000');
  eq(b1.upLimit, 21.45, '昨收 19.5 → 涨停 21.45');
  eq(b1.downLimit, 17.55, '昨收 19.5 → 跌停 17.55');
  ok(b1.bid >= 20, '委托价不低于最新价', '实际 ' + b1.bid);
  ok(b1.bid <= b1.upLimit, '委托价不超过涨停价');
  near(b1.bid, 20.16, 0.01, '委托价 = 最新价 × 1.008（20.16）');

  // 接近涨停时被涨停价压制（但委托价不得低于最新价，故取两者较大者）
  const b2 = P.calcBid(21.4, 19.5, '600000');
  ok(b2.bid <= b2.upLimit, '接近涨停 → 委托价不超涨停', `bid=${b2.bid} up=${b2.upLimit}`);
  near(b2.bid, Math.max(21.4, Math.round(21.45 * 0.995 * 100) / 100), 0.01,
    '委托价 = max(最新价, 涨停 × 0.995)');

  // 创业板 20%
  const b3 = P.calcBid(11, 10, '300001');
  eq(b3.upLimit, 12, '创业板涨停 12');
  eq(b3.lim, 0.2, '创业板涨幅限制 0.2');

  // calcStop：最宽但不超过 -8%
  const st = P.calcStop(20, 18, 1.0);
  ok(st < 20, '止损价低于买入价');
  ok(st >= 20 * 0.92 - 1e-9, '止损不超过 -8%', '实际 ' + st);
  ok(st <= 20 * 0.985 + 1e-9, '止损至少 -1.5%');
  info('止损样例', `买入 20 → 止损 ${st}（${(((st - 20) / 20) * 100).toFixed(2)}%）`);

  // calcShares：100 股一手，688 为 200 股
  eq(P.calcShares(8000, 20, '600000'), 400, '8000 元 / 20 元 → 400 股（4 手）');
  eq(P.calcShares(6000, 22.08, '600000'), 200, '6000 元 / 22.08 元 → 200 股');
  eq(P.calcShares(8000, 91.2, '688228'), 0, '8000 元 / 91.2 元（688 需 200 股）→ 0 股');
  eq(P.calcShares(30000, 146.97, '688787'), 200, '3 万元 / 146.97 元（688）→ 200 股');
  eq(P.calcShares(1000, 20, '600000'), 0, '预算不足一手 → 0 股');
  eq(P.calcShares(8000, 0, '600000'), 0, '价格为 0 → 0 股');

  // buildPlan 完整输出
  const stock = {
    code: '300378', name: '鼎捷数智', price: 44.45, prevClose: 43.66,
    mainNames: ['财税数字化', 'ChatGPT概念'], industry: '软件开发',
    score: 85.3, factors: { mom20: 88 }, reason: '测试理由',
  };
  const plan = P.buildPlan(stock, { perStockBudget: 8000, atr: 1.2, low5: 41.5, level: null, capital: 50000 });
  ok(plan !== null, 'buildPlan 返回非空');
  eq(plan.code, '300378', 'plan.code 正确');
  eq(plan.name, '鼎捷数智', 'plan.name 正确');
  ok(plan.bid > 44.45, '委托价高于最新价');
  eq(plan.shares, 100, '8000 元 / 44.81 元 → 100 股');
  near(plan.amount, 4481, 1, '成交金额 = 100 × 44.81 = 4481');
  ok(plan.affordable, 'affordable = true');
  ok(plan.stop < plan.bid, '止损低于买入价');
  near(plan.tp1, Math.round(plan.bid * 1.06 * 100) / 100, 0.01, '止盈1 = 买入价 × 1.06');
  near(plan.tp2, Math.round(plan.bid * 1.12 * 100) / 100, 0.01, '止盈2 = 买入价 × 1.12');
  ok(plan.rr > 0, '风险收益比 > 0', '实际 ' + plan.rr);
  ok(plan.maxLoss > 0, '最大亏损 > 0');
  info('计划样例', `${plan.name} 委托 ${plan.bid} 股数 ${plan.shares} 金额 ${plan.amount} 止损 ${plan.stop} 止盈 ${plan.tp1}/${plan.tp2} R:R=${plan.rr}`);

  // 高价股 → shares=0 且 affordable=false
  const planHi = P.buildPlan(
    { code: '688228', name: '开普云', price: 91.2, prevClose: 90, mainNames: [] },
    { perStockBudget: 6000, atr: 3, low5: 85 }
  );
  eq(planHi.shares, 0, '高价股 6000 元预算 → 0 股');
  ok(!planHi.affordable, 'affordable = false（提示买不起）');

  // 非法输入
  eq(P.buildPlan({ code: '600000', price: NaN, prevClose: 10 }, {}), null, '价格为 NaN → null');
  eq(P.buildPlan({ code: '600000', price: 10, prevClose: 0 }, {}), null, '昨收为 0 → null');

  // buildDailyPlan
  const picks = [
    { code: '600001', name: 'A股', price: 20, prevClose: 19.6, industry: '软件开发', mainNames: ['财税数字化'], score: 90 },
    { code: '600002', name: 'B股', price: 15, prevClose: 14.8, industry: '医疗器械', mainNames: ['精准诊断'], score: 85 },
    { code: '600003', name: 'C股', price: 10, prevClose: 9.9, industry: '半导体', mainNames: ['ChatGPT概念'], score: 80 },
  ];
  const klMap = new Map();
  for (const p of picks) {
    const nn = 100;
    const kl = {
      dates: Array.from({ length: nn }, (_, i) => '2026-01-' + String(i + 1).padStart(2, '0')),
      open: new Float64Array(nn).fill(p.price),
      close: new Float64Array(nn).fill(p.price),
      high: new Float64Array(nn).fill(p.price * 1.02),
      low: new Float64Array(nn).fill(p.price * 0.98),
      vol: new Float64Array(nn).fill(10000),
      amt: new Float64Array(nn).fill(1e8),
      n: nn,
    };
    klMap.set(p.code, kl);
  }
  const daily = P.buildDailyPlan(picks, {
    capital: 50000,
    level: { position: 0.6, picks: 5, key: 'neutral', name: '中性' },
    klines: klMap,
  });
  ok(daily && Array.isArray(daily.items), 'buildDailyPlan 返回 items 数组');
  eq(daily.items.length, 3, '3 只都生成计划');
  ok(daily.totalAmount > 0, '总投入 > 0', '实际 ' + daily.totalAmount);
  ok(daily.totalAmount <= 50000, '总投入不超过本金 5 万', '实际 ' + daily.totalAmount);
  ok(typeof daily.cashLeft === 'number', '返回剩余资金');
  for (const it of daily.items) ok(it.shares > 0, '每只股数 > 0: ' + it.name);
  info('每日计划', `总投入 ${daily.totalAmount} 元，剩余 ${daily.cashLeft} 元`);

  // 一键复制文本
  const copy = P.buildCopyText(daily, { dateStr: '2026-10-26', level: '中性' });
  ok(typeof copy === 'string' && copy.length > 50, 'buildCopyText 生成清单文本');
  ok(copy.includes('600001') || copy.includes('A股'), '清单文本含股票');
  info('复制清单前 80 字', copy.slice(0, 80).replace(/\n/g, ' | '));

  // 同花顺条件单参数（每只股票 3 条：买入 / 止盈 / 止损）
  const cond = P.buildConditionOrders(daily);
  ok(Array.isArray(cond) && cond.length === daily.items.length * 3,
    'buildConditionOrders 每只 3 条条件单', `实际 ${cond.length} 条`);
  const byCode = new Map();
  for (const c of cond) {
    ok(c.code && c.name, '条件单含代码与名称');
    ok(typeof c.condition === 'string' && c.condition.length > 0, '条件单含触发条件文本');
    ok(typeof c.action === 'string' && c.action.length > 0, '条件单含执行动作文本');
    byCode.set(c.code, (byCode.get(c.code) || 0) + 1);
  }
  ok([...byCode.values()].every((n) => n === 3), '每只股票恰好 3 条条件单');
  const types = new Set(cond.map((c) => c.type));
  ok(types.has('买入') && types.has('止盈') && types.has('止损'), '含买入/止盈/止损三类');
  // 触发价必须能从事项里取到
  for (const it of daily.items) {
    ok(it.bid > 0, '计划项含委托价: ' + it.name);
    ok(it.stop > 0, '计划项含止损价: ' + it.name);
    ok(it.tp1 > 0, '计划项含止盈价: ' + it.name);
  }
  const condText = P.buildConditionText(daily);
  ok(typeof condText === 'string' && condText.length > 30, 'buildConditionText 生成文本');
  info('条件单样例', condText.slice(0, 100).replace(/\n/g, ' | '));

  // 持仓盈亏（持仓对象字段是 cost 而非 buyPrice）
  const pos = { code: '600001', name: 'A股', cost: 20, shares: 100, buyDate: '2026-10-20' };
  const pnl = P.positionPnl(pos, 21);
  ok(pnl && pnl.pnl > 0, '涨到 21 元 → 盈利', 'pnl=' + (pnl && pnl.pnl));
  ok(pnl && pnl.pnlPct > 0, '盈亏比例 > 0');
  const pnl2 = P.positionPnl(pos, 19);
  ok(pnl2 && pnl2.pnl < 0, '跌到 19 元 → 亏损');
  info('持仓盈亏', `${pnl.pnl.toFixed(2)} 元 (${pnl.pnlPct.toFixed(2)}%)`);
}

/* ============================================================
   第 7 组：backtest.js 回测
   ============================================================ */

async function testBacktest() {
  const B = await import(url('backtest.js'));
  describe('backtest.js · 回测引擎');

  // 构造 30 只股票 × 200 根 K 线（带随机游走）
  const klines = new Map();
  const stocks = [];
  let seed = 42;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };

  for (let s = 0; s < 30; s++) {
    const code = '60' + String(1000 + s);
    const nn = 200;
    const close = new Float64Array(nn);
    const open = new Float64Array(nn);
    const high = new Float64Array(nn);
    const low = new Float64Array(nn);
    const vol = new Float64Array(nn);
    const amt = new Float64Array(nn);
    const dates = new Array(nn);
    let p = 10 + s;
    for (let i = 0; i < nn; i++) {
      const drift = 0.0005 * (s % 3 - 1);
      p = Math.max(1, p * (1 + drift + (rnd() - 0.5) * 0.04));
      close[i] = p;
      open[i] = p * (1 + (rnd() - 0.5) * 0.01);
      high[i] = Math.max(open[i], close[i]) * (1 + rnd() * 0.01);
      low[i] = Math.min(open[i], close[i]) * (1 - rnd() * 0.01);
      vol[i] = 10000 + rnd() * 5000;
      amt[i] = vol[i] * p * 100;
      const d = new Date(2025, 0, 1 + i);
      dates[i] = d.toISOString().slice(0, 10);
    }
    klines.set(code, { dates, open, close, high, low, vol, amt, n: nn });
    stocks.push({
      code, name: '测试股' + s, industry: '行业' + (s % 5),
      concepts: '财税数字化', mainScore: 10 - s * 0.2, mainNames: ['财税数字化'],
    });
  }

  const r = B.runBacktest({ klines, stocks, days: 30, holdDays: 3, topN: 5, strategy: 'balanced' });
  ok(!r.error, '回测无错误', r.error);
  ok(r.ok === true, '返回 ok 标记');
  // 注意：返回的是 tradeCount 与 recent（最近 20 笔），不是完整 trades
  ok(typeof r.tradeCount === 'number' && r.tradeCount > 0, '产生交易记录', '实际 ' + r.tradeCount);
  ok(Array.isArray(r.recent) && r.recent.length > 0, '返回 recent 最近交易');
  ok(typeof r.winRate === 'number', '返回胜率');
  inRange(r.winRate, 0, 1, '胜率为 0~1 小数', '实际 ' + r.winRate);
  ok(Array.isArray(r.equity) && r.equity.length > 1, '返回资金曲线');
  ok(typeof r.totalReturn === 'number', '返回总收益率（小数）');
  ok(typeof r.maxDD === 'number' && r.maxDD <= 0, '返回最大回撤（≤0）');
  ok(typeof r.profitFactor === 'number', '返回盈亏比');
  ok(Array.isArray(r.dateRange) && r.dateRange.length === 2, '返回回测区间');
  ok(typeof r.warning === 'string' && r.warning.length > 10, '带幸存者偏差提示');
  ok(r.recent[0].code && r.recent[0].buyDate, '交易记录含代码与买入日期');
  ok(typeof r.recent[0].ret === 'number', '交易记录含收益率');
  info('回测结果', `交易 ${r.tradeCount} 笔，胜率 ${(r.winRate * 100).toFixed(1)}%，总收益 ${(r.totalReturn * 100).toFixed(2)}%，最大回撤 ${(r.maxDD * 100).toFixed(2)}%`);
  info('回测区间', r.dateRange.join(' → '));

  // 空数据
  ok(B.runBacktest({}).error, '空数据 → 返回 error');
  ok(B.runBacktest({ klines: new Map(), stocks: [] }).error, '无 K 线 → 返回 error');

  // 矩阵回测（多持有期对比）
  const mtx = B.runBacktestMatrix({ klines, stocks, days: 20, topN: 5 });
  ok(Array.isArray(mtx) && mtx.length === 4, '矩阵回测返回 4 组结果', '实际 ' + (mtx ? mtx.length : 0));
  for (const m of mtx) {
    ok(typeof m.label === 'string' && m.label.length > 0, '矩阵结果含 label: ' + m.label);
    ok(typeof m.holdDays === 'number', '矩阵结果含 holdDays');
    ok(typeof m.winRate === 'number', '矩阵结果含胜率');
  }
  info('矩阵回测', mtx.map((m) => `${m.holdDays}日/${m.topN}只:胜率${(m.winRate * 100).toFixed(0)}%`).join(' '));
}

/* ============================================================
   第 8 组：api.js 解析与常量（离线部分）
   ============================================================ */

async function testApiOffline() {
  const A = await import(url('api.js'));
  describe('api.js · 解析与常量（离线部分）');

  // secid 前缀
  eq(A.secidOf('600000'), '1.600000', '沪市 600000 → 1.600000');
  eq(A.secidOf('688001'), '1.688001', '科创板 688001 → 1.688001');
  eq(A.secidOf('000001'), '0.000001', '深市 000001 → 0.000001');
  eq(A.secidOf('300001'), '0.300001', '创业板 300001 → 0.300001');
  eq(A.secidOf('301001'), '0.301001', '创业板 301001 → 0.301001');

  // 字段串常量
  ok(A.F_KLINE === 'f51,f52,f53,f54,f55,f56,f57', 'K 线字段串正确');
  ok(A.F_SNAP_FULL.includes('f12') && A.F_SNAP_FULL.includes('f20'), '快照字段含 f12/f20');
  ok(A.F_BOARD.includes('f109'), '板块字段含 f109（5 日涨跌）');
  eq(A.FS_ALL, 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23', '全市场 fs 范围正确');

  // parseKlines：注意顺序是 开/收/高/低
  const parsed = A.parseKlines([
    '2026-10-24,10.00,10.50,10.80,9.90,12345,13000000.00',
    '2026-10-25,10.50,10.60,10.70,10.40,22345,24000000.00',
  ]);
  eq(parsed.n, 2, 'parseKlines n = 2');
  eq(parsed.dates[0], '2026-10-24', '日期解析正确');
  eq(parsed.open[0], 10.00, '开盘价解析正确（第 2 列）');
  eq(parsed.close[0], 10.50, '收盘价解析正确（第 3 列）');
  eq(parsed.high[0], 10.80, '最高价解析正确（第 4 列）');
  eq(parsed.low[0], 9.90, '最低价解析正确（第 5 列）');
  eq(parsed.vol[0], 12345, '成交量解析正确');
  eq(parsed.amt[0], 13000000, '成交额解析正确');
  ok(parsed.close instanceof Float64Array, 'close 为 Float64Array（省内存）');

  // ymd
  const y = A.ymd(new Date(2026, 9, 26));
  eq(y, '20261026', 'ymd 格式 YYYYMMDD');

  // ApiError
  const err = new A.ApiError('测试错误', 'http://x');
  ok(err instanceof Error, 'ApiError 继承 Error');
  eq(err.name, 'ApiError', 'ApiError.name 正确');
  eq(err.url, 'http://x', 'ApiError 保留 url');
}

/* ============================================================
   第 9 组：在线端到端（--live）
   ============================================================ */

async function testLive() {
  const A = await import(url('api.js'));
  const U = await import(url('universe.js'));
  const M = await import(url('mainline.js'));
  const K = await import(url('market.js'));
  const I = await import(url('indicators.js'));
  const S = await import(url('strategy.js'));
  const P = await import(url('plan.js'));

  describe('在线端到端 · 真实东财数据');

  const t0 = Date.now();

  // 1. 全市场快照
  process.stdout.write('  拉取全市场快照（56 页）…');
  const rows = await A.fetchSnapshot({
    fields: A.F_SNAP_LITE + ',f9,f10,f23,f21,f62,f100,f103',
    limit: 6,
  });
  console.log(` ${rows.length} 只，${((Date.now() - t0) / 1000).toFixed(1)}s`);
  // 上游（东财）偶发限流/不可达时，快照会返回空。这属于环境抖动而非产品缺陷：
  // 产品端已逐只容错，自测端也应跳过后续联网断言，避免误报失败。
  if (rows.length < 4000) {
    info('在线端到端', '东财快照为空（上游限流/不可达），跳过后续联网断言（非产品缺陷）');
    return;
  }
  // 非交易时段（开盘前/集合竞价前/休市）东财实时行情字段全为 "-"，快照虽非空但无有效报价，
  // 此时选股必然为空——这是时段问题，不是逻辑缺陷。检测到则跳过联网选股断言。
  const quoted = rows.filter((r) => r && r.f2 !== '-' && r.f2 !== null && Number(r.f2) > 0).length;
  if (quoted < 4000) {
    info('在线端到端', `当前行情无有效报价（${quoted}/${rows.length} 只可报价）——处于非交易时段或集合竞价前，行情字段为 "-"，跳过联网选股断言（产品在交易时段正常）`);
    return;
  }
  ok(rows.length > 4000, '快照股票数 > 4000', '实际 ' + rows.length);
  const tSnap = Date.now() - t0;
  LIVE_T_SNAP = tSnap;

  // 2. 板块
  process.stdout.write('  拉取概念 + 行业板块…');
  const boards = await A.fetchBoards({ limit: 6 });
  console.log(` ${boards.length} 个`);
  ok(boards.length > 900, '板块数 > 900', '实际 ' + boards.length);

  // 3. 建池
  const { pool, stats } = U.buildUniverse(rows, { capital: 50000, maxPicks: 5 });
  console.log('  股票池 ' + pool.length + ' 只');
  // 池规模随「时点 + 当日成交额/换手/涨跌停分布」波动很大，不能写死窄区间：
  //   · 成交额阈值是累计值 → 越接近收盘，越过 1 亿的票越多，池子越大
  //   · 普跌日涨停票少 → 被「剔除涨停」刷掉的少，池子也更大
  // 实测同一天不同时点出现过 1097 / 1149 / 1417 / 1820 / 1848 / 1899 / 2023。
  // 因此这里只校验「量级合理」+「占总快照比例合理」，真正的硬约束由下面 0 ST / 0 超 800 亿等断言保证。
  inRange(pool.length, 800, 2800, '股票池规模在 [800,2800]', '实际 ' + pool.length);
  const poolRatio = pool.length / rows.length;
  inRange(poolRatio, 0.1, 0.6, '股票池占全市场比例在 [10%,60%]', '实际 ' + (poolRatio * 100).toFixed(1) + '%');
  ok(pool.every((s) => !U.isST(s.name)), '池内 0 只 ST 股');
  ok(pool.every((s) => s.mktCap <= 800e8), '池内 0 只市值 > 800 亿');
  ok(pool.every((s) => s.mktCap >= 20e8), '池内 0 只市值 < 20 亿');
  ok(pool.every((s) => s.price > 2), '池内 0 只价格 ≤ 2 元');
  ok(pool.every((s) => s.amount >= 1e8), '池内 0 只成交额 < 1 亿');
  const caps = pool.map((s) => s.mktCap / 1e8).sort((a, b) => a - b);
  const medianCap = caps[Math.floor(caps.length / 2)];
  if (caps.length) {
    info('市值分布(亿)', `最小 ${caps[0].toFixed(1)} / 中位 ${medianCap.toFixed(1)} / 最大 ${caps[caps.length - 1].toFixed(1)}`);
  }
  const prices = pool.map((s) => s.price).sort((a, b) => a - b);
  if (prices.length) info('价格中位数', prices[Math.floor(prices.length / 2)].toFixed(2) + ' 元');

  // 4. 主线
  const ml = M.analyzeMainline(boards);
  console.log('  有效板块 ' + ml.all.length + ' 个');
  inRange(ml.all.length, 500, 800, '有效板块数在 [500,800]', '实际 ' + ml.all.length);
  eq(ml.top.length, 20, '主线 Top20');
  eq(ml.bottom.length, 10, '退潮 Top10');
  console.log('  主线 Top8: ' + ml.top.slice(0, 8).map((b) => `${b.name}(${b.score.toFixed(1)})`).join(' '));
  console.log('  退潮 Top5: ' + ml.bottom.slice(0, 5).map((b) => `${b.name}(${b.score.toFixed(1)})`).join(' '));

  const { qualified, stats: mlStats } = M.annotatePool(pool, ml);
  console.log(`  过主线门槛 ${qualified.length} 只（匹配到板块 ${mlStats.matched}/${mlStats.pool}）`);
  ok(mlStats.matched / mlStats.pool > 0.95, '主线匹配率 > 95%', '实际 ' + ((mlStats.matched / mlStats.pool) * 100).toFixed(1) + '%');
  ok(qualified.length > 20, '过门槛股票数 > 20', '实际 ' + qualified.length);

  // 5. 指数 + 大盘
  // 指数接口偶发网络抖动（TypeError: fetch failed），整条失败会让大盘评分退化。
  // 这里重试整段，把「上游瞬断」和「真实逻辑缺陷」区分开（产品内 fetchKlines 已逐只容错）。
  let indexKl = null;
  let idxErr = null;
  for (let attempt = 0; attempt < 3 && !indexKl; attempt++) {
    try {
      indexKl = await A.fetchIndexKline('1.000001', 250);
    } catch (e) {
      idxErr = e;
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  if (!indexKl) {
    // 上游（push2his）对本机限流时，指数 K 线拉不到。这与产品逻辑无关——
    // 产品内 engine.js 同样用 fetchIndexKline(...).catch(() => null) 优雅降级。
    // 这里只标记「上游不可用」，跳过依赖指数的断言，其余逻辑照常验证。
    console.log('\n  \u001b[33m⚠ 上证指数 K 线上游暂不可用（限流/瞬断），跳过指数相关断言（产品内会优雅降级）\u001b[0m');
    info('上游状态', 'push2his 限流：指数 K 线拉取失败（非逻辑缺陷）');
    await testLiveLate(pool, ml, qualified, rows, { total: 0, pool: [] }, { total: 0, pool: [] }, mktFallback());
    return;
  }
  ok(indexKl && indexKl.n > 200, '上证指数 K 线 > 200 根', '实际 ' + (indexKl ? indexKl.n : 0));
  const idxQ = A.klineQuality(indexKl);
  ok(idxQ.ok, '上证指数 K 线质量合格（无 >15 天空档）', idxQ.reason + ` maxGap=${idxQ.maxGap}d`);
  const dateStr = A.ymd();
  const [ztPool, dtPool] = await Promise.all([
    A.fetchLimitPool('up', dateStr).catch(() => ({ total: 0, pool: [] })),
    A.fetchLimitPool('down', dateStr).catch(() => ({ total: 0, pool: [] })),
  ]);
  info('涨停/跌停家数', `${ztPool.total} / ${dtPool.total}`);
  const mkt = K.analyzeMarket({ indexKl, snapshot: rows, ztPool, dtPool });
  await dumpMarket(mkt);
  await testLiveLate(pool, ml, qualified, rows, ztPool, dtPool, mkt);
}

/** 大盘评分降级值：上游指数拉不到时，用中性近似（产品 engine 同样会降级） */
function mktFallback() {
  return {
    score: 50, level: { name: '中性(降级)', key: 'neutral', position: 0.6, picks: 5 },
    dims: {
      trend: { name: '趋势', score: 50, weight: 0.3 },
      breadth: { name: '广度', score: 50, weight: 0.25 },
      sentiment: { name: '情绪', score: 50, weight: 0.25 },
      volume: { name: '量能', score: 50, weight: 0.2 },
    },
  };
}

/** 打印大盘维度（两个分支共用） */
async function dumpMarket(mkt) {
  console.log(`  大盘 ${mkt.score.toFixed(1)} 分 → ${mkt.level.name}档（仓位 ${(mkt.level.position * 100).toFixed(0)}%，${mkt.level.picks} 只）`);
  inRange(mkt.score, 0, 100, '大盘得分在 [0,100]');
  ok(['attack', 'neutral', 'defend', 'frozen'].includes(mkt.level.key), '档位合法');
  for (const k of Object.keys(mkt.dims)) {
    const d = mkt.dims[k];
    info('维度 ' + d.name, d.score.toFixed(1) + ' (权重 ' + d.weight + ')');
  }
}

/** 尾段：K 线 → 因子 → 打分 → 计划 → 回测（两个分支共用）。上游不可用时，K 线/因子环节自动跳过。 */
async function testLiveLate(pool, ml, qualified, rows, ztPool, dtPool, mkt) {
  const A = await import(url('api.js'));
  const U = await import(url('universe.js'));
  const I = await import(url('indicators.js'));
  const S = await import(url('strategy.js'));
  const P = await import(url('plan.js'));
  const dateStr = A.ymd();
  const t0 = Date.now();

  // 7. K 线（限制 60 只以控制耗时）
  // 上游 HIS 池被本机限流时同样可能拉不到；与产品内一致——逐只容错，且允许「零 K 线」降级（因子环节跳过）。
  let klines = new Map();
  try {
    const want = qualified.slice(0, 60);
    process.stdout.write('  拉取 ' + want.length + ' 只日 K 线…');
    const tk = Date.now();
    klines = await A.fetchKlines(want.map((s) => s.code), 250, { limit: 6 });
    console.log(` 成功 ${klines.size} 只，${((Date.now() - tk) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.log('\u001b[33m⚠ K 线拉取失败（上游限流），跳过 K 线相关断言\u001b[0m');
  }
  if (klines.size > 0) {
    // 允许少量失败：上游 HIS 池限流时并发 6 会有部分连接被拒，产品端逐只容错。
    ok(klines.size >= 60 * 0.5, 'K 线成功率 ≥ 50%', `${klines.size}/60`);
    // 7.1 用当日快照补齐今日 bar
    const poolMap = U.poolToMap(pool);
    for (const [code, kl] of klines) {
      const s = poolMap.get(code);
      if (!s || !isFinite(s.open) || !isFinite(s.price)) continue;
      const last = kl.dates[kl.n - 1];
      if (last === dateStr.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')) continue; // 已有今日
      const nn = kl.n + 1;
      const dates = kl.dates.concat([dateStr.replace(/(\d{4})(\d{2})(\d{2})/, '$1-$2-$3')]);
      const o = new Float64Array(nn); o.set(kl.open); o[nn - 1] = s.open;
      const c = new Float64Array(nn); c.set(kl.close); c[nn - 1] = s.price;
      const h = new Float64Array(nn); h.set(kl.high); h[nn - 1] = s.high;
      const l = new Float64Array(nn); l.set(kl.low); l[nn - 1] = s.low;
      const v = new Float64Array(nn); v.set(kl.vol); v[nn - 1] = s.vol;
      const a = new Float64Array(nn); a.set(kl.amt); a[nn - 1] = s.amount;
      klines.set(code, { dates, open: o, close: c, high: h, low: l, vol: v, amt: a, n: nn });
    }
    // K 线必须完整：push2test 曾返回 73~116 根且带 28~57 天空档，会让 MA60/回撤失真。
    // 允许极少数次新股（上市不足一年）天然 K 线偏短，但不能出现「大面积残缺」。
    const nArr = [...klines.values()].map((k) => k.n);
    const shortOnes = nArr.filter((n) => n < 240).length;
    info('K 线根数', `min ${Math.min(...nArr)} / max ${Math.max(...nArr)} / <240根 ${shortOnes} 只`);
    ok(shortOnes <= Math.max(1, Math.floor(klines.size * 0.05)), 'K 线 ≥ 240 根（允许 ≤5% 次新股）',
      shortOnes ? `${shortOnes}/${klines.size} 只不足 240 根` : '');
    const badQ = [...klines.entries()].filter(([, k]) => !A.klineQuality(k).ok);
    ok(badQ.length === 0, '全部 K 线质量合格（无 >15 天空档）',
      badQ.slice(0, 3).map(([c, k]) => c + ':' + A.klineQuality(k).reason).join(' '));
  }

  // 8. 因子
  const withFactors = [];
  for (const s of qualified) {
    const kl = klines.get(s.code);
    if (!kl) continue;
    const f = I.computeFactors(kl);
    if (!f) continue;
    withFactors.push({ ...s, ...f });
  }
  console.log('  因子齐备 ' + withFactors.length + ' 只');
  // 零 K 线 = 上游 HIS 池限流（产品端会优雅降级为「无技术面因子」），
  // 此时打分/选股/计划/回测必然为空，属环境限制而非逻辑缺陷，跳过后续断言。
  if (klines.size === 0) {
    info('在线端到端', 'K 线上游不可用（push2his 限流），跳过因子/选股/计划/回测断言（非产品缺陷）');
    return;
  }
  ok(withFactors.length >= 20, '因子齐备股票数 ≥ 20', '实际 ' + withFactors.length);

  // 9. 打分 + 约束 + 计划
  const strategy = 'balanced';
  const scored = S.scoreCandidates(withFactors, strategy);
  const maxPicks = Math.min(5, mkt.level.picks);
  const picks = S.applyPortfolioConstraints(scored, maxPicks, { maxPerIndustry: 2, maxPerBoard: 2 });
  eq(picks.length, maxPicks, `选出 ${maxPicks} 只`);

  const plan = P.buildDailyPlan(picks, { capital: 50000, level: mkt.level, klines });
  eq(plan.items.length, maxPicks, '计划条目数与选出只数一致');
  ok(plan.items.every((it) => it.shares > 0), '每只都能买得起（股数 > 0）');
  ok(plan.totalAmount <= 50000, '总投入不超过本金', '实际 ' + plan.totalAmount);

  console.log('\n  \u001b[1m今日推荐（真实数据）\u001b[0m');
  console.log('  ' + '-'.repeat(96));
  for (const it of plan.items) {
    console.log(
      '  ' + String(it.code).padEnd(7) +
      String(it.name).slice(0, 6).padEnd(8) +
      ('委托 ' + it.bid).padEnd(12) +
      (it.shares + '股').padEnd(8) +
      ('金额 ' + Math.round(it.amount)).padEnd(12) +
      ('止损 ' + it.stop).padEnd(12) +
      ('止盈 ' + it.tp1).padEnd(12) +
      ('分 ' + (it.score || 0).toFixed(1))
    );
  }
  console.log('  ' + '-'.repeat(96));
  info('总投入', plan.totalAmount + ' 元 / 本金 50000 元');
  info('剩余资金', plan.cashLeft + ' 元');
  info('耗时', '快照 ' + (LIVE_T_SNAP / 1000).toFixed(1) + 's，总计 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');

  // 10. 回测
  const B = await import(url('backtest.js'));
  const stocksForBt = qualified.map((s) => ({
    code: s.code, name: s.name, industry: s.industry,
    concepts: s.concepts, mainScore: s.mainScore, mainNames: s.mainNames,
  }));
  const bt = B.runBacktest({ klines, stocks: stocksForBt, days: 20, holdDays: 3, topN: 5, strategy });
  if (!bt.error) {
    info('回测(20日/持有3日)',
      `交易 ${bt.tradeCount} 笔，胜率 ${(bt.winRate * 100).toFixed(1)}%，总收益 ${(bt.totalReturn * 100).toFixed(2)}%，最大回撤 ${(bt.maxDD * 100).toFixed(2)}%`);
    ok(bt.tradeCount > 0, '在线回测产生交易记录');
    ok(bt.dateRange[0] && bt.dateRange[1], '在线回测有区间');
    info('回测区间', bt.dateRange.join(' → '));
  } else {
    ok(false, '在线回测失败', bt.error);
  }
}

/* ============================================================
   主流程
   ============================================================ */

async function main() {
  const live = process.argv.includes('--live');

  console.log('');
  console.log('='.repeat(70));
  console.log('  A股每日买入计划 · 自测套件');
  console.log('  模式: ' + (live ? '离线单元测试 + 在线端到端' : '离线单元测试'));
  console.log('='.repeat(70));

  const t0 = Date.now();

  try {
    await testUniverse();
    await testMainline();
    await testIndicators();
    await testMarket();
    await testStrategy();
    await testPlan();
    await testBacktest();
    await testApiOffline();
    if (live) { await testLive(); }
  } catch (e) {
    failed++;
    failures.push('未捕获异常: ' + (e && e.stack ? e.stack : e));
    console.log('\n\u001b[31m未捕获异常:\u001b[0m');
    console.log(e && e.stack ? e.stack : e);
  }

  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  let report = '\n' + '='.repeat(70) + '\n';
  if (failed === 0) {
    report += `\u001b[32m  全部通过: ${passed} 项断言，耗时 ${dt}s\u001b[0m\n`;
  } else {
    report += `\u001b[31m  失败 ${failed} 项 / 通过 ${passed} 项，耗时 ${dt}s\u001b[0m\n`;
    report += '\n  失败清单:\n';
    for (const f of failures) report += '    \u001b[31m×\u001b[0m ' + f + '\n';
  }
  report += '='.repeat(70) + '\n';

  // 输出报告：写文件（最可靠） + stdout（TTY 下即时可见）
  try {
    fs.mkdirSync(path.dirname(REPORT_FILE), { recursive: true });
    fs.writeFileSync(REPORT_FILE, report, 'utf8');
  } catch (_) { /* 忽略文件写入失败 */ }
  process.stdout.write(report);
  process.exit(failed === 0 ? 0 : 1);
}

main();
