/**
 * 成就：全部由引擎从状态里判定，不依赖模型。
 *
 * 结构：每条成就一个 `test(state)` 纯函数；已解锁的记录在 `state.$成就[id]`。
 * 每回合落地后由界面调用一次 `evaluateAchievements`，返回本次**新解锁**的列表。
 * @module engine/achievements
 */

import { parseRealm, realmIndex } from './rules.js';

const majorAtLeast = (state, major) =>
  realmIndex(parseRealm(state?.主角?.境界).major) >= realmIndex(major);

const count = (obj) => Object.keys(obj || {}).length;

export const ACHIEVEMENTS = Object.freeze([
  {
    id: 'breakthrough',
    name: '破·瓶颈',
    desc: '首次突破成功',
    test: (s) => (s.$统计?.突破成功 || 0) >= 1,
  },
  {
    id: 'zhuji',
    name: '登堂入室',
    desc: '境界达到筑基期',
    test: (s) => majorAtLeast(s, '筑基期'),
  },
  {
    id: 'jindan',
    name: '金丹大道',
    desc: '境界达到金丹期',
    test: (s) => majorAtLeast(s, '金丹期'),
  },
  {
    id: 'daolv',
    name: '道侣天成',
    desc: '结下一段道侣之缘',
    test: (s) => count(s.道侣) > 0,
  },
  {
    id: 'lingchong',
    name: '灵宠相伴',
    desc: '收获一只灵宠',
    test: (s) => count(s.灵宠) > 0,
  },
  {
    id: 'renyuan',
    name: '人脉初成',
    desc: '结识五位修士',
    test: (s) => count(s.人物) >= 5,
  },
  {
    id: 'fujia',
    name: '富甲一方',
    desc: '下品灵石积累到 100 枚',
    test: (s) => Number(s.主角?.储物袋?.['下品灵石']?.数量) >= 100,
  },
  {
    id: 'shibai',
    name: '百折不回',
    desc: '经历一百个回合',
    test: (s) => (s.$统计?.回合数 || 0) >= 100,
  },
]);

/**
 * 结算一次成就判定。
 * @param {object} state
 * @param {{kind?:string, duel?:{win:boolean}|null}} [ctx] 本回合信息（突破成败计数）
 * @returns {Array<{id:string,name:string,desc:string}>} 本次新解锁
 */
export function evaluateAchievements(state, ctx = {}) {
  if (!state.$统计) state.$统计 = { 回合数: 0, 突破成功: 0, 突破失败: 0 };
  if (!state.$成就) state.$成就 = {};

  if (ctx.kind === 'breakthrough' && ctx.duel) {
    if (ctx.duel.win) state.$统计.突破成功 = (state.$统计.突破成功 || 0) + 1;
    else state.$统计.突破失败 = (state.$统计.突破失败 || 0) + 1;
  }
  state.$统计.回合数 = (state.$统计.回合数 || 0) + 1;

  const unlocked = [];
  for (const a of ACHIEVEMENTS) {
    if (state.$成就[a.id]) continue;
    let hit = false;
    try { hit = !!a.test(state); } catch { hit = false; }
    if (hit) {
      state.$成就[a.id] = { 天数: state.世界?.天数 || 1 };
      unlocked.push({ id: a.id, name: a.name, desc: a.desc });
    }
  }
  return unlocked;
}
