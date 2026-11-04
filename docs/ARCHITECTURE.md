# 架构与模块契约（Architecture）

## 一、一句话架构

**纯前端 PWA + 零后端 + 零依赖 + 零构建**。浏览器直接 `import` ES Module，直连东方财富公开接口，
所有计算（过滤 / 打分 / 计划 / 回测）都在浏览器里完成；本机只跑一个静态文件服务器。

这么选的理由（都是实测结论，不是偏好）：

| 决策 | 原因 |
|---|---|
| 不做后端 | 东财接口对任意 Origin **反射式放行 CORS**（`Access-Control-Allow-Origin: <请求的 Origin>` + `Allow-Credentials: true`），手机浏览器可直连。有后端就失去了"随手丢到任何静态托管就能跑"的能力 |
| 零依赖 | 没有 `npm i`、没有构建步骤、没有供应链风险；iPhone 上就是"打开网页 → 添加到主屏幕" |
| 零构建 | 源码即产物。改一个 `.js` 刷新就生效，不需要 watch/编译 |
| Canvas 手绘图表 | 引 CDN 图表库在离线/弱网下会白屏，且增加首屏体积 |

## 二、层次与依赖方向

依赖是**单向向上**的，下层绝不 import 上层：

```
┌──────────────────────────────────────────────┐
│  views/  (today mainline picks positions     │  ← 只读 ctx，纯渲染
│           settings)                          │
└───────────────────▲──────────────────────────┘
                    │ ctx
┌───────────────────┴──────────────────────────┐
│  main.js   编排 + 全局状态 S + 路由 + 尾盘轮询   │
└───────────────────▲──────────────────────────┘
                    │ state / result
┌───────────────────┴──────────────────────────┐
│  engine.js   数据编排（loadAll / analyze）      │
└───────────────────▲──────────────────────────┘
                    │
┌───────────────────┴──────────────────────────┐
│  计算层（纯函数，无 DOM 无网络）                 │
│  universe  mainline  market  indicators       │
│  strategy  plan      backtest                 │
└───────────────────▲──────────────────────────┘
                    │
┌───────────────────┴──────────────────────────┐
│  基础层  api.js   store.js   ui.js   charts.js │
└──────────────────────────────────────────────┘
```

**硬约束**：

- `universe / mainline / market / indicators / strategy / plan / backtest` **不得** import `api / store / ui / charts / engine / main`。
  它们是纯函数，正因为如此才能被 `tools/selftest.mjs` 在 Node 里直接 import 断言（不需要浏览器）。
- `views/*` **不得** import `engine / main / store`，只能通过 `ctx` 拿数据和回调。
- 只有 `main.js` 持有可变状态 `S`。

## 三、数据流（一次完整刷新）

```
boot()
 └─ registerSW()                        ← 立刻注册，不等数据
 └─ settingsLoad()                      ← IndexedDB meta.settings
 └─ restoreSlim()                       ← 上次结果的精简副本 → 秒开首屏
 └─ reload()
     └─ engine.loadAll({settings, onProgress})
         ├─ api.fetchSnapshot()         56 分页并发，5400+ 只
         ├─ api.fetchBoards()           概念 516 + 行业 496
         ├─ universe.buildUniverse()    ★ 基础过滤 11 道（可配置）→ pool
         ├─ mainline.analyzeMainline()  板块清洗 + 打分 → Top20/退潮10
         ├─ mainline.annotatePool()     给每只票挂主线得分 + mainRank
         ├─ api.fetchLimitPool()        涨停/跌停池
         └─ market.analyzeMarket()      四维打分 → 档位
     └─ engine.analyze(state)
         ├─ mainline.annotatePool()     主线门槛（Top20 且非退潮）
         ├─ api.fetchKlines()           四策略配额抽样日 K（并发池）
         ├─ strategy.applyStage1()      策略专属门槛 · 快照初筛
         ├─ indicators.computeFactors() 8 个因子
         ├─ strategy.computeLeader()    同行业板块龙头度（leader）
         ├─ strategy.applyStage2()      策略专属门槛 · K 线因子精筛
         ├─ strategy.relaxStage2()      极端行情保底放宽
         ├─ strategy.scoreCandidates()  分位标准化 + 加权
         ├─ strategy.applyPortfolioConstraints()  行业/主线各 ≤2
         └─ plan.buildDailyPlan()       委托价/股数/止损止盈/费用
     └─ saveSlim() → render() → updateBadge()
```

### 关键中间结构

