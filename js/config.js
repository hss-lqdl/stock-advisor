/* ============================================================
   config.js — 应用默认配置（纯常量，不依赖任何模块）
   ------------------------------------------------------------
   原先 DEFAULT_SETTINGS 放在 store.js（IndexedDB 存储层），
   而 universe.js（数据层）也要用它兜底，形成「数据层 → 存储层」
   的反向依赖。挪到本模块后：store.js / universe.js / views 都只依赖 config.js。
   ============================================================ */

export const DEFAULT_SETTINGS = {
  capital: 50000,          // 本金
  strategy: 'balanced',    // balanced | momentum | reversal | dragon | limitup
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

/** 用默认值补齐用户设置（老版本缺字段时用） */
export function withDefaults(settings) {
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}
