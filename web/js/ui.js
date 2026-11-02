/* ============================================================
   ui.js — 通用 UI 工具：DOM 助手 / toast / 底部弹层 / 格式化
   ============================================================ */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 创建元素 */
export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else node.setAttribute(k, v);
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' || typeof c === 'number'
      ? document.createTextNode(String(c))
      : c);
  }
  return node;
}

/** 转义 HTML */
export function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- 格式化 ---------------- */

export function fmtNum(v, digits = 2) {
  if (!isFinite(v)) return '--';
  return v.toFixed(digits);
}

export function fmtPct(v, digits = 2) {
  if (!isFinite(v)) return '--';
  const s = (v * 100).toFixed(digits);
  return (v > 0 ? '+' : '') + s + '%';
}

export function fmtPctRaw(v, digits = 2) {
  if (!isFinite(v)) return '--';
  return (v > 0 ? '+' : '') + v.toFixed(digits) + '%';
}

/** 金额：元 → 万/亿 */
export function fmtMoney(v, digits = 2) {
  if (!isFinite(v)) return '--';
  const abs = Math.abs(v);
  if (abs >= 1e8) return (v / 1e8).toFixed(digits) + '亿';
  if (abs >= 1e4) return (v / 1e4).toFixed(digits) + '万';
  return v.toFixed(0);
}

export function fmtInt(v) {
  if (!isFinite(v)) return '--';
  return Math.round(v).toLocaleString('zh-CN');
}

/** 涨跌 CSS 类 */
export function updown(v) {
  if (!isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

export function signCls(v) {
  if (!isFinite(v) || v === 0) return 'flat';
  return v > 0 ? 'up' : 'down';
}

/* ---------------- Toast ---------------- */

let toastTimer = null;
export function toast(msg, ms = 2200) {
  const node = $('#toast');
  if (!node) return;
  node.textContent = msg;
  node.classList.remove('hidden');
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.classList.add('hidden'), 220);
  }, ms);
}

/* ---------------- 底部弹层 ---------------- */

export function openSheet(contentNode, opt = {}) {
  const mask = $('#sheetMask');
  const box = $('#sheetContent');
  if (!mask || !box) return;
  box.innerHTML = '';
  if (typeof contentNode === 'string') box.innerHTML = contentNode;
  else box.append(contentNode);
  mask.classList.remove('hidden');
  requestAnimationFrame(() => mask.classList.add('show'));

  if (opt.onClose) {
    const handler = () => {
      mask.removeEventListener('click', onMask);
      opt.onClose();
    };
    const onMask = (e) => {
      if (e.target === mask) {
        closeSheet();
        handler();
      }
    };
    mask.addEventListener('click', onMask);
  }
}

export function closeSheet() {
  const mask = $('#sheetMask');
  if (!mask) return;
  mask.classList.remove('show');
  setTimeout(() => mask.classList.add('hidden'), 240);
}

/* ---------------- 复制到剪贴板 ---------------- */

export async function copyText(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) { /* fallthrough */ }

  // 兜底：textarea + execCommand（iOS Safari 需要）
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (e) {
    return false;
  }
}

/* ---------------- 骨架屏 ---------------- */

export function skeletonCards(n = 3) {
  const wrap = el('div', {});
  for (let i = 0; i < n; i++) {
    wrap.append(el('div', { class: 'skel skel-card', style: { padding: '16px' } }, [
      el('div', { class: 'skel skel-line', style: { width: '45%' } }),
      el('div', { class: 'skel skel-line', style: { width: '80%' } }),
      el('div', { class: 'skel skel-line', style: { width: '60%' } }),
    ]));
  }
  return wrap;
}

/* ---------------- 空状态 ---------------- */

export function emptyState(text, actionText, onAction) {
  const node = el('div', { class: 'empty' }, [
    el('div', { class: 'ic', html: '<svg viewBox="0 0 24 24" width="40" height="40"><path d="M3 13h4l3 7 4-16 3 9h4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' }),
    el('div', { class: 't', text }),
  ]);
  if (actionText && onAction) {
    node.append(el('button', {
      class: 'btn btn-primary btn-sm mt10',
      text: actionText,
      onclick: onAction,
    }));
  }
  return node;
}

/* ---------------- 错误框 ---------------- */

export function errorBox(msg, retry) {
  const node = el('div', { class: 'err-box' }, [
    el('div', { text: msg }),
  ]);
  if (retry) {
    node.append(el('button', {
      class: 'btn btn-ghost btn-sm mt6',
      text: '重试',
      onclick: retry,
    }));
  }
  return node;
}

/* ---------------- 进度条 ---------------- */

export function showProgress(pct, text) {
  const wrap = $('#progressWrap');
  const bar = $('#progressBar');
  const txt = $('#progressText');
  if (!wrap) return;
  wrap.classList.remove('hidden');
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  if (txt && text) txt.textContent = text;
}

export function hideProgress() {
  const wrap = $('#progressWrap');
  if (!wrap) return;
  setTimeout(() => wrap.classList.add('hidden'), 400);
}

/* ---------------- 开关 ---------------- */

export function switchRow(label, desc, checked, onChange) {
  let on = !!checked;
  const sw = el('button', { class: 'switch' + (on ? ' on' : ''), type: 'button', 'aria-label': label });
  sw.addEventListener('click', () => {
    on = !on;
    sw.classList.toggle('on', on);
    onChange(on);
  });
  return el('div', { class: 'switch-row' }, [
    el('div', {}, [
      el('div', { class: 'lbl', text: label }),
      desc ? el('div', { class: 'sub', text: desc }) : null,
    ]),
    sw,
  ]);
}

/* ---------------- 日期时间 ---------------- */

export function nowHHMMSS(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function fmtDuration(ms) {
  if (!isFinite(ms) || ms < 0) return '--';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + ' 秒';
  const m = Math.floor(s / 60);
  const ss = s % 60;
  return `${m} 分 ${ss} 秒`;
}

export function timeAgo(ts) {
  if (!ts) return '--';
  const d = Date.now() - ts;
  if (d < 60000) return '刚刚';
  if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前';
  if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前';
  return Math.floor(d / 86400000) + ' 天前';
}
