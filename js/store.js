/* ============================================================
   store.js — IndexedDB 存储层
   表：meta / snapshot / klines / boards / plans / positions / boardDaily
   ============================================================ */

const DB_NAME = 'stock_advisor';
const DB_VER = 1;

let dbPromise = null;

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = (ev) => {
      const db = req.result;
      const old = ev.oldVersion;
      if (old < 1) {
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
        if (!db.objectStoreNames.contains('snapshot')) db.createObjectStore('snapshot', { keyPath: 'code' });
        if (!db.objectStoreNames.contains('klines')) db.createObjectStore('klines', { keyPath: 'code' });
        if (!db.objectStoreNames.contains('boards')) db.createObjectStore('boards', { keyPath: 'name' });
        if (!db.objectStoreNames.contains('plans')) db.createObjectStore('plans', { keyPath: 'date' });
        if (!db.objectStoreNames.contains('positions')) db.createObjectStore('positions', { keyPath: 'id', autoIncrement: true });
        if (!db.objectStoreNames.contains('boardDaily')) db.createObjectStore('boardDaily', { keyPath: 'date' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('IndexedDB 被其他标签页占用，请关闭其他页面后重试'));
  });
  return dbPromise;
}

function tx(store, mode = 'readonly') {
  return openDB().then((db) => {
    const t = db.transaction(store, mode);
    return { t, s: t.objectStore(store) };
  });
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/* ---------------- meta ---------------- */

export async function metaGet(key, fallback = null) {
  try {
    const { s } = await tx('meta');
    const v = await reqToPromise(s.get(key));
    return v === undefined ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

export async function metaSet(key, value) {
  try {
    const { s } = await tx('meta', 'readwrite');
    await reqToPromise(s.put(value, key));
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- snapshot ---------------- */

export async function snapshotSaveAll(rows) {
  const { t, s } = await tx('snapshot', 'readwrite');
  s.clear();
  for (const r of rows) s.put(r);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(rows.length);
    t.onerror = () => reject(t.error);
  });
}

export async function snapshotLoadAll() {
  try {
    const { s } = await tx('snapshot');
    const all = await reqToPromise(s.getAll());
    return all || [];
  } catch (e) {
    return [];
  }
}

export async function snapshotClear() {
  try {
    const { s } = await tx('snapshot', 'readwrite');
    await reqToPromise(s.clear());
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- klines ---------------- */

/**
 * 保存 K 线。kline 对象为 api.parseKlines 的列式结构。
 * 存 Float64Array 时结构化克隆可直接存，比 JSON 省很多。
 */
export async function klinesSave(code, kl) {
  try {
    const { s } = await tx('klines', 'readwrite');
    await reqToPromise(s.put({
      code: String(code),
      dates: Array.from(kl.dates),
      open: Array.from(kl.open),
      close: Array.from(kl.close),
      high: Array.from(kl.high),
      low: Array.from(kl.low),
      vol: Array.from(kl.vol),
      amt: Array.from(kl.amt),
      n: kl.n,
      updated: Date.now(),
    }));
    return true;
  } catch (e) {
    return false;
  }
}

export async function klinesSaveMany(map) {
  const { t, s } = await tx('klines', 'readwrite');
  let cnt = 0;
  for (const [code, kl] of map) {
    s.put({
      code: String(code),
      dates: Array.from(kl.dates),
      open: Array.from(kl.open),
      close: Array.from(kl.close),
      high: Array.from(kl.high),
      low: Array.from(kl.low),
      vol: Array.from(kl.vol),
      amt: Array.from(kl.amt),
      n: kl.n,
      updated: Date.now(),
    });
    cnt++;
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(cnt);
    t.onerror = () => reject(t.error);
  });
}

export async function klinesGet(code) {
  try {
    const { s } = await tx('klines');
    const v = await reqToPromise(s.get(String(code)));
    if (!v) return null;
    return {
      dates: v.dates,
      open: Float64Array.from(v.open),
      close: Float64Array.from(v.close),
      high: Float64Array.from(v.high),
      low: Float64Array.from(v.low),
      vol: Float64Array.from(v.vol),
      amt: Float64Array.from(v.amt),
      n: v.n,
      updated: v.updated,
    };
  } catch (e) {
    return null;
  }
}

export async function klinesGetMany(codes) {
  const out = new Map();
  if (!codes.length) return out;
  try {
    const { s } = await tx('klines');
    await Promise.all(codes.map(async (c) => {
      const v = await reqToPromise(s.get(String(c)));
      if (v) {
        out.set(String(c), {
          dates: v.dates,
          open: Float64Array.from(v.open),
          close: Float64Array.from(v.close),
          high: Float64Array.from(v.high),
          low: Float64Array.from(v.low),
          vol: Float64Array.from(v.vol),
          amt: Float64Array.from(v.amt),
          n: v.n,
          updated: v.updated,
        });
      }
    }));
    return out;
  } catch (e) {
    return out;
  }
}

/** 把「当日未完成 bar」追加进已有 K 线（若最后一根就是今天则覆盖） */
export function klineAppendToday(kl, dateStr, o, h, l, c, v) {
  if (!kl || !kl.n) return kl;
  const lastDate = kl.dates[kl.n - 1];
  if (lastDate === dateStr) {
    kl.open[kl.n - 1] = o;
    kl.high[kl.n - 1] = h;
    kl.low[kl.n - 1] = l;
    kl.close[kl.n - 1] = c;
    kl.vol[kl.n - 1] = v;
    return kl;
  }
  const n2 = kl.n + 1;
  const grow = (arr, val) => {
    const out = new Float64Array(n2);
    out.set(arr.subarray(0, kl.n));
    out[n2 - 1] = val;
    return out;
  };
  kl.dates = [...kl.dates, dateStr];
  kl.open = grow(kl.open, o);
  kl.high = grow(kl.high, h);
  kl.low = grow(kl.low, l);
  kl.close = grow(kl.close, c);
  kl.vol = grow(kl.vol, v);
  kl.amt = grow(kl.amt, c * v * 100);
  kl.n = n2;
  return kl;
}

export async function klinesCount() {
  try {
    const { s } = await tx('klines');
    return await reqToPromise(s.count());
  } catch (e) {
    return 0;
  }
}

export async function klinesClear() {
  try {
    const { s } = await tx('klines', 'readwrite');
    await reqToPromise(s.clear());
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- boards ---------------- */

export async function boardsSaveAll(list) {
  const { t, s } = await tx('boards', 'readwrite');
  s.clear();
  for (const b of list) {
    if (!b || !b.f14) continue;
    s.put({ name: String(b.f14), raw: b });
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(list.length);
    t.onerror = () => reject(t.error);
  });
}

export async function boardsLoadAll() {
  try {
    const { s } = await tx('boards');
    const all = await reqToPromise(s.getAll());
    return (all || []).map((x) => x.raw);
  } catch (e) {
    return [];
  }
}

/* ---------------- boardDaily（主线热度历史） ---------------- */

export async function boardDailySave(dateStr, rows) {
  try {
    const { s } = await tx('boardDaily', 'readwrite');
    await reqToPromise(s.put({ date: dateStr, rows, savedAt: Date.now() }));
    return true;
  } catch (e) {
    return false;
  }
}

export async function boardDailyGet(dateStr) {
  try {
    const { s } = await tx('boardDaily');
    const v = await reqToPromise(s.get(dateStr));
    return v || null;
  } catch (e) {
    return null;
  }
}

/** 取最近 n 天的主线历史（按日期升序） */
export async function boardDailyRecent(n = 6) {
  try {
    const { s } = await tx('boardDaily');
    const all = await reqToPromise(s.getAll());
    const sorted = (all || []).sort((a, b) => (a.date < b.date ? -1 : 1));
    return sorted.slice(-n);
  } catch (e) {
    return [];
  }
}

/* ---------------- plans（每日计划归档） ---------------- */

export async function planSave(dateStr, plan) {
  try {
    const { s } = await tx('plans', 'readwrite');
    await reqToPromise(s.put({ date: dateStr, ...plan, savedAt: Date.now() }));
    return true;
  } catch (e) {
    return false;
  }
}

export async function planGet(dateStr) {
  try {
    const { s } = await tx('plans');
    return (await reqToPromise(s.get(dateStr))) || null;
  } catch (e) {
    return null;
  }
}

export async function planRecent(n = 10) {
  try {
    const { s } = await tx('plans');
    const all = await reqToPromise(s.getAll());
    return (all || []).sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, n);
  } catch (e) {
    return [];
  }
}

/* ---------------- positions（模拟盘） ---------------- */

export async function positionAdd(pos) {
  try {
    const { s } = await tx('positions', 'readwrite');
    const id = await reqToPromise(s.add({ ...pos, createdAt: Date.now() }));
    return id;
  } catch (e) {
    return null;
  }
}

export async function positionUpdate(pos) {
  try {
    const { s } = await tx('positions', 'readwrite');
    await reqToPromise(s.put(pos));
    return true;
  } catch (e) {
    return false;
  }
}

export async function positionRemove(id) {
  try {
    const { s } = await tx('positions', 'readwrite');
    await reqToPromise(s.delete(id));
    return true;
  } catch (e) {
    return false;
  }
}

export async function positionsLoadAll() {
  try {
    const { s } = await tx('positions');
    const all = await reqToPromise(s.getAll());
    return all || [];
  } catch (e) {
    return [];
  }
}

export async function positionsClear() {
  try {
    const { s } = await tx('positions', 'readwrite');
    await reqToPromise(s.clear());
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------- 设置（存 meta） ---------------- */

export const DEFAULT_SETTINGS = {
  capital: 50000,          // 本金
  strategy: 'balanced',    // balanced | momentum | reversal | dragon
  maxMarketCap: 800,       // 亿元（旧字段，仅用于把老用户的设置迁移进 filterConfig）
  minMarketCap: 20,        // 亿元（同上）
  maxPicks: 5,
  tailMode: true,          // 是否启用尾盘模式
  showDisclaimer: true,
  costModel: true,         // 是否计算手续费
  excludeChiNext: true,    // 是否剔除创业板（旧字段，迁移用；新的开关在 filterConfig.base）
  // 可配置过滤条件：null = 全部用代码默认（filters.js），
  // 用户在设置页改动后写入完整配置对象（见 filters.js serializeConfig）
  filterConfig: null,
};

export async function settingsLoad() {
  const s = await metaGet('settings', null);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function settingsSave(patch) {
  const cur = await settingsLoad();
  const next = { ...cur, ...patch };
  await metaSet('settings', next);
  return next;
}

/* ---------------- 数据体积统计 ---------------- */

export async function storageEstimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      return {
        usage: est.usage || 0,
        quota: est.quota || 0,
        percent: est.quota ? (est.usage / est.quota) * 100 : 0,
      };
    }
  } catch (e) { /* ignore */ }
  return null;
}

/** 清空所有缓存（保留设置与持仓） */
export async function clearCache() {
  await Promise.all([
    snapshotClear(),
    klinesClear(),
    (async () => {
      try {
        const { s } = await tx('boards', 'readwrite');
        await reqToPromise(s.clear());
      } catch (e) { /* ignore */ }
    })(),
  ]);
  return true;
}
