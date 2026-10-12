/**
 * 宏渲染：把 ST 预设里的 `{{...}}` 换成真实内容。
 *
 * 支持面参考掌上酒馆的 macros 层（char/user/persona/personality/description/
 * scenario/time/date/newline/pick/noop），外加 `random` 与 `roll`。
 *
 * **已确认的决策 D5：`{{random}}` 与 `{{roll}}` 用真随机**（贴 ST 行为）。
 * 代价是提示词单测不能断言随机宏的具体取值——只断言"宏被替换掉了"。
 *
 * **未知宏一律原样保留 + 告警**，绝不静默清空：用户换了预设却看不出为什么，最难排查。
 * @module preset/macros
 */

const RE_MACRO = /\{\{([^{}]*)\}\}/g;

/** 无参宏 → 取上下文里的值。 */
const SIMPLE = {
  char: (c) => c.charName,
  user: (c) => c.userName,
  persona: (c) => c.persona,
  description: (c) => c.description,
  personality: (c) => c.personality,
  scenario: (c) => c.scenario,
  time: (c) => c.time,
  date: (c) => c.date,
  input: (c) => c.input,
  newline: () => '\n',
  noop: () => '',
  trim: () => '',
};

/** 带参宏：`{{random a,b,c}}` / `{{pick a::b::c}}` / `{{roll 1d6}}`。 */
const WITH_ARGS = {
  random: (args, rng) => (args.length ? args[Math.floor(rng() * args.length)] : ''),
  pick: (args, rng) => (args.length ? args[Math.floor(rng() * args.length)] : ''),
  roll: (args, rng) => rollDice(String(args[0] || '1d6'), rng),
};

/** 把参数按 ST 的两种分隔符切开：逗号或 `::`。 */
export function splitArgs(rest) {
  const s = String(rest || '').trim();
  if (!s) return [];
  const parts = s.includes('::') ? s.split('::') : s.split(',');
  return parts.map((p) => p.trim()).filter((p) => p !== '');
}

/** `NdM` 掷骰，返回数字字符串。非法表达式原样返回。 */
export function rollDice(expr, rng = Math.random) {
  const m = /^(\d*)d(\d+)$/i.exec(expr.trim());
  if (!m) return expr;
  const n = m[1] === '' ? 1 : Math.max(1, Math.min(100, parseInt(m[1], 10)));
  const faces = Math.max(2, Math.min(1000, parseInt(m[2], 10)));
  let sum = 0;
  for (let i = 0; i < n; i++) sum += 1 + Math.floor(rng() * faces);
  return String(sum);
}

/**
 * 渲染一段文本里的所有宏。
 * @param {string} text
 * @param {object} ctx 上下文（charName/userName/persona/description/personality/scenario/time/date/input）
 * @param {{rng?:() => number}} [opts]
 * @returns {{text:string, warnings:string[], used:string[]}}
 */
export function renderMacros(text, ctx = {}, opts = {}) {
  const rng = opts.rng || Math.random;
  const warnings = [];
  const used = [];
  const unknown = new Set();

  const out = String(text == null ? '' : text).replace(RE_MACRO, (whole, body) => {
    const raw = String(body || '').trim();
    if (!raw) return whole;

    // 带参形式：`name rest`
    const sp = raw.search(/\s/);
    const name = (sp < 0 ? raw : raw.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : raw.slice(sp + 1);

    if (Object.prototype.hasOwnProperty.call(WITH_ARGS, name)) {
      used.push(name);
      return WITH_ARGS[name](splitArgs(rest), rng);
    }
    if (Object.prototype.hasOwnProperty.call(SIMPLE, name) && sp < 0) {
      used.push(name);
      const v = SIMPLE[name](ctx);
      return v == null ? '' : String(v);
    }
    // 未知宏：原样保留，只告警一次
    if (!unknown.has(name)) {
      unknown.add(name);
      warnings.push(`预设使用了本应用未实现的宏 {{${name}}}，已按原文保留`);
    }
    return whole;
  });

  return { text: out, warnings, used: [...new Set(used)] };
}

/** 供 UI 展示：本应用实现了哪些宏。 */
export const SUPPORTED_MACROS = [
  ...Object.keys(SIMPLE).map((k) => `{{${k}}}`),
  '{{random a,b,c}}', '{{pick a,b,c}}', '{{roll 1d6}}',
];
