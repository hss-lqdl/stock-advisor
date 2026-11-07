/* ============================================================
   filters.js — 可配置过滤条件的声明式内核（零依赖、纯数据 + 纯函数）
   ------------------------------------------------------------
   设计目标：把「过滤条件」从代码里的闭包，变成可序列化、可编辑、
   可开关的数据。设置页据此渲染编辑器，用户可：
     · 逐个开关任意一道条件
     · 编辑每一道的阈值 / 区间
     · 给任意策略追加自定义条件（字段 + 运算符 + 阈值）
   规则（可 JSON 序列化，存在 settings.filterConfig 里）：
     {
       id: 'amountMin',          // 稳定 id（默认规则固定，自定义规则自动生成）
       on: true,                 // 是否启用
       kind: 'special' | 'field',
       special: 'st',            // kind==='special' 时用，见 SPECIAL_RULES
       field: 'amount',          // kind==='field' 时用，见 FILTER_FIELDS
       op: '>=',                 // 见 OPS
       value: 1, value2: null,   // 阈值（按字段的显示单位）
       strict: false,            // true = 字段缺失即剔除（默认 false = 放行）
       custom: false,            // 是否用户自建（自建可删除，默认只能关闭）
       label: '',                // 自定义标签（留空则按字段+运算符自动生成）
       note: '',                 // 标签后缀备注，如「（放量）」
     }
   约定：字段缺失时一律「放行」（fail-open），避免上游缺数据把池子清空；
   真正兜底的是 strategy.js 的 relaxStage2 逐级放宽。
   ============================================================ */

/** 配置结构版本号：将来字段含义变更时用于迁移 */
export const FILTER_CONFIG_VERSION = 1;

const isNum = (v) => typeof v === 'number' && isFinite(v);

/* ============================================================
   〇、与代码前缀相关的通用判定
   （放在这里而不是 universe.js，避免 filters ← universe 的循环依赖；
     universe.js 会原样 re-export，保持既有 import 路径可用）
   ============================================================ */

/** 涨停幅度按代码前缀区分：300/301/688 = 20%，其余 10% */
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

/** 当日是否已涨停（留 0.3% 余量）或一字板 */
export function isLimitUp(s) {
  if (!isNum(s.chgPct) || !isNum(s.prevClose)) return false;
  const lim = limitPct(s.code) * 100;
  if (s.chgPct >= lim - 0.3) return true;
  if (isNum(s.open) && isNum(s.high) && isNum(s.low)) {
    return Math.abs(s.open - s.high) < 1e-6 &&
           Math.abs(s.high - s.low) < 1e-6 &&
           s.chgPct >= lim - 0.5;
  }
  return false;
}

/** 当日是否已跌停 */
export function isLimitDown(s) {
  if (!isNum(s.chgPct)) return false;
  const lim = limitPct(s.code) * 100;
  return s.chgPct <= -(lim - 0.3);
}

/* ============================================================
   一、字段注册表
   scale：把原始值换算成「显示单位」的系数（市值元 → 亿元 = 1e-8）
   group：UI 下拉分组（snap = 快照可用 / factor = 需要 K 线 / text = 文本）
   ============================================================ */

const numField = (label, unit, scale, get, group = 'snap') =>
  ({ label, unit, scale, get, group, type: 'num' });
const textField = (label, get) =>
  ({ label, unit: '', scale: 1, get, group: 'text', type: 'text' });

