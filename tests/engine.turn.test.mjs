/**
 * 回合编排单测。用**桩 llm**（不联网）验证：
 * 引擎算的部分是否落地、模型给的部分是否落地、失败是否降级、时间是否由引擎独占。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { runTurn, resolveIntent, advanceTime, deriveTime } from '../prototype/engine/turn.js';
import { emptyState, normalize, snapshot } from '../prototype/engine/state.js';
import { buildIndex } from '../prototype/memory/index.js';
import { makeRng } from '../prototype/core/rng.js';

const INDEX = buildIndex({
  entries: [
    { id: 0, title: '境界', name: '境界', category: '规则', keys: [], content: '炼气至超脱共十五境。', constant: true, enabled: true, order: 100, len: 12, realm: '' },
    { id: 1, title: '详细人物:林若悠', name: '林若悠', category: '人物', keys: ['林若悠'], content: '玉灵宫圣女，空明幻体，性情清冷。', constant: false, enabled: true, order: 100, len: 20, realm: '玄天界' },
    { id: 2, title: '人物详情：真仙大能', name: '真仙大能', category: '人物', keys: ['真仙大能'], content: '隐居千年的老怪物。', constant: false, enabled: true, order: 100, len: 10, realm: '' },
  ],
});

function stubLlm({ deltas = ['你', '凝神', '引气', '。'], verdict, streamThrows = false } = {}) {
  return {
    async stream(_req, onEvent) {
      if (streamThrows) throw new Error('网络不可用');
      for (const d of deltas) onEvent({ type: 'delta', data: { text: d } });
    },
    async completeJson() {
      if (verdict === undefined) throw new Error('裁决模型未配置');
      return verdict;
    },
  };
}

function baseState(over = {}) {
  const s = emptyState();
  s.主角.姓名 = '陆沉';
  s.主角.境界 = '炼气三层';
  s.主角.灵根 = '黄品 · 单灵根（火）';
  Object.assign(s.主角, over);
  return normalize(s);
}

/* ----------------------------- 自由行动 ----------------------------- */
test('runTurn（自由行动）：叙事来自模型，效果来自裁决，时间由引擎推进', async () => {
  const state = baseState();
  const before = snapshot(state);

  const r = await runTurn({
    action: { kind: 'free', text: '四处探索' },
    state,
    index: INDEX,
    llm: stubLlm({
      verdict: {
        effects: [{ op: 'delta', target: '主角.灵力', value: -12, reason: '施展御剑术' }],
        scene: { 当前地点: '青石镇 · 醉仙楼', 危机程度: '低', 天气: '细雨' },
        choices: ['继续修炼', '去坊市看看'],
      },
    }),
    rng: makeRng(1),
    recent: [],
    fallbackNarratives: ['（离线）'],
  });

  assert.equal(r.source, 'llm');
  assert.equal(r.narrative, '你凝神引气。');
  assert.equal(r.effects.length, 1);
  assert.equal(state.主角.灵力, before.主角.灵力 - 12);
  assert.equal(state.世界.当前地点, '青石镇 · 醉仙楼');
  assert.equal(state.世界.危机程度, '低');
  assert.deepEqual(r.choices, ['继续修炼', '去坊市看看']);
  // 时间：只走一个时段
  assert.equal(state.世界.天数, before.世界.天数);
  assert.notEqual(state.世界.时段, before.世界.时段);
  // 有进度条类事件供 UI 演动画
  assert.ok(r.events.some((e) => e.kind === 'float' && e.key === '灵力'));
});

test('runTurn：模型不能改时间（引擎独占）', async () => {
  const state = baseState();
  const before = deriveTime(state.世界);
  await runTurn({
    action: { kind: 'free', text: '发呆' },
    state,
    index: INDEX,
    llm: stubLlm({
      verdict: {
        effects: [],
        scene: { 当前时间: '三千年后', 当前地点: '天外' },
        choices: [],
      },
    }),
    rng: makeRng(2),
  });
  assert.notEqual(state.世界.当前时间, '三千年后');
  assert.equal(state.世界.当前地点, '天外'); // 地点允许模型改
  assert.ok(before !== state.世界.当前时间);
});

/* ----------------------------- 修炼 ----------------------------- */
test('resolveIntent（修炼）：产出由引擎算，时间按天数推进', () => {
  const state = baseState();
  const intent = resolveIntent({ kind: 'cultivate', text: '闭关' }, state, makeRng(1));
  assert.equal(intent.preEffects, true);
  const xiuwei = intent.effects.find((e) => e.target === '主角.修为');
  assert.equal(xiuwei.value, 16); // 黄品 / 炼气期
  assert.equal(state.世界.天数, 31); // 基础 30 日
  assert.match(intent.hints.join('\n'), /修为 0 → 16/);
  assert.match(intent.hints.join('\n'), /本次 \+16/);
});

test('runTurn（修炼）：引擎效果与模型效果都落地', async () => {
  const state = baseState();
  const r = await runTurn({
    action: { kind: 'cultivate', text: '闭关' },
    state,
    index: INDEX,
    llm: stubLlm({ verdict: { effects: [{ op: 'delta', target: '主角.道心', value: 3 }], choices: [] } }),
    rng: makeRng(3),
  });
  assert.equal(state.主角.修为, 16);
  assert.equal(state.主角.道心, 53);
  assert.equal(r.applied.skipped, 0);
  assert.equal(state.世界.天数, 31);
});

