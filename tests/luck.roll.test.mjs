/**
 * 气运演算机制的回归测试。
 *
 * 每条断言都对应原卡创角界面里的一段真实代码（`_卡资产提取/regex8_creation.txt` 行号
 * 标在 engine/fate.js 的分支上）。写这些测试的原因是上一版把整套机制换成了
 * "把池子平铺出来、随便挑 3 条"，而界面层写的规则没法测 —— 这次全下沉到引擎。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { rollFates, fateText, findFate, eroPool, FATE_MODES } from '../prototype/engine/fate.js';
import { applyCreateState, migrateFates } from '../prototype/engine/create.js';
import { parseRealm } from '../prototype/engine/rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REAL = JSON.parse(readFileSync(resolve(ROOT, 'prototype/data/luck.json'), 'utf8'));

/** 12 条凡道 + 对应真条 + 合欢三池（合欢合计 ≥5，够开合欢时填满 5 个候选）。 */
function fixture() {
  const normal = Array.from({ length: 12 }, (_, i) => ({
    name: `凡${i}`, desc: `凡${i}的代价`, trueName: `真${i}`,
  }));
  const trueP = Array.from({ length: 12 }, (_, i) => ({ name: `真${i}`, desc: `真${i}的代价` }));
  return {
    normal,
    true: trueP,
    ero: {
      female: [{ name: '女池A', desc: 'a' }, { name: '女池B', desc: 'b' }, { name: '女池C', desc: 'c' }],
      male: [{ name: '男池A', desc: 'd' }, { name: '男池B', desc: 'e' }],
      neutral: [{ name: '通用A', desc: 'f' }, { name: '通用B', desc: 'g' }],
    },
  };
}
/**
 * 按脚本顺序出数的随机源；用完后**轮转下标**而不是给常数 ——
 * 给常数的话每次都抽到同一条，被去重挡掉，候选就凑不满，测的就不是引擎而是脚本。
 * 轮转值刻意避开 <0.05 区间，免得顺带把 5% 真气运掷中。
 */
function scripted(seq, len = 12) {
  let i = 0;
  let k = 0;
  return () => {
    if (i < seq.length) return seq[i++];
    const v = (k++ % len) / len;
    return v < 0.06 ? 0.07 : v;
  };
}

test('三档难度的重抽预算照卡：3 / 10 / 5', () => {
  assert.equal(FATE_MODES.simple.预算, 3);
  assert.equal(FATE_MODES.normal.预算, 10);
  assert.equal(FATE_MODES.hard.预算, 5);
});

test('候选个数：simple/normal 给 10 个，hard 给 5 个（卡内 2948）', () => {
  const luck = fixture();
  assert.equal(rollFates({ luck, rng: scripted([]), mode: 'simple' }).normal.length, 10);
  assert.equal(rollFates({ luck, rng: scripted([]), mode: 'normal' }).normal.length, 10);
  assert.equal(rollFates({ luck, rng: scripted([]), mode: 'hard' }).normal.length, 5);
});

test('合欢模式改成 5 凡 + 5 合欢（卡内 2936 / 2946）', () => {
  const luck = fixture();
  const r = rollFates({ luck, rng: scripted([]), mode: 'simple', ero: true, gender: '不定' });
  assert.equal(r.normal.length, 5, '开了合欢，凡道候选降到 5');
  assert.equal(r.ero.length, 5);
});

test('一次演算内不出现重名候选', () => {
  const r = rollFates({ luck: fixture(), rng: scripted([]), mode: 'simple', ero: true, gender: '女' });
  const names = [...r.normal, ...r.ero].map((e) => e.name);
  assert.equal(new Set(names).size, names.length, `候选重名：${names.join('、')}`);
});

test('真·气运：要「逆天改命」勾选，且命中的是**同序号**那条真条（卡内 2908）', () => {
  const luck = fixture();
  // 第一次取 0 号下标 → 命中 5% → 应换成凡0 绑定的「真0」
  const hit = rollFates({ luck, rng: scripted([0, 0.01]), mode: 'simple', cheat: true });
  assert.equal(hit.normal[0].name, '真0');
  assert.equal(hit.normal[0].真, true);

  // 同样掷骰，但没开逆天改命 → 不得出现真条
  const noCheat = rollFates({ luck, rng: scripted([0, 0.01]), mode: 'simple', cheat: false });
  assert.ok(noCheat.normal.every((e) => !e.真), '未开逆天改命却出了真条');

  // 开了逆天改命但档位是 hard → 卡内明确排除 hard
  const hard = rollFates({ luck, rng: scripted([0, 0.01, 0.02, 0.03, 0.04]), mode: 'hard', cheat: true });
  assert.ok(hard.normal.every((e) => !e.真), '逆天而行档位不该出真条');
});

test('真条绑定认名字，不认数组顺序', () => {
  const luck = fixture();
  luck.normal[3].trueName = '真7';           // 手工改绑定
  luck.true[3].name = '被挪走的真3';          // 数组顺序与绑定脱钩
  const r = rollFates({ luck, rng: scripted([3 / 12, 0.01]), mode: 'simple', cheat: true });
  assert.equal(r.normal[0].name, '真7', '应按 trueName 查，而不是按同下标取');
});

test('合欢池按创角性别过滤（卡内 2938-2946）', () => {
  const luck = fixture();
  assert.deepEqual(eroPool(luck, '女').map((e) => e.name), ['女池A', '女池B', '女池C', '通用A', '通用B']);
  assert.deepEqual(eroPool(luck, '男').map((e) => e.name), ['男池A', '男池B', '通用A', '通用B']);
  assert.deepEqual(eroPool(luck, '不定').map((e) => e.name),
    ['女池A', '女池B', '女池C', '男池A', '男池B', '通用A', '通用B']);
  assert.deepEqual(eroPool(luck, '雌性').map((e) => e.name),
    ['女池A', '女池B', '女池C', '通用A', '通用B'], '卡内正则还认"雌"');
});

