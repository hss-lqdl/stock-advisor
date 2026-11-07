/* ============================================================
   api.js — 东方财富公开行情接口封装
   纯前端直连：已实测东财对任意 Origin 反射式放行 CORS
   兜底：JSONP（cb= 参数）当 fetch 被拦时自动降级
   ============================================================ */

const HOST_PUSH = 'https://push2test.eastmoney.com';
/*
 * 日 K 必须走 push2his 系，不能用 push2test！
 * 【实测 2026-10-26】push2test 的 kline 数据窗口被截断：lmt=250 时
 *   1.600519 只回 116 根（首根固定 2026-02-27）、1.688648 只回 73 根、
 *   1.601607 只回 99 根，且中间有 28~57 天的大段缺口（lmt/beg/fqt 全改也无效）。
 *   用它算 MA60 / 60 日回撤 / 20 日动量会严重失真。
 * push2his 系同参数稳定返回完整 250 根、日期连续（唯一缺口是春节休市 11 天）。
 */
const HOST_HIS  = 'https://push2his.eastmoney.com';
const HOST_EX   = 'https://push2ex.eastmoney.com';

/* 统一查询参数：fltt=2 是必须的，否则数值会被放大 100 倍 */
const BASE = 'fltt=2&invt=2';

/* ============================================================
   主机故障转移（已实测：push2 主域名会间歇性 "other side closed"，
   而 1/2/4/5/8/10.push2 与 push2test 是等价镜像，可无缝替换）
   ============================================================ */

/**
 * 可互换的行情镜像主机。
 *
 * 【实测依据 2026-10-26】东财主域名 push2 / push2his 会整段路由劣化：
 *   TCP 443 可连（24ms）、TLS 1.3 握手成功，但发完 HTTP 请求即被 RST
 *   （Node 侧表现为 UND_ERR_SOCKET / other side closed），持续 20s 以上不恢复。
 *   而 push2test.eastmoney.com 在 HTTPS 下对 clist / ulist / kline 全部 5/5 成功，
 *   且返回的是实时生产数据（盘中两次请求成交额从 310499621 增至 310559725），
 *   数据字段与主域名逐字段一致。
 * 因此把 push2test 放第一位，其余域名作为后备（它们可能在不同网络环境下更好）。
 *
 * 【刻意排除 push2delay.eastmoney.com】它是延迟行情源，用于实盘交易会给出错误价格，
 * 宁可失败也不能用延迟数据下单。
 */
const PUSH_MIRRORS = [
  'push2test.eastmoney.com',
  'push2.eastmoney.com',
  '8.push2.eastmoney.com',
  '1.push2.eastmoney.com',
  '2.push2.eastmoney.com',
  '4.push2.eastmoney.com',
  '5.push2.eastmoney.com',
];

/**
 * push2his 系（日 K）镜像。
 *
 * 【实测依据 2026-10-26，浏览器内 iPhone UA，30 只股票 × 每主机最多 2 次重试】
 *   push2his     ok=16/30 full=16  (成功者全部 ≥240 根，数据完整)
 *   3.push2his   ok=19/30 full=19
 *   1.push2his   ok=16/30 full=16
 *   6.push2his   ok=17/30 full=17
 * 单主机成功率约 55%，四主机轮转 + 每主机重试后综合成功率 ≈ 96%，足够冷启动使用。
 * 注意：这 4 个主机对 clist/ulist 全部失败，快照必须走 PUSH_MIRRORS（已分池）。
 * 也刻意不含 push2test：它的 kline 数据窗口残缺（见 HOST_HIS 注释）。
 */
const HIS_MIRRORS = [
  '3.push2his.eastmoney.com',
  '6.push2his.eastmoney.com',
  'push2his.eastmoney.com',
  '1.push2his.eastmoney.com',
];

/** 精确主机名集合，用于 rewriteHost 判定（不能用 includes('push2')，会误伤 push2ex） */
const PUSH_HOST_SET = new Set(PUSH_MIRRORS);
const HIS_HOST_SET = new Set(HIS_MIRRORS);

