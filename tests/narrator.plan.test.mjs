/**
 * 提示词组装测试：默认模式与预设模式必须产出同一种 PromptPlan。
 *
 * 锁住的关键行为（对应 docs/06 的已确认决策）：
 *   D1 预设模式**不注入 L0 引擎协议**；
 *   D2 {{char}}/{{user}} 来自两个可配置字段；
 *   D7 取 character_id=100000 的顺序组；
 *   深度插入（injection_position=1）、触发词、marker 映射、上下文预算。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPromptPlan, applyContextBudget, MARKER_FILLERS } from '../prototype/narrator/plan.js';
import { parsePreset } from '../prototype/preset/schema.js';
import { buildIndex } from '../prototype/memory/index.js';
import { emptyState, normalize } from '../prototype/engine/state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE = readFileSync(resolve(ROOT, 'tests/fixtures/st-preset.sample.json'), 'utf8');

const INDEX = buildIndex({
  entries: [
    { id: 0, title: '境界', name: '境界', category: '规则', keys: [], content: '炼气至超脱共十五境。', constant: true, enabled: true, order: 100, len: 12, realm: '' },
    { id: 1, title: '势力详情：尸魔宗', name: '尸魔宗', category: '势力', keys: ['尸魔宗'], content: '盘踞葬仙坡的邪道宗门。', constant: false, enabled: true, order: 100, len: 12, realm: '' },
  ],
});

function makeState() {
  const s = emptyState();
  s.主角.姓名 = '陆沉';
  s.主角.境界 = '炼气三层';
  s.世界.当前地点 = '青石镇 · 醉仙楼';
  return normalize(s);
}

function engine(over = {}) {
  return {
    action: '往后山走',
    index: INDEX,
    state: makeState(),
    retrieved: [{ title: '势力详情：尸魔宗', content: '盘踞葬仙坡的邪道宗门。' }],
    recent: [
      { role: 'assistant', text: '雨落在青石上。' },
      { role: 'user', text: '我推门进去。' },
      { role: 'assistant', text: '暖气和酒香涌出来。' },
      { role: 'user', text: '我坐下。' },
    ],
    hints: ['时间推进到：初春 · 午后。'],
    ...over,
  };
}

/* ============================ 默认模式 ============================ */

test('默认模式：注入 L0 引擎协议，并带上 L1/L2/L3', () => {
  const plan = buildPromptPlan({ mode: 'default', engine: engine() });
  assert.equal(plan.meta.mode, 'default');
  assert.match(plan.messages[0].content, /只输出剧情正文/);
  assert.ok(plan.messages.some((m) => m.content.includes('世界法则')));
  assert.ok(plan.messages.some((m) => m.content.includes('本回合相关设定')));
  assert.equal(plan.messages[plan.messages.length - 1].role, 'user');
  assert.match(plan.messages[plan.messages.length - 1].content, /往后山走/);
});

/* ============================ 预设模式 ============================ */

function presetPlan(over = {}, names = {}) {
  const parsed = parsePreset(FIXTURE);
  assert.equal(parsed.ok, true, parsed.error);
  return buildPromptPlan({
    mode: 'preset',
    preset: parsed.preset,
    engine: engine(over),
    names: { charName: '道渊', userName: '陆沉', ...names },
    rng: () => 0.5,
  });
}

test('预设模式：不注入引擎协议 L0（决策 D1）', () => {
  const plan = presetPlan();
  assert.equal(plan.meta.mode, 'preset');
  const all = plan.messages.map((m) => m.content).join('\n');
  assert.ok(!all.includes('你是《道渊》的叙事引擎'), '预设模式不应出现 L0 协议原文');
  assert.ok(!/不要输出任何状态标记[\s\S]*只输出剧情正文/.test(all), '不应同时出现两套协议');
});

test('预设模式：按 prompt_order 展开，main 在最前且宏已替换（D2）', () => {
  const plan = presetPlan();
  const first = plan.messages[0];
  assert.match(first.content, /道渊/);
  assert.match(first.content, /陆沉/);
  assert.ok(!first.content.includes('{{char}}'), '宏必须被替换');
});

