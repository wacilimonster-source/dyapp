/**
 * 叙事层单测：裁决结果解析容错 + 提示词分层与预算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { extractJson, validateEffect, parseTurnResult, pickNarrative } from '../prototype/narrator/parse.js';
import { composeNarrative, composeArbiter, retrievedBlock, L0_PROTOCOL, LAYER_BUDGET } from '../prototype/narrator/prompt.js';
import { buildIndex, constantText } from '../prototype/memory/index.js';
import { emptyState, normalize } from '../prototype/engine/state.js';
import { estimateTokens } from '../prototype/memory/retrieve.js';

const INDEX = buildIndex({
  entries: [
    { id: 0, title: '境界', name: '境界', category: '规则', keys: [], content: '炼气至超脱共十五境。', constant: true, enabled: true, order: 100, len: 12, realm: '' },
    { id: 1, title: '详细人物:林若悠', name: '林若悠', category: '人物', keys: ['林若悠'], content: '玉灵宫圣女，空明幻体。', constant: false, enabled: true, order: 100, len: 12, realm: '玄天界' },
  ],
});

/* ----------------------------- 解析 ----------------------------- */
test('extractJson：容忍代码围栏与前后废话', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('好的，结果如下：\n{"a":1}\n以上。'), { a: 1 });
  assert.equal(extractJson('完全不是 JSON'), null);
  assert.equal(extractJson(''), null);
});

test('validateEffect：四种 op 的合法性与字段校验', () => {
  assert.equal(validateEffect({ op: 'delta', target: '主角.灵力', value: -5 }).ok, true);
  assert.equal(validateEffect({ op: 'set', target: '世界.当前地点', value: 'x' }).ok, true);
  assert.equal(validateEffect({ op: 'add', target: '人物.甲', value: {} }).ok, true);
  assert.equal(validateEffect({ op: 'remove', target: '人物.甲' }).ok, true);

  assert.equal(validateEffect({ op: 'drop', target: '主角.灵力' }).ok, false);
  assert.equal(validateEffect({ op: 'delta', target: '主角.灵力' }).ok, false); // 缺 value
  assert.equal(validateEffect({ op: 'delta', target: '', value: 1 }).ok, false);
  assert.equal(validateEffect(null).ok, false);
  assert.equal(validateEffect([]).ok, false);
  assert.equal(validateEffect({ op: 'delta', target: '主角.灵力', value: 'NaN' }).ok, false);
});

test('validateEffect：remove 不带 value，reason 截断', () => {
  const r = validateEffect({ op: 'remove', target: '人物.甲', value: 'ignore', reason: 'x'.repeat(200) });
  assert.equal('value' in r.effect, false);
  assert.equal(r.effect.reason.length, 60);
});

test('parseTurnResult：坏条目丢弃、好条目保留，并给出日志', () => {
  const raw = {
    effects: [
      { op: 'delta', target: '主角.灵力', value: -12, reason: '御剑' },
      { op: 'oops', target: '主角.生命', value: -5 },
      { target: '主角.生命', value: -5 },
      'not an object',
    ],
    scene: { 当前地点: '青石镇 · 醉仙楼', 危机程度: '低', 天气: '细雨', 未知字段: '忽略我' },
    choices: ['继续修炼', '去坊市看看', '找师姐说话', '第四项会被截断', '第五项'],
  };
  const r = parseTurnResult(raw);
  assert.equal(r.effects.length, 1);
  assert.equal(r.logs.length, 3);
  assert.equal('未知字段' in r.scene, false);
  assert.equal(r.scene.当前地点, '青石镇 · 醉仙楼');
  assert.equal(r.choices.length, 4);
});

test('parseTurnResult：非法危机程度与超长 choices 被挡下', () => {
  const r = parseTurnResult({ scene: { 危机程度: '灭世' }, choices: ['x'.repeat(80)] });
  assert.equal('危机程度' in r.scene, false);
  assert.ok(r.logs.some((l) => l.includes('危机程度')));
  assert.equal(r.choices[0].length, 40);
});

test('parseTurnResult：完全不是 JSON 时不抛异常，返回空结果 + 日志', () => {
  const r = parseTurnResult('模型今天不想干活');
  assert.deepEqual(r.effects, []);
  assert.deepEqual(r.scene, {});
  assert.equal(r.logs.length, 1);
});

test('parseTurnResult：effects 过多被截断到 40 条并告警', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ op: 'set', target: `主角.状态`, value: `s${i}` }));
  const r = parseTurnResult({ effects: many });
  assert.equal(r.effects.length, 40);
  assert.ok(r.logs.some((l) => l.includes('过多')));
});

test('pickNarrative：从多个候选字段里取正文', () => {
  assert.equal(pickNarrative({ narrative: '甲' }), '甲');
  assert.equal(pickNarrative({ text: '乙' }), '乙');
  assert.equal(pickNarrative({ content: '丙' }), '丙');
  assert.equal(pickNarrative('丁'), '丁');
  assert.equal(pickNarrative({}), '');
});

