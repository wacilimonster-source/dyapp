/**
 * 内核单测：规则 / 状态 / 效果 / 遭遇 / 时间。
 * 跑法：node --test tests/
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { clamp, clampField } from '../prototype/core/clamp.js';
import { makeRng, pickByChance, pickWeighted } from '../prototype/core/rng.js';
import {
  parseRealm, realmLabel, realmDC, realmIndex, crossMajorRealm, dcTier,
  cultivate, breakthroughChance, daoStage, vague, rootTier, gainBand,
} from '../prototype/engine/rules.js';
import { emptyState, normalize, snapshot, isFrozen } from '../prototype/engine/state.js';
import { applyEffect, applyAll, resolvePath } from '../prototype/engine/effects.js';
import { sceneClass, tick as encounterTick, pickCandidate } from '../prototype/engine/encounter.js';
import { advanceTime, deriveTime } from '../prototype/engine/time.js';

/* ----------------------------- clamp ----------------------------- */
test('clamp：非数值回落到下界', () => {
  assert.equal(clamp('abc', 0, 100), 0);
  assert.equal(clamp(NaN, 0, 100), 0);
  assert.equal(clamp(150, 0, 100), 100);
  assert.equal(clamp(-5, 0, 100), 0);
});

test('clampField：遭遇冷却上限 15，其它百分比上限 100', () => {
  assert.equal(clampField('遭遇冷却', 99), 15);
  assert.equal(clampField('灵力', 120), 100);
  assert.equal(clampField('宗门贡献', 1234.6), 1235);
  assert.equal(clampField('数量', -3), 0);
});

/* ----------------------------- 境界 ----------------------------- */
test('parseRealm：炼气三层 → DC 3', () => {
  const r = parseRealm('炼气三层');
  assert.equal(r.major, '炼气期');
  assert.equal(r.minor, 3);
  assert.equal(r.dc, 3);
});

test('parseRealm：容忍带 DC 后缀与"炼气"简写', () => {
  assert.equal(parseRealm('炼气三层（DC:3）').dc, 3);
  assert.equal(parseRealm('筑基').major, '筑基期');
  assert.equal(parseRealm('凡').dc, 0);
});

test('realmDC：段内线性（一层..九层 → lo..lo+8），单值境界恒定', () => {
  assert.equal(realmDC('筑基期', 1), 25);
  assert.equal(realmDC('筑基期', 9), 33); // 34 是「圆满」档，不作为层数使用
  assert.equal(realmDC('渡劫期', 5), 182);
  assert.equal(realmDC('超脱境', 1), 999);
});

test('realmLabel：生成规范标签（用词根，不出现"炼气期三层"）', () => {
  assert.equal(realmLabel('炼气期', 3), '炼气三层（DC:3）');
  assert.equal(realmLabel('元婴期', 1), '元婴一层（DC:73）');
  assert.equal(realmLabel('真仙境', 4), '真仙四层（DC:220）');
  assert.equal(realmLabel('超脱境', 1), '超脱境（DC:999）');
});

test('crossMajorRealm / realmIndex：跨大境界计数', () => {
  assert.equal(realmIndex('金丹期') - realmIndex('炼气期'), 2); // 炼气 → 筑基 → 金丹
  assert.equal(crossMajorRealm('金丹期', '炼气期'), 2);
  assert.equal(crossMajorRealm('炼气期', '金丹期'), -2);
  assert.equal(crossMajorRealm('真仙境', '炼气期'), 9);
});

test('dcTier：压制阶梯按 |差| 分档', () => {
  assert.equal(dcTier(0).desc, '同层博弈，胜负看战术 · 法宝 · 临场');
  assert.match(dcTier(3).desc, /越一小境界/);
  assert.match(dcTier(9).desc, /同阶绝对压制/);
  assert.match(dcTier(15).desc, /精神灵压律/);
  assert.match(dcTier(120).desc, /不可逆伤害律/);
});

