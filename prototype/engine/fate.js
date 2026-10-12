/**
 * 抽取类机制：灵根品阶、气运、真·气运。
 * @module engine/fate
 */

import { pickByChance, pickWeighted } from '../core/rng.js';
import { ROOT_TIERS } from './rules.js';

/** 抽灵根品阶（天 1% / 地 4% / 玄 15% / 黄 35% / 凡 45%）。 */
export function drawRoot(rng) {
  return pickByChance(rng, ROOT_TIERS);
}

/**
 * 从气运池里抽 n 条不重复的。
 * @param {Array<{name:string,向:string,desc:string,weight?:number}>} pool
 */
export function drawLuck(rng, pool, n = 1, filter = null) {
  const candidates = (pool || []).filter((l) => l && (!filter || filter(l)));
  const out = [];
  const used = new Set();
  let guard = 0;
  while (out.length < n && guard++ < 200) {
    const rest = candidates.filter((l) => !used.has(l.name));
    if (!rest.length) break;
    const picked = pickWeighted(rng, rest, rest.map((l) => l.weight ?? 1));
    used.add(picked.name);
    out.push(picked);
  }
  return out;
}

/** 真·气运：把普通气运升格，概率由调用方决定（卡内为 5%）。 */
export function toTrueLuck(name) {
  const n = String(name || '');
  return n.startsWith('真·') ? n : `真·${n}`;
}

/** 判断一次"真·气运"抽取是否命中。 */
export function hitTrueLuck(rng, chance = 0.05) {
  return rng() < chance;
}
