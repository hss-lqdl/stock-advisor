#!/usr/bin/env node
/**
 * 发布到 GitHub Pages
 * ---------------------------------------------------------------------------
 * 用途：把 web/ 目录发布成可直接访问的 HTTPS 站点，供 iPhone「添加到主屏幕」。
 *
 * 仓库结构（一条 repo，两个分支）：
 *   main      源码全量（本项目所有文件）
 *   gh-pages  仅 web/ 的内容，GitHub Pages 从这里发布
 *
 * 用法：
 *   $env:GH_TOKEN = "github_pat_xxx"     # PowerShell
 *   node tools/publish-pages.mjs
 *
 * 可选环境变量：
 *   GH_OWNER  默认 hss-lqdl
 *   GH_REPO   默认 stock-advisor
 *   GH_TOKEN  必填。fine-grained token 需勾选：
 *               Repository access: All repositories
 *               Administration: Read and write   （仅首次建仓库需要）
 *               Contents:       Read and write
 *               Pages:          Read and write
 *
 * 幂等：可反复执行。仓库已存在则跳过创建，gh-pages 分支整体强制覆盖。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');

const OWNER = process.env.GH_OWNER || 'hss-lqdl';
const REPO = process.env.GH_REPO || 'stock-advisor';
const TOKEN = (process.env.GH_TOKEN || '').trim();
const SITE_BRANCH = 'gh-pages';
const SOURCE_BRANCH = 'main';
const SITE_URL = `https://${OWNER.toLowerCase()}.github.io/${REPO}/`;

/**
 * 网络类 git 操作（push / ls-remote）的认证参数。
 *
 * 两个坑，都是本机实测踩出来的：
 *  1. 默认 TLS 后端 schannel 在本机不可用，会报
 *     `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS`，
 *     换成 openssl 后端即正常。
 *  2. 把 Token 拼进 remote URL（https://x-access-token:TOKEN@...）同样会踩上面的错，
 *     且容易把 Token 写进日志，因此改用 http.extraHeader 传 Basic 认证。
 */
function authArgs() {
  const basic = Buffer.from(`x-access-token:${TOKEN}`).toString('base64');
  return [
    '-c', 'http.sslBackend=openssl',
    '-c', `http.extraHeader=Authorization: Basic ${basic}`,
  ];
}

const C = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  bad: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const mask = (s) => String(s).split(TOKEN).join('***');
const step = (n, s) => console.log(`\n${C.bold(`[${n}]`)} ${s}`);
const ok = (s) => console.log(`    ${C.ok('OK')} ${s}`);
const info = (s) => console.log(`    ${C.dim(s)}`);

function die(msg, hint) {
  console.error(`\n${C.bad('失败')} ${msg}`);
  if (hint) console.error(`\n${hint}\n`);
  process.exit(1);
}

/**
 * 执行 git。
 * 注意：这里刻意不用 stdio:'pipe' 捕获输出 —— 在受限沙箱里，
 * 子进程的管道读写会被拒绝（spawnSync git EPERM），
 * 因此把 stdout/stderr 重定向到临时文件再读回来，任何环境都能工作。
 */
function git(args, cwd = ROOT, { allowFail = false } = {}) {
  const logFile = path.join(os.tmpdir(), `git-${process.pid}-${Math.random().toString(36).slice(2)}.log`);
  const fd = fs.openSync(logFile, 'w');
  let code = 0;
  try {
    execFileSync('git', args, { cwd, stdio: ['ignore', fd, fd] });
  } catch (e) {
    code = typeof e.status === 'number' ? e.status : 1;
  } finally {
    try { fs.closeSync(fd); } catch { /* 已关闭 */ }
  }
  let out = '';
  try { out = fs.readFileSync(logFile, 'utf8'); } catch { /* 无输出 */ }
  try { fs.rmSync(logFile, { force: true }); } catch { /* 忽略 */ }
  if (code !== 0 && !allowFail) {
    throw new Error(mask(out.trim() || `git ${args[0]} 退出码 ${code}`));
  }
  return { code, out };
}

