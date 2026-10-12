/**
 * 第二轮全量审查修掉的 bug 的回归测试。
 *
 * 每条对应一个真实缺陷（部分为上一轮未覆盖的角落）；作用同样是：
 * **同样的错不会再悄悄回来**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { emptyState, normalize } from '../prototype/engine/state.js';
import { applyAll, applyEffect } from '../prototype/engine/effects.js';
import { resolveIntent } from '../prototype/engine/turn.js';
import { applyCreateState, openingTurn, drawTrueLuck } from '../prototype/engine/create.js';
import { evaluateAchievements, ACHIEVEMENTS } from '../prototype/engine/achievements.js';
import { buildRecap } from '../prototype/memory/recap.js';
import { composeNarrative } from '../prototype/narrator/prompt.js';
import { buildPromptPlan } from '../prototype/narrator/plan.js';
import { parseTurnResult } from '../prototype/narrator/parse.js';
import { makeRng } from '../prototype/core/rng.js';

function baseState() {
  const s = emptyState();
  s.主角.姓名 = '陆沉';
  return normalize(s);
}

/* ============================================================
 * bug: effects 对「境界」先写后判 —— delta 会把境界覆盖成数字，
 * 再被 normalize 归一成「凡」，玩家境界被静默清空
 * ============================================================ */

test('effects：delta 境界被拒绝且状态未被污染', () => {
  const s = baseState();
  const before = s.主角.境界;
  const r = applyEffect(s, { op: 'delta', target: '主角.境界', value: 5 });
  assert.equal(r.ok, false);
  assert.equal(s.主角.境界, before, '拒绝的 effect 不能留下任何写入');
  normalize(s);
  assert.match(s.主角.境界, /炼气一层/, '境界不能被清成「凡」');
});

test('effects：set 境界DC 被拒绝（DC 由引擎按境界查表生成）', () => {
  const s = baseState();
  const r = applyEffect(s, { op: 'set', target: '主角.境界DC', value: 999 });
  assert.equal(r.ok, false);
  assert.equal(s.主角.境界DC, 1);
});

test('effects：set 境界 仍会联动更新 DC（原有能力不回退）', () => {
  const s = baseState();
  const r = applyEffect(s, { op: 'set', target: '主角.境界', value: '筑基三层' });
  assert.equal(r.ok, true);
  assert.equal(s.主角.境界DC, 27); // 筑基期 25 + (3-1)
});

/* ============================================================
 * bug: 突破无修为门槛 —— 修为 0 也能无限刷突破（0.5± 成功率）
 * ============================================================ */

test('突破：修为未满 100 时引擎不掷骰、不推进时间', () => {
  const s = baseState();
  s.主角.修为 = 30;
  const days = s.世界.天数;
  const r = resolveIntent({ kind: 'breakthrough', text: '冲' }, s, makeRng(1));
  assert.equal(r.duel, null);
  assert.equal(r.effects.length, 0);
  assert.equal(s.世界.天数, days, '无效突破不该推进时间');
  assert.match(r.hints.join('\n'), /修为未满/);
});

test('突破：修为满 100 时照常掷骰', () => {
  const s = baseState();
  s.主角.修为 = 100;
  const r = resolveIntent({ kind: 'breakthrough', text: '冲' }, s, makeRng(7));
  assert.ok(r.duel, '应产出判定结果');
  assert.ok(r.duel.chance > 0 && r.duel.chance <= 0.95);
  assert.equal(s.世界.天数, 4); // +3 日
});

/* ============================================================
 * bug: 「真·气运（5%）」按钮直接入选 —— 概率形同虚设；
 * 且抽取逻辑在界面层不可测
 * ============================================================ */

test('真·气运：5% 命中/未命中可复现，且不与已有条目重复', () => {
  const pool = [{ name: '过目不忘', 向: '通用', desc: 'x' }, { name: '混沌体', 向: '通用', desc: 'y' }];
  const hit = drawTrueLuck(() => 0.01, pool, [], 0.05);
  assert.ok(hit && hit.name.startsWith('真·'));
  assert.equal(hit.真, true);

  const miss = drawTrueLuck(() => 0.9, pool, [], 0.05);
  assert.equal(miss, null, '掷骰未命中必须返回 null');

  // 命中的名字已存在时跳过它（用常量 rng 会一直抽同一条，守卫会返回 null）
  const taken = [{ name: '真·过目不忘' }];
  const dup = drawTrueLuck(() => 0.01, [{ name: '过目不忘', 向: '通用', desc: 'x' }], taken, 0.05);
  assert.equal(dup, null, '池中唯一候选已被占用时不重复发放');
});

/* ============================================================
 * bug: 创角规则散在界面层（死条件 '青云宗外门'、道侣不拷预设设定、
 * 玉简不建档导致面板必崩、二次创角继承上一局状态）
 * ============================================================ */

