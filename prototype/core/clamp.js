/**
 * 数值守卫。所有写入 GameState 的数值都必须过这里。
 * @module core/clamp
 */

/** 百分比区间字段（0–100）。 */
export const PCT_MIN = 0;
export const PCT_MAX = 100;

/** 遭遇冷却上限（卡内设定）。 */
export const COOLDOWN_MAX = 15;

/** 字段 → 上限。未列出的按 [0,100] 处理。 */
const CEILINGS = Object.freeze({
  遭遇冷却: COOLDOWN_MAX,
  宗门贡献: Number.MAX_SAFE_INTEGER,
  数量: Number.MAX_SAFE_INTEGER,
  熟练度: PCT_MAX,
  成功率: PCT_MAX,
  损耗度: PCT_MAX,
  好感: PCT_MAX,
  好感度: PCT_MAX,
  亲密: PCT_MAX,
  亲密度: PCT_MAX,
  生命: PCT_MAX,
  精血: PCT_MAX,
  灵力: PCT_MAX,
  修为: PCT_MAX,
  神识: PCT_MAX,
  道心: PCT_MAX,
});

export function clamp(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return n < min ? min : n > max ? max : n;
}

/**
 * 按字段名把数值夹进合法区间。字段未知则按 [0,100]。
 * @param {string} key 末级字段名
 * @param {unknown} value
 * @param {unknown} [fallback=0] 非数值时的兜底
 */
export function clampField(key, value, fallback = 0) {
  const max = CEILINGS[key];
  if (max === Number.MAX_SAFE_INTEGER) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.round(n)) : fallback;
  }
  const upper = typeof max === 'number' ? max : PCT_MAX;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, PCT_MIN, upper);
}

/** 是否为百分比字段（用于 UI 判断，如是否画进度条）。 */
export function isPercentField(key) {
  return Object.prototype.hasOwnProperty.call(CEILINGS, key) && CEILINGS[key] === PCT_MAX;
}
