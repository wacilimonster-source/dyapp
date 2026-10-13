/**
 * 斗法结算：把"打不打得赢"变成一次可复现的掷骰。
 *
 * 原卡里战斗是模型裁量（只有 DC 查表推理，全卡没有 d100），所以这一整块
 * 属于独立版的**有意加强**：胜负与伤势由引擎定成硬事实，模型只写过程。
 * 沿用 `engine/dice.js` 的胜率公式（境界差主导、道心与灵力修正）与
 * `rules.js` 的 DC 压制阶梯 —— 与突破判定同一条路子，不另立一套数值。
 *
 * 自创项（卡里没有依据，如实标注）：
 *   - 对手从哪来：见 `pickAdversary` 的三级优先；
 *   - 对手境界的生成：按「危机程度」推，见 `inventAdversary`；
 *   - 伤势数字档位：见 `HURT`。
 * @module engine/combat
 */

import { clamp } from '../core/clamp.js';
import {
  REALM_ORDER, crisisLevel, parseRealm, realmIndex, realmLabel,
} from './rules.js';
import { rollDuel } from './dice.js';

/** 战斗意图关键词。命中即由引擎结算，不再让模型自己决定谁赢。 */
export const COMBAT_WORDS = [
  '出手', '攻击', '进攻', '斩杀', '击杀', '灭杀', '斗法', '激战', '恶战', '决战',
  '应战', '迎战', '围攻', '搏杀', '厮杀', '动手', '拔剑', '出剑', '一剑', '轰杀',
  '封印', '擒', '挑战', '干一架', '打起来', '战斗', '开打', '打他', '打她',
];

/** 判断一句话是不是战斗意图（点名在场人物 + 战斗词，或纯战斗词）。 */
export function isCombatIntent(text) {
  const t = String(text || '');
  return COMBAT_WORDS.some((w) => t.includes(w));
}

/** DC 差档位 → 落败时的伤势（生命）。档位来自 rules.js 的 DC_TIERS 顺序。 */
const HURT = [6, 8, 14, 22, 34, 45];
/** 获胜时的轻伤：随档位递增，但任何档位都必须轻于同档位落败。 */
const SCRATCH = [3, 4, 5, 6, 7, 8];

function tierIndex(dcTierObj) {
  const i = [2, 3, 6, 9, 15, Infinity].indexOf(dcTierObj?.max);
  return i < 0 ? 0 : i;
}

/** 把境界标签平移：majorShift 为大境界差，minor 为指定小境界层。 */
function realmNear(label, majorShift, minor) {
  const { major, minor: m } = parseRealm(label);
  const idx = clamp(realmIndex(major) + majorShift, 0, REALM_ORDER.length - 1);
  return realmLabel(REALM_ORDER[idx], minor == null ? m : minor);
}

/**
 * 挑一个对手。优先级：
 *   1. 玩家文本里点名的在场人物；
 *   2. 在场人物里关系最差的那个（好感 ≤ 20）；
 *   3. 按「危机程度」现编一个（危机越高，对手越强）。
 */
export function pickAdversary(state, text = '', rng = Math.random) {
  const mine = String(state?.主角?.境界 || '凡');
  const npcs = state?.人物 || {};
  const names = Object.keys(npcs);

  const named = names.find((n) => n && text.includes(n));
  if (named) {
    return { name: named, realm: npcs[named].境界 || mine, 来源: '在场人物（玩家点名）' };
  }
  const hostile = names
    .map((n) => ({ n, 好: Number(npcs[n].好感 ?? npcs[n].好感度 ?? 50) }))
    .filter((x) => x.好 <= 20)
    .sort((a, b) => a.好 - b.好)[0];
  if (hostile) {
    return { name: hostile.n, realm: npcs[hostile.n].境界 || mine, 来源: '在场人物（敌意最深）' };
  }
  return inventAdversary(state, mine, rng);
}

/** 现编对手：危机程度 无/低/中/高 → 对手比玩家弱一小境 / 同境 / 高一小境 / 高一大境。 */
export function inventAdversary(state, mine, rng = Math.random) {
  const lv = crisisLevel(state?.世界?.危机程度);
  const shift = [-1, -1, 0, 1][lv] ?? 0;
  const realm = shift < 0
    ? realmNear(mine, 0, Math.max(1, parseRealm(mine).minor - 1))
    : realmNear(mine, shift, shift > 0 ? 1 : undefined);
  const 名 = ['黑衣修士', '无名剑修', '山道劫匪', '来路不明的强者', '蒙面人'][Math.floor(rng() * 5) % 5];
  return { name: 名, realm, 来源: `按危机程度「${state?.世界?.危机程度 || '无'}」生成` };
}

/**
 * 一次斗法结算。
 * @returns {{hints:string[], effects:object[], duel:object}}
 */
export function resolveDuel({ state, text = '', rng = Math.random }) {
  const P = state.主角;
  const foe = pickAdversary(state, text, rng);
  const mine = String(P.境界 || '凡');
  const dcA = Number(P.境界DC ?? parseRealm(mine).dc);
  const dcB = parseRealm(foe.realm).dc;

  const r = rollDuel({
    a: { name: P.姓名, realm: mine, dc: dcA, 道心: P.道心, 灵力: P.灵力 },
    b: { name: foe.name, realm: foe.realm, dc: dcB },
  }, rng);
  const ti = tierIndex(r.tier);
  const effects = [
    { op: 'delta', target: '主角.灵力', value: -18, reason: '斗法消耗' },
  ];
  if (r.win) {
    effects.push({ op: 'delta', target: '主角.生命', value: -SCRATCH[Math.min(ti, SCRATCH.length - 1)], reason: '斗法轻伤' });
    effects.push({ op: 'delta', target: '主角.修为', value: 6, reason: '战斗中悟道' });
  } else {
    effects.push({ op: 'delta', target: '主角.生命', value: -HURT[Math.min(ti, HURT.length - 1)], reason: '斗法受创' });
    if (Math.abs(r.跨大境界) >= 1 && r.diff > 0) {
      // 卡内「不可逆伤害律」：跨大境界碾压时伤到本源，精血一并掉
      effects.push({ op: 'delta', target: '主角.精血', value: -6, reason: '不可逆伤害律' });
    }
  }
  const 器物 = Object.keys(P.器物 || {})[0];
  if (器物) effects.push({ op: 'delta', target: `主角.器物.${器物}.损耗度`, value: 12, reason: '斗法损耗' });

  const hints = [
    `斗法结算：对手「${foe.name}」（${foe.realm}，来源：${foe.来源}）。`
    + `DC ${dcA} 对 ${dcB}，差 ${r.diff}，压制档位「${r.tier.desc}」，胜率 ${(r.chance * 100).toFixed(0)}%。`
    + `引擎已判定：本战「${r.win ? '胜' : '负'}」。请照这个结果写过程与伤势，不要改胜负、不要改数字。`,
  ];
  if (Math.abs(r.跨大境界) >= 1) {
    hints.push(`跨大境界差 ${r.跨大境界}：${r.diff > 0 ? '你以弱击强，对方境界压人' : '你境界压人，对方难以正面抗衡'}。`);
  }
  return {
    hints,
    effects,
    duel: {
      win: r.win, chance: r.chance, diff: r.diff, tier: r.tier,
      opponentName: foe.name, opponentRealm: foe.realm, 来源: foe.来源,
    },
  };
}
