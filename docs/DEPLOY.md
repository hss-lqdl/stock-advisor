# 部署到 GitHub Pages（拿到手机随时能用的固定地址）

部署完成后你会得到一个**永久不变的 HTTPS 地址**：

```
https://hss-lqdl.github.io/stock-advisor/
```

它和局域网方案的本质区别：

| | 局域网（启动.bat） | GitHub Pages |
|---|---|---|
| 电脑要开机 | 要 | **不用** |
| 手机要同一 WiFi | 要 | **不用** |
| 地址 | 内网 IP，会变 | **固定不变** |
| 协议 | http（SW 不注册） | **https（SW 正常，可离线）** |
| 主屏图标 | 能装但离线无效 | **完全可用** |

---

## 一、仓库结构

一条仓库，两个分支：

```
main       ← 源码全量（整个项目，含 server.mjs / tools / docs）
gh-pages   ← 只有 web/ 目录的内容，GitHub Pages 从这里发布
```

`gh-pages` 由脚本自动生成，**不要手动改它**，每次发布都会被整体覆盖。

---

## 二、发布

### 准备 Token（只需一次）

打开 <https://github.com/settings/personal-access-tokens/new>：

| 项目 | 填什么 |
|---|---|
| Token name | `stock-advisor-deploy` |
| Expiration | `30 days` |
| Repository access | **All repositories** |
| Permissions → Administration | **Read and write**（仅首次建仓库需要） |
| Permissions → Contents | **Read and write** |
| Permissions → Pages | **Read and write** |

生成后复制 `github_pat_...`（只显示一次）。

> 如果不想给 Administration 权限，就先在 <https://github.com/new> 手动建一个名为
> `stock-advisor` 的 **Public** 空仓库（不要勾 README / .gitignore / license），
> 之后 Token 只需 Contents + Pages 两项即可。

### 执行发布

```powershell
$env:GH_TOKEN = "github_pat_xxx"
node tools/publish-pages.mjs
```

或：

```powershell
npm run publish
```

脚本会依次完成：校验 Token → 建仓库（若不存在）→ 推源码到 `main` →
构建并推送 `gh-pages` → 开启 Pages → 轮询直到站点可访问。

**可反复执行**，改了代码之后重跑一次就是更新。

首次部署 GitHub 侧需要 1–3 分钟才生效，脚本最多等 5 分钟。

### 发布后清理

回到 <https://github.com/settings/tokens> 把刚才那个 Token **Delete** 掉。
之后要再发布，重新生成一个即可（Token 不落盘、不进仓库）。

---

## 三、iPhone 安装

必须用 **Safari**（微信内置浏览器、Chrome for iOS 都不行 —— iOS 只允许 Safari 把网页加到主屏）。

1. Safari 打开 `https://hss-lqdl.github.io/stock-advisor/`
2. 点底部 **分享** 图标（方框带向上箭头）
3. 下滑找到 **添加到主屏幕**
4. 名称保持「A股计划」→ 点 **添加**
5. 回到主屏，点图标启动

启动后是独立窗口：没有地址栏、没有浏览器返回键 —— 所以应用内每个弹层都带了「← 返回」。

---

## 四、日常更新流程

改完代码后：

```powershell
npm test              # 离线自测
npm run test:live     # 联网自测（需交易时段数据）
$env:GH_TOKEN = "github_pat_xxx"
node tools/publish-pages.mjs
```

手机上打开应用 → 若 `web/sw.js` 的 `VERSION` 变了，Service Worker 会自动拉新版本。
**改动任何被预缓存的 JS/CSS 后必须 bump `VERSION`**，否则手机上还跑旧代码。

> 想让手机立即更新：主屏图标 → 长按 → 删除 App → 重新从 Safari 添加。
> 这只是清主屏快捷方式，数据（IndexedDB）里缓存的是行情，会自然刷新。

---

## 五、注意事项

- **仓库必须是 Public**。GitHub Pages 对免费账号的私有仓库不开放站点托管。
- `.nojekyll` 必须存在（已在 `web/` 里）。否则 Jekyll 会跳过下划线开头的文件，并拖慢构建。
- 站点是纯静态的，**所有计算都在手机浏览器里完成**，GitHub 只负责发文件，不消耗任何后端资源。
- 行情数据由手机直连东方财富公开接口获取 —— 这意味着**手机必须能上网**才能刷新数据，
  但应用本身（界面、上次的推荐）可以离线打开。
- 仓库里 `.gitignore` 已排除 `.server_url` 等运行期产物，Token 不会进入版本库。

---

## 六、排错

