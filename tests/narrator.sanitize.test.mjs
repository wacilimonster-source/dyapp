/**
 * 状态标记清洗（真机实测回归）。
 *
 * 背景：卡片的「状态栏 / 变量输出格式」世界书条目本身就在"教模型吐标记"。
 * 它们一度被当成常驻法则注入 L1，于是真机上正文里真的长出了一整块
 * `<data_block>`（`<threat_level>` / `<inventory>` / `<skills>`）。
 * 记忆层已排除这些条目，这里锁住第二道防线：无论模型漏出什么，界面都不能显示。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeNarrative, stateBlockIndex } from '../prototype/narrator/parse.js';

test('sanitizeNarrative：剥掉完整的 data_block', () => {
  const raw = '雨声落下来。\n\n<data_block>\n<threat_level>无</threat_level>\n<inventory>旧衣袍</inventory>\n</data_block>\n';
  const clean = sanitizeNarrative(raw);
  assert.equal(clean, '雨声落下来。');
  assert.ok(!clean.includes('threat_level'));
  assert.ok(!clean.includes('data_block'));
});

test('sanitizeNarrative：未闭合的块从开标签截断到结尾', () => {
  assert.equal(sanitizeNarrative('你走进雨里。\n<UpdateVariable>\n{部分 JSON 没写完'), '你走进雨里。');
  assert.equal(sanitizeNarrative('你走进雨里。\n<data_block>'), '你走进雨里。');
});

test('sanitizeNarrative：各类标记都清掉，正文保留', () => {
  const raw = '甲<UpdateVariable>x</UpdateVariable>乙<Analysis>y</Analysis>丙<StatusPlaceHolderImpl/>丁';
  assert.equal(sanitizeNarrative(raw), '甲乙丙丁');
});

test('sanitizeNarrative：干净正文原样保留，只压多余空行', () => {
  assert.equal(sanitizeNarrative('第一段。\n\n\n\n第二段。'), '第一段。\n\n第二段。');
  assert.equal(sanitizeNarrative(''), '');
  assert.equal(sanitizeNarrative(null), '');
});

test('sanitizeNarrative：只出现"状态"字样但无标签时不误伤', () => {
  const raw = '他翻看自己的状态，又摸了摸储物袋。';
  assert.equal(sanitizeNarrative(raw), raw);
});

test('stateBlockIndex：流式截断用的开标签定位', () => {
  assert.equal(stateBlockIndex('正常正文'), -1);
  assert.equal(stateBlockIndex('正文<data_block>'), 2);
  assert.equal(stateBlockIndex('正文<UpdateVariable>'), 2);
  assert.equal(stateBlockIndex('正文<Analysis>'), 2);
  assert.equal(stateBlockIndex('提到 data_block 但没有尖括号'), -1);
});