test('重 roll 保留已定那条（卡内 lockedNormal / lockedEro）', () => {
  const luck = fixture();
  const locked = { name: '凡2', desc: '凡2的代价' };
  const r = rollFates({ luck, rng: scripted([]), mode: 'simple', lockedNormal: locked });
  assert.equal(r.normal[0].name, '凡2', '锁定项应排在候选首位');
  assert.equal(r.normal.length, 10, '锁定项占掉一个名额，总数仍是 10');
  assert.equal(r.normal.filter((e) => e.name === '凡2').length, 1, '锁定项不该被再抽一次');
});

test('落盘文本照卡：【A】 & 【B】，合欢描述前加 [合欢]:', () => {
  const t = fateText([
    { name: '凡0', desc: '甲', 真: false, 合欢: false },
    { name: '女池A', desc: '乙', 真: false, 合欢: true },
  ]);
  assert.equal(t.names, '【凡0】 & 【女池A】');
  assert.equal(t.desc, '甲\n\n[合欢]: 乙');
  assert.equal(fateText([]).names, '');
});

test('气运库能选到 roll 永远抽不到的真条（凡池走完之后的 86 条）', () => {
  assert.ok(REAL.trueOnlyCount > 0, '数据里应记录有多少真条是 roll 抽不到的');
  const unreachable = REAL.true.slice(REAL.normal.length);
  for (const e of unreachable.slice(0, 5)) {
    const f = findFate(REAL, e.name);
    assert.ok(f, `气运库找不到 ${e.name}`);
    assert.equal(f.真, true);
    assert.equal(f.desc, e.desc, '库里的描述必须与卡内一致');
  }
});

test('findFate 认得四个池子，池外的名号返回 null', () => {
  assert.equal(findFate(REAL, REAL.normal[0].name).合欢, 'normal');
  assert.equal(findFate(REAL, REAL.true[0].name).真, true);
  assert.equal(findFate(REAL, REAL.ero.female[0].name).合欢, 'female');
  assert.equal(findFate(REAL, REAL.ero.neutral[0].name).合欢, 'neutral');
  assert.equal(findFate(REAL, '过目不忘'), null, '上一版自创的名号不该存在');
});

test('三档难度对整个创角表单的约束照卡', () => {
  assert.deepEqual(
    Object.values(FATE_MODES).map((m) => [m.可自选道侣, m.可自定义, m.境界]),
    [[true, true, '输入'], [false, false, '下拉'], [false, false, '未修炼']],
    '卡内 normal/hard 同时隐藏道侣自选与自定义气运（3131/3137、3123/3136）',
  );
});

test('起始境界由难度档决定，且能盖过出生界的默认推导', () => {
  // 境界标签由引擎规范化（state.normalize），所以断言看 DC 而不是看字面
  const free = applyCreateState({ 姓名: '甲', 境界: '炼气三层', 出生界: '玄天界' });
  assert.equal(parseRealm(free.主角.境界).dc, 3);
  const xian = applyCreateState({ 姓名: '乙', 出生界: '仙界' });
  assert.equal(parseRealm(xian.主角.境界).dc, 217, '没给境界时仍按出生界推导');
  const hard = applyCreateState({ 姓名: '丙', 境界: '未修炼', 出生界: '仙界' });
  assert.equal(parseRealm(hard.主角.境界).dc, 0, '逆天而行必须落到最低一档');
  assert.ok(hard.主角.境界.startsWith('凡'), '卡内的"未修炼"不在十五境内，引擎规范化成"凡"（DC 0，机制等价）');
});

test('创角落盘带上卡内原文效果（描述要能被模型读到）', () => {
  const picked = [
    { name: REAL.normal[0].name, desc: REAL.normal[0].desc, 真: false, 合欢: false },
    { name: REAL.ero.female[0].name, desc: REAL.ero.female[0].desc, 真: false, 合欢: true },
  ];
  const s = applyCreateState({ 姓名: '试', 性别: '女', 出身: '宗门外门', 气运: picked });
  const a = s.主角.气运[REAL.normal[0].name];
  assert.equal(a.效果, REAL.normal[0].desc, '效果必须是卡内原文，不能再写成"（创角所选气运）"');
  assert.equal(a.类型, '凡道');
  assert.equal(s.主角.气运[REAL.ero.female[0].name].类型, '合欢');
});

test('旧档气运按新池重建：池里没有的丢掉，同名取原文（裁决⑤）', () => {
  const s = applyCreateState({
    姓名: '旧档', 性别: '男', 出身: '宗门外门',
    气运: [{ name: '不化骨', desc: '肉身坚硬如僵尸，不老不死，不入轮回。', 真: false, 合欢: false },
      { name: '过目不忘', desc: '凡读过的功法口诀，皆可默记七分。', 真: false, 合欢: false }],
  });
  assert.ok(s.主角.气运['过目不忘'], '构造旧档用');
  const { kept, dropped } = migrateFates(s, REAL);
  assert.deepEqual(dropped, ['过目不忘'], '卡内没有的名号应被剔除');
  assert.deepEqual(kept, ['不化骨']);
  assert.ok(s.主角.气运['不化骨'].效果.includes('关节僵硬'), '描述应被换回卡内原文（含代价）');
  assert.ok(!s.主角.气运['过目不忘']);
});
