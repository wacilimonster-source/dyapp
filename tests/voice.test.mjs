import test from 'node:test';
import assert from 'node:assert/strict';
import { pickSpiritLine, pickSpiritLineFor } from '../prototype/engine/voice.js';

const LINES = ['年轻人，急躁是道途大忌。', '山雨欲来，收敛气息为上。', '此地的灵脉在动。'];

test('器灵台词：正常抽取、空池安全', () => {
  assert.ok(LINES.includes(pickSpiritLine(LINES, { rng: () => 0.5 })));
  assert.equal(pickSpiritLine([], {}), null);
  assert.equal(pickSpiritLine(null), null);
  assert.equal(pickSpiritLine(['   ', ''], {}), null, '全是空白也算没台词');
});

test('器灵台词：尽量不连抽同一句（rng 可注入复现）', () => {
  const a = pickSpiritLine(LINES, { rng: () => 0.99, avoid: '此地的灵脉在动。' });
  assert.notEqual(a, '此地的灵脉在动。');
  // 只剩一句且恰好是 avoid：允许返回它（没有别的可选，不能返回 null 假装有台词）
  assert.equal(pickSpiritLine(['独一句', { rng: true }].slice(0, 1), { avoid: '独一句' }), '独一句');
});

test('器灵台词：分场合结构（未来台词库分家后的入口）', () => {
  const byOcc = { breakthrough: ['破关时：莫忘本心。'], idle: ['闲时：且看云起。'] };
  assert.equal(pickSpiritLineFor(byOcc, 'breakthrough', { rng: () => 0 }), '破关时：莫忘本心。');
  assert.equal(pickSpiritLineFor(byOcc, 'idle', { rng: () => 0 }), '闲时：且看云起。');
  // 旧形状（纯数组）任何场合都能用
  assert.ok(LINES.includes(pickSpiritLineFor(LINES, 'idle', { rng: () => 0 })));
});