/* ----------------------------- 提示词分层 ----------------------------- */
function makeState() {
  const s = emptyState();
  s.主角.姓名 = '陆沉';
  normalize(s);
  return s;
}

test('composeNarrative：层序固定，L0 恒定且在最前', () => {
  const { messages, meta } = composeNarrative({
    action: '往后山走',
    index: INDEX,
    state: makeState(),
    recent: [{ role: 'user', text: '你好' }, { role: 'assistant', text: '夜色渐深。' }],
  });
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[0].content, L0_PROTOCOL);
  assert.equal(messages[messages.length - 1].role, 'user');
  assert.match(messages[messages.length - 1].content, /往后山走/);
  const names = meta.layers.map((l) => l.name);
  assert.deepEqual(names, ['L0', 'L1', 'L3', 'L4', 'L5']);
});

test('composeNarrative：同样的 L0/L1 内容逐字相同（前缀缓存前提）', () => {
  const a = composeNarrative({ action: '甲', index: INDEX, state: makeState() });
  const b = composeNarrative({ action: '乙', index: INDEX, state: makeState() });
  assert.equal(a.messages[0].content, b.messages[0].content);
  assert.equal(a.messages[1].content, b.messages[1].content);
});

test('composeNarrative：L4 超预算时丢最早的回合', () => {
  const recent = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: '这是一段很长的话'.repeat(30) }));
  const { meta, messages } = composeNarrative({ action: '继续', index: INDEX, state: makeState(), recent });
  assert.ok(meta.droppedTurns > 0, '应记录丢弃数');
  const l4 = meta.layers.find((l) => l.name === 'L4');
  assert.ok(l4.tokens <= LAYER_BUDGET.L4, `L4=${l4.tokens}`);
  assert.equal(messages[messages.length - 1].role, 'user');
});

test('composeNarrative：注入检索段（L2）并计入预算', () => {
  const retrieved = [{ title: '详细人物:林若悠', content: '玉灵宫圣女，空明幻体。', why: ['称号命中'] }];
  const { messages, meta } = composeNarrative({ action: '见礼', index: INDEX, state: makeState(), retrieved });
  assert.ok(messages.some((m) => m.content.includes('本回合相关设定')));
  assert.ok(meta.layers.some((l) => l.name === 'L2'));
});

test('composeNarrative：无索引时降级为 L0 + L3/L4/L5，不报错', () => {
  const { messages, meta } = composeNarrative({ action: '走', index: null, state: makeState() });
  assert.equal(messages[0].content, L0_PROTOCOL);
  assert.deepEqual(meta.layers.map((l) => l.name), ['L0', 'L3', 'L4', 'L5']);
});

test('composeNarrative：引擎裁定以 hints 形式进入本回合，不被裁掉', () => {
  const { messages } = composeNarrative({
    action: '闭关',
    index: INDEX,
    state: makeState(),
    hints: ['修炼结算：修为 +16，耗时 30 日。'],
  });
  const last = messages[messages.length - 1].content;
  assert.match(last, /引擎裁定/);
  assert.match(last, /修为 \+16/);
});

test('retrievedBlock：空输入返回空串', () => {
  assert.deepEqual(retrievedBlock([]), { content: '', tokens: 0 });
  const b = retrievedBlock([{ title: '甲', content: '乙' }]);
  assert.match(b.content, /【甲】/);
  assert.ok(b.tokens > 0);
});

/* ----------------------------- 裁决提示词 ----------------------------- */
test('composeArbiter：明确要求 JSON，且含 target 前缀说明与铁律', () => {
  const msgs = composeArbiter({
    action: '施展御剑术',
    narrative: '你掐诀，青纹剑化作一道青光。',
    state: makeState(),
    recent: [{ role: 'assistant', text: '风起了。' }],
    retrieved: [{ title: '境界', content: '十五境。' }],
  });
  assert.equal(msgs.length, 3);
  const sys = msgs[0].content;
  assert.match(sys, /只输出一个 JSON 对象/);
  assert.match(sys, /主角\.灵力/);
  assert.match(sys, /0–100/);
  assert.match(sys, /性格/);
  const user = msgs[2].content;
  assert.match(user, /施展御剑术/);
  assert.match(user, /青纹剑/);
});

test('composeArbiter：无检索结果时不出现空的设定段', () => {
  const msgs = composeArbiter({ action: 'a', narrative: 'b', state: makeState() });
  assert.ok(!msgs[1].content.includes('本回合相关设定'));
});

test('estimateTokens 与 L1 预算一致：常驻文本不超上限', () => {
  const L1 = constantText(INDEX, { maxChars: Math.round(LAYER_BUDGET.L1 * 1.6) });
  assert.ok(estimateTokens(L1.text) <= LAYER_BUDGET.L1 + 20);
});