async function api(pathname, { method = 'GET', body } = {}) {
  const headers = {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'stock-advisor-publish',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body) headers['Content-Type'] = 'application/json';
  const r = await fetch(`https://api.github.com${pathname}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: r.status, body: parsed };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
async function main() {
  console.log(C.bold('\nGitHub Pages 发布'));
  console.log(C.dim(`仓库 ${OWNER}/${REPO} → ${SITE_URL}`));

  if (!TOKEN) die('缺少 GH_TOKEN 环境变量', 'PowerShell 里先执行：\n  $env:GH_TOKEN = "github_pat_xxx"\n然后重跑本脚本。');

  // -- 1. 校验 Token ---------------------------------------------------------
  step(1, '校验 Token');
  const me = await api('/user');
  if (me.status !== 200) die(`Token 无效（HTTP ${me.status}）：${JSON.stringify(me.body).slice(0, 200)}`);
  if (me.body.login.toLowerCase() !== OWNER.toLowerCase()) {
    info(`Token 属于 ${me.body.login}，与目标账号 ${OWNER} 不一致（继续尝试）`);
  } else {
    ok(`身份 ${me.body.login}`);
  }

  // -- 2. 确保仓库存在 -------------------------------------------------------
  step(2, '确保仓库存在');
  let repo = await api(`/repos/${OWNER}/${REPO}`);
  if (repo.status === 200) {
    ok(`仓库已存在（默认分支 ${repo.body.default_branch}，公开=${!repo.body.private}）`);
  } else if (repo.status === 404) {
    info('仓库不存在，尝试创建…');
    const created = await api('/user/repos', {
      method: 'POST',
      body: {
        name: REPO,
        description: 'A股每日买入计划 PWA — 可安装到 iPhone 的选股客户端',
        homepage: SITE_URL,
        private: false,
        has_issues: true,
        has_wiki: false,
        has_projects: false,
        auto_init: false,
      },
    });
    if (created.status === 201) {
      ok(`已创建 https://github.com/${OWNER}/${REPO}`);
    } else if (created.status === 403 || created.status === 404) {
      die(
        `Token 无权创建仓库（HTTP ${created.status}）`,
        '两个选择，任选其一：\n' +
        `  A. 先手动建空仓库：打开 https://github.com/new ，名称填 ${REPO}，选 Public，\n` +
        '     不要勾选 README / .gitignore / license，点 Create。然后重跑本脚本。\n' +
        '  B. 重新生成 Token，打开 https://github.com/settings/personal-access-tokens/new ，\n' +
        '     Repository access 选 All repositories，\n' +
        '     Permissions 里把 Administration、Contents、Pages 都设为 Read and write。'
      );
    } else {
      die(`创建仓库失败（HTTP ${created.status}）：${JSON.stringify(created.body).slice(0, 300)}`);
    }
  } else {
    die(`查询仓库失败（HTTP ${repo.status}）：${JSON.stringify(repo.body).slice(0, 300)}`);
  }

  // -- 3. 推送源码到 main ----------------------------------------------------
  step(3, `推送源码到 ${SOURCE_BRANCH}`);
  const remote = `https://github.com/${OWNER}/${REPO}.git`;
  const existingRemote = git(['remote', 'get-url', 'origin'], ROOT, { allowFail: true });
  if (existingRemote.code === 0) {
    info(`origin 已存在：${existingRemote.out.trim()}`);
    git(['remote', 'set-url', 'origin', remote]);
  } else {
    git(['remote', 'add', 'origin', remote]);
    info('已添加 origin');
  }
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).out.trim();
  info(`本地当前分支 ${branch} → 远程 ${SOURCE_BRANCH}`);
  git([...authArgs(), 'push', '--quiet', remote, `HEAD:refs/heads/${SOURCE_BRANCH}`, '--force']);
  ok(`源码已推送（${git(['rev-list', '--count', 'HEAD']).out.trim()} 个提交）`);

  // -- 4. 构建并推送站点分支 --------------------------------------------------
  step(4, `构建 ${SITE_BRANCH} 分支（来自 web/）`);
  if (!fs.existsSync(path.join(WEB, 'index.html'))) die('web/index.html 不存在，无法发布');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-build-'));
  try {
    fs.cpSync(WEB, tmp, { recursive: true });
    // .nojekyll：绕开 Jekyll（会忽略下划线开头的文件，并拖慢构建）
    fs.writeFileSync(path.join(tmp, '.nojekyll'), '');

    const files = [];
    (function walk(dir, rel = '') {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(path.join(dir, e.name), r);
        else files.push(r);
      }
    })(tmp);
    const bytes = files.reduce((s, f) => s + fs.statSync(path.join(tmp, f)).size, 0);
    info(`${files.length} 个文件，${(bytes / 1024).toFixed(0)} KB`);

    git(['init', '--quiet'], tmp);
    git(['checkout', '--quiet', '-B', SITE_BRANCH], tmp);
    git(['add', '-A'], tmp);
    git(
      ['-c', 'user.name=' + OWNER, '-c', 'user.email=' + OWNER + '@users.noreply.github.com',
       'commit', '--quiet', '-m', `deploy: ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`],
      tmp
    );
    git([...authArgs(), 'push', '--quiet', '--force', remote, `HEAD:refs/heads/${SITE_BRANCH}`], tmp);
    ok(`站点已推送 → ${SITE_BRANCH}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // -- 5. 开启 / 更新 Pages ---------------------------------------------------
  step(5, '配置 GitHub Pages');
  const cfg = await api(`/repos/${OWNER}/${REPO}/pages`);
  if (cfg.status === 404) {
    const on = await api(`/repos/${OWNER}/${REPO}/pages`, {
      method: 'POST',
      body: { source: { branch: SITE_BRANCH, path: '/' } },
    });
    if (on.status === 201) ok(`Pages 已开启（${SITE_BRANCH} 根目录）`);
    else if (on.status === 409) ok('Pages 已存在（并发创建）');
    else die(`开启 Pages 失败（HTTP ${on.status}）：${JSON.stringify(on.body).slice(0, 300)}`, await hintPages());
  } else if (cfg.status === 200) {
    if (cfg.body.source && cfg.body.source.branch === SITE_BRANCH) {
      ok(`Pages 已指向 ${SITE_BRANCH}`);
    } else {
      const upd = await api(`/repos/${OWNER}/${REPO}/pages`, {
        method: 'PUT',
        body: { source: { branch: SITE_BRANCH, path: '/' } },
      });
      if (upd.status === 204 || upd.status === 200) ok(`Pages 已改指向 ${SITE_BRANCH}`);
      else die(`更新 Pages 失败（HTTP ${upd.status}）`, await hintPages());
    }
  } else {
    die(`查询 Pages 配置失败（HTTP ${cfg.status}）`, await hintPages());
  }

  // -- 6. 等待上线 -----------------------------------------------------------
  step(6, '等待上线');
  const deadline = Date.now() + 300_000;
  let live = false;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const r = await fetch(SITE_URL, { redirect: 'follow' });
      const body = await r.text();
      if (r.status === 200 && /<title>|id="app"/.test(body)) { live = true; break; }
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e.message.slice(0, 60);
    }
    process.stdout.write(C.dim(`    ${last}，重试…\r`));
    await sleep(5000);
  }
  if (live) {
    console.log(' '.repeat(60) + '\r');
    ok('站点已可访问');
  } else {
    console.log(' '.repeat(60) + '\r');
    info(`首次部署通常需要 1–3 分钟，当前尚未生效（${last}）`);
    info(`稍后手动打开：${SITE_URL}`);
  }

  console.log(C.bold('\n完成\n'));
  console.log(`  站点      ${SITE_URL}`);
  console.log(`  仓库      https://github.com/${OWNER}/${REPO}`);
  console.log(`  源码分支  ${SOURCE_BRANCH}`);
  console.log(`  站点分支  ${SITE_BRANCH}`);
  console.log(C.dim('\niPhone 安装：Safari 打开上面的站点 → 分享 → 添加到主屏幕\n'));
}

async function hintPages() {
  const who = await api('/user').catch(() => null);
  return (
    '排查建议：\n' +
    `  · 手动开启：https://github.com/${OWNER}/${REPO}/settings/pages\n` +
    '     Source 选 Deploy from a branch → Branch 选 gh-pages / (root) → Save\n' +
    `  · 确认 Token 有 Pages 权限（当前身份：${who && who.body && who.body.login ? who.body.login : '未知'}）`
  );
}

main().catch((e) => die(e.message));
