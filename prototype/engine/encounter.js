/**
 * 动态遭遇。复刻卡内逻辑：
 *   遭遇冷却 > 0 → 每回合 −1，禁止偶遇；
 *   遭遇冷却 = 0 → 按「玩家境界 × 场景」抽候选，然后重置冷却。
 * @module engine/encounter
 */

import { COOLDOWN_MAX } from '../core/clamp.js';
import { pickWeighted } from '../core/rng.js';
import { realmIndex, parseRealm } from './rules.js';

const OUTDOOR_HINTS = /山|林|野|原|谷|镇|城|坊|路|道|岭|川|海|泽|滩|郊|外|野渡|码头|街/;
const INDOOR_HINTS = /楼|阁|殿|堂|室|府|宅|洞|窟|宫|塔|院|坊市|酒馆|客栈|铺|屋/;

/**
 * 室内 / 室外 / 未知。
 *
 * 关键：地名字符串往往带层级（"青石镇 · 醉仙楼"），此时**最具体的那一段**才决定类别
 * ——"镇"是室外泛指，但玩家实际身处"醉仙楼"内。所以先取最后一段判断，再退回全串。
 */
export function sceneClass(place) {
  const whole = String(place || '').trim();
  if (!whole) return 'unknown';
  const parts = whole.split(/[·•/／,，>＞\-—]/).map((s) => s.trim()).filter(Boolean);
  const specific = parts.length ? parts[parts.length - 1] : whole;
  const bySpecific = classifyOne(specific);
  return bySpecific !== 'unknown' ? bySpecific : classifyOne(whole);
}

function classifyOne(s) {
  if (!s) return 'unknown';
  const indoor = INDOOR_HINTS.test(s);
  const outdoor = OUTDOOR_HINTS.test(s);
  // 同一段里两种提示都命中时偏向"室内"：能同时写进一处的，通常是具体建筑（山中小楼）
  if (indoor) return 'indoor';
  if (outdoor) return 'outdoor';
  return 'unknown';
}

/**
 * 推进冷却。返回本回合是否**触发**遭遇，以及新的冷却值。
 * @param {object} world
 * @param {{reset?:number}} [opts]
 */
export function tick(world, opts = {}) {
  const reset = Number.isFinite(opts.reset) ? opts.reset : 6;
  const cur = Number(world?.遭遇冷却) || 0;
  if (cur > 0) {
    world.遭遇冷却 = Math.max(0, cur - 1);
    // 归零的这一回合不触发，下一回合才轮到偶遇——避免"冷却刚清零就必遇"
    return { fired: false, cooldown: world.遭遇冷却, armed: world.遭遇冷却 === 0 };
  }
  world.遭遇冷却 = Math.min(COOLDOWN_MAX, reset);
  return { fired: true, cooldown: world.遭遇冷却, armed: false };
}

/**
 * 从世界书候选里抽一个 NPC 条目。
 *
 * 权重体现卡内规则：**高阶人物更少出现**，与玩家同阶/低阶更多。
 * @param {Array<{title:string,name:string,category:string,realm:string}>} entries
 * @param {{realm:string, scene:string}} ctx
 * @param {() => number} rng
 */
export function pickCandidate(entries, ctx, rng) {
  const pool = (entries || []).filter(
    (e) => e && e.category === '人物' && !e.constant && !/生成规则/.test(e.title || ''),
  );
  if (!pool.length) return undefined;

  const playerIdx = realmIndex(parseRealm(ctx?.realm).major);
  const weights = pool.map((e) => {
    const m = String(e.title || '').match(/(炼气|筑基|金丹|元婴|化神|炼虚|合体|大乘|渡劫|真仙|金仙|玄仙|仙帝)/);
    if (!m) return 1;
    // 必须复用 parseRealm：大境界是「真仙境」「金仙境」这种带"境"的，
    // 手工拼"期"会得到「真仙期」→ indexOf 落空 → 权重全乱。
    const idx = realmIndex(parseRealm(m[1]).major);
    const gap = idx - playerIdx;
    if (gap >= 4) return 0.15; // 远高于玩家：极罕见
    if (gap >= 1) return 0.6;  // 略高：少见
    if (gap === 0) return 1.2; // 同阶：常见
    return 1.0;                // 低阶：正常
  });

  return pickWeighted(rng, pool, weights);
}
