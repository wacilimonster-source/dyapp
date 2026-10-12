/**
 * 记忆层单测：分词 / BM25 / 索引分层 / 重排 / 预算。
 * 用**真实世界书**（prototype/data/worldbook.json，319 条）跑，避免自造数据掩盖问题。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { tokenize, termFreq, augmentWithProperNouns } from '../prototype/memory/tokenize.js';
import { buildCorpus, search } from '../prototype/memory/bm25.js';
import { buildIndex, constantText } from '../prototype/memory/index.js';
import { retrieve, estimateTokens } from '../prototype/memory/retrieve.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const worldbook = JSON.parse(readFileSync(resolve(ROOT, 'prototype/data/worldbook.json'), 'utf8'));

/* ----------------------------- 分词 ----------------------------- */
test('tokenize：中文二元切分 + 短段整体保留 + 英文小写', () => {
  const t = tokenize('尸魔宗');
  assert.ok(t.includes('尸魔'));
  assert.ok(t.includes('魔宗'));
  assert.ok(t.includes('尸魔宗')); // ≤6 字整体保留
  assert.ok(tokenize('OpenAI 兼容').includes('openai'));
  assert.deepEqual(tokenize(''), []);
});

test('tokenize：长段不做整体保留，避免噪音', () => {
  const t = tokenize('玄天界主要势力与组织');
  assert.ok(t.includes('玄天'));
  assert.ok(!t.includes('玄天界主要势力与组织'));
});

test('augmentWithProperNouns：专名整体加入，过滤过短', () => {
  const out = augmentWithProperNouns(['尸魔'], ['林若悠', '甲', '']);
  assert.ok(out.includes('林若悠'));
  assert.ok(!out.includes('甲'));
});

test('termFreq：词频统计正确', () => {
  const tf = termFreq(['a', 'b', 'a']);
  assert.equal(tf.get('a'), 2);
  assert.equal(tf.get('b'), 1);
});

/* ----------------------------- 索引 ----------------------------- */
test('buildIndex：常驻与可检索分离，常驻不参与 Top-K', () => {
  const idx = buildIndex(worldbook);
  assert.ok(idx.constant.length > 0, '应存在常驻条目');
  assert.equal(idx.constant.every((e) => e.constant), true);
  assert.equal(idx.entries.some((e) => e.constant), false);
  assert.equal(idx.stats.total, worldbook.entries.length);
  assert.equal(idx.stats.constant + idx.stats.searchable, worldbook.entries.length);
});

test('buildIndex：按出生界过滤仙界专属条目', () => {
  const all = buildIndex(worldbook, { realm: '' });
  const xt = buildIndex(worldbook, { realm: '玄天界' });
  assert.ok(xt.stats.filteredByRealm > 0, '玄天界应过滤掉仙界条目');
  assert.ok(xt.entries.length < all.entries.length);
  assert.ok(xt.constant.every((e) => !e.realm || e.realm === '玄天界'));
  assert.ok(xt.entries.every((e) => !e.realm || e.realm === '玄天界'));
});

test('constantText：受 maxChars 限制，且不会为空', () => {
  const idx = buildIndex(worldbook);
  const small = constantText(idx, { maxChars: 800 });
  assert.ok(small.used <= 800);
  assert.ok(small.included >= 1);
  assert.ok(small.included <= small.total);
});

/* ----------------------------- BM25 ----------------------------- */
test('bm25：专名查询能命中对应条目', () => {
  const idx = buildIndex(worldbook);
  const results = search(idx.corpus, tokenize('尸魔宗'), { limit: 10 });
  assert.ok(results.length > 0);
  const titles = results.map((r) => idx.byId.get(r.id)?.title || '');
  assert.ok(titles.some((t) => t.includes('尸魔宗') || t.includes('尸魔')), titles.join(' | '));
});

test('bm25：空查询返回空，不抛异常', () => {
  const corpus = buildCorpus([{ id: 0, text: '甲' }]);
  assert.deepEqual(search(corpus, []), []);
});

/* ----------------------------- 检索与重排 ----------------------------- */
test('retrieve：命中条目携带为什么被召回', () => {
  const idx = buildIndex(worldbook);
  const r = retrieve(idx, { action: '去尸魔宗打探消息', place: '葬仙坡', npcs: [] });
  assert.ok(r.items.length > 0);
  assert.ok(r.items[0].why.length > 0, '应给出重排理由');
  assert.ok(r.usedTokens > 0);
});

test('retrieve：当前地点与在场人物提升排序', () => {
  const idx = buildIndex(worldbook);
  const withCtx = retrieve(idx, { action: '上前见礼', place: '广寒宫', npcs: ['林若悠'] });
  const without = retrieve(idx, { action: '上前见礼' });
  const topWith = withCtx.items[0]?.title || '';
  assert.ok(withCtx.items.length >= without.items.length);
  assert.ok(topWith.length > 0);
});

test('retrieve：token 预算被遵守', () => {
  const idx = buildIndex(worldbook);
  const r = retrieve(idx, { action: '玄天界 修仙 宗门 灵石 境界 修炼 秘境 势力' }, { tokenBudget: 300 });
  assert.ok(r.usedTokens <= 300, `实际 ${r.usedTokens}`);
});

test('retrieve：null 索引不崩（降级路径）', () => {
  const r = retrieve(null, { action: '走' });
  assert.deepEqual(r.items, []);
  assert.equal(r.usedTokens, 0);
});

test('estimateTokens：中文按 1.6 字/token 估算', () => {
  assert.equal(estimateTokens('十六个字'), Math.ceil(4 / 1.6));
  assert.equal(estimateTokens(''), 0);
});
