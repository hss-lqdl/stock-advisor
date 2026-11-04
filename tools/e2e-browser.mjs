#!/usr/bin/env node
/* ============================================================
   e2e-browser.mjs — 真浏览器端到端验收（用 puppeteer-core 驱动本机 Edge）

   为什么需要它：
     `msedge --headless --screenshot` 在本机沙箱下会被 crashpad 拦住
     （OpenProcess 拒绝访问 0x5 / "Multiple targets are not supported"），
     拿不到截图。改用 puppeteer-core 走 CDP 协议控制浏览器，可以正常出图。

   用法：
     node tools/e2e-browser.mjs                    # 手机尺寸 iPhone 14 Pro
     node tools/e2e-browser.mjs --live             # 允许真实联网抓数据（较慢）
     node tools/e2e-browser.mjs --out shots        # 截图输出目录

   输出：
     <out>/*.png      各 Tab 截图
     <out>/report.json 结构化结果（含 console 错误、页面异常、断言）

   依赖：tools/_e2e/node_modules/puppeteer-core（已安装，仅开发期使用，
         不进入交付物；交付的 App 本身零依赖）
   ============================================================ */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

/* puppeteer-core 装在 tools/_e2e 下，用 createRequire 定位 */
import { createRequire } from 'node:module';
const require = createRequire(path.join(__dirname, '_e2e', 'package.json'));
let puppeteer;
try {
  puppeteer = require('puppeteer-core');
} catch (e) {
  console.error('缺少 puppeteer-core，请先执行：');
  console.error('  cd tools/_e2e && npm install puppeteer-core');
  process.exit(1);
}

/* ---------------- 参数 ---------------- */

const argv = process.argv.slice(2);
const has = (k) => argv.includes(k);
const argVal = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const BASE = argVal('--url', process.env.APP_URL || 'http://127.0.0.1:8765/');
const OUT = path.resolve(ROOT, argVal('--out', 'tools/_e2e/shots'));
const LIVE = has('--live');
const HEADFUL = has('--headful');
const WAIT_MS = Number(argVal('--wait', '9000'));
// 启动屏单独用更长的等待：E2E 每次都用全新 profile（无 IndexedDB 缓存），
// 首屏必须真的拉完「56 页全市场快照 + 1000+ 板块 + K 线」才能隐藏启动屏。
// 上游限流时这一段实测可超过 60s。该断言的目的是「启动屏不会永久卡住」，
// 不是「8 秒内出首屏」——后者要靠预热缓存，属于另一条验收路径。
const BOOT_WAIT_MS = Number(argVal('--boot-wait', '90000'));

const EDGE_PATHS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const edge = EDGE_PATHS.find((p) => fs.existsSync(p));
if (!edge) {
  console.error('找不到 Edge 可执行文件');
  process.exit(1);
}

/* ---------------- 断言收集 ---------------- */