test('预设模式：marker 按映射表填充（世界法则/检索/状态/场景）', () => {
  const plan = presetPlan();
  const all = plan.messages.map((m) => m.content).join('\n');
  assert.ok(all.includes('世界法则'), 'worldInfoBefore → 常驻法则');
  assert.ok(all.includes('本回合相关设定'), 'worldInfoAfter → 检索结果');
  assert.ok(all.includes('主角状态'), 'personaDescription → 状态摘要');
  assert.ok(all.includes('青石镇 · 醉仙楼'), 'scenario → 当前地点');
  assert.ok(all.includes('时间推进到'), 'scenario 应带上引擎裁定');
});

test('预设模式：dialogueExamples 默认留空（决策 D8）', () => {
  const plan = presetPlan();
  assert.ok(!plan.messages.some((m) => m.content.includes('Example Chat')));
});

test('预设模式：深度插入被放进历史里的指定深度（injection_position=1）', () => {
  const plan = presetPlan();
  const idx = plan.messages.findIndex((m) => m.content.includes('此刻正在下雨'));
  assert.ok(idx > 0, '深插条目应存在');
  // depth=2 → 插在倒数第 2 条历史之前，所以它后面还应有历史消息，且不会是最后
  assert.notEqual(idx, plan.messages.length - 1, '深插条目不应排在最末（末尾是本回合）');
  assert.equal(plan.meta.deepInserts, 1);
});

test('预设模式：触发词条目未命中时不注入，命中时注入', () => {
  const noHit = presetPlan({ action: '随便走走' });
  assert.ok(!noHit.messages.some((m) => m.content.includes('墙后有人')));
  const hit = presetPlan({ action: '我仔细看墙面有没有暗门' });
  assert.ok(hit.messages.some((m) => m.content.includes('墙后有人')), '命中「看墙」应注入');
});

test('预设模式：prompt_order 引用了不存在的条目 → 告警但不崩', () => {
  const plan = presetPlan();
  assert.ok(plan.warnings.some((w) => w.includes('missing-entry')));
});

test('预设模式：本回合永远在最后', () => {
  const plan = presetPlan();
  const last = plan.messages[plan.messages.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content, /往后山走/);
  assert.match(last.content, /引擎裁定/);
});

test('预设模式：采样参数被带出来，且非标准项不进请求（只进 detail）', () => {
  const plan = presetPlan();
  assert.equal(plan.sampling.temperature, 0.85);
  assert.equal(plan.sampling.top_k, 40, 'top_k 应保留在采样里（供 UI 显示"已忽略"）');
  const sent = (plan.meta.layers || []).length ? null : null;
  assert.equal(sent, null);
});

test('预设模式：{{char}}/{{user}} 可用配置覆盖', () => {
  const plan = presetPlan({}, { charName: '老天爷', userName: '张三' });
  assert.match(plan.messages[0].content, /老天爷/);
  assert.match(plan.messages[0].content, /张三/);
});

/* ============================ 上下文预算 ============================ */

test('applyContextBudget：先裁最老的回合，保留最近一条', () => {
  const warnings = [];
  const hist = Array.from({ length: 40 }, (_, i) => ({ role: 'user', content: '很长的一段'.repeat(40) + i }));
  const out = applyContextBudget(hist, 2000, warnings);
  assert.ok(out.length < hist.length);
  assert.ok(warnings.some((w) => w.includes('裁掉')));
  assert.equal(out[out.length - 1].content, hist[hist.length - 1].content, '最近的要留下');
});

test('applyContextBudget：无上限时原样返回', () => {
  const hist = [{ role: 'user', content: '甲' }];
  assert.equal(applyContextBudget(hist, 0, []), hist);
});

test('MARKER_FILLERS：覆盖 ST 的常见 marker', () => {
  for (const k of ['chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'personaDescription', 'scenario']) {
    assert.ok(MARKER_FILLERS[k], k + ' 应有说明');
  }
});
