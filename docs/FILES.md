# 文件清单（File Inventory）

> 项目根目录：`stock_advisor/`
> 本文件是**唯一权威的文件地图**。新增/删除/重命名任何文件，请同步更新本文件。

## 一、目录总览

```
stock_advisor/
├── README.md                ← 面向使用者：怎么用、怎么装到手机、选股逻辑、风险提示
├── CHANGELOG.md             ← 版本历史
├── package.json             ← npm 脚本入口（运行/测试/生成图标）
├── .gitignore
├── .editorconfig
├── 启动.bat                  ← 双击启动器（Windows）
├── server.mjs               ← 本地静态服务器（Node，主用）
├── server.py                ← 本地静态服务器（Python，备用）
├── docs/                    ← 面向开发者
│   ├── FILES.md             ← 本文件
│   ├── ARCHITECTURE.md      ← 架构、模块契约、数据流
│   └── BACKLOG.md           ← 已知限制与后续路线
├── web/                     ← ★ 整个 App（可单独托管到任意静态服务器）
│   ├── index.html
│   ├── manifest.webmanifest
│   ├── sw.js                ← Service Worker（离线外壳）
│   ├── style.css
│   ├── icons/
│   └── js/
│       ├── main.js          ← 编排层（唯一有状态模块）
│       ├── api.js
│       ├── store.js
│       ├── universe.js
│       ├── mainline.js
│       ├── market.js
│       ├── indicators.js
│       ├── strategy.js
│       ├── plan.js
│       ├── backtest.js
│       ├── charts.js
│       ├── engine.js
│       ├── ui.js
│       └── views/
└── tools/                   ← 开发工具（不参与运行）
    ├── selftest.mjs
    ├── e2e-browser.mjs
    ├── make_icons.py
    └── _e2e/                ← 测试产物（已 gitignore）
```

## 二、根目录文件

| 文件 | 职责 | 改动注意 |
|---|---|---|
| `README.md` | 使用者文档。快速开始 / 尾盘流程 / 三条下单路径 / 选股逻辑 / 自测 / FAQ / 风险提示 | 改选股逻辑或验收项时必须同步 |
| `CHANGELOG.md` | 版本历史，按 `vX.Y.Z` 记录新增/修复/变更 | 每次 bump 版本追加一节 |
| `package.json` | npm 脚本：`start` / `test` / `test:live` / `test:e2e` / `test:all` / `icons` | `version` 与 `web/sw.js` 的 `VERSION` 保持一致 |
| `启动.bat` | Windows 双击启动：检测 8765 是否已在跑 → 优先 Node → 回退 Python | 编码必须是 UTF-8 + `chcp 65001`，否则中文乱码 |
| `server.mjs` | 静态服务器（412 行）。控制台打印本机/局域网地址 + 二维码 | 参数：`--port` `--no-browser` `--no-qr` `--host` |
| `server.py` | 同上的 Python 实现（412 行量级），Node 缺失时兜底 | 功能需与 `server.mjs` 对齐 |

## 三、`web/` 外壳

| 文件 | 职责 |
|---|---|
| `index.html` | 唯一页面。含 `#bootScreen` 启动屏、`#topbar`、`#tabbar`（5 个 Tab）、5 个 `[data-tab]` 面板；末尾 `<script type="module" src="js/main.js">` |
| `manifest.webmanifest` | PWA 清单：name/short_name/start_url/display=standalone/theme_color/background_color + 全套 icons |
| `sw.js` | Service Worker。**network-first** 策略（缓存优先会永久钉死旧 JS，实测踩过）；`VERSION` 常量决定缓存名 |
| `style.css` | 全部样式（深色主题，`#0b0f17` 背景）。含启动屏、骨架屏、卡片、弹层、Tab、尾盘条 |
| `icons/` | `icon.svg`、`favicon-64.png`、`icon-180.png`（iOS 主屏）、`icon-192.png`、`icon-512.png`、`maskable-512.png`、`icon-1024.png` |

> **改 `web/` 下任何被 `sw.js` 预缓存的文件后，必须把 `sw.js` 的 `VERSION` bump 一位**，
> 并把 `package.json` 的 `version` 一起改。否则用户端仍跑旧代码。

## 四、`web/js/` 模块（按依赖层次，自下而上）

### 4.1 基础层