test('cultivate：灵根品阶 × 境界段决定产出，且随天数缩放', () => {
  const a = cultivate({ rootText: '黄品 · 单灵根（火）', realmLabel: '炼气三层' });
  assert.equal(a.品阶, '黄品');
  assert.equal(a.修为增量, 16); // 黄品/炼气 = 16
  const b = cultivate({ rootText: '天品 灵根', realmLabel: '炼气一层' });
  assert.equal(b.修为增量, 30);
  const half = cultivate({ rootText: '黄品', realmLabel: '炼气三层', days: 15 });
  assert.equal(half.修为增量, 8);
});

test('gainBand：境界段映射正确', () => {
  assert.equal(gainBand('炼气期'), '炼气');
  assert.equal(gainBand('筑基期'), '筑基化神');
  assert.equal(gainBand('化神期'), '筑基化神');
  assert.equal(gainBand('炼虚期'), '炼虚大乘');
  assert.equal(gainBand('真仙境'), '真仙仙帝');
});

test('rootTier：从灵根描述取品阶，取不到按凡品', () => {
  assert.equal(rootTier('玄品 · 单灵根'), '玄品');
  assert.equal(rootTier('单灵根（火）'), '凡品');
});

test('breakthroughChance：道心与灵根影响成功率，且被夹在 5%–95%', () => {
  const low = breakthroughChance({ 道心: 0, rootText: '凡品' });
  const high = breakthroughChance({ 道心: 100, rootText: '天品' });
  assert.ok(high > low);
  assert.ok(low >= 0.05 && high <= 0.95);
  const dan = breakthroughChance({ 道心: 50, rootText: '黄品', 丹药加成: 0.2 });
  assert.ok(Math.abs(dan - 0.7) < 1e-9);
});

test('daoStage / vague：四境与模糊语边界', () => {
  assert.equal(daoStage(10), '凡心');
  assert.equal(daoStage(30), '初窥门径');
  assert.equal(daoStage(60), '澄澈');
  assert.equal(daoStage(90), '磐石');
  assert.equal(vague(85), '充盈');
  assert.equal(vague(31), '稳固');
  assert.equal(vague(0), '归零');
});

/* ----------------------------- 状态归一化 ----------------------------- */
test('normalize：百分比越界被截断、负数归零', () => {
  const s = emptyState();
  s.主角.灵力 = 999;
  s.主角.生命 = -50;
  s.人物['甲'] = { 好感: 500, 关系阶段: '陌生' };
  normalize(s);
  assert.equal(s.主角.灵力, 100);
  assert.equal(s.主角.生命, 0);
  assert.equal(s.人物['甲'].好感, 100);
});

test('normalize：储物袋数量归零自动剔除', () => {
  const s = emptyState();
  s.主角.储物袋 = { 灵石: { 描述: '硬通货', 数量: 3 }, 空瓶: { 描述: '', 数量: 0 }, 负: { 描述: '', 数量: -1 } };
  normalize(s);
  assert.deepEqual(Object.keys(s.主角.储物袋), ['灵石']);
});

test('normalize：机遇与玉简历史按容量截断，保留最近的', () => {
  const s = emptyState();
  for (let i = 0; i < 25; i++) s.机遇[`任务${i}`] = { 难度: '低' };
  s.玉简['甲'] = { 好感度: 10, 历史记录: {} };
  for (let i = 0; i < 130; i++) s.玉简['甲'].历史记录[`m${i}`] = { 内容: String(i) };
  normalize(s);
  assert.equal(Object.keys(s.机遇).length, 20);
  assert.ok('任务24' in s.机遇);
  assert.ok(!('任务0' in s.机遇));
  assert.equal(Object.keys(s.玉简['甲'].历史记录).length, 100);
  assert.ok('m129' in s.玉简['甲'].历史记录);
});

test('normalize：幂等', () => {
  const s = emptyState();
  s.主角.修为 = 250;
  s.机遇['x'] = { 难度: '高' };
  const once = JSON.stringify(normalize(s));
  const twice = JSON.stringify(normalize(snapshot(s)));
  assert.equal(once, twice);
});