```js
// engine.loadAll() 返回的 state
{
  rows,        // 原始快照（5400+）
  boards,      // 板块原始数据
  pool,        // 过滤后的股票池（~1100-2100）
  poolStats,   // FilterStats 实例：steps[] 记录每一道过滤的 input/removed/remain
  mainline,    // { top: [...], bottom: [...], byName: Map }
  ztPool,      // 涨停池
  dtPool,      // 跌停池
  market,      // { score, level, dims: {trend,breadth,sentiment,volume} }
  settings,
  loadedAt,
}

// engine.analyze() 返回的 result
{
  picks,       // 打分后的候选（含 factors）
  plan,        // { items: [{code,name,bid,shares,amount,stop,tp1,tp2,score,...}], totalAmount, cashLeft }
  strategy,    // 策略 key
  capital,
}
```

## 四、核心契约

### 4.1 大盘档位（`market.js` `LEVELS`）

| key | 名称 | minScore | 建议仓位 | 推荐只数 |
|---|---|---|---|---|
| `attack` | 进攻 | 70 | 80% | 5 |
| `neutral` | 中性 | 50 | 60% | 5 |
| `defend` | 防守 | 30 | 35% | 4 |
| `frozen` | 冰点 | -1 | 20% | 3 |

四维权重：趋势 30 / 广度 25 / 情绪 25 / 量能 20。

### 4.2 策略（`strategy.js` `STRATEGIES`）

| key | 名称 | 反向因子 | 特色门槛与因子 |
|---|---|---|---|
| `balanced` | 均衡多因子 | `rsi`, `atrp` | 稳健多因子均衡配置 |
| `momentum` | 趋势动量 | `rsi`, `atrp` | 均线全多头 + 动量突破 |
| `reversal` | 超跌反弹 | `dd`, `rsi`, `atrp` | 深度回撤 + 超卖反抽 |
| `dragon` | 龙头战法 | `atrp` | **属于主线 Top10** + **板块龙头度 ≥ 60** + 均线全多头 + 新增 `leader` 因子 (20%) |

反向因子在 `crossSectionNormalize(rows, keys, reverseKeys)` 里取 `100 - pct`：
即数值越低分越高（如 RSI 低 = 超卖 = 好）。注意 `dragon` 策略的 `rsi` 不做反向处理（龙头追强势）。

### 4.2.1 股票池三段式过滤体系
每种选股策略拥有专属的过滤链与明细展示：
1. **基础过滤（共用 11 道，可配置）**：停牌 → ST/退市 → 低价 ≤2 元 → 市值不在 [min,max] → 成交额 <1 亿 → 换手率 <0.5% → 涨停/一字板 → 跌停 → 创业板（可关） → 一手成本超预算。
2. **主线门槛（共用）**：所属板块入围近一周主线 Top20 且非退潮 Top10。
3. **策略专属门槛（`strategy.js` `STRATEGY_FILTERS`）**：
   - Stage 1（快照初筛）：按策略特质过滤成交额、换手、量比、市值及主线排名；
   - Stage 2（K 线因子门槛）：过滤均线形态、动量、回撤及龙头度等深度因子。
   - 保底放宽（`relaxStage2`）：避免极值行情空池，自动降级保底。

### 4.3 设置项（`store.js` `DEFAULT_SETTINGS`）

```js
{
  capital: 50000,          // 本金
  strategy: 'balanced',    // balanced | momentum | reversal | dragon
  maxMarketCap: 800,       // 亿元（总市值口径 f20）
  minMarketCap: 20,        // 亿元
  maxPicks: 5,
  tailMode: true,          // 尾盘模式
  showDisclaimer: true,
  costModel: true,         // 计算手续费
  excludeChiNext: true,    // 剔除创业板 300/301
}
```

### 4.4 股票池 10 道过滤（`universe.js` `buildUniverse`）

依次为：停牌 → ST/退市 → 价格 ≤2 元 → 市值不在 [min,max] → 成交额 <1 亿 →
换手率 <0.5% → 涨停/一字板 → 跌停 → **创业板（300/301，可关）** → 一手成本超预算。
每道都通过 `stats.add(label, before, after)` 记账，设置页与自测都依赖这份 `steps`。

### 4.5 视图契约

`render*(root, ctx)`，`ctx` 字段见 [`FILES.md` 4.4 节](./FILES.md)。视图**不缓存状态**，每次全量重渲染。

## 五、接口层（`api.js`）的关键事实

这些是实测踩出来的，改动前务必读一遍：