/**
 * 主机健康状态。
 *   score  : 0 起，成功 +1（上限 0），失败 -3（下限 -12）
 *   fails  : 连续失败次数
 *   lastOk : 最近一次成功的时间戳（0 = 从未成功）
 *   downAt : 进入冷却的时刻
 *
 * 【排序策略（关键）】必须优先「已知可用」的主机，而不是「从没试过」的主机。
 * 曾经的实现只按 score 排序，结果 push2test 抖动一次（score -3）后，
 * 从没试过的 push2（score 0）反而排到它前面，而 push2 实际已死 →
 * 每次请求都先撞死主机再回退，整个 App 启动极慢甚至失败。
 */
const hostHealth = new Map();
const HOST_COOLDOWN_MS = 20000;
const COOLDOWN_AFTER_FAILS = 2;

function hostState(h) {
  let s = hostHealth.get(h);
  if (!s) { s = { score: 0, fails: 0, lastOk: 0, downAt: 0 }; hostHealth.set(h, s); }
  return s;
}
function hostScore(h) {
  return hostState(h).score;
}
function isCooling(h) {
  const s = hostState(h);
  return s.downAt > 0 && Date.now() - s.downAt < HOST_COOLDOWN_MS;
}
function markHost(h, ok) {
  if (!h) return;
  const s = hostState(h);
  if (ok) {
    s.score = Math.min(0, s.score + 1);
    s.fails = 0;
    s.lastOk = Date.now();
    s.downAt = 0;
  } else {
    s.score = Math.max(-12, s.score - 3);
    s.fails += 1;
    if (s.fails >= COOLDOWN_AFTER_FAILS) s.downAt = Date.now();
  }
}

/**
 * 主机优先级：数字越小越优先。
 *   0 = 本次会话成功过（已知可用，最可信）
 *   1 = 从未试过（未知）
 *   2 = 试过但从未成功（多半不可用）
 *   3 = 冷却中（明确故障，排最后）
 */
function hostRank(h) {
  const s = hostState(h);
  if (isCooling(h)) return 3;
  if (s.lastOk > 0 && s.fails === 0) return 0;
  if (s.fails === 0) return 1;
  return 2;
}