const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond, extra });
  const mark = cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`  ${mark} ${name}${extra ? '  \x1b[90m' + extra + '\x1b[0m' : ''}`);
  return !!cond;
}
function info(msg) {
  console.log(`    \x1b[90m· ${msg}\x1b[0m`);
}
function section(t) {
  console.log(`\n\x1b[36m── ${t} ──\x1b[0m`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 主流程 ---------------- */

async function main() {
  await fsp.mkdir(OUT, { recursive: true });

  // 【必须每次都清空 profile】
  // profile 目录名是固定的，跨次运行会残留上一轮的 Service Worker 与 CacheStorage。
  // 一旦上一轮把旧版 js 缓存下来，这一轮页面就可能拿到旧代码——
  // 表现是「代码明明改了，页面却还是老样子」，极难排查（本次就踩到过）。
  const PROFILE = path.join(os.tmpdir(), 'stock-advisor-e2e-profile');
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
  } catch (e) {
    info('清理旧 profile 失败（不影响本次运行）', String(e && e.message ? e.message : e));
  }

  const browser = await puppeteer.launch({
    executablePath: edge,
    headless: HEADFUL ? false : 'new',
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-features=Translate,BackForwardCache',
      '--no-sandbox',
      '--disable-gpu',
      '--hide-scrollbars',
      // 浏览器 profile 必须放系统临时目录：放 OUT 里会残留 50MB+ 的 Cache 文件，
      // 污染截图目录（实测 _profile 占 52MB）。
      `--user-data-dir=${PROFILE}`,
    ],
    defaultViewport: { width: 393, height: 852, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
    protocolTimeout: 180000,
  });

  const page = await browser.newPage();

  /* 收集 console / pageerror / requestfailed */
  const consoleErrors = [];
  const pageErrors = [];
  const failedReqs = [];
  const allConsole = [];

  page.on('console', (m) => {
    const t = m.type();
    const txt = m.text();
    allConsole.push({ type: t, text: txt });
    if (t === 'error') consoleErrors.push(txt);
  });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message ? e.message : e)));
  page.on('requestfailed', (r) => {
    const u = r.url();
    failedReqs.push({ url: u, err: r.failure() ? r.failure().errorText : '' });
  });

  /* iPhone 14 Pro UA */
  await page.setUserAgent(
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 ' +
    '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'
  );

  section('加载首页');
  const t0 = Date.now();
  const resp = await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  ok('HTTP 200', resp && resp.status() === 200, `status=${resp && resp.status()}`);
  const loadMs = Date.now() - t0;
  info(`DOMContentLoaded 用时 ${loadMs}ms`);

  /* 等 boot 屏消失或主界面渲染 */
  // 注意：CSS 里隐藏启动屏用的类是 `.boot.hide`（不是 `.hidden`），
  // 且 display 始终保持 flex，只有 opacity 过渡到 0 / visibility 变 hidden。
  // 早期版本这里查 `classList.contains('hidden')` 与 `display === 'none'`，是写错的断言。
  let bootGone = false;
  let bootErr = '';
  try {
    await page.waitForFunction(
      () => {
        const b = document.getElementById('bootScreen');
        if (!b) return true;
        const cs = getComputedStyle(b);
        return (
          b.classList.contains('hide') ||
          cs.display === 'none' ||
          cs.visibility === 'hidden' ||
          cs.opacity === '0'
        );
      },
      { timeout: BOOT_WAIT_MS }
    );
    bootGone = true;
  } catch (e) {
    bootGone = false;
    bootErr = String((e && e.message) || e).slice(0, 120);
  }
  ok('启动屏已消失', bootGone, bootGone ? '' : `${BOOT_WAIT_MS}ms 内仍可见${bootErr ? ' · ' + bootErr : ''}`);
  await sleep(600);

  /* ---------- 基本外壳断言 ---------- */
  section('外壳与 PWA 元信息');

  const shell = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    return {
      title: document.title,
      hasApp: !!q('#app'),
      hasTopbar: !!q('#topbar'),
      hasTabbar: !!q('#tabbar'),
      tabCount: document.querySelectorAll('.tab-btn').length,
      manifest: (q('link[rel="manifest"]') || {}).href || '',
      appleIcon: (q('link[rel="apple-touch-icon"]') || {}).href || '',
      appleCapable: (q('meta[name="apple-mobile-web-app-capable"]') || {}).content || '',
      themeColor: (q('meta[name="theme-color"]') || {}).content || '',
      viewport: (q('meta[name="viewport"]') || {}).content || '',
      bodyBg: getComputedStyle(document.body).backgroundColor,
      scrollW: document.documentElement.scrollWidth,
      clientW: document.documentElement.clientWidth,
      panelCount: document.querySelectorAll('.tab-panel').length,
    };
  });

  ok('document.title 非空', shell.title && shell.title.length > 0, shell.title);
  ok('#app 存在', shell.hasApp);
  ok('#topbar 存在', shell.hasTopbar);
  ok('#tabbar 存在', shell.hasTabbar);
  ok('底部 Tab 数量 = 5', shell.tabCount === 5, `实际 ${shell.tabCount}`);
  ok('Tab 面板数量 = 5', shell.panelCount === 5, `实际 ${shell.panelCount}`);
  ok('manifest 已声明', /manifest\.webmanifest/.test(shell.manifest), shell.manifest);
  ok('apple-touch-icon 已声明', /icon-180\.png/.test(shell.appleIcon), shell.appleIcon);
  ok('apple-mobile-web-app-capable=yes', shell.appleCapable === 'yes');
  ok('theme-color 已设置', /^#/.test(shell.themeColor), shell.themeColor);
  ok('viewport 含 viewport-fit=cover', /viewport-fit=cover/.test(shell.viewport), shell.viewport);
  ok('无横向溢出（scrollWidth <= clientWidth+1）',
    shell.scrollW <= shell.clientW + 1, `${shell.scrollW} vs ${shell.clientW}`);
  ok('深色主题生效（body 背景非白色）', !/rgb\(255,\s*255,\s*255\)/.test(shell.bodyBg), shell.bodyBg);

  /* ---------- 逐 Tab 截图 ---------- */
  section('五个 Tab 渲染与截图');

  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll('.tab-btn')).map((b) => ({
      tab: b.dataset.tab || b.getAttribute('data-tab') || '',
      label: (b.textContent || '').trim(),
    }))
  );
  info(`Tab: ${tabs.map((t) => `${t.tab}(${t.label})`).join(' / ')}`);
  ok('每个 Tab 都有 data-tab', tabs.every((t) => !!t.tab));

  const tabShots = [];
  for (const t of tabs) {
    if (!t.tab) continue;
    try {
      await page.evaluate((tab) => {
        const b = document.querySelector(`.tab-btn[data-tab="${tab}"]`);
        if (b) b.click();
      }, t.tab);
      await sleep(1200);

      const st = await page.evaluate((tab) => {
        const panel = document.getElementById('tab-' + tab);
        const content = document.getElementById(tab + 'Content');
        const vis = panel ? getComputedStyle(panel).display !== 'none' : false;
        return {
          visible: vis,
          contentLen: content ? content.innerHTML.length : -1,
          textLen: content ? (content.innerText || '').trim().length : -1,
          hasEmpty: !!(content && content.querySelector('.empty')),
          hasErr: !!(content && content.querySelector('.err-box')),
          hasSkeleton: !!(content && content.querySelector('.skel')),
        };
      }, t.tab);

      ok(`Tab[${t.tab}] 面板可见`, st.visible);
      ok(`Tab[${t.tab}] 有内容（HTML>200 字符）`, st.contentLen > 200, `${st.contentLen} 字符`);
      ok(`Tab[${t.tab}] 无错误框`, !st.hasErr);

      const file = path.join(OUT, `tab-${t.tab}.png`);
      await page.screenshot({ path: file, fullPage: false });
      tabShots.push({ tab: t.tab, file, ...st });

      // 设置 Tab 专属校验：龙头战法策略选项 + 过滤明细分组 + 各策略初筛对比
      if (t.tab === 'settings') {
        const setCheck = await page.evaluate(() => {
          const sel = document.querySelector('select');
          const opts = sel ? [...sel.options].map((o) => ({ val: o.value, text: o.text })) : [];
          const hasDragon = opts.some((o) => o.val === 'dragon' && o.text.includes('龙头战法'));
          const secRows = document.querySelectorAll('#tab-settings .tbl tr.row-sec');
          const titles = [...document.querySelectorAll('#tab-settings .card-title')].map((c) => (c.innerText || '').trim());
          const filterTitle = titles.find((t) => t.includes('股票池过滤明细'));
          return {
            optCount: opts.length,
            hasDragon,
            secRowCount: secRows.length,
            hasFilterTitle: !!filterTitle,
            filterTitleText: filterTitle || '',
          };
        });
        ok('设置页策略下拉包含「龙头战法」（4 种策略）', setCheck.optCount >= 4 && setCheck.hasDragon, `选项数 ${setCheck.optCount}，含龙头=${setCheck.hasDragon}`);
        ok('过滤明细卡片标题包含当前策略名', setCheck.hasFilterTitle, setCheck.filterTitleText);
        ok('过滤明细表格包含阶段分组小标题', setCheck.secRowCount >= 2, `分组行数 ${setCheck.secRowCount}`);

        /* ---- 过滤条件编辑器：可开关 / 可编辑 / 可自定义 ---- */
        const edCheck = await page.evaluate(() => {
          const titles = [...document.querySelectorAll('#tab-settings .card-title')]
            .map((c) => (c.innerText || '').trim());
          const title = titles.find((t) => t.includes('过滤条件设置'));
          const card = [...document.querySelectorAll('#tab-settings .card')]
            .find((c) => (c.querySelector('.card-title') || {}).innerText
              && c.querySelector('.card-title').innerText.includes('过滤条件设置'));
          if (!card) return { hasTitle: false };
          const secTitles = [...card.querySelectorAll('.rule-sec-hd .t')].map((n) => (n.innerText || '').trim());
          const rows = [...card.querySelectorAll('.rule-row')];
          const switches = [...card.querySelectorAll('.rule-sw .switch')];
          const inputs = [...card.querySelectorAll('.rule-ctrl .input-xs')];
          const selects = [...card.querySelectorAll('.rule-ctrl select')];
          const addBtns = [...card.querySelectorAll('button')].filter((b) => /添加自定义条件/.test(b.innerText || ''));
          const sub = (card.querySelector('.card-sub') || {}).innerText || '';
          const numInputs = inputs.filter((i) => i.type === 'number').length;
          const textInputs = inputs.filter((i) => i.type === 'text').length;
          return {
            hasTitle: !!title,
            sub,
            secTitles,
            sectionCount: secTitles.length,
            rowCount: rows.length,
            switchCount: switches.length,
            selectCount: selects.length,
            numInputs,
            textInputs,
            addCount: addBtns.length,
            hasReset: [...card.querySelectorAll('button')].some((b) => /恢复默认/.test(b.innerText || '')),
            offRows: card.querySelectorAll('.rule-row.is-off').length,
            lockedSwitches: card.querySelectorAll('.rule-sw .switch.is-locked').length,
          };
        });
        ok('存在「过滤条件设置」卡片', edCheck.hasTitle, edCheck.hasTitle ? '已渲染' : '未找到');
        if (edCheck.hasTitle) {
          info(`过滤条件设置：${edCheck.sub}`);
          ok('编辑器包含 4 个条件分组（基础/主线/快照/因子）', edCheck.sectionCount >= 4,
            `分组 ${edCheck.sectionCount}：${edCheck.secTitles.join(' / ')}`);
          ok('编辑器渲染出 ≥ 10 行条件', edCheck.rowCount >= 10, `规则行 ${edCheck.rowCount}`);
          ok('每条条件都有独立开关', edCheck.switchCount >= 10, `开关 ${edCheck.switchCount}`);
          ok('条件阈值可编辑（数值输入框）', edCheck.numInputs >= 5, `数值输入 ${edCheck.numInputs}`);
          ok('提供运算符下拉（可改比较方式）', edCheck.selectCount >= 3, `下拉 ${edCheck.selectCount}`);
          ok('支持添加自定义条件', edCheck.addCount >= 2, `添加按钮 ${edCheck.addCount}`);
          ok('提供「恢复默认」按钮', edCheck.hasReset);
          ok('必需的停牌条件被锁定（不可关闭）', edCheck.lockedSwitches >= 1, `锁定开关 ${edCheck.lockedSwitches}`);

          /* 交互：关掉第一条基础条件 → 已启用数量减少，且不崩溃 */
          const toggle = await page.evaluate(() => {
            const card = [...document.querySelectorAll('#tab-settings .card')]
              .find((c) => (c.querySelector('.card-title') || {}).innerText
                && c.querySelector('.card-title').innerText.includes('过滤条件设置'));
            if (!card) return null;
            const before = (card.querySelector('.card-sub') || {}).innerText || '';
            const sw = [...card.querySelectorAll('.rule-sec .rule-row .rule-sw .switch')]
              .find((s) => !s.classList.contains('is-locked'));
            if (!sw) return null;
            sw.click();
            return { before };
          });
          await sleep(2500);
          const afterToggle = await page.evaluate(() => {
            const card = [...document.querySelectorAll('#tab-settings .card')]
              .find((c) => (c.querySelector('.card-title') || {}).innerText
                && c.querySelector('.card-title').innerText.includes('过滤条件设置'));
            const errBox = !!document.querySelector('#tab-settings .err-box');
            return {
              sub: card ? ((card.querySelector('.card-sub') || {}).innerText || '') : '',
              offRows: card ? card.querySelectorAll('.rule-row.is-off').length : -1,
              errBox,
              bodyLen: document.body.innerHTML.length,
            };
          });
          ok('关闭一条过滤条件后计数下降',
            toggle && afterToggle.sub !== toggle.before,
            toggle ? `${toggle.before} → ${afterToggle.sub}` : '未找到可关闭的开关');
          ok('关闭后该行显示为已停用样式', afterToggle.offRows >= 1, `is-off 行 ${afterToggle.offRows}`);
          ok('切换过滤条件后页面未出错也未白屏',
            !afterToggle.errBox && afterToggle.bodyLen > 3000, `errBox=${afterToggle.errBox} body=${afterToggle.bodyLen}`);

          /* 复原：恢复默认，避免影响后续断言 */
          await page.evaluate(() => {
            const card = [...document.querySelectorAll('#tab-settings .card')]
              .find((c) => (c.querySelector('.card-title') || {}).innerText
                && c.querySelector('.card-title').innerText.includes('过滤条件设置'));
            if (!card) return;
            const b = [...card.querySelectorAll('button')].find((x) => /恢复默认/.test(x.innerText || ''));
            if (b) b.click();
          });
          await sleep(2500);
          const afterReset = await page.evaluate(() => {
            const card = [...document.querySelectorAll('#tab-settings .card')]
              .find((c) => (c.querySelector('.card-title') || {}).innerText
                && c.querySelector('.card-title').innerText.includes('过滤条件设置'));
            return card ? card.querySelectorAll('.rule-row.is-off').length : -1;
          });
          ok('「恢复默认」把关闭的条件重新打开', afterReset === 0, `is-off 行 ${afterReset}`);
        }
      }
    } catch (e) {
      ok(`Tab[${t.tab}] 渲染`, false, String(e.message || e));
    }
  }

  /* ---------- 交互：刷新按钮 ---------- */
  section('交互：刷新 / 详情弹层 / 尾盘条');

  const btnState = await page.evaluate(() => {
    const b = document.getElementById('btnRefresh');
    if (!b) return null;
    return {
      text: (b.textContent || '').trim(),
      aria: (b.getAttribute('aria-label') || '').trim(),
      title: (b.getAttribute('title') || '').trim(),
      disabled: !!b.disabled,
    };
  });
  ok('刷新按钮存在', !!btnState, btnState ? (btnState.aria || btnState.text) : '');
  /* 图标按钮：无可见文字，靠 aria-label / title 提供可访问名称 */
  ok(
    '刷新按钮有可访问名称（aria-label 或 title）',
    !!btnState && (btnState.aria.length > 0 || btnState.title.length > 0),
    btnState ? `${btnState.aria} / ${btnState.title}` : ''
  );

  /* 点击一次刷新（离线环境下应给出可读错误或成功，不能白屏） */
  if (btnState && !LIVE) {
    info('点击刷新（离线预期：给出错误提示但不白屏）…');
    await page.evaluate(() => {
      const b = document.getElementById('btnRefresh');
      if (b) b.click();
    });
    await sleep(3500);
    const after = await page.evaluate(() => ({
      bodyLen: document.body.innerHTML.length,
      errBox: !!document.querySelector('.err-box'),
      toast: (document.querySelector('.toast') || {}).innerText || '',
      contentLen: (document.getElementById('todayContent') || {}).innerHTML
        ? document.getElementById('todayContent').innerHTML.length : 0,
    }));
    ok('刷新后页面未白屏（body>3000 字符）', after.bodyLen > 3000, `${after.bodyLen}`);
    info(`刷新后 todayContent ${after.contentLen} 字符，errBox=${after.errBox}`);
    await page.screenshot({ path: path.join(OUT, 'after-refresh.png') });
  }

  /* 详情弹层：点推荐卡片里的「K线详情」按钮（卡片本身不可点） */
  const hasPick = await page.evaluate(() => {
    const card = document.querySelector('.pick');
    if (!card) return null;
    const btns = [...card.querySelectorAll('button')];
    const detail = btns.find((b) => /K线|详情/.test((b.textContent || '').trim()));
    return {
      cardText: (card.innerText || '').slice(0, 40),
      btnText: detail ? (detail.textContent || '').trim() : '',
      found: !!detail,
    };
  });
  if (hasPick && hasPick.found) {
    info(`找到推荐卡片「${hasPick.cardText.split('\n')[0]}」，点击「${hasPick.btnText}」…`);
    try {
      await page.evaluate(() => {
        const card = document.querySelector('.pick');
        const btns = [...card.querySelectorAll('button')];
        const detail = btns.find((b) => /K线|详情/.test((b.textContent || '').trim()));
        if (detail) detail.click();
      });
      await sleep(1200);
      const sheet = await page.evaluate(() => {
        const m = document.getElementById('sheetMask');
        const s = document.getElementById('sheetContent');
        return {
          maskVisible: m ? !m.classList.contains('hidden') : false,
          contentLen: s ? s.innerHTML.length : 0,
          text: s ? (s.innerText || '').slice(0, 200) : '',
        };
      });
      ok('详情弹层可打开', sheet.maskVisible, `内容 ${sheet.contentLen} 字符`);
      if (sheet.maskVisible) {
        await page.screenshot({ path: path.join(OUT, 'sheet-detail.png') });

        // 弹层必须自带「返回」按钮：iPhone 主屏模式没有浏览器返回键，
        // 只能靠这个按钮退出弹层（见 ui.js openSheet 的说明）。
        const back = await page.evaluate(() => {
          const b = document.querySelector('#sheetContent .sheet-back');
          return { exists: !!b, text: b ? (b.textContent || '').trim() : '' };
        });
        ok('弹层有「返回」按钮', back.exists, back.exists ? back.text : '未找到 .sheet-back');

        // 点「返回」必须真的能关掉弹层
        const clicked = await page.evaluate(() => {
          const b = document.querySelector('#sheetContent .sheet-back');
          if (!b) return false;
          b.click();
          return true;
        });
        await sleep(600);
        const closed = await page.evaluate(() => {
          const m = document.getElementById('sheetMask');
          return m ? m.classList.contains('hidden') : true;
        });
        ok('点「返回」能关闭弹层', clicked && closed, closed ? '已关闭' : '仍然打开');
      }
    } catch (e) {
      ok('详情弹层可打开', false, String(e.message || e));
    }
  } else if (hasPick) {
    ok('详情弹层可打开', false, '推荐卡片内未找到「K线详情」按钮');
  } else {
    info('当前无推荐卡片（离线模式正常），跳过弹层测试');
  }

  /* ---------- Service Worker ---------- */
  section('Service Worker');
  const sw = await page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false };
    // 注册是异步的：轮询最多 15s，避免「刚注册完就被判失败」的假阴性。
    let regs = await navigator.serviceWorker.getRegistrations();
    for (let i = 0; i < 30 && regs.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 500));
      regs = await navigator.serviceWorker.getRegistrations();
    }
    return {
      supported: true,
      secure: window.isSecureContext,
      count: regs.length,
      scope: regs[0] ? regs[0].scope : '',
    };
  });
  ok('浏览器支持 Service Worker', sw.supported);
  if (sw.secure) {
    ok('SW 已注册（secure context）', sw.count > 0, `count=${sw.count} scope=${sw.scope}`);
  } else {
    info('非 secure context（局域网 http），SW 按设计不注册 —— 符合预期');
    ok('非 secure context 时不注册 SW（设计如此）', sw.count === 0);
  }

  /* ---------- 缓存 API ---------- */
  const cachesInfo = await page.evaluate(async () => {
    if (!('caches' in window)) return { supported: false };
    const keys = await caches.keys();
    return { supported: true, keys };
  });
  ok('CacheStorage 可用', cachesInfo.supported, cachesInfo.keys ? cachesInfo.keys.join(',') : '');

  /* ---------- IndexedDB ---------- */
  section('IndexedDB');
  const idb = await page.evaluate(async () => {
    const dbs = (indexedDB.databases ? await indexedDB.databases() : []).map((d) => d.name);
    return new Promise((resolve) => {
      const req = indexedDB.open('stock_advisor');
      req.onsuccess = () => {
        const db = req.result;
        const stores = Array.from(db.objectStoreNames);
        db.close();
        resolve({ ok: true, stores, dbs });
      };
      req.onerror = () => resolve({ ok: false, err: String(req.error), dbs });
      setTimeout(() => resolve({ ok: false, err: 'timeout', dbs }), 5000);
    });
  });
  ok('IndexedDB 数据库可打开', idb.ok, idb.err || '');
  ok('含 7 个对象仓库', idb.stores && idb.stores.length >= 7,
    idb.stores ? idb.stores.join(',') : '');

  /* ---------- 全页长截图 ---------- */
  section('整页截图');
  try {
    await page.evaluate(() => {
      const b = document.querySelector('.tab-btn[data-tab="today"]');
      if (b) b.click();
    });
    await sleep(800);
    await page.screenshot({ path: path.join(OUT, 'full-today.png'), fullPage: true });
    ok('整页截图成功', true, 'full-today.png');
  } catch (e) {
    ok('整页截图成功', false, String(e.message || e));
  }

  /* ---------- 错误汇总 ---------- */
  section('运行期错误汇总');
  const ignorePatterns = [
    /Failed to load resource/i,      // 离线时东财接口必然失败，属预期
    /net::ERR_/i,
    /NetworkError/i,
    /Load failed/i,
    /The Internet connection appears to be offline/i,
  ];
  const realConsoleErrors = consoleErrors.filter((t) => !ignorePatterns.some((re) => re.test(t)));
  const realPageErrors = pageErrors.filter((t) => !ignorePatterns.some((re) => re.test(t)));

  ok('无未捕获页面异常', realPageErrors.length === 0,
    realPageErrors.slice(0, 3).join(' | '));
  ok('无致命 console.error', realConsoleErrors.length === 0,
    realConsoleErrors.slice(0, 3).join(' | '));

  if (!LIVE) {
    info(`离线模式下网络失败 ${failedReqs.length} 次（东财接口不可达，属预期）`);
  } else {
    const emFails = failedReqs.filter((r) => /eastmoney\.com/.test(r.url));
    info(`东财接口失败 ${emFails.length} 次 / 总请求失败 ${failedReqs.length} 次`);
  }

  await browser.close();

  /* ---------- 汇总 ---------- */
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  const report = {
    base: BASE,
    live: LIVE,
    at: new Date().toISOString(),
    loadMs,
    passed,
    failed,
    results,
    consoleErrors,
    pageErrors,
    failedRequests: failedReqs.slice(0, 50),
    tabShots,
    shell,
    idb,
    sw,
  };
  await fsp.writeFile(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2), 'utf8');

  console.log('\n' + '='.repeat(70));
  if (failed === 0) {
    console.log(`\x1b[32m  浏览器 E2E 全部通过: ${passed} 项断言\x1b[0m`);
  } else {
    console.log(`\x1b[31m  通过 ${passed} 项，失败 ${failed} 项\x1b[0m`);
    results.filter((r) => !r.pass).forEach((r) => {
      console.log(`\x1b[31m    ✗ ${r.name}  ${r.extra}\x1b[0m`);
    });
  }
  console.log(`  截图目录: ${OUT}`);
  console.log(`  报告: ${path.join(OUT, 'report.json')}`);
  console.log('='.repeat(70));

  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n\x1b[31mE2E 崩溃：\x1b[0m', e);
  process.exit(2);
});
