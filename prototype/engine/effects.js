/**
 * 效果落地：把模型输出的**语义 effect** 变成真实的 GameState 变更。
 *
 * 协议（docs/附录B）：`{ op:'set'|'delta'|'add'|'remove', target:'主角.灵力', value, reason? }`
 *
 * 三条硬规则：
 * 1. **不抛异常**——一条坏数据不能毁掉整回合，只记日志并跳过；
 * 2. **必经 clamp**——任何数值写入都过 clampField；
 * 3. **冻结字段不可改**——如 道侣/NPC 的「性格」，首次写入后冻结。
 * @module engine/effects
 */

import { clampField, isPercentField } from '../core/clamp.js';
import { FROZEN_KEYS, freeze, isFrozen, normalize } from './state.js';
import { parseRealm, realmLabel, realmDC } from './rules.js';

const OPS = new Set(['set', 'delta', 'add', 'remove']);

/**
 * 解析扁平点路径。
 * @returns {{ok:boolean, obj?:object, key?:string, parentPath?:string, error?:string}}
 */
export function resolvePath(state, path, { create = true } = {}) {
  if (typeof path !== 'string' || !path.trim()) return { ok: false, error: '空的 target' };
  const clean = path.trim().replace(/^\.+|\.+$/g, '');
  if (clean.includes('..')) return { ok: false, error: 'target 含连续点' };
  // 拒绝原型污染
  if (/(^|\.)(__proto__|constructor|prototype)(\.|$)/.test(clean)) {
    return { ok: false, error: 'target 含非法键' };
  }
  const parts = clean.split('.');
  if (parts.length < 2) return { ok: false, error: 'target 至少要有两段（如 主角.灵力）' };

  let obj = state;
  for (let i = 0; i < parts.length - 1; i++) {
    const seg = parts[i];
    if (obj[seg] === undefined || obj[seg] === null) {
      if (!create) return { ok: false, error: `路径不存在：${parts.slice(0, i + 1).join('.')}` };
      obj[seg] = {};
    }
    if (typeof obj[seg] !== 'object') {
      return { ok: false, error: `路径中段不是对象：${parts.slice(0, i + 1).join('.')}` };
    }
    obj = obj[seg];
  }
  const key = parts[parts.length - 1];
  return { ok: true, obj, key, parentPath: parts.slice(0, -1).join('.') };
}

/**
 * 落地单条 effect。
 * @param {object} state
 * @param {{op:string,target:string,value?:unknown,reason?:string}} effect
 * @returns {{ok:boolean, event?:object, log?:string}}
 */
export function applyEffect(state, effect) {
  if (!effect || typeof effect !== 'object') return { ok: false, log: 'effect 不是对象' };
  const op = String(effect.op || '');
  if (!OPS.has(op)) return { ok: false, log: `未知 op：${op}` };

  const { ok, obj, key, parentPath, error } = resolvePath(state, effect.target, {
    create: op !== 'delta' && op !== 'remove',
  });
  if (!ok) return { ok: false, log: `${effect.target}：${error}` };

  const path = `${parentPath}.${key}`;

  if (op === 'remove') {
    if (!(key in obj)) return { ok: false, log: `remove 目标不存在：${path}` };
    delete obj[key];
    return { ok: true, event: { kind: 'remove', path } };
  }

  if (FROZEN_KEYS.has(key) && isFrozen(state, path)) {
    return { ok: false, log: `「${path}」已冻结，拒绝改写` };
  }

  if (op === 'delta') {
    const d = Number(effect.value);
    if (!Number.isFinite(d)) return { ok: false, log: `${path}：delta 的值不是有限数` };
    // 境界与境界DC 只能由引擎结算（set 境界 会查表联动 DC）。
    // 校验必须在**写入之前**：原先先写后判，境界会被静默覆盖成数字再归一成「凡」。
    if (key === '境界' || key === '境界DC') {
      return { ok: false, log: `${path}：${key} 不能用 delta（境界由引擎结算）` };
    }
    const before = Number(obj[key]);
    const base = Number.isFinite(before) ? before : 0;
    const after = clampField(key, base + d, base);
    obj[key] = after;
    return {
      ok: true,
      event: { kind: isPercentField(key) ? 'float' : 'change', path, key, delta: after - base, value: after },
    };
  }

  if (op === 'set') {
    const value = effect.value;
    if (key === '境界DC') {
      // 引擎在 set 境界 时按境界表生成 DC；直接写会写出与境界不符的数字
      return { ok: false, log: `${path}：境界DC 由引擎按境界查表生成，不接受直接写入` };
    }
    if (key === '境界') {
      const parsed = parseRealm(String(value));
      obj[key] = realmLabel(parsed.major, parsed.minor);
      // 境界与 DC 必须同步：DC 由引擎查表生成，不接受模型给的数字
      if (obj === state.主角) state.主角.境界DC = realmDC(parsed.major, parsed.minor);
      return { ok: true, event: { kind: 'realm', path, value: obj[key], dc: realmDC(parsed.major, parsed.minor) } };
    }
    const next = typeof value === 'number' ? clampField(key, value, 0) : value;
    obj[key] = next;
    if (FROZEN_KEYS.has(key)) freeze(state, path);
    return { ok: true, event: { kind: 'set', path, key, value: next } };
  }

  // op === 'add'：新增条目（通常是对象或数组元素）
  const existed = key in obj;
  obj[key] = effect.value;
  if (FROZEN_KEYS.has(key)) freeze(state, path);
  // 新增人物/道侣/灵宠时，把内层冻结字段也标记上，避免下一回合被改写
  if (parentPath && /^(人物|道侣|灵宠)$/.test(parentPath) && !existed) {
    for (const fk of FROZEN_KEYS) {
      if (obj[key] && typeof obj[key] === 'object' && fk in obj[key]) freeze(state, `${path}.${fk}`);
    }
  }
  return { ok: true, event: { kind: existed ? 'replace' : 'add', path, key } };
}

/**
 * 批量落地 + 统一归一化。
 * @param {object} state
 * @param {Array} effects
 * @returns {{applied:number, skipped:number, events:Array, logs:string[]}}
 */
export function applyAll(state, effects) {
  const events = [];
  const logs = [];
  let applied = 0;
  let skipped = 0;

  for (const e of Array.isArray(effects) ? effects : []) {
    const r = applyEffect(state, e);
    if (r.ok) {
      applied++;
      if (r.event) events.push(r.event);
    } else {
      skipped++;
      logs.push(r.log || `${e?.target}: 落地失败`);
    }
  }

  normalize(state);
  if (logs.length) state.$log = [...(state.$log || []), ...logs].slice(-200);
  return { applied, skipped, events, logs };
}
