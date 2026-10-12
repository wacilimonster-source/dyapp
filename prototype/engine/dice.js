/**
 * 判定：把"谁更强"变成一次可复现的掷骰。
 * @module engine/dice
 */

import { clamp } from '../core/clamp.js';
import { crossMajorRealm, dcTier, parseRealm } from './rules.js';

/**
 * 胜率。境界差是主导项，道心与灵力是修正项。
 * @param {{dcA:number, dcB:number, 道心?:number, 灵力?:number}} input
 */
export function winChance({ dcA, dcB, 道心 = 50, 灵力 = 50 }) {
  const diff = Number(dcB) - Number(dcA); // 正数=对手更高
  const raw = 50 - diff * 3 + (clamp(道心, 0, 100) - 50) * 0.3 + clamp(灵力, 0, 100) * 0.2;
  return clamp(raw / 100, 0.05, 0.92);
}

/**
 * 一次对拼。
 * @param {{a:{name:string,realm:string,dc:number,道心?:number,灵力?:number},
 *          b:{name:string,realm:string,dc:number}}} input
 * @param {() => number} rng
 */
export function rollDuel({ a, b }, rng) {
  const chance = winChance({ dcA: a.dc, dcB: b.dc, 道心: a.道心, 灵力: a.灵力 });
  const diff = Number(b.dc) - Number(a.dc);
  const aMajor = parseRealm(a.realm).major;
  const bMajor = parseRealm(b.realm).major;
  return {
    win: rng() < chance,
    chance,
    diff,
    tier: dcTier(diff),
    跨大境界: crossMajorRealm(bMajor, aMajor),
  };
}
