/**
 * 斗法结算的回归测试。
 *
 * 这块是独立版相对原卡的**有意加强**（卡里战斗全靠模型裁量），
 * 所以测试盯的是"引擎说了算"这件事：胜负可复现、伤势有数字、模型只能照着写。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { isCombatIntent, pickAdversary, resolveDuel, inventAdversary } from '../prototype/engine/combat.js';
import { resolveIntent } from '../prototype/engine/turn.js';
import { applyCreateState } from '../prototype/engine/create.js';
import { parseRealm } from '../prototype/engine/rules.js';

function hero(over = {}) {
  const s = applyCreateState({ 姓名: '陆沉', 性别: '男', 出身: '宗门外门', 出生界: '玄天界' });
  s.主角.境界 = '炼气三层';
  s.主角.境界DC = parseRealm('炼气三层').dc;
  Object.assign(s.主角, over);
  return s;
}
/** 固定随机源：先给 seq 里的数，用完给 0.99（保证不命中概率分支）。 */
function rngOf(seq) {
  let i = 0;
  return () => (i < seq.length ? seq[i++] : 0.99);
}

test('战斗意图识别：命中战斗词，不误伤日常行动', () => {
  assert.ok(isCombatIntent('拔剑攻上去'));
  assert.ok(isCombatIntent('与他对上，出手'));
  assert.ok(!isCombatIntent('四处探索，看看这附近有什么。'));
  assert.ok(!isCombatIntent('打坐回复灵力'), '"打坐"不该被当成打架');
});

test('对手优先取玩家点名的在场人物', () => {
  const s = hero();
  s.人物['血刀老祖'] = { 境界: '筑基二层', 好感: 5, 关系阶段: '敌对' };
  s.人物['林若悠'] = { 境界: '炼气五层', 好感: 80, 关系阶段: '相识' };
  const a = pickAdversary(s, '朝林若悠出手');
  assert.equal(a.name, '林若悠', '点名了就用点名的，哪怕她好感很高');
  const b = pickAdversary(s, '出手');
  assert.equal(b.name, '血刀老祖', '没点名时取敌意最深的');
});

test('没有可打的人时按危机程度现编，危机越高对手越强', () => {
  const calm = hero(); calm.世界.危机程度 = '低';
  const hot = hero(); hot.世界.危机程度 = '高';
  const a = inventAdversary(calm, '炼气三层', rngOf([0]));
  const b = inventAdversary(hot, '炼气三层', rngOf([0]));
  assert.ok(parseRealm(b.realm).dc > parseRealm(a.realm).dc,
    `高危机对手应更强：${a.realm} vs ${b.realm}`);
});

test('斗法结算：胜负可复现，灵力必掉，败了掉更多血', () => {
  const win = resolveDuel({ state: hero({ 灵力: 80, 生命: 90 }), text: '出手', rng: rngOf([0, 0]) });
  const lose = resolveDuel({ state: hero({ 灵力: 80, 生命: 90 }), text: '出手', rng: rngOf([0.99, 0.99]) });
  assert.equal(win.duel.win, true);
  assert.equal(lose.duel.win, false);
  const hurt = (r) => -Number(r.effects.find((e) => e.target === '主角.生命').value);
  assert.ok(hurt(lose) > hurt(win), `败北伤势(${hurt(lose)}) 应重于获胜轻伤(${hurt(win)})`);
  assert.ok(win.effects.some((e) => e.target === '主角.灵力' && e.value === -18), '斗法必耗灵力');
  assert.ok(win.hints.some((h) => /引擎已判定/.test(h)), '提示词要明说结果是引擎定的');
  assert.ok(win.hints.some((h) => /不要改胜负/.test(h)), '要禁止模型改结果');
});

test('跨大境界以弱击强而落败，触发不可逆伤害律（精血也掉）', () => {
  const s = hero();
  s.人物['金甲仙人'] = { 境界: '金丹一层', 好感: 0, 关系阶段: '死敌' };
  const r = resolveDuel({ state: s, text: '朝金甲仙人出手', rng: rngOf([0.99, 0.99]) });
  assert.equal(r.duel.win, false);
  assert.ok(r.effects.some((e) => e.target === '主角.精血'), '跨大境界碾压应伤及本源');
  assert.match(r.hints.join('\n'), /跨大境界/);
});

test('有器物时计入损耗', () => {
  const s = hero();
  s.主角.器物['青纹剑'] = { 等级: '下品法器', 类型: '飞剑', 损耗度: 0, 状态: '完好', 描述: 'x' };
  const r = resolveDuel({ state: s, text: '拔剑', rng: rngOf([0, 0]) });
  const wear = r.effects.find((e) => e.target.endsWith('.损耗度'));
  assert.ok(wear, '应有一条器物损耗');
  assert.equal(wear.value, 12);
});

test('对手越强胜率越低，并且胜率有下限（不留 0% 的死局）', () => {
  const chanceVs = (realm) => {
    const s = hero();
    s.人物['对手'] = { 境界: realm, 好感: 0, 关系阶段: '敌对' };
    return resolveDuel({ state: s, text: '朝对手出手', rng: rngOf([0.99, 0.99]) }).duel.chance;
  };
  // 只在未被上下限夹住的区间里比单调性
  assert.ok(chanceVs('炼气二层') > chanceVs('炼气六层'), '对手小境界更高，胜率应更低');
  assert.ok(chanceVs('炼气六层') > chanceVs('炼气九层'));
  // 跨大境界碾压会被夹到下限 5%：仍有胜机，这才叫修仙界的"以下克上"
  assert.equal(chanceVs('金丹一层'), 0.05, '胜率下限必须是 5%');
});

test('回合编排：kind=duel 与自由文本里的战斗词都走引擎结算', () => {
  const s = hero({ 灵力: 70, 生命: 88 });
  const byKind = resolveIntent({ kind: 'duel', text: '出手' }, s, rngOf([0, 0]));
  assert.ok(byKind.duel, 'kind=duel 必须带回判定结果');
  assert.equal(byKind.preEffects, true, '斗法效果要由引擎先落地');

  const s2 = hero({ 灵力: 70, 生命: 88 });
  const byText = resolveIntent({ kind: 'free', text: '拔剑攻上去' }, s2, rngOf([0, 0]));
  assert.ok(byText.duel, '自由文本里的战斗词也要被引擎接住');

  const s3 = hero();
  const calm = resolveIntent({ kind: 'free', text: '四处探索' }, s3, rngOf([0, 0]));
  assert.equal(calm.duel, undefined, '非战斗文本不该产生斗法判定');
});