test('runTurn（突破）：引擎掷骰并给出判定结果，且可复现', async () => {
  const run = async (seed) => {
    const state = baseState();
    state.主角.修为 = 100;
    const r = await runTurn({
      action: { kind: 'breakthrough', text: '冲击筑基' },
      state,
      index: INDEX,
      llm: stubLlm({ verdict: { effects: [], choices: [] } }),
      rng: makeRng(seed),
    });
    return { r, state };
  };
  const a = await run(7);
  const b = await run(7);
  assert.equal(a.r.duel.win, b.r.duel.win);
  assert.ok(a.r.duel.chance > 0 && a.r.duel.chance <= 0.95);
  assert.equal(a.state.世界.天数, 4); // +3 日
  assert.match(a.r.narrative, /凝神引气/);
});

/* ----------------------------- 降级 ----------------------------- */
test('runTurn：叙事失败时降级为离线文本，时间照常推进，状态不被模型污染', async () => {
  const state = baseState();
  const r = await runTurn({
    action: { kind: 'free', text: '探索' },
    state,
    index: INDEX,
    llm: stubLlm({ streamThrows: true }),
    rng: makeRng(4),
    fallbackNarratives: ['（离线示例文本）'],
  });
  assert.equal(r.source, 'fallback');
  assert.equal(r.narrative, '（离线示例文本）');
  assert.deepEqual(r.effects, []);
  assert.notEqual(state.世界.时段, '清晨');
  assert.ok(r.logs.some((l) => l.includes('降级')));
});

test('runTurn：完全没有 llm 时也能跑完（纯引擎推进）', async () => {
  const state = baseState();
  const r = await runTurn({ action: { kind: 'free', text: '走' }, state, index: INDEX, llm: null, rng: makeRng(5) });
  assert.equal(r.source, 'fallback');
  assert.ok(r.narrative.length > 0);
  assert.equal(state.世界.天数, 1);
});

test('runTurn：裁决失败但叙事成功时，正文保留、状态不落地', async () => {
  const state = baseState();
  const r = await runTurn({
    action: { kind: 'free', text: '施法' },
    state,
    index: INDEX,
    llm: stubLlm({ verdict: undefined }), // completeJson 抛错
    rng: makeRng(6),
  });
  assert.equal(r.narrative, '你凝神引气。');
  assert.deepEqual(r.effects, []);
  assert.ok(r.logs.some((l) => l.includes('裁决失败')));
});

/* ----------------------------- 检索降级与遭遇 ----------------------------- */
test('runTurn：索引为 null 时只注入常驻法则，不崩', async () => {
  const state = baseState();
  const r = await runTurn({
    action: { kind: 'free', text: '走' },
    state,
    index: null,
    llm: stubLlm({ verdict: { effects: [], choices: [] } }),
    rng: makeRng(7),
  });
  assert.equal(r.meta.retrieve.count, 0);
  assert.ok(r.narrative.length > 0);
});

test('runTurn：遭遇冷却归零时抽到候选，并写进 hints', async () => {
  const state = baseState();
  state.世界.遭遇冷却 = 0;
  const r = await runTurn({
    action: { kind: 'free', text: '在山道上走' },
    state,
    index: INDEX,
    llm: stubLlm({ verdict: { effects: [], choices: [] } }),
    rng: makeRng(8),
  });
  assert.ok(r.encounter, '应触发一次遭遇');
  assert.ok(r.encounter.name.length > 0);
  assert.equal(state.世界.遭遇冷却, 6); // 重置
});

test('runTurn：冷却未归零时不触发遭遇', async () => {
  const state = baseState();
  state.世界.遭遇冷却 = 3;
  const r = await runTurn({
    action: { kind: 'free', text: '走' },
    state,
    index: INDEX,
    llm: stubLlm({ verdict: { effects: [], choices: [] } }),
    rng: makeRng(9),
  });
  assert.equal(r.encounter, null);
  assert.equal(state.世界.遭遇冷却, 2);
});

/* ----------------------------- 提示词元信息 ----------------------------- */
test('runTurn：返回提示词分层元信息，便于排查上下文构成', async () => {
  const state = baseState();
  const r = await runTurn({
    action: { kind: 'free', text: '走' },
    state,
    index: INDEX,
    llm: stubLlm({ verdict: { effects: [], choices: [] } }),
    rng: makeRng(10),
  });
  const names = r.meta.prompt.layers.map((l) => l.name);
  assert.ok(names.includes('L0'));
  assert.ok(names.includes('L1'));
  assert.ok(r.meta.prompt.totalTokens > 0);
});

test('advanceTime：只走时段时天数不变；跨日时时段回到清晨', () => {
  const w = { 天数: 2, 时段: '黄昏' };
  advanceTime(w, 0);
  assert.equal(w.天数, 2);
  assert.equal(w.时段, '入夜');
  advanceTime(w, 0);
  assert.equal(w.天数, 3);
  assert.equal(w.时段, '清晨');
});