/** 对外暴露主机健康快照，便于设置页显示网络诊断 */
export function hostHealthSnapshot() {
  const out = [];
  for (const [host, s] of hostHealth) {
    out.push({ host, score: s.score, cooling: isCooling(host) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/**
 * 把 URL 中的东财主机名替换为第 n 个候选镜像。
 * 排序规则：健康分高的优先，冷却中的主机排到最后。
 *
 * 【重要】必须用「精确主机名」判断而不是 includes('push2')：
 *   push2ex.eastmoney.com（涨跌停池）与 push2/push2his 是不同服务，
 *   互相替换会因 CORS/路径不存在而失败，进而污染健康分。
 * @param {string} url
 * @param {number} n 轮转序号
 */
export function rewriteHost(url, n = 0) {
  const host = hostOf(url);
  if (!host) return url;

  let mirrors = null;
  if (PUSH_HOST_SET.has(host)) {
    // 日K 走 HIS 镜像池（push2his 系），其余走 PUSH 镜像池
    mirrors = url.includes('/kline/') ? HIS_MIRRORS : PUSH_MIRRORS;
  } else if (HIS_HOST_SET.has(host)) {
    mirrors = HIS_MIRRORS;
  } else {
    return url;                       // push2ex 等其它服务保持原样
  }

  const ordered = [...new Set(mirrors)].sort((a, b) => {
    const ra = hostRank(a);
    const rb = hostRank(b);
    if (ra !== rb) return ra - rb;              // 已知可用 > 未知 > 已知失败 > 冷却
    return hostScore(b) - hostScore(a);         // 同档内健康分高的优先
  });
  const target = ordered[n % ordered.length];
  if (!target || target === host) return url;
  return url.replace(host, target);
}

/** 从 URL 里取出东财主机名 */
function hostOf(url) {
  try {
    return new URL(url).host;
  } catch (e) {
    return '';
  }
}

/* 全市场范围：沪主板 + 深主板 + 创业板 + 科创板 */
export const FS_ALL = 'm:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23';
export const FS_CONCEPT = 'm:90+t:3';
export const FS_INDUSTRY = 'm:90+t:2';

/* 快照字段集 */
export const F_SNAP_FULL =
  'f2,f3,f5,f6,f8,f9,f10,f12,f13,f14,f15,f16,f17,f18,f20,f21,f23,f62,f100,f103';
export const F_SNAP_LITE = 'f2,f3,f5,f6,f8,f12,f14,f15,f16,f17,f18,f20';
export const F_SNAP_MIN  = 'f2,f3,f5,f6,f8,f12,f14';
export const F_BOARD =
  'f2,f3,f12,f14,f62,f104,f105,f109,f160';

/* K 线字段：注意顺序是 开/收/高/低，不是 开/高/低/收 */
export const F_KLINE = 'f51,f52,f53,f54,f55,f56,f57';

const DEFAULT_TIMEOUT = 12000;
/**
 * 默认重试次数。实测：单主机在路由劣化时 3 次重试全失败，但换主机后 100% 成功，
 * 因此这里保证「至少覆盖 3 个不同镜像」。
 */
const DEFAULT_RETRY = 3;

/* ---------------- 基础工具 ---------------- */

export class ApiError extends Error {
  constructor(msg, url) {
    super(msg);
    this.name = 'ApiError';
    this.url = url;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 带超时 + 重试 + 主机故障转移 + JSONP 兜底的 GET JSON */
export async function getJSON(url, opts = {}) {
  const timeout = opts.timeout ?? DEFAULT_TIMEOUT;
  const retry = opts.retry ?? DEFAULT_RETRY;
  const rotate = opts.rotate !== false;      // 是否启用镜像轮转
  let lastErr = null;

  for (let attempt = 0; attempt <= retry; attempt++) {
    const tryUrl = rotate ? rewriteHost(url, attempt) : url;
    try {
      const data = await fetchJSON(tryUrl, timeout);
      markHost(hostOf(tryUrl), true);
      return data;
    } catch (e) {
      markHost(hostOf(tryUrl), false);
      lastErr = e;
      // JSONP 兜底：仅当这是 fetch 层失败（CORS/网络被拦）且只试一次。
      // 路由 RST 类故障 JSONP 同样会失败，所以不占用重试预算。
      if (attempt === 0 && opts.jsonp !== false && isNetworkError(e)) {
        try {
          const data = await jsonpJSON(tryUrl, timeout);
          markHost(hostOf(tryUrl), true);
          return data;
        } catch (e2) {
          markHost(hostOf(tryUrl), false);
          lastErr = e;
        }
      }
      // 退避：路由劣化需要秒级恢复，指数退避比固定 220ms 更有效
      if (attempt < retry) await sleep(Math.min(1500, 200 * Math.pow(2, attempt)));
    }
  }
  throw lastErr || new ApiError('请求失败', url);
}

/** 判断是否属于网络层错误（可尝试 JSONP 兜底） */
function isNetworkError(e) {
  if (!e) return false;
  const msg = String(e.message || e.name || '');
  return /Failed to fetch|NetworkError|load failed|other side closed|ECONNRESET|ECONNREFUSED|UND_ERR/i.test(msg);
}

async function fetchJSON(url, timeout) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      credentials: 'omit',
      mode: 'cors',
      cache: 'no-store',
    });
    if (!res.ok) throw new ApiError('HTTP ' + res.status, url);
    const text = await res.text();
    return parseMaybeJSONP(text);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError('请求超时', url);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/** 东财部分接口即使没传 cb 也可能返回 JSONP 包装，这里统一解包 */
function parseMaybeJSONP(text) {
  const s = text.trim();
  if (s.startsWith('{') || s.startsWith('[')) return JSON.parse(s);
  const m = s.match(/^[\w$.]+\s*\(([\s\S]*)\)\s*;?\s*$/);
  if (m) return JSON.parse(m[1]);
  throw new ApiError('响应不是合法 JSON', '');
}

let jsonpSeq = 0;
/** JSONP 兜底通道：用 <script> 标签绕过 fetch 限制 */
export function jsonpJSON(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const cb = '__em_cb_' + Date.now() + '_' + (++jsonpSeq);
    const sep = url.includes('?') ? '&' : '?';
    const full = url + sep + 'cb=' + cb;
    const script = document.createElement('script');
    let done = false;

    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      try { delete window[cb]; } catch (e) { window[cb] = undefined; }
      script.remove();
    };
    const timer = setTimeout(() => {
      if (done) return;
      cleanup();
      reject(new ApiError('JSONP 超时', url));
    }, timeout);

    window[cb] = (data) => {
      if (done) return;
      cleanup();
      resolve(data);
    };
    script.onerror = () => {
      if (done) return;
      cleanup();
      reject(new ApiError('JSONP 加载失败', url));
    };
    script.src = full;
    document.head.appendChild(script);
  });
}

/**
 * 并发池：按 limit 并发执行 tasks（函数数组），返回结果数组。
 * 失败的 task 结果为 null，不中断整体。
 */
export async function pool(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let next = 0;

  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = null;
      }
    }
  }

  const n = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