export const FILTER_FIELDS = {
  /* --- 快照字段：基础过滤与 stage1 可用 --- */
  price: numField('价格', '元', 1, (s) => s.price),
  chgPct: numField('当日涨幅', '%', 1, (s) => s.chgPct),
  turnover: numField('换手率', '%', 1, (s) => s.turnover),
  volRatio: numField('量比', '', 1, (s) => s.volRatio),
  amount: numField('成交额', '亿', 1e-8, (s) => s.amount),
  mktCap: numField('总市值', '亿', 1e-8, (s) => s.mktCap),
  floatCap: numField('流通市值', '亿', 1e-8, (s) => s.floatCap),
  pe: numField('市盈率', '', 1, (s) => s.pe),
  pb: numField('市净率', '', 1, (s) => s.pb),
  mainInflow: numField('主力净流入', '亿', 1e-8, (s) => s.mainInflow),
  mainScore: numField('主线强度分', '', 1, (s) => s.mainScore),
  mainRank: numField('所属主线排名', '', 1, (s) => s.mainRank),

  /* --- K 线因子字段：stage2 可用 --- */
  mom20: numField('20日动量', '%', 100, (s) => s.mom20, 'factor'),
  mom5: numField('5日动量', '%', 100, (s) => s.mom5, 'factor'),
  // dd 是「距 60 日高的涨跌幅」（≤0，越负越深）；这里暴露成「回撤幅度」（正数）更直观
  ddMag: numField('60日回撤幅度', '%', 100, (s) => (isNum(s.dd) ? -s.dd : NaN), 'factor'),
  trend: numField('趋势强度', '%', 100, (s) => s.trend, 'factor'),
  rsi: numField('RSI', '', 1, (s) => s.rsi, 'factor'),
  atrp: numField('波动率ATR', '%', 100, (s) => s.atrp, 'factor'),
  maAlign: numField('均线多头数', '/3', 1, (s) => s.maAlign, 'factor'),
  vr: numField('量比(K线)', '', 1, (s) => s.vr, 'factor'),
  leader: numField('板块龙头度', '', 1, (s) => s.leader, 'factor'),

  /* --- 文本字段：用 contains / notContains / startsWith --- */
  name: textField('股票名称', (s) => s.name),
  code: textField('股票代码', (s) => s.code),
  industry: textField('所属行业', (s) => s.industry),
  concepts: textField('概念板块', (s) => s.concepts),
  market: textField('上市板块', (s) => s.market),
};

/** 按分组取字段（UI 下拉用） */
export function fieldsByGroup(group) {
  return Object.entries(FILTER_FIELDS)
    .filter(([, f]) => f.group === group)
    .map(([k, f]) => ({ key: k, ...f }));
}

/* ============================================================
   二、运算符
   ============================================================ */

export const OPS = {
  '>=': { label: '≥', arity: 1, kind: 'num' },
  '<=': { label: '≤', arity: 1, kind: 'num' },
  '>': { label: '>', arity: 1, kind: 'num' },
  '<': { label: '<', arity: 1, kind: 'num' },
  between: { label: '介于', arity: 2, kind: 'num' },
  contains: { label: '包含', arity: 1, kind: 'text' },
  notContains: { label: '不包含', arity: 1, kind: 'text' },
  startsWith: { label: '开头是', arity: 1, kind: 'text' },
  endsWith: { label: '结尾是', arity: 1, kind: 'text' },
};

/** 某字段可用的运算符列表 */
export function opsForField(fieldKey) {
  const f = FILTER_FIELDS[fieldKey];
  const kind = f && f.type === 'text' ? 'text' : 'num';
  return Object.entries(OPS)
    .filter(([, o]) => o.kind === kind)
    .map(([k, o]) => ({ key: k, ...o }));
}

/* ============================================================
   三、特殊条件（不是简单字段比较，或承载固定业务含义）
   locked: true 的条件在 UI 上禁用开关（关掉会让下游算不出来）
   ============================================================ */

export const SPECIAL_RULES = {
  suspended: {
    label: '剔除停牌/无报价',
    hint: '没有实时报价就算不出买入价，技术必需，不可关闭',
    locked: true,
  },
  st: { label: '剔除 ST / 退市', hint: '名称含 ST、* 或「退」' },
  limitUp: { label: '剔除涨停/一字板', hint: '已封板则尾盘买不进去' },
  limitDown: { label: '剔除跌停', hint: '跌停时卖出流动性差' },
  chiNext: { label: '剔除创业板', hint: '300 / 301 开头' },
  lotCost: { label: '一手成本 ≤ 单只预算', hint: '按本金与最多推荐只数估算' },
  shsz: { label: '仅保留沪深标的', hint: '剔除北交所等非沪深代码' },
  /* 以下三个用于策略 stage1 之外的组合条件，可按需启用 */
  mainTop: { label: '必须属于当前主线', hint: '所属板块需要落在主线 Top N 内' },
};

/* ============================================================
   四、默认规则（用户没改过时用的就是这些）
   ============================================================ */

