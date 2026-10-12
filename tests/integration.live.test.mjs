/**
 * 真实模型集成测试（**默认跳过**）。
 *
 * 只有显式提供环境变量时才运行，因此：
 *   - CI 永远不会执行它 → 密钥不会进仓库，也不会在流水线里泄漏；
 *   - 本地要测时，密钥只从环境变量读，不落盘、不进 git。
 *
 * 用法（PowerShell / Git Bash）：
 *   export DY_LLM_BASE_URL="https://opencode.ai/zen/go/v1"
 *   export DY_LLM_API_KEY="<你的 key>"
 *   export DY_LLM_MODEL="deepseek-v4.1-flash"
 *   node --test tests/integration.live.test.mjs
 *
 * 它跑的是**应用自己的代码**：narrator/prompt 组装 L0–L5 → 流式请求 →
 * narrator/parse 解析裁决 JSON → engine/effects 落地 → engine/state 归一化。
 * 也就是说，这个测试同时验证了提示词有效性、流式解析、结构化输出合规性与落地不变量。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runTurn } from '../prototype/engine/turn.js';
import { emptyState, normalize, snapshot } from '../prototype/engine/state.js';
import { buildIndex } from '../prototype/memory/index.js';
import { makeRng } from '../prototype/core/rng.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BASE = process.env.DY_LLM_BASE_URL || '';
const KEY = process.env.DY_LLM_API_KEY || '';
const MODEL = process.env.DY_LLM_MODEL || '';
const ARBITER = process.env.DY_LLM_ARBITER_MODEL || '';
const LIVE = !!(BASE && KEY && MODEL);

const skip = LIVE ? false : '未提供 DY_LLM_BASE_URL / DY_LLM_API_KEY / DY_LLM_MODEL，跳过真实模型测试';

/* ------------------------- 与 Rust 侧同构的 HTTP 适配器 ------------------------- */

function joinUrl(base, path) {
  const b = String(base).replace(/\/+$/, '');
  return path.startsWith('/') ? b + path : `${b}/${path}`;
}

/**
 * 实现 narrator/client.js 期望的 LlmLike 接口。
 * 行为对齐壳里的 llm.rs：Bearer 鉴权、SSE 逐行解析、json_object 模式。
 */
function httpLlm({ baseUrl, apiKey, model, arbiterModel, timeoutMs = 180000, temperature = 0.85 }) {
  // 部分网关（实测 opencodego）要求带会话 ID 头，否则 400/挂起。
  const session = process.env.DY_LLM_SESSION || `dyapp-${Date.now()}-4000-8000-000000000001`;
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    'x-opencode-session': session,
  };
  const body = (req, stream) => {
    const b = {
      model: req.useArbiter && arbiterModel ? arbiterModel : model,
      messages: req.messages,
      temperature: req.useArbiter ? 0.3 : temperature,
      stream,
    };
    if (stream) b.stream_options = { include_usage: true };
    if (req.jsonMode) b.response_format = { type: 'json_object' };
    return b;
  };

  return {
    async stream(req, onEvent) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(joinUrl(baseUrl, '/chat/completions'), {
          method: 'POST',
          headers,
          body: JSON.stringify(body(req, true)),
          signal: ctrl.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          onEvent({ type: 'error', data: { message: `HTTP ${res.status}: ${text.slice(0, 300)}` } });
          return;
        }
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(5).trim();
            if (payload === '[DONE]') continue;
            let v;
            try { v = JSON.parse(payload); } catch { continue; }
            const d = v.choices && v.choices[0] && v.choices[0].delta;
            // 只取 content：思维链（reasoning_content）由壳按卡设定丢弃，不进正文
            const piece = d && d.content;
            if (typeof piece === 'string' && piece) onEvent({ type: 'delta', data: { text: piece } });
          }
        }
        onEvent({ type: 'done', data: {} });
      } finally {
        clearTimeout(t);
      }
    },

    // 一律走流式累积：实测该渠道对 stream:false 会挂住不返回。
    async completeJson(req) {
      let acc = '';
      await this.stream(req, (ev) => {
        if (ev.type === 'delta') acc += ev.data.text;
        if (ev.type === 'error') throw new Error(ev.data.message);
      });
      const fence = acc.trim().match(/```(?:json)?\s*([\s\S]*?)```/i);
      return JSON.parse(fence ? fence[1].trim() : acc.trim());
    },
  };
}

function demoState() {
  const s = emptyState();
  Object.assign(s.主角, {
    姓名: '陆沉', 性别: '男', 境界: '炼气三层', 宗门: '青云宗 · 外门',
    灵根: '黄品 · 单灵根（火）', 所在界: '玄天界',
    生命: 92, 精血: 78, 灵力: 61, 修为: 42, 神识: 71, 道心: 55,
  });
  s.世界.当前地点 = '青石镇 · 醉仙楼';
  s.人物['宫银叶'] = { 性别: '女', 头衔: '醉仙楼老板娘', 境界: '筑基中期', 好感: 22, 关系阶段: '试探期', 生命: 80, 灵力: 70, 修为: 55, 道心: 60, 性格: '泼辣精明', 描述: '消息最灵通的人。' };
  return normalize(s);
}

const worldbook = JSON.parse(readFileSync(resolve(ROOT, 'prototype/data/worldbook.json'), 'utf8'));

/* ------------------------------- 测试 ------------------------------- */