| 现象 | 原因 / 处理 |
|---|---|
| `Resource not accessible by personal access token` | Token 权限不够。按第二节重新勾选；或先手动建空仓库 |
| 页面 404 | 还没部署完，等 1–3 分钟；或 Pages 没开启 —— 去 Settings → Pages 选 `gh-pages` / root |
| 页面白屏 | 检查 `gh-pages` 分支里是否有 `index.html`（编译产物是否完整） |
| 手机上还是旧版本 | `web/sw.js` 的 `VERSION` 没 bump |
| 图片/JS 404 | `gh-pages` 分支内容不完整，重新发布 |
| Pages 显示 "Your site is having problems building" | 确认 `.nojekyll` 在分支根目录 |
| 自定义域名填了但一发布就变回空白 | 手工在网页上设的域名会被 `gh-pages` 强推覆盖 —— 必须用 `web/CNAME`（见第七节） |
| 自定义域名报 `NET::ERR_CERT_COMMON_NAME_INVALID` | 证书还在签发（几分钟到 24 小时），先等；超过一天检查 DNS 是否两条都配对 |

---

## 七、自定义域名（可选）

默认地址 `https://hss-lqdl.github.io/stock-advisor/` 已经能用。想要更好记的地址（例如
`https://stock.example.com`），按下面三步做。

### 先说清楚收益与代价

| | 说明 |
|---|---|
| 好处 | 地址短好记、不暴露 GitHub 用户名、以后换托管后端时手机上的书签不用改 |
| **不是好处** | **不会让国内访问变快**。解析出来仍是 GitHub 的 `185.199.108-111.153`，能不能连上取决于你到 GitHub 的线路 |
| 代价 | 多一个域名年费；需要自己配 DNS；证书签发有等待期 |

> 想真正改善国内访问，需要套 CDN（Cloudflare 等）或换国内静态托管 —— 那是另一件事，
> 且国内托管要求域名已备案。**只绑域名不解决连通性问题。**

### 步骤 1：改代码侧（一条命令）

把域名写进 `web/CNAME`（这个文件会跟着源码走，发布脚本会自动带到 `gh-pages` 根目录）：

```powershell
cd C:\Users\lqdl\Downloads\stock_advisor
Set-Content -Path web\CNAME -Value "stock.example.com" -Encoding ascii -NoNewline
```

> 为什么必须落在文件里：GitHub Pages 靠**发布分支根目录的 `CNAME` 文件**认域名。
> 本项目的发布脚本每次都 `--force` 重建 `gh-pages`，在网页上手工填的域名会被下一次发布冲掉。

临时想试别的域名，也可以不改文件，直接给环境变量：

```powershell
$env:PAGES_DOMAIN = "stock.example.com"
```

优先级：`PAGES_DOMAIN` > `web/CNAME`。

### 步骤 2：配 DNS 解析

去你买域名的地方（阿里云 / 腾讯云 / Cloudflare / Namecheap 都行）加记录。

**如果用的是根域名**（`example.com`，两段式）—— 四条 A + 四条 AAAA + 一条 www：

| 主机记录 | 类型 | 值 |
|---|---|---|
| `@` | A | `185.199.108.153` |
| `@` | A | `185.199.109.153` |
| `@` | A | `185.199.110.153` |
| `@` | A | `185.199.111.153` |
| `@` | AAAA | `2606:50c0:8000::153` |
| `@` | AAAA | `2606:50c0:8001::153` |
| `@` | AAAA | `2606:50c0:8002::153` |
| `@` | AAAA | `2606:50c0:8003::153` |
| `www` | CNAME | `hss-lqdl.github.io` |

> 这些 IP 是 GitHub Pages 官方的固定地址，上面 8 条已用 DNS 实测核对过。
> 有的服务商不支持给 `@` 加 AAAA，那就只配 4 条 A，IPv6 不是必须的。
> **不要**给 `@` 配 CNAME（根域名 CNAME 违反 DNS 规范，部分服务商允许但会出问题）。

**如果用的是子域名**（`stock.example.com`）—— 一条就够：

| 主机记录 | 类型 | 值 |
|---|---|---|
| `stock` | CNAME | `hss-lqdl.github.io` |

CLI 自检（解析生效后才会返回上面的 IP）：

```powershell
nslookup stock.example.com
```

### 步骤 3：发布 + 开 HTTPS

```powershell
$env:GH_TOKEN = "你的token"
npm run publish
```

脚本会：把 `CNAME` 写进站点 → 推送 → 调 API 绑定域名 → 探活。最后会打印该配的 DNS 记录。

然后等证书（几分钟到 24 小时），打开 <https://github.com/hss-lqdl/stock-advisor/settings/pages>
勾上 **Enforce HTTPS**（证书没签发好之前这个勾是灰的）。

### 绑定之后的行为

- 旧地址 `https://hss-lqdl.github.io/stock-advisor/` 会自动 **301 跳转**到新域名，手机上的旧主屏图标仍能打开。
- 站点根路径从 `/stock-advisor/` 变成 `/`。本项目所有资源都用相对路径（`./index.html`、`./sw.js`、`./`），
  **无需改任何代码**；Service Worker 的 scope 会自动跟随到新根目录。
- 想撤回：删掉 `web/CNAME` 重新发布，再到 Settings → Pages 把 Custom domain 清空。