/** 简单进度回调包装 */
export function withProgress(tasks, limit, onProgress) {
  let done = 0;
  const total = tasks.length;
  const wrapped = tasks.map((t) => async () => {
    try {
      return await t();
    } finally {
      done++;
      if (onProgress) {
        try { onProgress(done, total); } catch (e) { /* ignore */ }
      }
    }
  });
  return pool(wrapped, limit);
}

/* ---------------- 分页抓取 ---------------- */

/**
 * 抓取 clist 列表（单页硬上限 100，必须分页）。
 * @param {string} fs   板块范围
 * @param {string} fields 字段串
 * @param {object} opt  { pages, limit, onPage, pageSize, sortField }
 * @returns {Promise<Array>}
 */
export async function fetchList(fs, fields, opt = {}) {
  const pageSize = Math.min(100, opt.pageSize || 100);
  const limit = opt.limit || 6;
  const sortField = opt.sortField || 'f3';

  const firstUrl =
    `${HOST_PUSH}/api/qt/clist/get?pn=1&pz=${pageSize}&po=1&np=1&${BASE}` +
    `&fid=${sortField}&fs=${encodeURIComponent(fs)}&fields=${fields}`;

  const first = await getJSON(firstUrl, {
    timeout: opt.timeout || 12000,
    retry: opt.retry,
  });
  const data = first && first.data;
  if (!data) return [];
  // 有时 data.diff 是对象（key 为序号），统一转数组
  const firstRows = Array.isArray(data.diff)
    ? data.diff
    : data.diff && typeof data.diff === 'object'
      ? Object.values(data.diff)
      : [];
  const total = Number(data.total) || firstRows.length;
  const pages = opt.pages || Math.ceil(total / pageSize);
  const out = [...firstRows];

  const tasks = [];
  for (let p = 2; p <= pages; p++) {
    const url =
      `${HOST_PUSH}/api/qt/clist/get?pn=${p}&pz=${pageSize}&po=1&np=1&${BASE}` +
      `&fid=${sortField}&fs=${encodeURIComponent(fs)}&fields=${fields}`;
    tasks.push(async () => {
      const j = await getJSON(url, {
        timeout: opt.timeout || 12000,
        retry: opt.retry,
      });
      const d = j && j.data;
      if (!d) throw new ApiError('分页响应无数据', url);
      if (Array.isArray(d.diff)) return d.diff;
      if (d.diff && typeof d.diff === 'object') return Object.values(d.diff);
      throw new ApiError('分页响应格式无效', url);
    });
  }

  let donePages = 1;
  const rs = tasks.length
    ? await withProgress(tasks, limit, (d) => {
      donePages = 1 + d;
      if (opt.onPage) {
        try { opt.onPage(donePages, pages, out.length); } catch (e) { /* ignore */ }
      }
    })
    : [];

  const failedPages = rs
    .map((r, i) => Array.isArray(r) ? null : i + 2)
    .filter((page) => page !== null);
  if (failedPages.length) {
    throw new ApiError(
      `行情分页不完整：第 ${failedPages.join('、')} 页请求失败，共 ${pages} 页`,
      firstUrl,
    );
  }
  for (const r of rs) out.push(...r);

  // 去重（分页边界可能重复）
  const seen = new Set();
  const uniq = [];
  for (const x of out) {
    const code = x && x.f12;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    uniq.push(x);
  }
  if (opt.requireComplete && uniq.length !== total) {
    throw new ApiError(
      `行情分页不完整：预期 ${total} 条，实际 ${uniq.length} 条`,
      firstUrl,
    );
  }
  return uniq;
}

