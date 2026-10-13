/**
 * 气运数据保真守卫：卡内原文 ↔ prototype/data/luck.json 逐条对齐。
 *
 * 为什么单独有这一份：上一版气运是"人肉节选 + 顺手改写"，结果 10 条里 9 条
 * 把卡里明写的代价删掉了（「不化骨」从"关节僵硬、易被当做妖魔斩杀"变成"不老不死"），
 * 还混进一条卡内根本不存在的名号。这种偏差靠看代码看不出来，只能拿原文比对。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CARD = resolve(ROOT, '_卡资产提取/regex8_creation.txt');
const DATA = resolve(ROOT, 'prototype/data/luck.json');

const src = readFileSync(CARD, 'utf8');
const luck = JSON.parse(readFileSync(DATA, 'utf8'));

const all = [
  ...luck.normal.map((e) => ['normal', e]),
  ...luck.true.map((e) => ['true', e]),
  ...luck.ero.female.map((e) => ['eroFemale', e]),
  ...luck.ero.male.map((e) => ['eroMale', e]),
  ...luck.ero.neutral.map((e) => ['eroNeutral', e]),
];

test('五池条数与卡内一致（改动必须先重跑 tools/build-luck.mjs）', () => {
  assert.equal(luck.normal.length, 113, '凡道气运');
  assert.equal(luck.true.length, 199, '真气运');
  assert.equal(luck.ero.female.length, 119, '合欢·女');
  assert.equal(luck.ero.male.length, 136, '合欢·男');
  assert.equal(luck.ero.neutral.length, 42, '合欢·通用');
  assert.equal(luck.count, 609);
  assert.equal(all.length, luck.count, 'count 与实际条数不符 = 有池子被漏装');
});

test('每条名号与描述都在卡内原文里逐字出现', () => {
  const missingName = [];
  const missingDesc = [];
  for (const [pool, e] of all) {
    if (!src.includes(`name: ${JSON.stringify(e.name)}`)) missingName.push(`${pool}/${e.name}`);
    if (!src.includes(`desc: ${JSON.stringify(e.desc)}`)) missingDesc.push(`${pool}/${e.name}`);
  }
  assert.deepEqual(missingName, [], '这些名号在卡内找不到逐字对应');
  assert.deepEqual(missingDesc, [], '这些描述被改写过（哪怕一个标点都不允许）');
});

test('卡内明写的"代价"没有被删（抽查若干条关键词仍在）', () => {
  const must = {
    不化骨: '关节僵硬',
    鸿蒙紫气: '举世皆敌',
    混沌体: '百倍',
    先天道胎: '情感淡漠',
    每日签到系统: '厄运缠身',
    赘婿战神: '受尽轻视',
  };
  for (const [name, kw] of Object.entries(must)) {
    const e = luck.normal.find((x) => x.name === name);
    assert.ok(e, `凡道池里找不到 ${name}`);
    assert.ok(e.desc.includes(kw), `${name} 的描述里应当保留"${kw}"（这是代价，不能删）`);
  }
});

test('真气运按同下标绑定，绑定关系写在数据里而不是靠数组顺序', () => {
  luck.normal.forEach((e, i) => {
    assert.equal(e.trueName, luck.true[i].name, `凡道第 ${i} 条的真条绑定错位`);
  });
  // 卡内 roll 的 5% 分支是 trueFortunePresets[index]（regex8_creation.txt:2908）
  assert.equal(luck.trueOnlyCount, luck.true.length - luck.normal.length);
  assert.ok(luck.true[luck.normal.length].name.startsWith('真·'), '凡池之后的真条也应带"真·"前缀');
});

test('合欢三池的名号互不重复，且不与凡道/真池混名', () => {
  const seen = new Map();
  for (const [pool, e] of all) {
    assert.ok(!seen.has(e.name), `${e.name} 同时出现在 ${seen.get(e.name)} 和 ${pool}`);
    seen.set(e.name, pool);
  }
});

test('上一版自创的名号不再出现在数据里', () => {
  // 「过目不忘」在卡内 609 条里根本不存在，是当初手写的
  assert.equal(all.filter(([, e]) => e.name === '过目不忘').length, 0);
});

test('每条都有非空描述（描述才是给模型看的规则，缺了等于白抽）', () => {
  const empty = all.filter(([, e]) => !e.desc.trim());
  assert.deepEqual(empty, []);
});