test('normalize：境界与 DC 由引擎重算，不信任输入', () => {
  const s = emptyState();
  s.主角.境界 = '筑基五层';
  s.主角.境界DC = 999; // 模型给错的数字
  normalize(s);
  assert.equal(s.主角.境界, '筑基五层（DC:29）');
  assert.equal(s.主角.境界DC, 29);
});

/* ----------------------------- 效果落地 ----------------------------- */
test('applyEffect：delta 增减并 clamp', () => {
  const s = emptyState();
  s.主角.灵力 = 60;
  const r = applyEffect(s, { op: 'delta', target: '主角.灵力', value: -80 });
  assert.equal(r.ok, true);
  assert.equal(s.主角.灵力, 0);
  assert.equal(r.event.delta, -60);
});

test('applyEffect：set 世界字段', () => {
  const s = emptyState();
  const r = applyEffect(s, { op: 'set', target: '世界.当前地点', value: '青石镇 · 醉仙楼' });
  assert.equal(r.ok, true);
  assert.equal(s.世界.当前地点, '青石镇 · 醉仙楼');
});

test('applyEffect：新增人物并归一化', () => {
  const s = emptyState();
  const r = applyEffect(s, { op: 'add', target: '人物.宫银叶', value: { 头衔: '醉仙楼老板娘', 好感: 22, 关系阶段: '试探期' } });
  assert.equal(r.ok, true);
  assert.equal(s.人物['宫银叶'].好感, 22);
});

test('applyEffect：remove 删条目', () => {
  const s = emptyState();
  s.主角.储物袋 = { 灵石: { 描述: '', 数量: 1 } };
  assert.equal(applyEffect(s, { op: 'remove', target: '主角.储物袋.灵石' }).ok, true);
  assert.equal(s.主角.储物袋.灵石, undefined);
  assert.equal(applyEffect(s, { op: 'remove', target: '主角.储物袋.不存在' }).ok, false);
});

test('applyEffect：性格首次写入后冻结，再改被拒', () => {
  const s = emptyState();
  assert.equal(applyEffect(s, { op: 'add', target: '人物.甲', value: { 性格: '泼辣' } }).ok, true);
  assert.equal(isFrozen(s, '人物.甲.性格'), true);
  const again = applyEffect(s, { op: 'set', target: '人物.甲.性格', value: '温柔' });
  assert.equal(again.ok, false);
  assert.match(again.log, /冻结/);
  assert.equal(s.人物['甲'].性格, '泼辣');
});

test('applyEffect：非法 op / 空 target / 单段路径全部拒绝', () => {
  const s = emptyState();
  assert.equal(applyEffect(s, { op: 'explode', target: '主角.灵力', value: 1 }).ok, false);
  assert.equal(applyEffect(s, { op: 'delta', target: '', value: 1 }).ok, false);
  assert.equal(applyEffect(s, { op: 'delta', target: '主角', value: 1 }).ok, false);
  assert.equal(applyEffect(s, { op: 'delta', target: '主角.灵力', value: 'x' }).ok, false);
});

test('resolvePath：拒绝原型污染', () => {
  const s = emptyState();
  for (const p of ['__proto__.x', '主角.__proto__', 'constructor.prototype.x']) {
    const r = resolvePath(s, p);
    assert.equal(r.ok, false, `应拒绝 ${p}`);
  }
  assert.equal({}.polluted, undefined);
});

test('applyEffect：境界只能 set，且 DC 由引擎同步', () => {
  const s = emptyState();
  assert.equal(applyEffect(s, { op: 'delta', target: '主角.境界', value: 1 }).ok, false);
  const r = applyEffect(s, { op: 'set', target: '主角.境界', value: '金丹二层' });
  assert.equal(r.ok, true);
  assert.equal(s.主角.境界, '金丹二层（DC:50）');
  assert.equal(s.主角.境界DC, 50);
});