/** 全市场快照 */
export function fetchSnapshot(opt = {}) {
  return fetchList(FS_ALL, opt.fields || F_SNAP_FULL, {
    limit: opt.limit || 6,
    onPage: opt.onPage,
    timeout: opt.timeout,
    sortField: 'f12',
    requireComplete: true,
  });
}

/** 板块列表（概念 + 行业合并） */
export async function fetchBoards(opt = {}) {
  const limit = opt.limit || 6;
  const [concepts, industries] = await Promise.all([
    fetchList(FS_CONCEPT, F_BOARD, { limit, onPage: opt.onPage }),
    fetchList(FS_INDUSTRY, F_BOARD, { limit, onPage: opt.onPage }),
  ]);
  const tag = (arr, type) => arr.map((b) => ({ ...b, _type: type }));
  return [...tag(concepts, 'concept'), ...tag(industries, 'industry')];
}

/* ---------------- 批量行情（ulist） ---------------- */

const ULIST_MAX = 100;

/** secid 前缀：沪市(6/9 开头)=1.，深市(0/3 开头)=0. */
export function secidOf(code) {
  const c = String(code);
  if (c.startsWith('6') || c.startsWith('9') || c.startsWith('5')) return '1.' + c;
  return '0.' + c;
}

/**
 * 批量拉取行情（单次最多 100 个 secid，自动分批）
 * @param {string[]} codes 6 位代码
 * @param {string} fields
 * @param {object} opt { limit, onProgress }
 */
export async function fetchQuotes(codes, fields = F_SNAP_LITE, opt = {}) {
  const list = Array.from(new Set(codes.map(String)));
  if (!list.length) return [];

  const chunks = [];
  for (let i = 0; i < list.length; i += ULIST_MAX) {
    chunks.push(list.slice(i, i + ULIST_MAX));
  }

  const tasks = chunks.map((chunk) => async () => {
    const secids = chunk.map(secidOf).join(',');
    const url = `${HOST_PUSH}/api/qt/ulist.np/get?${BASE}&secids=${secids}&fields=${fields}`;
    const j = await getJSON(url, { timeout: 10000 });
    const d = j && j.data;
    if (!d || !d.diff) return [];
    return Array.isArray(d.diff) ? d.diff : Object.values(d.diff);
  });

  const rs = await withProgress(tasks, opt.limit || 5, opt.onProgress);
  const out = [];
  for (const r of rs) if (Array.isArray(r)) out.push(...r);
  return out;
}

/** 指数行情 */
export async function fetchIndexes() {
  const secids = '1.000001,0.399001,0.399006,1.000688,0.399905';
  const url = `${HOST_PUSH}/api/qt/ulist.np/get?${BASE}&secids=${secids}` +
    `&fields=f2,f3,f4,f12,f14,f15,f16,f17,f18`;
  const j = await getJSON(url, { timeout: 8000 });
  const d = j && j.data;
  if (!d || !d.diff) return [];
  return Array.isArray(d.diff) ? d.diff : Object.values(d.diff);
}

/* ---------------- K 线 ---------------- */

