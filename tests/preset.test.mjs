/**
 * 预设解析与宏渲染的测试。
 *
 * fixture 是按实测的 ST 形状手写的（含 12 条内置 prompts、prompt_order 两组、
 * 两类自定义条目），**不依赖本机是否装了 SillyTavern**，所以 CI 也能跑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parsePreset, resolveOrder, toStPreset, SUPPORTED_SAMPLING, DUMMY_ID_DEFAULT,
} from '../prototype/preset/schema.js';
import { renderMacros, splitArgs, rollDice, SUPPORTED_MACROS } from '../prototype/preset/macros.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = readFileSync(resolve(ROOT, 'tests/fixtures/st-preset.sample.json'), 'utf8');

/* ============================ schema ============================ */

test('parsePreset：解析真实的 ST 形状', () => {
  const r = parsePreset(FIXTURE);
  assert.equal(r.ok, true, r.error);
  const p = r.preset;
  assert.equal(p.entries.length, 13);
  assert.equal(p.order.length, 14);
  assert.equal(p.orderGroup, DUMMY_ID_DEFAULT, '应选 character_id=100000 那一组');
});

test('parsePreset：marker 与可编辑条目区分正确', () => {
  const { preset } = parsePreset(FIXTURE);
  const markers = preset.entries.filter((e) => e.marker).map((e) => e.identifier);
  assert.ok(markers.includes('chatHistory'));
  assert.ok(markers.includes('worldInfoBefore'));
  assert.ok(!markers.includes('main'), 'main 不是 marker');
  const main = preset.entries.find((e) => e.identifier === 'main');
  assert.equal(main.builtin, true);
  assert.equal(main.role, 'system');
});

test('parsePreset：system_prompt=false 视为用户自建条目', () => {
  const { preset } = parsePreset(FIXTURE);
  assert.equal(preset.entries.find((e) => e.identifier === 'custom-1').builtin, false);
  assert.equal(preset.entries.find((e) => e.identifier === 'main').builtin, true);
});

test('parsePreset：自定义条目的注入字段被读出来', () => {
  const { preset } = parsePreset(FIXTURE);
  const deep = preset.entries.find((e) => e.identifier === 'custom-1');
  assert.equal(deep.injectionPosition, 1);
  assert.equal(deep.injectionDepth, 2);
  const trig = preset.entries.find((e) => e.identifier === 'custom-2');
  assert.deepEqual(trig.injectionTrigger, ['看墙', '查探']);
});

test('parsePreset：采样参数只收已知项，未知项进 ignoredKeys 而不丢', () => {
  const { preset } = parsePreset(FIXTURE);
  assert.equal(preset.sampling.temperature, 0.85);
  assert.equal(preset.sampling.top_p, 0.95);
  assert.equal(preset.sampling.openai_max_tokens, 512);
  assert.equal(preset.sampling.top_k, 40, 'top_k 属于"收到的片段"，由上层决定是否透传');
  assert.ok(preset.ignoredKeys.includes('openai_model'));
  assert.ok(preset.ignoredKeys.includes('custom_url'));
  assert.ok(preset.ignoredKeys.includes('unknown_future_key_we_do_not_understand'), '未知键必须保留在 raw 里');
  assert.ok(preset.raw.unknown_future_key_we_do_not_understand, 'raw 必须原样保留');
});

test('parsePreset：宽容包装 {preset:{…}} 与 {settings:{…}}', () => {
  const inner = JSON.parse(FIXTURE);
  for (const wrap of ['preset', 'settings']) {
    const r = parsePreset({ [wrap]: inner });
    assert.equal(r.ok, true, wrap);
    assert.equal(r.preset.entries.length, 13);
  }
});

test('parsePreset：拒绝不像预设的输入', () => {
  assert.equal(parsePreset('不是 JSON').ok, false);
  assert.equal(parsePreset('[1,2,3]').ok, false);
  assert.equal(parsePreset('{"foo":1}').ok, false);
  assert.equal(parsePreset({ prompts: [] }).ok, false);
  const r = parsePreset({ prompts: [{ name: '没 identifier' }] });
  assert.equal(r.ok, false);
});