test('真实模型：一回合走通「提示词 → 流式叙事 → 裁决 JSON → 引擎落地」', { skip }, async () => {
  const state = demoState();
  const index = buildIndex(worldbook, { realm: state.主角.所在界 });
  const llm = httpLlm({ baseUrl: BASE, apiKey: KEY, model: MODEL, arbiterModel: ARBITER });

  let firstDeltaAt = 0;
  const started = Date.now();
  const r = await runTurn({
    action: { kind: 'free', text: '向宫银叶打听后山失踪的采药人。' },
    state,
    index,
    llm,
    rng: makeRng(20261012),
    recent: [{ role: 'assistant', text: '雨丝斜斜地织着，你推开醉仙楼的木门。' }],
    arbiterConfigured: !!ARBITER,
    onDelta: () => { if (!firstDeltaAt) firstDeltaAt = Date.now(); },
    fallbackNarratives: [],
  });
  const elapsed = Date.now() - started;

  // 叙事必须真的来自模型（而不是降级文本）
  assert.equal(r.source, 'llm', `叙事降级了：${r.logs.join(' | ')}`);
  assert.ok(r.narrative.length >= 80, `叙事过短（${r.narrative.length} 字）：${r.narrative}`);
  assert.ok(firstDeltaAt > 0, '没有收到任何流式增量');

  // 提示词分层必须齐全
  const layers = r.meta.prompt.layers.map((l) => l.name);
  assert.ok(layers.includes('L0') && layers.includes('L1') && layers.includes('L3'), `层缺失：${layers}`);

  // 检索必须命中（青石镇/宫银叶应能召回相关设定）
  assert.ok(r.meta.retrieve.count > 0, '检索一条都没命中');

  // 结构化裁决：允许 effects 为空数组，但必须是合法解析结果
  assert.ok(Array.isArray(r.effects), 'effects 不是数组');
  assert.ok(r.choices.length > 0, '没有行动建议');

  // 状态不变量：落地后所有百分比仍在 0–100
  for (const [k, v] of Object.entries(state.主角)) {
    if (typeof v === 'number' && /生命|精血|灵力|修为|神识|道心/.test(k)) {
      assert.ok(v >= 0 && v <= 100, `${k}=${v} 越界`);
    }
  }
  // 时间必须被推进（引擎独占）
  assert.notEqual(state.世界.时段, '清晨');

  console.log('\n——— 真实模型回合报告 ———');
  console.log(`模型           : ${MODEL}${ARBITER ? ` + 裁决 ${ARBITER}` : '（裁决复用同一模型）'}`);
  console.log(`耗时           : ${elapsed}ms（首字 ${firstDeltaAt - started}ms）`);
  console.log(`提示词分层     : ${r.meta.prompt.layers.map((l) => `${l.name}:${l.tokens}`).join(' ')} 共 ${r.meta.prompt.totalTokens} tok`);
  console.log(`检索命中       : ${r.meta.retrieve.count} 条 / ${r.meta.retrieve.usedTokens} tok`);
  console.log(`落地效果       : ${r.applied.applied} 条（跳过 ${r.applied.skipped}）`);
  console.log(`effects        : ${JSON.stringify(r.effects)}`);
  console.log(`scene          : ${JSON.stringify(r.scene)}`);
  console.log(`choices        : ${JSON.stringify(r.choices)}`);
  console.log(`时间           : ${state.世界.当前时间}（第 ${state.世界.天数} 日）`);
  console.log(`引擎日志       : ${r.logs.length ? r.logs.join(' | ') : '（无）'}`);
  console.log(`叙事正文（前 200 字）：\n${r.narrative.slice(0, 200)}\n`);
});

test('真实模型：裁决能用 JSON 模式产出可解析的 effects（单独压一次）', { skip }, async () => {
  const state = demoState();
  const index = buildIndex(worldbook, { realm: state.主角.所在界 });
  const llm = httpLlm({ baseUrl: BASE, apiKey: KEY, model: MODEL, arbiterModel: ARBITER });

  const r = await runTurn({
    action: { kind: 'cultivate', text: '闭关修炼七日。' },
    state,
    index,
    llm,
    rng: makeRng(7),
    arbiterConfigured: !!ARBITER,
    fallbackNarratives: [],
  });

  assert.equal(r.source, 'llm', `叙事降级：${r.logs.join(' | ')}`);
  // 修炼由引擎结算，修为必须增加（与模型是否返回 effects 无关）
  assert.ok(state.主角.修为 > 42, `修为未增长：${state.主角.修为}`);
  assert.ok(state.世界.天数 > 1, `天数未推进：${state.世界.天数}`);
  console.log(`\n修炼回合：修为 42 → ${state.主角.修为}，第 ${state.世界.天数} 日，落地 ${r.applied.applied} 条\n`);
});

test('真实模型：/models 可达且包含目标模型', { skip }, async () => {
  const res = await fetch(joinUrl(BASE, '/models'), { headers: { Authorization: `Bearer ${KEY}` } });
  assert.equal(res.status, 200);
  const d = await res.json();
  const ids = (d.data || []).map((m) => m.id);
  assert.ok(ids.includes(MODEL), `模型列表里没有 ${MODEL}`);
  console.log(`\n/models 返回 ${ids.length} 个模型，包含 ${MODEL}\n`);
});

void snapshot;