/** 基础过滤（所有策略共用）。顺序即执行顺序。 */
export const BASE_RULE_DEFAULTS = [
  { id: 'suspend', on: true, kind: 'special', special: 'suspended' },
  { id: 'st', on: true, kind: 'special', special: 'st' },
  { id: 'priceMin', on: true, kind: 'field', field: 'price', op: '>', value: 2, strict: true },
  { id: 'marketCap', on: true, kind: 'field', field: 'mktCap', op: 'between', value: 20, value2: 800 },
  { id: 'amountMin', on: true, kind: 'field', field: 'amount', op: '>=', value: 1 },
  { id: 'turnoverMin', on: true, kind: 'field', field: 'turnover', op: '>=', value: 0.5 },
  { id: 'limitUp', on: true, kind: 'special', special: 'limitUp' },
  { id: 'limitDown', on: true, kind: 'special', special: 'limitDown' },
  { id: 'chiNext', on: true, kind: 'special', special: 'chiNext' },
  { id: 'lotCost', on: true, kind: 'special', special: 'lotCost' },
  { id: 'shsz', on: true, kind: 'special', special: 'shsz' },
];

/** 主线门槛（所有策略共用，可关可调） */
export const MAINLINE_DEFAULTS = {
  on: true,
  topN: 20,
  avoidBottom: true,
  bottomN: 10,
};

/** 各策略专属门槛：stage1 只用快照字段，stage2 需要 K 线因子 */
export const STAGE_RULE_DEFAULTS = {
  balanced: {
    stage1: [
      { id: 'b1_amount', on: true, kind: 'field', field: 'amount', op: '>=', value: 1.5 },
      { id: 'b1_turnover', on: true, kind: 'field', field: 'turnover', op: 'between', value: 1, value2: 18 },
      { id: 'b1_volRatio', on: true, kind: 'field', field: 'volRatio', op: '>=', value: 0.8 },
      { id: 'b1_mktCap', on: true, kind: 'field', field: 'mktCap', op: '<=', value: 600 },
    ],
    stage2: [
      { id: 'b2_mom20', on: true, kind: 'field', field: 'mom20', op: '>', value: -10 },
      { id: 'b2_maAlign', on: true, kind: 'field', field: 'maAlign', op: '>=', value: 1 },
      { id: 'b2_atrp', on: true, kind: 'field', field: 'atrp', op: '<=', value: 12, note: '（波动可控）' },
    ],
  },
  momentum: {
    stage1: [
      { id: 'm1_amount', on: true, kind: 'field', field: 'amount', op: '>=', value: 2 },
      { id: 'm1_turnover', on: true, kind: 'field', field: 'turnover', op: '>=', value: 2 },
      { id: 'm1_volRatio', on: true, kind: 'field', field: 'volRatio', op: '>=', value: 1.0, note: '（放量）' },
      { id: 'm1_chgPct', on: true, kind: 'field', field: 'chgPct', op: '>', value: 0 },
      { id: 'm1_mktCap', on: true, kind: 'field', field: 'mktCap', op: '<=', value: 800 },
    ],
    stage2: [
      { id: 'm2_maAlign', on: true, kind: 'field', field: 'maAlign', op: '>=', value: 3, strict: true },
      { id: 'm2_mom20', on: true, kind: 'field', field: 'mom20', op: '>', value: 0 },
      { id: 'm2_ddMag', on: true, kind: 'field', field: 'ddMag', op: '<=', value: 18 },
      { id: 'm2_rsi', on: true, kind: 'field', field: 'rsi', op: '<=', value: 82, note: '（不追过热）' },
    ],
  },
  reversal: {
    stage1: [
      { id: 'r1_amount', on: true, kind: 'field', field: 'amount', op: '>=', value: 1.2 },
      { id: 'r1_mktCap', on: true, kind: 'field', field: 'mktCap', op: '<=', value: 300, note: '（小盘弹性）' },
      { id: 'r1_chgPct', on: true, kind: 'field', field: 'chgPct', op: 'between', value: -8, value2: 3 },
      { id: 'r1_volRatio', on: true, kind: 'field', field: 'volRatio', op: '>=', value: 0.8 },
    ],
    stage2: [
      { id: 'r2_mom20', on: true, kind: 'field', field: 'mom20', op: '<', value: 0, note: '（确实跌过）' },
      { id: 'r2_ddMag', on: true, kind: 'field', field: 'ddMag', op: '>=', value: 15 },
      { id: 'r2_rsi', on: true, kind: 'field', field: 'rsi', op: '<=', value: 50, note: '（超卖区）' },
      { id: 'r2_atrp', on: true, kind: 'field', field: 'atrp', op: '<=', value: 15, note: '（不接崩盘股）' },
    ],
  },
  dragon: {
    stage1: [
      { id: 'd1_mainRank', on: true, kind: 'field', field: 'mainRank', op: '<=', value: 10 },
      { id: 'd1_amount', on: true, kind: 'field', field: 'amount', op: '>=', value: 2 },
      { id: 'd1_turnover', on: true, kind: 'field', field: 'turnover', op: '>=', value: 2 },
      { id: 'd1_mktCap', on: true, kind: 'field', field: 'mktCap', op: '<=', value: 800 },
    ],
    stage2: [
      { id: 'd2_leader', on: true, kind: 'field', field: 'leader', op: '>=', value: 60 },
      { id: 'd2_maAlign', on: true, kind: 'field', field: 'maAlign', op: '>=', value: 3, strict: true },
      { id: 'd2_mom20', on: true, kind: 'field', field: 'mom20', op: '>', value: 0 },
      { id: 'd2_vr', on: true, kind: 'field', field: 'vr', op: '>=', value: 1.0, note: '（放量）' },
      { id: 'd2_ddMag', on: true, kind: 'field', field: 'ddMag', op: '<=', value: 15 },
    ],
  },
};

