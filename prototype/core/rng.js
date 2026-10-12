/**
 * 可注入的随机源。
 *
 * 为什么不用 Math.random 直接调：引擎里的掷骰、抽气运、抽遭遇都必须**可复现**，
 * 否则回归测试无法断言。测试里传 makeRng(种子)，运行时传 defaultRng。
 * @module core/rng
 */

/** 默认随机源（真随机）。 */
export const defaultRng = () => Math.random();

/** mulberry32：小而稳的可复现伪随机。 */
export function makeRng(seed = 1) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [0, n) 内的整数。 */
export function randInt(rng, n) {
  return Math.floor(rng() * n);
}

/** 从数组里等概率取一个。 */
export function pick(rng, arr) {
  if (!arr || !arr.length) return undefined;
  return arr[randInt(rng, arr.length)];
}

/**
 * 按权重取一个。weights 与 items 等长。
 * 权重全为 0 时退化为等概率。
 */
export function pickWeighted(rng, items, weights) {
  if (!items || !items.length) return undefined;
  const total = weights.reduce((s, w) => s + Math.max(0, Number(w) || 0), 0);
  if (total <= 0) return pick(rng, items);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) {
    r -= Math.max(0, Number(weights[i]) || 0);
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

/**
 * 按累计概率表命中一档（如灵根品阶）。
 * @param {Array<{概率:number}>} tiers 概率之和应≈1；不足则按最后一档兜底
 */
export function pickByChance(rng, tiers) {
  const r = rng();
  let acc = 0;
  for (const t of tiers) {
    acc += Number(t.概率) || 0;
    if (r <= acc) return t;
  }
  return tiers[tiers.length - 1];
}
