/* ============================================================
   stock-charts.js — 个股详情里的日 K / 分时图表组件
   ============================================================ */

import { el } from './ui.js';
import { drawKline, drawMinuteLine } from './charts.js';

export function createStockCharts(opt = {}) {
  const root = el('div', { class: 'stock-charts' });
  const tabs = el('div', { class: 'chart-tabs', role: 'tablist', 'aria-label': '走势周期' });
  const dailyPanel = el('div', { class: 'stock-chart-panel', role: 'tabpanel' });
  const minutePanel = el('div', {
    class: 'stock-chart-panel',
    role: 'tabpanel',
    style: { display: 'none' },
  });
  const dailyButton = el('button', {
    class: 'chart-tab active',
    type: 'button',
    role: 'tab',
    'aria-selected': 'true',
    text: '日K',
  });
  const minuteButton = el('button', {
    class: 'chart-tab',
    type: 'button',
    role: 'tab',
    'aria-selected': 'false',
    text: '分时',
  });
  const minuteCanvas = el('canvas', { class: 'minute-chart' });
  const minuteStatus = el('div', {
    class: 'chart-status',
    role: 'status',
    text: '正在获取最新分时…',
  });
  const refreshButton = el('button', {
    class: 'btn btn-ghost btn-sm',
    type: 'button',
    text: '刷新分时',
  });

  let minuteKline = null;
  let refreshing = false;
  let disposed = false;

  const drawMinute = () => {
    if (!minuteKline || !minutePanel.isConnected) return;
    try {
      drawMinuteLine(minuteCanvas, minuteKline, {
        bars: 240,
        height: 190,
        prevClose: opt.prevClose,
      });
    } catch (e) {
      console.error('绘制分时图失败', e);
    }
  };

  const selectChart = (period) => {
    const minute = period === 'minute';
    dailyPanel.style.display = minute ? 'none' : '';
    minutePanel.style.display = minute ? '' : 'none';
    dailyButton.classList.toggle('active', !minute);
    minuteButton.classList.toggle('active', minute);
    dailyButton.setAttribute('aria-selected', String(!minute));
    minuteButton.setAttribute('aria-selected', String(minute));
    if (minute) drawMinute();
  };
  dailyButton.addEventListener('click', () => selectChart('daily'));
  minuteButton.addEventListener('click', () => selectChart('minute'));
  tabs.append(dailyButton, minuteButton);

  if (opt.dailyKline && opt.dailyKline.n) {
    const dailyCanvas = el('canvas', { class: 'daily-chart' });
    dailyPanel.append(
      el('div', { class: 'chart-caption', text: '日 K 线 · MA5 / MA20' }),
      el('div', { class: 'chart-box' }, [dailyCanvas]),
    );
    requestAnimationFrame(() => {
      if (!dailyPanel.isConnected) return;
      try { drawKline(dailyCanvas, opt.dailyKline, { bars: 90, height: 210 }); }
      catch (e) { console.error(e); }
    });
  } else {
    dailyPanel.append(el('div', { class: 'chart-status', text: '暂无日 K 数据' }));
  }

  const refresh = async () => {
    if (refreshing || disposed || !root.isConnected) return;
    refreshing = true;
    refreshButton.disabled = true;
    minuteStatus.textContent = minuteKline ? '正在更新分时…' : '正在获取最新分时…';
    try {
      const result = await opt.loadMinute();
      if (!result || !result.n || !result.dates) throw new Error('分钟 K 线数据为空');
      minuteKline = result;
      if (!minutePanel.isConnected) return;
      minuteStatus.textContent =
        `更新于 ${new Date().toLocaleTimeString('zh-CN')} · 最新 ${minuteKline.dates[minuteKline.n - 1]}`;
      if (minutePanel.style.display !== 'none') drawMinute();
    } catch (e) {
      if (minutePanel.isConnected) {
        minuteStatus.textContent =
          `分时加载失败：${e && e.message ? e.message : String(e)}，可点击「刷新分时」重试`;
      }
    } finally {
      refreshing = false;
      refreshButton.disabled = false;
    }
  };
  refreshButton.addEventListener('click', refresh);

  minutePanel.append(
    el('div', { class: 'chart-caption' }, [
      el('span', { text: '1 分钟走势 · 盘中约每分钟自动更新' }),
      refreshButton,
    ]),
    minuteStatus,
    el('div', { class: 'chart-box' }, [minuteCanvas]),
  );
  root.append(tabs, dailyPanel, minutePanel);

  const timer = setInterval(() => {
    if (disposed) return;
    if (!root.isConnected) {
      dispose();
      return;
    }
    if (!opt.canAutoRefresh || opt.canAutoRefresh()) refresh();
  }, opt.refreshIntervalMs || 60000);

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(timer);
  };

  return {
    element: root,
    refresh,
    dispose,
  };
}