| 模块 | 行数 | 职责 | 主要导出 |
|---|---|---|---|
| `api.js` | 646 | 东财接口层：分页并发池、重试、多主机轮转、JSONP 兜底、K 线解析与质量校验 | `fetchSnapshot` `fetchBoards` `fetchKlines` `fetchKline` `fetchIndexes` `fetchQuotes` `fetchLimitPool` `fetchServerClock` `parseKlines` `klineQuality` `secidOf` `pool` `withProgress` `ApiError`；常量 `FS_ALL/FS_CONCEPT/FS_INDUSTRY/F_SNAP_*/F_BOARD/F_KLINE` |
| `store.js` | 444 | IndexedDB 持久层（7 张表：snapshot / klines / boards / boardDaily / plans / positions / meta） | `openDB` `snapshotSaveAll/LoadAll` `klinesSaveMany/GetMany` `klineAppendToday` `boardsSaveAll/LoadAll` `boardDailySave/Recent` `planSave/Get/Recent` `positionAdd/Update/Remove/LoadAll` `settingsLoad/Save` `storageEstimate` `clearCache`；`DEFAULT_SETTINGS` 已移至 `config.js`，此处仅再导出 |
| `config.js` | 19 | 默认设置常量（独立于存储层与数据层，避免 universe.js → store.js 的反向依赖） | `DEFAULT_SETTINGS` `withDefaults` |
| `constants.js` | 29 | 时间/文案常量：尾盘窗口、收盘与集合竞价时刻，替代各文件里的 `14:55` 硬编码 | `TAIL_START_H/M` `TAIL_END_H/M` `TAIL_START_MIN` `TAIL_END_MIN` `TAIL_HHMM` `CLOSE_HHMM` `CLOSE_AUCTION_HHMM` `TAIL_WINDOW_TEXT` |
| `ui.js` | 292 | DOM 与格式化工具（无业务逻辑）。`openSheet` 会给每个弹层加一个 sticky 的「← 返回」按钮 | `$` `$$` `el` `esc` `fmtNum` `fmtPct` `fmtMoney` `fmtInt` `updown` `signCls` `toast` `openSheet` `closeSheet` `copyText` `skeletonCards` `emptyState` `errorBox` `showProgress` `hideProgress` `switchRow` `timeAgo` |
| `charts.js` | 453 | Canvas 2D 手绘图表（零依赖） | `drawKline` `drawMainlineBars` `drawTrendLine` `drawDimBars` `drawSparkline` `drawEquityCurve` |

### 4.2 计算层（纯函数，无 DOM、无网络）

| 模块 | 行数 | 职责 | 主要导出 |
|---|---|---|---|
| `universe.js` | 画像 ~180 | 股票池基础过滤（11 道，规则来自 `filters.js`） | `buildUniverse(rows, cfg)` → `{pool, stats, budgetPerStock, filterConfig}`；`FilterStats` `cloneStats` `normalizeStock` `poolToMap` `limitPrices`；再导出 `filters.js` 的 `isST` `isSuspended` `limitPct` `marketOf` `ruleLabel` `isChiNext`（保持既有 import 路径可用） |
| `filters.js` | ~591 | **可配置过滤条件**：字段注册表 + 运算符表 + 特殊条件 + 规则求值 + 序列化/合并（零依赖，纯数据 + 纯函数） | `FILTER_FIELDS` `fieldsByGroup` `OPS` `opsForField` `SPECIAL_RULES` `BASE_RULE_DEFAULTS` `MAINLINE_DEFAULTS` `STAGE_RULE_DEFAULTS` `ruleLabel` `evalRule` `runRules` `cloneRule/cloneList/mergeList` `makeRule` `setRule` `upsertRule` `removeRule` `serializeConfig` `resolveFilterConfig` `countRules` `fieldRange` `clampFieldValue` `limitPct` `isST` `isSuspended` `marketOf` `isChiNext` `isLimitUp` `isLimitDown`；常量 `FILTER_CONFIG_VERSION` |
| `mainline.js` | 224 | 近一周主线情绪（板块清洗 + 打分 + 个股归属），主线门槛可参数化 | `analyzeMainline(boards, opt)`（`opt` = `{topN, bottomN, avoidBottom, on}`）`cleanBoards` `boardScore` `stockMainline` `annotatePool` `mainlineTrend`；常量 `NOISE_PATTERN` `MIN_MEMBERS` `TOP_N` `BOTTOM_N` |
| `market.js` | 235 | 大盘四维打分（趋势 30 / 广度 25 / 情绪 25 / 量能 20）→ 档位 | `analyzeMarket` `trendScore` `breadthScore` `sentimentScore` `volumeScore` `levelByScore` `budgetPerStock`；常量 `LEVELS` |
| `indicators.js` | 225 | 8 个技术因子 + 标准化 | `computeFactors` `maAt` `maSeries` `rsiAt` `atrAt` `momentum` `drawdownFromHigh` `volumeRatio` `slopePct` `percentileRank` `crossSectionNormalize` |
| `strategy.js` | 190 | 分位标准化 + 加权打分 + 组合约束 | `scoreCandidates` `applyPortfolioConstraints` `buildReason` `getStrategy`；常量 `STRATEGIES` `REVERSE_KEYS` `FACTOR_LABELS` |
| `plan.js` | 295 | 买入计划：委托价 / 股数 / 止损止盈 / 费用 / 条件单文本 | `buildDailyPlan` `buildPlan` `calcBid` `calcStop` `calcShares` `buyFee` `sellFee` `buildCopyText` `buildConditionOrders` `buildConditionText` `positionPnl`；常量 `COMMISSION_RATE` `COMMISSION_MIN` `TRANSFER_RATE` `STAMP_RATE` `QUEUE_MAX_LOSS` |
| `backtest.js` | 183 | 滚动回测 | `runBacktest` `runBacktestMatrix` |