/* ============================================================
   五、标签生成与求值
   ============================================================ */

/** 数字去掉多余小数位：1 → "1"，1.5 → "1.5"，1.25 → "1.25" */
function fmtVal(v) {
  const n = Number(v);
  if (!isFinite(n)) return String(v == null ? '' : v);
  const r = Math.round(n * 10000) / 10000;
  return String(r);
}

/** 生成规则的可读中文标签 */
export function ruleLabel(rule, ctx = {}) {
  if (!rule) return '';
  if (rule.label) return rule.label + (rule.note || '');
  const note = rule.note || '';
  if (rule.kind === 'special') {
    const def = SPECIAL_RULES[rule.special];
    let base = def ? def.label : String(rule.special || '');
    // 一手成本门槛的预算随本金/只数变化，标签里带上实际金额
    if (rule.special === 'lotCost' && isNum(ctx.budgetPerStock)) {
      base = `一手成本 ≤ ${Math.round(ctx.budgetPerStock)} 元`;
    }
    return base + note;
  }
  const f = FILTER_FIELDS[rule.field];
  if (!f) return String(rule.field || '') + note;
  const op = OPS[rule.op];
  if (!op) return f.label + note;
  const u = f.unit || '';
  if (rule.op === 'between') {
    return `${f.label} ${fmtVal(rule.value)}~${fmtVal(rule.value2)}${u}${note}`;
  }
  if (op.kind === 'text') {
    return `${f.label} ${op.label}「${rule.value == null ? '' : rule.value}」${note}`;
  }
  return `${f.label} ${op.label} ${fmtVal(rule.value)}${u}${note}`;
}

/* ---------- 特殊条件求值 ---------- */

export function isChiNext(code) {
  const c = String(code);
  return c.startsWith('300') || c.startsWith('301');
}

function evalSpecial(key, s, ctx) {
  switch (key) {
    case 'suspended':
      return isNum(s.price);
    case 'st':
      return !(s.name && isST(s.name));
    case 'limitUp':
      return !isLimitUp(s);
    case 'limitDown':
      return !isLimitDown(s);
    case 'chiNext':
      return !isChiNext(s.code);
    case 'lotCost': {
      if (!isNum(s.price)) return false;
      // 科创板（688）一手至少 200 股，其余 100 股
      const lot = String(s.code).startsWith('688') ? 200 : 100;
      const budget = isNum(ctx.budgetPerStock) ? ctx.budgetPerStock : Infinity;
      return s.price * lot <= budget;
    }
    case 'shsz':
      return /^[036]/.test(String(s.code));
    case 'mainTop':
      return isNum(s.mainRank) ? s.mainRank <= (isNum(ctx.topN) ? ctx.topN : 20) : true;
    default:
      return true;
  }
}