test('创角：出身加成与初始物资正确', () => {
  const han = applyCreateState({ 姓名: '甲', 出身: '寒门散修', 出生界: '玄天界' });
  assert.equal(han.主角.道心, 58);
  assert.equal(han.主角.储物袋['下品灵石'].数量, 16);

  const wai = applyCreateState({ 姓名: '乙', 出身: '宗门外门', 出生界: '玄天界' });
  assert.equal(wai.主角.宗门贡献, 120);

  const shi = applyCreateState({ 姓名: '丙', 出身: '没落世家', 出生界: '玄天界' });
  assert.equal(shi.主角.储物袋['下品灵石'].数量, 36);
});

test('创角：仙界开局为真仙一层；天品灵根加道心', () => {
  const xian = applyCreateState({ 姓名: '丁', 出生界: '仙界' });
  assert.match(xian.主角.境界, /真仙一层/);
  assert.equal(xian.主角.境界DC, 217);

  const tian = applyCreateState({ 姓名: '戊', 出生界: '玄天界', 灵根: { 品: '天品' } });
  assert.equal(tian.主角.道心, 60); // 50 + 10
  assert.match(tian.主角.灵根, /天品/);
});

test('创角：道侣带出预设设定，并同步建立玉简档案', () => {
  const preset = {
    林若悠: {
      性别: '女', 种族: '人族', 状态: '正常', 境界: '筑基后期',
      亲密: 34, 生命: 88, 灵力: 76, 修为: 62, 道心: 70,
      性格: '清冷端庄，外冷内热，重诺。', 外观: '一袭素白仙裙', 身高: '五尺七寸',
      背景: '玉灵宫圣女。', 神通: '空明幻体', 心声: '（……）',
    },
  };
  const s = applyCreateState({ 姓名: '己', 道侣: '林若悠', 出生界: '玄天界' }, { partnerPreset: preset });
  assert.equal(s.道侣['林若悠'].性格, '清冷端庄，外冷内热，重诺。', '应拷贝预设设定而不是套模板');
  assert.ok(s.玉简['林若悠'], '玉简应同步建档（否则打开面板必崩）');
  assert.equal(s.玉简['林若悠'].好感度, 34);
  assert.deepEqual(s.玉简['林若悠'].历史记录, {});

  // 不选道侣：玉简为空是合法状态（面板必须有空态渲染）
  const none = applyCreateState({ 姓名: '庚', 出生界: '玄天界' });
  assert.deepEqual(none.玉简, {});
});

test('创角：开局回合引用状态且可序列化', () => {
  const s = applyCreateState({ 姓名: '辛', 出生界: '玄天界' });
  const t = openingTurn(s);
  assert.equal(t.role, 'assistant');
  assert.ok(t.text.includes('辛'));
  assert.ok(t.scene.当前时间);
  assert.equal(t.choices.length, 3);
});

/* ============================================================
 * bug: 长局超过 L4 预算直接丢最早回合 —— 模型"忘了"去过哪、见过谁
 * ============================================================ */

test('recap：抽取窗口之外的助手回合（时间/地点 + 摘要），跳过玩家回合', () => {
  const turns = [];
  for (let i = 0; i < 20; i++) {
    turns.push({ role: 'user', text: `行动${i}` });
    turns.push({
      role: 'assistant', text: `正文第${i}段`.repeat(10),
      scene: { 当前时间: `第${i}日`, 当前地点: `地点${i}` },
    });
  }
  const recap = buildRecap(turns, { keep: 8, maxLines: 40, maxChars: 2000 });
  assert.ok(recap.includes('地点0'), '窗口外的早期回合要进摘要');
  assert.ok(!recap.includes('行动0'), '玩家行动不重复进摘要');
  assert.ok(!recap.includes('地点19'), '窗口内的最近回合不进摘要');
  assert.ok(!recap.includes('地点16'), '最近 8 条之外的都应被摘');
  assert.ok(recap.includes('地点15'), 'keep 窗口之前一条仍应被摘');
});

test('recap：短局返回空串；超长时按 maxChars 从尾部截断', () => {
  assert.equal(buildRecap([{ role: 'assistant', text: 'hi' }], { keep: 8 }), '');
  const many = Array.from({ length: 100 }, (_, i) => ({
    role: 'assistant', text: `第${i}段内容`.repeat(6), scene: { 当前地点: `L${i}` },
  }));
  const recap = buildRecap(many, { keep: 0, maxLines: 100, maxChars: 300 });
  assert.ok(recap.length <= 301);
  assert.ok(recap.startsWith('…'), '截断保留的是最近的内容');
});