1. **K 线必须走 `push2his`**，不能用 `push2test`。后者返回的 K 线只有 73~116 根、带 28~57 天空档，
   会让 MA60 与回撤因子失真。多个镜像主机轮转（`retry=4`）。
2. **快照/板块/ulist 走 `push2test`**（PUSH 池），`push2his` 只负责历史 K 线。
3. `clist` 单页硬上限 100，`pz=200/500` 无效 → 必须真分页（本项目 56 页）。
4. `ulist.np` 单次最多 100 个 secid。
5. **涨跌停池必须传当日日期**，否则返回空。
6. 手机 UA 下请求 K 线必须**同时**给 `lmt` 和 `end=20500101`，否则只回少量数据。
7. 行情字段在**非交易时段全为 `"-"`**（实测开盘前 0/5563 只可报价）。
   `buildUniverse` 会把这些全部按"停牌/无报价"剔除，池子变 0 —— 这是时段问题，不是 bug。

## 六、运行环境约束

| 约束 | 影响 | 应对 |
|---|---|---|
| 局域网 `http://192.168.x.x` **不是 secure context** | Service Worker 不注册，PWA 离线能力与"添加到主屏幕"的完整体验受限 | `sw.js` 在 `try/catch` 里注册；界面照常可用。要完整体验就用 `localhost` 或 HTTPS 托管 |
| iOS Safari 主屏模式无地址栏 | 无法手动刷新 | 顶部提供刷新按钮 + 尾盘自动刷新 |
| `navigator.clipboard` 在非 HTTPS 下不可用 | 复制清单失败 | `ui.copyText` 用 `document.execCommand('copy')` 兜底 |
| Safari 每域名并发连接数限制 | 并发过高反而更慢 | 手机端并发池上限 6，PC 端 8 |

## 七、性能基线（实测）

| 指标 | 数值 |
|---|---|
| 全市场快照（56 页） | 0.7~1.3 s |
| 板块（1000+） | 0.5 s 左右 |
| 60 只日 K（并发 6） | 0.3~68 s（取决于上游是否限流） |
| 因子 + 打分 + 计划 | 1~2 ms（纯计算） |
| 冷启动体积 | 约 2.5~4 MB，日常刷新约 1.8 MB，尾盘刷新约 150 KB |
| IndexedDB 占用 | K 线为 Float64Array，1100 只 × 250 根约 2.6 MB |

## 八、测试策略

三层，全部不需要人工点界面：

1. **离线单元**（`node tools/selftest.mjs`，531 项）：纯函数断言，覆盖 10 道基础过滤、
   四套策略专属门槛（Stage1/Stage2）与保底放宽、主线打分、四维打分、9 个因子、分位标准化、
   委托价/股数/止损止盈/费用、条件单文本、K 线解析。
2. **联网全链路**（`--live`，531~570 项）：真实拉东财数据跑完整链路，打印当日推荐供人工核对。
   **上游限流时会主动跳过依赖它的断言并说明原因**，这是刻意设计，不是掩盖失败。
3. **真浏览器 E2E**（`tools/e2e-browser.mjs --live`，60 项）：iPhone 14 Pro 视口，5 个 Tab 渲染、
   manifest/图标/SW/IndexedDB、四策略选项与过滤明细分组、详情弹层、无横向溢出、深色主题、无页面异常。
   也可加 `--url https://hss-lqdl.github.io/stock-advisor/` 直接对线上站点跑。

判定标准统一是**失败 0 项**，而不是"项数等于某个固定值"——项数会随上游可用性浮动。

## 九、扩展指南（常见改动落在哪）

| 想做的事 | 改哪里 |
|---|---|
| 加一道股票过滤 | `universe.js` 的 `buildUniverse`（记得 `stats.add` 记账 + 同步 README 与自测） |
| 加一个技术因子 | `indicators.js` 的 `computeFactors` + `strategy.js` 的 `FACTOR_LABELS` 与策略权重 |
| 改大盘打分权重 | `market.js` 的 `analyzeMarket`（四维权重）+ `LEVELS` 阈值 |
| 加一个新策略 | `strategy.js` 的 `STRATEGIES` + 设置页下拉（`views/settings.js`） |
| 改止损止盈规则 | `plan.js` 的 `calcStop` / `calcBid` |
| 加一个新 Tab | `index.html` 加面板 + `views/` 加文件 + `main.js` 的 `switchTab`/`render` |
| 换数据源 | `api.js`（其它模块只依赖它的返回结构，不依赖 URL） |