/* ---------- 数值 / 文本比较 ---------- */

function applyNumOp(op, v, a, b) {
  switch (op) {
    case '>=': return v >= a;
    case '<=': return v <= a;
    case '>': return v > a;
    case '<': return v < a;
    case 'between': {
      const lo = Math.min(a, b);
      const hi = Math.max(a, b);
      return v >= lo && v <= hi;
    }
    default: return true;
  }
}

function applyTextOp(op, txt, val) {
  const needle = val == null ? '' : String(val);
  switch (op) {
    case 'contains': return txt.includes(needle);
    case 'notContains': return !txt.includes(needle);
    case 'startsWith': return txt.startsWith(needle);
    case 'endsWith': return txt.endsWith(needle);
    default: return true;
  }
}

/**
 * 求值单条规则。
 * @param {object} rule 规则对象
 * @param {object} s 股票对象（标准化后的，可含因子）
 * @param {object} ctx { budgetPerStock, topN }
 * @returns {boolean} true = 保留
 */
export function evalRule(rule, s, ctx = {}) {
  if (!rule || rule.on === false) return true;
  if (rule.kind === 'special') return evalSpecial(rule.special, s, ctx);

  const f = FILTER_FIELDS[rule.field];
  if (!f) return true;
  const op = OPS[rule.op];
  if (!op) return true;

  const raw = f.get(s);

  if (f.type === 'text' || op.kind === 'text') {
    const txt = raw == null ? '' : String(raw);
    if (!txt) return rule.strict ? false : true;
    return applyTextOp(rule.op, txt, rule.value);
  }

  if (!isNum(raw)) return rule.strict ? false : true;
  const v = raw * (isNum(f.scale) ? f.scale : 1);
  return applyNumOp(rule.op, v, Number(rule.value), Number(rule.value2));
}

/** 依次跑一组规则，返回幸存者；可选把每一步记进 stats */
export function runRules(rows, rules, ctx = {}, stats = null) {
  let cur = rows;
  for (const rule of rules || []) {
    if (rule.on === false) continue;
    const before = cur.length;
    cur = cur.filter((s) => evalRule(rule, s, ctx));
    if (stats) stats.add(ruleLabel(rule, ctx), before, cur.length);
  }
  return cur;
}

/* ============================================================
   六、配置解析（默认值 + 用户改写 / 旧设置迁移）
   ============================================================ */

/** 深拷贝一条规则（只保留已知字段，避免脏数据进配置） */
export function cloneRule(r) {
  return {
    id: String(r.id || ''),
    on: r.on !== false,
    kind: r.kind === 'special' ? 'special' : 'field',
    special: r.special || '',
    field: r.field || '',
    op: r.op || '>=',
    value: r.value === undefined ? 0 : r.value,
    value2: r.value2 === undefined || r.value2 === null ? null : r.value2,
    strict: r.strict === true,
    custom: r.custom === true,
    label: r.label || '',
    note: r.note || '',
  };
}

export function cloneList(list) {
  return (list || []).map(cloneRule);
}

/**
 * 合并「默认规则列表」与「用户保存的列表」：
 *   · 同 id → 用用户的字段覆盖（含 on:false 的关闭状态）
 *   · 用户新增的 id → 追加（自定义条件）
 *   · 用户删除的自定义 id → 不再出现（默认规则不允许删除，只能关闭）
 */
export function mergeList(defaults, saved) {
  const out = cloneList(defaults);
  if (!Array.isArray(saved)) return out;
  const idx = new Map(out.map((r, i) => [r.id, i]));
  for (const raw of saved) {
    if (!raw || !raw.id) continue;
    const r = cloneRule(raw);
    const i = idx.get(r.id);
    if (i === undefined) {
      out.push(r);
      idx.set(r.id, out.length - 1);
    } else {
      out[i] = r;
    }
  }
  return out;
}

let _seq = 0;
/** 生成一个自定义规则 id（同一会话内不重复即可，跨会话靠时间戳） */
export function newRuleId(prefix = 'c') {
  _seq += 1;
  return `${prefix}${Date.now().toString(36)}${_seq.toString(36)}`;
}