test('applyAll：坏数据跳过、好数据保留，并写入日志', () => {
  const s = emptyState();
  const r = applyAll(s, [
    { op: 'delta', target: '主角.灵力', value: -10 },
    { op: 'nope', target: '主角.生命', value: -10 },
    { op: 'delta', target: '主角.不存在.深层', value: 5 },
    { op: 'set', target: '世界.危机程度', value: '中' },
  ]);
  assert.equal(r.applied, 2);
  assert.equal(r.skipped, 2);
  assert.equal(r.logs.length, 2);
  assert.equal(s.主角.灵力, 50);
  assert.equal(s.世界.危机程度, '中');
});

/* ----------------------------- 遭遇 ----------------------------- */
test('sceneClass：室内外分类', () => {
  assert.equal(sceneClass('青石镇 · 醉仙楼'), 'indoor');
  assert.equal(sceneClass('青云宗 · 后山'), 'outdoor');
  assert.equal(sceneClass(''), 'unknown');
});

test('encounter.tick：冷却>0 递减且不触发；归零后触发并重置', () => {
  const w = { 遭遇冷却: 2 };
  assert.deepEqual(encounterTick(w), { fired: false, cooldown: 1, armed: false });
  assert.deepEqual(encounterTick(w), { fired: false, cooldown: 0, armed: true });
  const fired = encounterTick(w, { reset: 6 });
  assert.equal(fired.fired, true);
  assert.equal(w.遭遇冷却, 6);
});

test('pickCandidate：同阶权重高于远超玩家者，且可复现', () => {
  const entries = [
    { title: '人物详情：筑基修士', name: '筑基修士', category: '人物', constant: false },
    { title: '人物详情：真仙大能', name: '真仙大能', category: '人物', constant: false },
  ];
  const counts = { '筑基修士': 0, '真仙大能': 0 };
  const rng = makeRng(42);
  for (let i = 0; i < 2000; i++) {
    const e = pickCandidate(entries, { realm: '筑基三层' }, rng);
    counts[e.name]++;
  }
  assert.ok(counts['筑基修士'] > counts['真仙大能'] * 3, JSON.stringify(counts));
});

/* ----------------------------- 时间 ----------------------------- */
test('time：时段推进与跨日', () => {
  const w = { 天数: 1, 时段: '入夜' };
  advanceTime(w, 0);
  assert.equal(w.天数, 2);
  assert.equal(w.时段, '清晨');
  assert.match(w.当前时间, /^初春 · 清晨$/);
});

test('time：跨日推进按天数落在正确季节', () => {
  const w = { 天数: 1, 时段: '清晨' };
  advanceTime(w, 11); // 第 12 日 → 第二格
  assert.equal(w.天数, 12);
  assert.equal(deriveTime(w), '仲春 · 清晨');
});

test('time：季节循环不越界', () => {
  const w = { 天数: 1, 时段: '清晨' };
  advanceTime(w, 120);
  assert.equal(w.天数, 121);
  assert.match(deriveTime(w), /^初春 · 清晨$/);
});

/* ----------------------------- 随机源 ----------------------------- */
test('rng：同种子可复现，概率表命中分布合理', () => {
  const a = makeRng(7), b = makeRng(7);
  for (let i = 0; i < 20; i++) assert.equal(a(), b());

  const tiers = [{ 品: 'A', 概率: 0.1 }, { 品: 'B', 概率: 0.9 }];
  const rng = makeRng(1);
  let aCount = 0;
  for (let i = 0; i < 5000; i++) if (pickByChance(rng, tiers).品 === 'A') aCount++;
  assert.ok(Math.abs(aCount / 5000 - 0.1) < 0.02, String(aCount));
});

test('pickWeighted：权重全零退化为等概率，不返回 undefined', () => {
  const rng = makeRng(3);
  const out = new Set();
  for (let i = 0; i < 50; i++) out.add(pickWeighted(rng, ['x', 'y'], [0, 0]));
  assert.equal(out.size, 2);
});
