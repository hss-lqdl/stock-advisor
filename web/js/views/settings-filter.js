/* ============================================================
   views/settings-filter.js — 过滤条件编辑器（从 settings.js 拆出）
   ------------------------------------------------------------
   把 filters.js 的声明式规则渲染成「开关 + 可编辑阈值 + 可增删」的表单。
   任何改动都立即写回 settings.filterConfig 并触发重算（引擎侧只重算
   股票池与因子，不重新联网，因此是秒级生效）。
   ============================================================ */

import { el, toast } from '../ui.js';
import { settingsSave } from '../store.js';
import { STRATEGIES, strategyRules } from '../strategy.js';
import {
  FILTER_FIELDS, fieldsByGroup, OPS, opsForField, SPECIAL_RULES,
  ruleLabel, makeRule, resolveFilterConfig, serializeConfig,
  setRule, removeRule, countRules, clampFieldValue,
} from '../filters.js';

export const GROUP_LABEL = { snap: '快照字段', factor: 'K线因子', text: '文本字段' };

/**
 * 小号数字输入框：失焦/回车才提交，避免每敲一个字符就重算。
 * 传 range=[min,max] 时输入会被夹进这个区间，并回写到输入框。
 */
export function numInput(value, onCommit, ariaLabel, range) {
  const init = value === null || value === undefined ? '' : String(value);
  const inp = el('input', {
    class: 'input input-xs', type: 'number', inputmode: 'decimal',
    step: 'any', value: init, 'aria-label': ariaLabel || '',
    min: range ? String(range[0]) : null,
    max: range ? String(range[1]) : null,
    title: range ? `取值范围 ${range[0]} ~ ${range[1]}` : null,
  });
  inp.addEventListener('change', () => {
    let v = parseFloat(inp.value);
    if (!isFinite(v)) { inp.value = init; return; }
    if (range) {
      const clamped = Math.min(range[1], Math.max(range[0], v));
      if (clamped !== v) {
        toast(`取值需在 ${range[0]} ~ ${range[1]} 之间，已自动调整`);
        v = clamped;
      }
      inp.value = String(v);
    }
    onCommit(v);
  });
  return inp;
}

/** 一条规则的编辑控件：随 kind / field / op 变化 */
function ruleControls(rule, onPatch, onDelete) {
  const wrap = el('div', { class: 'rule-ctrl' });
  const locked = rule.kind === 'special'
    && SPECIAL_RULES[rule.special] && SPECIAL_RULES[rule.special].locked;

  if (rule.kind === 'field') {
    // 自定义规则可换字段；默认规则锁定字段，避免破坏既有语义
    if (rule.custom) {
      const fsel = el('select', { class: 'select select-xs', 'aria-label': '条件字段' });
      for (const grp of ['snap', 'factor', 'text']) {
        const g = el('optgroup', { label: GROUP_LABEL[grp] || grp });
        for (const f of fieldsByGroup(grp)) {
          const o = el('option', { value: f.key, text: f.label });
          if (f.key === rule.field) o.selected = true;
          g.append(o);
        }
        fsel.append(g);
      }
      fsel.addEventListener('change', () => {
        const ops = opsForField(fsel.value);
        const first = ops.length ? ops[0].key : '>=';
        const raw = (OPS[first] || {}).kind === 'text' ? '' : 1;
        onPatch({
          field: fsel.value,
          op: first,
          value: typeof raw === 'number' ? clampFieldValue(fsel.value, raw) : raw,
          value2: null,
        });
      });
      wrap.append(fsel);
    }

    const fld = FILTER_FIELDS[rule.field];
    const ops = opsForField(rule.field);
    if (ops.length > 1) {
      const osel = el('select', { class: 'select select-xs', 'aria-label': '运算符' });
      for (const o of ops) {
        const op = el('option', { value: o.key, text: o.label });
        if (o.key === rule.op) op.selected = true;
        osel.append(op);
      }
      osel.addEventListener('change', () => onPatch({
        op: osel.value,
        value2: osel.value === 'between' ? (rule.value2 == null ? rule.value : rule.value2) : null,
      }));
      wrap.append(osel);
    } else {
      wrap.append(el('span', { class: 'rule-op', text: (OPS[rule.op] || {}).label || rule.op }));
    }

    if (fld && fld.type === 'text') {
      const tin = el('input', {
        class: 'input input-xs grow', type: 'text',
        value: rule.value == null ? '' : String(rule.value), 'aria-label': '条件取值',
      });
      tin.addEventListener('change', () => onPatch({ value: tin.value }));
      wrap.append(tin);
    } else {
      // 数值字段带上下限：超范围会被夹回来，避免写出永远筛不出股票的阈值
      const range = fld && fld.type === 'num' ? [fld.min, fld.max] : null;
      const two = (OPS[rule.op] || {}).arity === 2;
      wrap.append(numInput(
        rule.value,
        (v) => onPatch(two
          ? { value: v, value2: Math.max(v, rule.value2 == null ? v : rule.value2) }
          : { value: v }),
        '阈值', range,
      ));
      if (two) {
        wrap.append(el('span', { class: 'rule-op', text: '~' }));
        wrap.append(numInput(
          rule.value2,
          (v) => onPatch({ value: v == null ? rule.value : Math.min(v, rule.value), value2: v }),
          '阈值上限', range,
        ));
      }
      if (fld && fld.unit) wrap.append(el('span', { class: 'rule-unit', text: fld.unit }));
      if (range) {
        wrap.append(el('span', { class: 'rule-range', text: `${range[0]}~${range[1]}` }));
      }
    }
  }

  if (locked) {
    wrap.append(el('span', { class: 'rule-unit', text: '必需' }));
  } else if (rule.custom && onDelete) {
    const del = el('button', { class: 'btn btn-ghost btn-xs rule-del', type: 'button', text: '删除' });
    del.addEventListener('click', () => onDelete());
    wrap.append(del);
  }
  return wrap;
}