test('prompt：传入 recap 时 L3.5 层出现在 L3 与 L4 之间', () => {
  const s = baseState();
  const { messages, meta } = composeNarrative({
    action: '前行',
    state: s,
    recap: '· 【第1日 · 青石镇】旧事一则',
  });
  const idx = messages.findIndex((m) => m.content.includes('往昔回顾'));
  assert.ok(idx >= 0, '应有往昔回顾消息');
  assert.ok(messages[idx].content.includes('旧事一则'));
  assert.deepEqual(meta.layers.map((l) => l.name), ['L0', 'L3', 'L3.5', 'L4', 'L5']);
});

/* ============================================================
 * bug: 默认模式 layers 里 L0 重复（预览面板出现两个 L0，totalTokens 对不上）
 * ============================================================ */

test('plan：默认模式的 layers 里 L0 只出现一次', () => {
  const s = baseState();
  const plan = buildPromptPlan({
    mode: 'default',
    engine: { action: '走', state: s, index: null, retrieved: [], recent: [], hints: [] },
  });
  const l0 = plan.meta.layers.filter((l) => l.name === 'L0');
  assert.equal(l0.length, 1);
  const sum = plan.meta.layers.reduce((acc, l) => acc + (l.tokens || 0), 0);
  assert.equal(plan.meta.totalTokens, sum, 'totalTokens 必须与 layers 之和对得上');
});

/* ============================================================
 * bug: 裁决协议要求模型产出「当前时间」，引擎又丢弃 —— 白耗 token
 * ============================================================ */

test('parse：scene 里的「当前时间」被忽略，其余场景字段保留', () => {
  const r = parseTurnResult(JSON.stringify({
    effects: [],
    scene: { 当前时间: '三千年后', 当前地点: '天外', 天气: '雷暴' },
    choices: [],
  }));
  assert.equal(r.scene.当前时间, undefined, '时间由引擎独占，不接受模型回传');
  assert.equal(r.scene.当前地点, '天外');
  assert.equal(r.scene.天气, '雷暴');
});

/* ============================================================
 * 成就与统计：引擎判定、只解锁一次、计数正确
 * ============================================================ */

test('成就：突破计数、筑基判定与去重', () => {
  const s = baseState();
  assert.equal(s.$统计.回合数, 0);
  assert.equal(s.$成就 && Object.keys(s.$成就).length, 0);

  const first = evaluateAchievements(s, { kind: 'breakthrough', duel: { win: true } });
  assert.equal(s.$统计.突破成功, 1);
  assert.equal(s.$统计.回合数, 1);
  assert.ok(first.some((a) => a.id === 'breakthrough'));

  // 已解锁不再重复返回
  const second = evaluateAchievements(s, { kind: 'breakthrough', duel: { win: false } });
  assert.ok(!second.some((a) => a.id === 'breakthrough'));
  assert.equal(s.$统计.突破失败, 1);

  s.主角.境界 = '筑基一层';
  const third = evaluateAchievements(s, {});
  assert.ok(third.some((a) => a.id === 'zhuji'));
});

test('成就：全部条目的 test 在空状态上不会抛错', () => {
  const s = emptyState();
  for (const a of ACHIEVEMENTS) {
    assert.doesNotThrow(() => a.test(s), `成就 ${a.id} 的判定不该抛错`);
  }
});

/* ============================================================
 * 状态归一化：新增字段的补齐与幂等
 * ============================================================ */

test('state：旧档缺少 $成就/$统计/$往昔 时归一化补齐且幂等', () => {
  const legacy = { 世界: {}, 主角: { 境界: '筑基二层' } };
  normalize(legacy);
  assert.deepEqual(legacy.$统计, { 回合数: 0, 突破成功: 0, 突破失败: 0 });
  assert.deepEqual(legacy.$成就, {});
  assert.equal(legacy.$往昔, '');

  const once = JSON.stringify(legacy);
  normalize(legacy);
  assert.equal(JSON.stringify(legacy), once, '归一化必须幂等');
});

test('state：$统计 的脏数据被夹回非负整数', () => {
  const s = emptyState();
  s.$统计 = { 回合数: -5, 突破成功: 'x', 突破失败: 2.7 };
  normalize(s);
  assert.deepEqual(s.$统计, { 回合数: 0, 突破成功: 0, 突破失败: 2 });
});

/* ============================================================
 * applyAll 汇总：拒绝的 effect 进 skipped，状态无污染
 * ============================================================ */

test('applyAll：混合效果里非法条目被跳过、合法条目正常落地', () => {
  const s = baseState();
  const r = applyAll(s, [
    { op: 'delta', target: '主角.灵力', value: -10 },
    { op: 'delta', target: '主角.境界', value: 3 },
    { op: 'set', target: '主角.境界DC', value: 500 },
  ]);
  assert.equal(s.主角.灵力, 50);
  assert.equal(r.skipped, 2);
  assert.match(s.主角.境界, /炼气一层/);
  assert.equal(s.主角.境界DC, 1);
});