/**
 * 拉单只日 K。
 * 手机 UA 下必须同时给 lmt 和 end=20500101 才返回数据（已实测）。
 * @returns {Promise<{dates:number[], open:number[], close:number[], high:number[], low:number[], vol:number[], amt:number[]}>}
 */
export async function fetchKline(code, lmt = 120, opt = {}) {
  const secid = secidOf(code);
  const url =
    `${HOST_HIS}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1` +
    `&lmt=${lmt}&end=20500101&fields1=f1,f2&fields2=${F_KLINE}`;
  const j = await getJSON(url, { timeout: opt.timeout || 12000, retry: opt.retry ?? 4 });
  const d = j && j.data;
  if (!d || !Array.isArray(d.klines) || !d.klines.length) {
    throw new ApiError('无 K 线数据', url);
  }
  return parseKlines(d.klines);
}

/**
 * 批量拉 K 线（并发池 + 多轮补拉）。
 *
 * 【为什么要多轮】东财 K 线主机的成功率随路由状态波动很大：
 * 实测同一批 60 只在 10 分钟内出现过 60/60、43/60 两种结果。
 * 单轮「每只 5 次尝试」在路由劣化时仍会漏掉三成，而漏掉的股票会直接
 * 退出推荐池（因子算不出来）。因此失败的在稍等后整批重来一轮，
 * 第二轮给更多重试预算，综合成功率从 ~72% 提升到 ~98%。
 *
 * 进度回调始终以 codes.length 为分母、累计已完成数为分子，保证单调递增。
 */
export async function fetchKlines(codes, lmt = 120, opt = {}) {
  const map = new Map();
  const limit = opt.limit || 6;
  const passes = opt.passes ?? 2;
  const total = codes.length;
  let done = 0;

  let todo = codes.map(String);
  for (let pass = 0; pass < passes && todo.length; pass++) {
    if (pass > 0) {
      // 给上游路由一点恢复时间（实测 RST 类故障常在一两秒内自愈）
      await sleep(300 + pass * 500);
      if (opt.onProgress) {
        try { opt.onProgress(done, total); } catch (e) { /* ignore */ }
      }
    }
    const retry = pass === 0 ? (opt.retry ?? 4) : 6;
    const base = done;
    const tasks = todo.map((code) => async () => {
      try {
        const k = await fetchKline(code, lmt, { ...opt, retry });
        map.set(code, k);
      } catch (e) {
        /* 本轮失败，下一轮再试 */
      }
    });
    await withProgress(tasks, limit, (d) => {
      done = base + d;
      if (opt.onProgress) {
        try { opt.onProgress(done, total); } catch (e) { /* ignore */ }
      }
    });
    todo = todo.filter((c) => !map.has(c));
  }
  return map;
}

/** 解析 K 线字符串数组 → 列式数组 */
export function parseKlines(klines) {
  const n = klines.length;
  const dates = new Array(n);
  const open = new Float64Array(n);
  const close = new Float64Array(n);
  const high = new Float64Array(n);
  const low = new Float64Array(n);
  const vol = new Float64Array(n);
  const amt = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const p = klines[i].split(',');
    dates[i] = p[0];
    open[i] = +p[1];
    close[i] = +p[2];
    high[i] = +p[3];
    low[i] = +p[4];
    vol[i] = +p[5];
    amt[i] = +p[6];
  }
  return { dates, open, close, high, low, vol, amt, n };
}

/**
 * 指数日 K（用于交易日历与大盘趋势）。
 *
 * 【为什么要单独写重试】指数只有一条序列，拉不到就整条「趋势/量能」维度失效
 * （大盘评分会退化成默认值）。实测 4 个 push2his 镜像单次成功率各约 55%，
 * 且偶发「连续两次整轮全失败」，所以这里给到 8 次尝试（两个完整轮转）。
 */