/** 一行规则：开关 + 标签 + 编辑控件 */
function ruleRow(rule, labelCtx, onPatch, onDelete) {
  const locked = rule.kind === 'special'
    && SPECIAL_RULES[rule.special] && SPECIAL_RULES[rule.special].locked;
  const on = rule.on !== false;

  const sw = el('button', {
    class: 'switch' + (on ? ' on' : '') + (locked ? ' is-locked' : ''),
    type: 'button', 'aria-label': (on ? '停用' : '启用') + ruleLabel(rule, labelCtx),
    disabled: locked ? 'disabled' : null,
  });
  if (!locked) sw.addEventListener('click', () => onPatch({ on: !on }));

  return el('div', { class: 'rule-row' + (on ? '' : ' is-off') + (rule.custom ? ' is-custom' : '') }, [
    el('div', { class: 'rule-sw' }, [sw]),
    el('div', { class: 'rule-main' }, [
      el('div', { class: 'lbl', text: ruleLabel(rule, labelCtx) }),
      rule.custom ? el('div', { class: 'sub', text: '自定义条件' }) : null,
    ]),
    ruleControls(rule, onPatch, onDelete),
  ]);
}

/**
 * 构造「过滤条件设置」卡片。
 * @param {object} s 当前设置
 * @param {object} ctx 视图上下文（用 onAnalyze 触发重算）
 */