/** 造一条自定义规则 */
export function makeRule(opt = {}) {
  const field = opt.field || 'amount';
  const f = FILTER_FIELDS[field];
  const ops = opsForField(field);
  return cloneRule({
    id: opt.id || newRuleId(),
    on: opt.on !== false,
    kind: 'field',
    field,
    op: opt.op || (ops[0] ? ops[0].key : '>='),
    value: opt.value === undefined ? 1 : opt.value,
    value2: opt.value2 === undefined ? null : opt.value2,
    strict: opt.strict === true,
    custom: true,
    label: opt.label || '',
    note: opt.note || '',
  });
}

/** 把规则列表转成可存档的精简结构 */
export function serializeConfig(cfg) {
  const c = cfg || {};
  const strategies = {};
  for (const [k, v] of Object.entries(c.strategies || {})) {
    strategies[k] = {
      stage1: cloneList(v.stage1),
      stage2: cloneList(v.stage2),
    };
  }
  return {
    v: FILTER_CONFIG_VERSION,
    base: cloneList(c.base),
    mainline: { ...MAINLINE_DEFAULTS, ...(c.mainline || {}) },
    strategies,
  };
}

/**
 * 解析出「当前生效的完整过滤配置」。
 * @param {object|null} saved settings.filterConfig（用户保存过的）
 * @param {object} legacy 旧的散装设置（excludeChiNext / minMarketCap / maxMarketCap）
 * @returns {{v:number, base:Array, mainline:object, strategies:object}}
 */
export function resolveFilterConfig(saved, legacy = {}) {
  const savedOk = saved && typeof saved === 'object';
  const cfg = {
    v: FILTER_CONFIG_VERSION,
    base: savedOk ? mergeList(BASE_RULE_DEFAULTS, saved.base) : cloneList(BASE_RULE_DEFAULTS),
    mainline: { ...MAINLINE_DEFAULTS, ...(savedOk && saved.mainline ? saved.mainline : null) },
    strategies: {},
  };

  for (const key of Object.keys(STAGE_RULE_DEFAULTS)) {
    const def = STAGE_RULE_DEFAULTS[key];
    const sv = savedOk && saved.strategies ? saved.strategies[key] : null;
    cfg.strategies[key] = {
      stage1: sv ? mergeList(def.stage1, sv.stage1) : cloneList(def.stage1),
      stage2: sv ? mergeList(def.stage2, sv.stage2) : cloneList(def.stage2),
    };
  }

  // 用户没保存过配置时，用旧设置回填，保证老用户升级后不掉设置
  if (!savedOk) {
    if (legacy.excludeChiNext === false) {
      const cn = cfg.base.find((r) => r.id === 'chiNext');
      if (cn) cn.on = false;
    }
    const mc = cfg.base.find((r) => r.id === 'marketCap');
    if (mc) {
      if (isNum(legacy.minMarketCap)) mc.value = legacy.minMarketCap;
      if (isNum(legacy.maxMarketCap)) mc.value2 = legacy.maxMarketCap;
    }
  }

  return cfg;
}

/** 按 id 改一条规则（返回新数组，不改原配置） */
export function setRule(list, id, patch) {
  const out = cloneList(list);
  const i = out.findIndex((r) => r.id === id);
  if (i >= 0) out[i] = cloneRule({ ...out[i], ...patch });
  return out;
}

/** 在列表里替换 / 追加规则 */
export function upsertRule(list, rule) {
  const out = cloneList(list);
  const i = out.findIndex((r) => r.id === rule.id);
  if (i >= 0) out[i] = cloneRule(rule);
  else out.push(cloneRule(rule));
  return out;
}

/** 从列表里删除规则（仅用于自定义规则） */
export function removeRule(list, id) {
  return cloneList(list).filter((r) => r.id !== id);
}

/** 统计一份配置里启用的条件数量，用于设置页概览 */
export function countRules(cfg) {
  let on = 0;
  let total = 0;
  for (const r of (cfg && cfg.base) || []) {
    total += 1;
    if (r.on !== false) on += 1;
  }
  if (cfg && cfg.mainline && cfg.mainline.on !== false) on += 1;
  total += 1;
  for (const st of Object.values((cfg && cfg.strategies) || {})) {
    for (const r of (st.stage1 || []).concat(st.stage2 || [])) {
      total += 1;
      if (r.on !== false) on += 1;
    }
  }
  return { on, total };
}