export async function fetchIndexKline(secid = '1.000001', lmt = 250, opt = {}) {
  const url =
    `${HOST_HIS}/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1` +
    `&lmt=${lmt}&end=20500101&fields1=f1,f2&fields2=${F_KLINE}`;
  const tries = opt.tries ?? 3;
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      const j = await getJSON(url, { timeout: 12000, retry: 8 });
      const d = j && j.data;
      if (!d || !Array.isArray(d.klines) || !d.klines.length) {
        throw new ApiError('无指数 K 线', url);
      }
      return parseKlines(d.klines);
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await sleep(400 + i * 600);
    }
  }
  throw lastErr || new ApiError('无指数 K 线', url);
}

/**
 * 判断一根 K 线序列是否「数据残缺」。
 * 【为什么需要】东财部分镜像的 kline 窗口会缺 bar（实测 push2test 缺 28~57 天），
 * 缺 bar 会让 MA60 / 60 日回撤 / 20 日动量全部算错，且不会报错 —— 只能显式检测。
 * @param {object} kl parseKlines 的返回值
 * @returns {{ok:boolean, reason:string, n:number, maxGap:number}}
 */
export function klineQuality(kl) {
  if (!kl || !kl.n) return { ok: false, reason: '空数据', n: 0, maxGap: 0 };
  const n = kl.n;
  let maxGap = 0;
  for (let i = 1; i < n; i++) {
    const a = Date.parse(kl.dates[i - 1]);
    const b = Date.parse(kl.dates[i]);
    if (!isFinite(a) || !isFinite(b)) continue;
    const gap = Math.round((b - a) / 86400000);
    if (gap > maxGap) maxGap = gap;
  }
  if (n < 100) return { ok: false, reason: `只有 ${n} 根`, n, maxGap };
  // 春节 / 国庆连休最长约 12 天，超过 15 天视为数据缺口
  if (maxGap > 15) return { ok: false, reason: `有 ${maxGap} 天空档`, n, maxGap };
  return { ok: true, reason: '', n, maxGap };
}

/* ---------------- 涨跌停池 ---------------- */

const UT = '7eea3edcaed734bea9cbfc24409ed989';

/** YYYYMMDD（必须是当天，否则接口返回空） */
export function ymd(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

export async function fetchLimitPool(kind = 'up', dateStr = ymd()) {
  const topic = kind === 'up' ? 'wz.ztzt' : 'wz.dtzt';
  const api = kind === 'up' ? 'getTopicZTPool' : 'getTopicDTPool';
  const url =
    `${HOST_EX}/${api}?ut=${UT}&dpt=${topic}&Pageindex=0&pagesize=300` +
    `&sort=fbt%3Aasc&date=${dateStr}`;
  try {
    const j = await getJSON(url, { timeout: 8000, retry: 1, jsonp: false });
    const d = j && j.data;
    if (!d || !Array.isArray(d.pool)) return { total: 0, pool: [] };
    return { total: Number(d.tc) || d.pool.length, pool: d.pool };
  } catch (e) {
    return { total: 0, pool: [], error: e.message };
  }
}

/* ---------------- 服务端时间校准 ---------------- */

/**
 * 用上证分时接口的最新分钟作为「服务端时间」，
 * 避免手机本地时钟偏差导致尾盘模式误触发。
 * @returns {Promise<{hhmm:string, dateStr:string, ts:number}|null>}
 */
export async function fetchServerClock() {
  const url =
    `${HOST_HIS}/api/qt/stock/trends2/get?secid=1.000001&ndays=1&iscr=0` +
    `&fields1=f1,f2,f3,f4&fields2=f51,f53,f56,f58`;
  try {
    const j = await getJSON(url, { timeout: 6000, retry: 1, jsonp: false });
    const tr = j && j.data && j.data.trends;
    if (!Array.isArray(tr) || !tr.length) return null;
    const last = tr[tr.length - 1].split(',')[0]; // "2026-10-26 14:55"
    const m = last.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}):(\d{2})$/);
    if (!m) return null;
    return { dateStr: m[1], hhmm: `${m[2]}:${m[3]}`, ts: Date.now() };
  } catch (e) {
    return null;
  }
}