### 4.3 编排层

| 模块 | 行数 | 职责 |
|---|---|---|
| `engine.js` | 361 | 数据编排：`loadAll`（快照→板块→池→主线→大盘）、`analyze`（因子→打分→计划）、`runFull`、`refreshPoolOnly`、`restoreFromCache`、`marketPhase`（时段判定）、`msToTail`；常量 `KLINE_CAP` `KLINE_LEN` |
| `main.js` | 667 | **唯一有状态模块**。全局 `S`、`boot()`、`reload()`、`render()`、`switchTab()`、`openStock()` 详情弹层、`setupTail()` 尾盘轮询、`registerSW()`、`restoreSlim()/saveSlim()` 秒开 |

### 4.4 视图层 `web/js/views/`

每个视图导出**一个** `render*` 函数，签名统一为 `render(root, ctx)`。

| 模块 | 行数 | 导出 | 渲染内容 |
|---|---|---|---|
| `today.js` | 297 | `renderToday` | 今日总览：大盘档位、四维得分、今日推荐摘要、指数走势 |
| `mainline.js` | 251 | `renderMainline` | 主线情绪 Top20 / 退潮 Top10、板块条形图 |
| `picks.js` | 351 | `renderPicks` | 推荐列表、每只的因子明细、K 线图、买入清单（A/B/C 三条下单路径） |
| `positions.js` | 268 | `renderPositions` | 模拟盘持仓、盈亏、止损止盈触发提醒 |
| `settings.js` | 574 | `renderSettings` `showInstallGuide` | 本金/策略/市值上限/排除创业板/尾盘模式开关、回测入口、缓存管理、安装指引、免责声明 |
| `settings-filter.js` | 331 | `buildFilterEditorCard` `numInput` `GROUP_LABEL` | 过滤条件编辑器（从 settings.js 拆出）：分组卡片、规则行、数值阈值上下限与钳制、「介于」上下限联动 |

**视图收到的 `ctx` 契约**（`views` 只读这些字段，不直接碰 `S`）：

| 字段/方法 | 类型 | 说明 |
|---|---|---|
| `ctx.state` | object | `engine.loadAll` 的输出（快照/板块/池/主线/大盘） |
| `ctx.result` | object | `engine.analyze` 的输出（`plan` / `picks` / `factors` …） |
| `ctx.indexes` | array | 指数行情与 K 线 |
| `ctx.quotes` | Map | 实时报价（尾盘刷新用） |
| `ctx.loading` | boolean | 是否正在加载（决定骨架屏） |
| `ctx.error` | string | 错误信息（空串表示无错） |
| `ctx.onReload()` | fn | 触发全量刷新 |
| `ctx.onAnalyze()` | fn | 设置变更后重算（不重新拉行情） |
| `ctx.onChanged()` | fn | 通知编排层"视图内部状态变了，请重渲染" |

## 五、`tools/`（不参与运行）

| 文件 | 职责 | 用法 |
|---|---|---|
| `selftest.mjs` | 离线单元断言 + `--live` 联网全链路断言。直接 `import` 纯 ES Module，不依赖浏览器 | `node tools/selftest.mjs` / `--live` |
| `e2e-browser.mjs` | 真浏览器端到端（puppeteer-core + 系统 Edge），iPhone 14 Pro 视口 | 需先起服务，见下 |
| `make_icons.py` | 一次性生成全套 PNG 图标（Pillow） | `python tools/make_icons.py` |
| `_e2e/` | 测试产物目录：`node_modules`（puppeteer-core）、`shots/`（截图与 report.json） | 已 gitignore |

### 跑浏览器 E2E 的正确姿势

```bash
# 1) 先起服务（E2E 不自己拉服务，默认连 8765）
node server.mjs --no-browser --no-qr

# 2) 首次需要装 puppeteer-core
cd tools/_e2e && npm i puppeteer-core && cd ../..

# 3) 跑（每次自动删 profile，确保是全新环境）
node tools/e2e-browser.mjs --live
```

常用参数：`--url <地址>`、`--wait <ms>`（常规等待，默认 9000）、`--boot-wait <ms>`（启动屏等待，默认 90000）、`--out <目录>`、`--headful`。

## 六、已删除/已废弃

| 名称 | 原因 |
|---|---|
| `tools/e2e.mjs` | 早期 Edge 无头 + 裸 CDP 方案，已被 `e2e-browser.mjs` 取代 |
| `web/js/ui/`（空目录） | 与 `ui.js` 重名的误建目录 |
| `.server_url` | 运行期产物，`启动.bat` 每次重建；已加入 `.gitignore` |