export function buildFilterEditorCard(s, ctx) {
  const work = resolveFilterConfig(s.filterConfig, s);
  const labelCtx = {
    budgetPerStock: (s.capital * 0.8) / Math.max(1, s.maxPicks),
    topN: work.mainline.topN,
  };
  let editKey = STRATEGIES[s.strategy] ? s.strategy : 'balanced';

  const card = el('div', { class: 'card settings-filter-editor' });
  const hd = el('div', { class: 'card-hd' });
  const body = el('div');
  card.append(hd, body);

  const commit = async () => {
    const scrollY = window.scrollY;
    const saved = serializeConfig(work);
    // 兼容旧字段：让「排除创业板」的旧开关状态与新规则保持一致
    const chi = (saved.base || []).find((r) => r.id === 'chiNext');
    await settingsSave({
      filterConfig: saved,
      excludeChiNext: chi ? chi.on !== false : s.excludeChiNext,
    });
    draw();
    window.scrollTo(0, scrollY);
    // 保存后立刻重建股票池并重算计划，保证今日买入计划用的是新条件 + 当前策略
    if (ctx.onAnalyze) await ctx.onAnalyze();
  };

  /** 生成某一份规则列表的编辑区 */
  const listBlock = (title, note, getList, setList, opts = {}) => {
    const box = el('div', { class: 'rule-sec' });
    box.append(el('div', { class: 'rule-sec-hd' }, [
      el('div', { class: 't', text: title }),
      note ? el('div', { class: 's', text: note }) : null,
    ]));
    const rows = el('div', { class: 'rule-rows' });
    for (const rule of getList()) {
      rows.append(ruleRow(
        rule,
        labelCtx,
        (patch) => { setList(setRule(getList(), rule.id, patch)); commit(); },
        rule.custom ? () => { setList(removeRule(getList(), rule.id)); commit(); } : null,
      ));
    }
    if (!getList().length) {
      rows.append(el('div', { class: 'dim tiny', text: '（该分组下暂无条件）' }));
    }
    box.append(rows);

    if (opts.addable) {
      const add = el('button', { class: 'btn btn-ghost btn-sm mt10', type: 'button', text: '＋ 添加自定义条件' });
      add.addEventListener('click', () => {
        setList(getList().concat([makeRule({ field: 'amount', op: '>=', value: 1 })]));
        commit();
      });
      box.append(add);
    }
    return box;
  };

  const draw = () => {
    const cnt = countRules(work);
    hd.innerHTML = '';
    hd.append(
      el('div', { class: 'card-title', text: '过滤条件设置' }),
      el('div', { class: 'card-sub', text: `已启用 ${cnt.on} / ${cnt.total} 项` }),
    );

    body.innerHTML = '';

    // 顶部：说明 + 恢复默认 + 策略选择器
    const bar = el('div', { class: 'rule-bar' });
    const reset = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '恢复默认' });
    reset.addEventListener('click', async () => {
      await settingsSave({ filterConfig: null, excludeChiNext: true });
      toast('过滤条件已恢复默认');
      if (ctx.onAnalyze) ctx.onAnalyze();
      else if (ctx.onReload) ctx.onReload();
    });
    const editSel = el('select', { class: 'select select-sm', 'aria-label': '要编辑哪个策略的过滤条件' });
    for (const [k, v] of Object.entries(STRATEGIES)) {
      const o = el('option', { value: k, text: v.name + (k === s.strategy ? '（当前）' : '') });
      if (k === editKey) o.selected = true;
      editSel.append(o);
    }
    editSel.addEventListener('change', () => { editKey = editSel.value; draw(); });
    bar.append(editSel, reset);
    body.append(bar);
    body.append(el('div', {
      class: 'dim tiny mt10',
      text: '每一道过滤条件都可以单独关闭或改阈值；五个策略各自拥有独立的专属门槛。'
        + '默认条件不能删除（只能关闭），自定义条件可以随时删除。改动即时生效。',
    }));

    // 1. 基础过滤
    body.append(listBlock(
      '基础过滤（所有策略共用）',
      '先在全市场里筛出可交易的股票池，五个策略共用这一步',
      () => work.base,
      (l) => { work.base = l; },
    ));

    // 2. 主线门槛
    const mlBox = el('div', { class: 'rule-sec' });
    mlBox.append(el('div', { class: 'rule-sec-hd' }, [
      el('div', { class: 't', text: '主线门槛（所有策略共用）' }),
      el('div', { class: 's', text: '只保留处在当前主线板块内的股票' }),
    ]));
    mlBox.append(el('div', { class: 'rule-row' }, [
      el('div', { class: 'rule-sw' }, [
        (() => {
          const on = work.mainline.on !== false;
          const sw = el('button', {
            class: 'switch' + (on ? ' on' : ''), type: 'button', 'aria-label': '启用主线门槛',
          });
          sw.addEventListener('click', () => { work.mainline.on = !on; commit(); });
          return sw;
        })(),
      ]),
      el('div', { class: 'rule-main' }, [
        el('div', { class: 'lbl', text: '必须属于主线板块' }),
      ]),
      el('div', { class: 'rule-ctrl' }, [
        el('span', { class: 'rule-op', text: 'Top' }),
        numInput(work.mainline.topN, (v) => { work.mainline.topN = Math.max(1, Math.round(v)); commit(); }, '主线 TopN'),
        el('span', { class: 'rule-unit', text: '个' }),
      ]),
    ]));
    mlBox.append(el('div', { class: 'rule-row' + (work.mainline.avoidBottom === false ? ' is-off' : '') }, [
      el('div', { class: 'rule-sw' }, [
        (() => {
          const on = work.mainline.avoidBottom !== false;
          const sw = el('button', {
            class: 'switch' + (on ? ' on' : ''), type: 'button', 'aria-label': '启用退潮剔除',
          });
          sw.addEventListener('click', () => { work.mainline.avoidBottom = !on; commit(); });
          return sw;
        })(),
      ]),
      el('div', { class: 'rule-main' }, [
        el('div', { class: 'lbl', text: '剔除退潮板块' }),
        el('div', { class: 'sub', text: '避开正在退潮的弱势板块' }),
      ]),
      el('div', { class: 'rule-ctrl' }, [
        el('span', { class: 'rule-op', text: '尾部' }),
        numInput(work.mainline.bottomN, (v) => { work.mainline.bottomN = Math.max(1, Math.round(v)); commit(); }, '退潮 TopN'),
        el('span', { class: 'rule-unit', text: '个' }),
      ]),
    ]));
    body.append(mlBox);

    // 3. 当前编辑策略的专属门槛
    const sr = strategyRules(editKey, work);
    const stName = STRATEGIES[editKey] ? STRATEGIES[editKey].name : editKey;
    body.append(listBlock(
      `${stName} · 快照门槛`,
      '只用实时行情就能判断的条件，在拉 K 线之前先筛一遍',
      () => work.strategies[editKey].stage1,
      (l) => { work.strategies[editKey].stage1 = l; },
      { addable: true },
    ));
    body.append(listBlock(
      `${stName} · 因子门槛`,
      '需要日 K 线才能计算的条件（动量、回撤、均线、龙头度等）',
      () => work.strategies[editKey].stage2,
      (l) => { work.strategies[editKey].stage2 = l; },
      { addable: true },
    ));
    void sr;
  };

  draw();
  return card;
}
