/**
 * 解析模型的裁决结果。**容错优先**：坏条目丢弃、好条目保留，绝不因为一条脏数据放弃整回合。
 * @module narrator/parse
 */

const OPS = new Set(['set', 'delta', 'add', 'remove']);
const SCENE_KEYS = ['当前时间', '当前地点', '危机程度', '天气', '灵气'];
const CRISIS = new Set(['无', '低', '中', '高']);
const MAX_CHOICES = 4;
const MAX_CHOICE_LEN = 40;

/** 从文本里剥出 JSON（兼容 ```json 围栏与前后废话）。 */
export function extractJson(text) {
  if (text && typeof text === 'object') return text;
  const s = String(text == null ? '' : text).trim();
  if (!s) return null;
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1].trim() : s;
  try { return JSON.parse(body); } catch { /* 继续尝试截取 */ }
  const first = body.indexOf('{');
  const last = body.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(body.slice(first, last + 1)); } catch { return null; }
  }
  return null;
}

/**
 * 校验单条 effect。
 * @returns {{ok:true, effect:object} | {ok:false, log:string}}
 */
export function validateEffect(e, i = 0) {
  if (!e || typeof e !== 'object' || Array.isArray(e)) return { ok: false, log: `effects[${i}] 不是对象` };
  const op = String(e.op || '');
  if (!OPS.has(op)) return { ok: false, log: `effects[${i}].op 非法：${op}` };
  const target = e.target;
  if (typeof target !== 'string' || !target.trim()) return { ok: false, log: `effects[${i}].target 缺失` };
  if (op === 'delta' && !Number.isFinite(Number(e.value))) {
    return { ok: false, log: `effects[${i}] delta 的值不是有限数` };
  }
  const effect = { op, target: target.trim() };
  if (op !== 'remove') effect.value = e.value;
  if (typeof e.reason === 'string' && e.reason.trim()) effect.reason = e.reason.trim().slice(0, 60);
  return { ok: true, effect };
}

/**
 * 解析一整个裁决结果。
 * @param {unknown} raw 模型返回（对象或字符串）
 * @returns {{effects:Array, scene:object, choices:string[], logs:string[]}}
 */
export function parseTurnResult(raw) {
  const logs = [];
  const value = extractJson(raw);
  if (!value || typeof value !== 'object') {
    return { effects: [], scene: {}, choices: [], logs: ['裁决结果不是合法 JSON，本次状态未更新'] };
  }

  const effects = [];
  const list = Array.isArray(value.effects) ? value.effects : [];
  if (!Array.isArray(value.effects) && value.effects !== undefined) logs.push('effects 不是数组，已忽略');
  for (let i = 0; i < list.length; i++) {
    const r = validateEffect(list[i], i);
    if (r.ok) effects.push(r.effect);
    else logs.push(r.log);
  }
  if (effects.length > 40) {
    logs.push(`effects 过多（${effects.length}），只保留前 40 条`);
    effects.length = 40;
  }

  const scene = {};
  if (value.scene && typeof value.scene === 'object' && !Array.isArray(value.scene)) {
    for (const k of SCENE_KEYS) {
      const v = value.scene[k];
      if (typeof v !== 'string' || !v.trim()) continue;
      const s = v.trim().slice(0, 40);
      if (k === '危机程度' && !CRISIS.has(s)) { logs.push(`危机程度取值非法：${s}`); continue; }
      scene[k] = s;
    }
  }

  const choices = [];
  if (Array.isArray(value.choices)) {
    for (const c of value.choices) {
      if (typeof c !== 'string') continue;
      const s = c.trim();
      if (!s) continue;
      choices.push(s.length > MAX_CHOICE_LEN ? s.slice(0, MAX_CHOICE_LEN) : s);
      if (choices.length >= MAX_CHOICES) break;
    }
  }

  return { effects, scene, choices, logs };
}

/** 只取正文：模型有时会把正文塞在 narrative/text/content 任一字段。 */
export function pickNarrative(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const k of ['narrative', 'text', 'content', 'story']) {
    if (typeof value[k] === 'string' && value[k].trim()) return value[k];
  }
  return '';
}