test('resolveOrder：没有 prompt_order 时回退为"全启用"', () => {
  const warnings = [];
  const r = resolveOrder(undefined, warnings);
  assert.equal(r.order, null);
  assert.equal(r.whichGroup, 'fallback');
  assert.ok(warnings.length > 0);
});

test('resolveOrder：缺少 100000 组时退回第一组并告警', () => {
  const warnings = [];
  const r = resolveOrder([{ character_id: 42, order: [{ identifier: 'main', enabled: true }] }], warnings);
  assert.equal(r.whichGroup, 42);
  assert.ok(warnings.some((w) => w.includes('100000')));
});

test('SUPPORTED_SAMPLING：不包含非标准项（严格端点会 400）', () => {
  for (const k of ['top_k', 'top_a', 'min_p', 'repetition_penalty']) {
    assert.ok(!SUPPORTED_SAMPLING.includes(k), k + ' 不应被当作文档化的支持项');
  }
});

test('toStPreset：导出的结构能被自己解析回去（往返一致）', () => {
  const st = toStPreset({ name: '测试', main: '你是 {{char}}' });
  const r = parsePreset(st);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.preset.orderGroup, DUMMY_ID_DEFAULT);
  assert.ok(r.preset.entries.some((e) => e.identifier === 'chatHistory' && e.marker));
});

/* ============================ macros ============================ */

test('renderMacros：简单宏按上下文替换', () => {
  const r = renderMacros('{{char}} 与 {{user}} 在 {{scenario}}（{{date}}）相遇。', {
    charName: '道渊', userName: '陆沉', scenario: '青石镇', date: '第 3 日',
  });
  assert.equal(r.text, '道渊 与 陆沉 在 青石镇（第 3 日）相遇。');
  assert.deepEqual(r.warnings, []);
});

test('renderMacros：{{newline}} 与 {{noop}}', () => {
  const r = renderMacros('甲{{newline}}乙{{noop}}丙', {});
  assert.equal(r.text, '甲\n乙丙');
});

test('renderMacros：未知宏原样保留并告警一次', () => {
  const r = renderMacros('{{char}} 用了 {{未实现宏}}，又用了一次 {{未实现宏}}', { charName: '道渊' });
  assert.ok(r.text.includes('{{未实现宏}}'), '未知宏必须原样保留');
  assert.equal(r.warnings.length, 1, '同一个未知宏只告警一次');
});

test('splitArgs：逗号与 :: 两种分隔符都支持', () => {
  assert.deepEqual(splitArgs('a, b ,c'), ['a', 'b', 'c']);
  assert.deepEqual(splitArgs('a::b::c'), ['a', 'b', 'c']);
  assert.deepEqual(splitArgs(''), []);
});

test('rollDice：NdM 在范围内且可复现', () => {
  const rng = () => 0.5;
  assert.equal(rollDice('1d6', rng), '4');
  assert.equal(rollDice('2d6', rng), '8');
  assert.equal(rollDice('d6', rng), '4');
  assert.equal(rollDice('不是骰子', rng), '不是骰子');
});

test('renderMacros：{{random}} 真的会随机（决策 D5：用真随机）', () => {
  const out = new Set();
  for (let i = 0; i < 60; i++) out.add(renderMacros('{{random 甲,乙,丙}}', {}).text);
  assert.ok(out.size > 1, '真随机应产生多种结果');
  for (const v of out) assert.ok(['甲', '乙', '丙'].includes(v));
});

test('SUPPORTED_MACROS：包含随机类宏', () => {
  assert.ok(SUPPORTED_MACROS.some((m) => m.includes('random')));
  assert.ok(SUPPORTED_MACROS.some((m) => m.includes('char')));
});
