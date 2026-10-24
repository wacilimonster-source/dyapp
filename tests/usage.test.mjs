import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyUsage, record, formatBill, summary, compact } from '../prototype/ui/usage.js';

test('账单：record 不改入参，按日按档累计', () => {
  const b0 = emptyUsage();
  const usage = { promptTokens: 1000, completionTokens: 320, totalTokens: 1320, cachedTokens: 400 };
  const b1 = record(b0, { saveId: 's1', usage, ms: 8400 });
  assert.equal(b0.total.calls, 0, '入参账本不能被改');
  assert.equal(b1.total.calls, 1);
  assert.equal(b1.total.prompt, 1000);
  assert.equal(b1.total.cached, 400);
  const day = new Date().toISOString().slice(0, 10);
  assert.equal(b1.days[day].calls, 1, '按日明细要记');
  assert.equal(b1.saves.s1.calls, 1, '分档明细要记');
  assert.equal(record(b1, { saveId: 's2', usage: null, ms: 100 }).saves.s2.calls, 1, '没 usage 也要计次与耗时');
});

test('账单：formatBill 渠道不给 usage 时只报耗时，不编 token 数', () => {
  assert.equal(formatBill({ usage: null, ms: 4200 }), '4.2s');
  assert.equal(formatBill({}), '0.0s');
  const s = formatBill({ usage: { promptTokens: 1000, completionTokens: 320, cachedTokens: 400 }, ms: 8400 });
  assert.match(s, /≈1\.3k tok/);
  assert.match(s, /入 1\.0k /);
  assert.match(s, /出 320/);
  assert.match(s, /8\.4s/);
  assert.match(s, /缓存命中 40%/);
  const noCache = formatBill({ usage: { promptTokens: 100, completionTokens: 20, cachedTokens: null }, ms: 900 });
  assert.doesNotMatch(noCache, /缓存/, '没有 cachedTokens 就不显示缓存字样');
});

test('账单：summary 汇总与 compact 限长', () => {
  let b = emptyUsage();
  for (let i = 0; i < 3; i++) b = record(b, { saveId: 's1', usage: { promptTokens: 1000, completionTokens: 100 }, ms: 1000 });
  const s = summary(b);
  assert.equal(s.calls, 3);
  assert.match(s.tokens, /3\.3k tok/);
  assert.equal(s.avgSec, '1.0s');
  assert.equal(s.cached, '无数据', '没缓存数据时明说，而不是 0%');
  const many = { total: b.total, days: {}, saves: {} };
  for (let i = 1; i <= 120; i++) many.days[`2026-01-${String(i % 30 + 1).padStart(2, '0')}-${i}`] = { calls: 1 };
  const c = compact(many);
  assert.equal(Object.keys(c.days).length, 90, '按日只留最近 90 天');
});
