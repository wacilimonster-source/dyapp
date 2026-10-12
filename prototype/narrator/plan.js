/**
 * 统一的提示词组装：**默认模式与预设模式走同一个出口**。
 *
 * 两种模式都产出同一种 `PromptPlan`，`engine/turn.js` 只认这个结构——
 * 这样"换模式"不会牵动回合逻辑，也让「预览将发送的提示词」在两种模式下都能用。
 *
 * 已确认的决策：
 *   D1 预设模式**不注入引擎协议 L0**，提示词完全由预设展开；
 *   D2 `{{char}}`/`{{user}}` 按 ST 规范映射到两个可配置字段；
 *   D5 随机宏用真随机；
 *   D7 prompt_order 取 character_id=100000 那组。
 *
 * 注意：不注入 L0 ≠ 不管正文质量。渲染层的 `sanitizeNarrative()` 与裁决抽取
 * 仍然生效（见 docs/06 §3.1 的两条后果）。
 * @module narrator/plan
 */

import { stateSummary } from '../engine/state.js';
import { constantText } from '../memory/index.js';
import { estimateTokens } from '../memory/retrieve.js';
import { composeNarrative, L0_PROTOCOL, LAYER_BUDGET } from './prompt.js';
import { renderMacros } from '../preset/macros.js';

/** 该 marker 用引擎的什么数据填（docs/06 §3.2）。 */
export const MARKER_FILLERS = {
  worldInfoBefore: '常驻世界法则（L1 精简版）',
  worldInfoAfter: '本回合检索命中的设定（L2）',
  chatHistory: '最近若干回合的叙事（受 max_context 裁剪）',
  charDescription: '叙事者设定（一句话）',
  charPersonality: '文风要求',
  scenario: '当前场景 + 本回合引擎裁定',
  personaDescription: '主角状态摘要',
  dialogueExamples: '示例对话（默认留空，可在预设里手填）',
};

const DEFAULT_STYLE = '玄天界修仙，第三人称限知视角，中文，冷静克制，重细节与留白。每段 150–400 字。';

/** 叙事者设定：预设模式下没有 L0，这条是 marker 需要的最小交代。 */
function narratorLine(charName) {
  return `你是本作的叙事引擎，负责扮演「${charName}」讲述剧情。`;
}

/**
 * @param {object} input
 * @param {'default'|'preset'} input.mode
 * @param {object} [input.preset] parsePreset 的产物
 * @param {object} input.engine { state, index, retrieved, recent, hints, action }
 * @param {{charName?:string, userName?:string, style?:string}} [input.names]
 * @param {() => number} [input.rng]
 * @returns {{messages:Array, meta:object, warnings:string[], sampling:object}}
 */
export function buildPromptPlan(input) {
  const { mode, preset, engine, names = {}, rng } = input;
  if (mode === 'preset' && preset) return buildPresetPlan({ preset, engine, names, rng });

  // 默认模式：直接用引擎自有分层
  const { messages, meta } = composeNarrative({
    action: engine.action,
    index: engine.index,
    state: engine.state,
    retrieved: engine.retrieved || [],
    recent: engine.recent || [],
    hints: engine.hints || [],
  });
  return {
    messages,
    meta: { ...meta, mode: 'default', layers: [{ name: 'L0', tokens: estimateTokens(L0_PROTOCOL) }, ...meta.layers] },
    warnings: [],
    sampling: {},
  };
}

/* ============================ 预设模式 ============================ */

function buildPresetPlan({ preset, engine, names, rng }) {
  const state = engine.state;
  const charName = names.charName || '道渊';
  const userName = names.userName || state?.主角?.姓名 || '修士';
  const style = names.style || DEFAULT_STYLE;

  const warnings = [...(preset.warnings || [])];
  const messages = [];
  const layers = [];
  const usedMacros = new Set();

  /** marker → 要推进去的消息。返回 null 表示该 marker 无内容。 */
  const fillMarker = (identifier) => {
    switch (identifier) {
      case 'worldInfoBefore': {
        if (!engine.index) return null;
        const L1 = constantText(engine.index, { maxChars: Math.round(LAYER_BUDGET.L1 * 1.6) });
        if (!L1.text) return null;
        layers.push({ name: 'L1 世界法则', tokens: estimateTokens(L1.text), items: L1.included });
        return [{ role: 'system', content: `【世界法则 · 常驻】\n${L1.text}` }];
      }
      case 'worldInfoAfter': {
        const items = engine.retrieved || [];
        if (!items.length) return null;
        const body = items.map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
        const content = `【本回合相关设定】\n${body}`;
        layers.push({ name: 'L2 检索记忆', tokens: estimateTokens(content), items: items.length });
        return [{ role: 'system', content }];
      }
      case 'personaDescription': {
        const content = `【主角状态】\n${stateSummary(state)}`;
        layers.push({ name: 'L3 状态摘要', tokens: estimateTokens(content) });
        return [{ role: 'system', content }];
      }
      case 'scenario': {
        const W = state.世界 || {};
        const lines = [`时间：${W.当前时间}`, `地点：${W.当前地点}`, `危机：${W.危机程度}`];
        if (engine.hints?.length) lines.push(engine.hints.join('\n'));
        const fmt = preset.sampling?.scenario_format;
        const content = fmt
          ? renderMacros(fmt, { scenario: lines.join('\n') }, { rng }).text
          : `【当前场景】\n${lines.join('\n')}`;
        layers.push({ name: 'L3 场景', tokens: estimateTokens(content) });
        return [{ role: 'system', content }];
      }
      case 'charDescription':
        return [{ role: 'system', content: narratorLine(charName) }];
      case 'charPersonality':
        return [{ role: 'system', content: `【文风】\n${style}` }];
      case 'dialogueExamples':
        return null; // 决策 D8：默认留空
      default:
        return null;
    }
  };

  const order = preset.order
    || preset.entries.map((e) => ({ identifier: e.identifier, enabled: true }));
  const byId = new Map(preset.entries.map((e) => [e.identifier, e]));

  // 深度插入（injection_position = 1）先收集，等 chatHistory 时按 depth 插进去
  const deepInserts = [];
  // 先跑一遍非 marker 的可编辑条目，处理触发词与深度
  const sequence = [];
  for (const { identifier, enabled } of order) {
    if (!enabled) continue;
    const entry = byId.get(identifier);
    if (!entry) { warnings.push(`prompt_order 引用了不存在的条目 ${identifier}，已跳过`); continue; }
    sequence.push(entry);
  }
  // 只渲染一次：门控（触发词）在这里判定，结果缓存进 active，
  // 展开阶段直接取用——否则展开阶段会绕过门控把条目无条件塞进去。
  const active = new Map();
  for (const entry of sequence) {
    if (entry.marker) continue;
    if (entry.injectionTrigger.length) {
      const haystack = [engine.action || '', ...(engine.recent || []).map((t) => t.text)].join(String.fromCharCode(10));
      if (!entry.injectionTrigger.some((t) => haystack.includes(t))) continue;
    }
    const r = renderMacros(entry.content, macroCtx({ engine, charName, userName, style }), { rng });
    r.warnings.forEach((w) => warnings.push(w));
    r.used.forEach((m) => usedMacros.add(m));
    if (entry.injectionPosition === 1) {
      // 深度必须夹到合法范围并记下越界项：原先只处理 1..8，
      // depth=20 的条目会既不做深度插入、又在顺序展开时被跳过 —— 静默消失
      let d = Math.floor(Number(entry.injectionDepth));
      if (!Number.isFinite(d) || d < 1) {
        warnings.push(`「${entry.name}」的注入深度 ${entry.injectionDepth} 非法，已按 1 处理`);
        d = 1;
      } else if (d > 32) {
        warnings.push(`「${entry.name}」的注入深度 ${d} 超出上限（32），已按 32 处理`);
        d = 32;
      }
      deepInserts.push({ depth: d, role: entry.role, content: r.text });
    } else {
      active.set(entry.identifier, r.text);
    }
  }

  /** 本回合实际用到的深度，去重排序（不再硬编码 1..8）。 */
  const insertedDepths = () => [...new Set(deepInserts.map((x) => x.depth))].sort((a, b) => a - b);

  const pushDeep = (into, depthFromEnd) => {
    const picked = deepInserts.filter((d) => d.depth === depthFromEnd);
    for (const d of picked) {
      const at = Math.max(0, into.length - depthFromEnd);
      into.splice(at, 0, { role: d.role, content: d.content, deep: true });
      layers.push({ name: `深度插入 d=${d.depth}`, tokens: estimateTokens(d.content) });
    }
  };

  // 按顺序展开
  for (const entry of sequence) {
    if (!entry.marker) {
      if (entry.injectionPosition === 1) continue; // 已收集为深度插入
      const text = active.get(entry.identifier);   // 未过门控的条目不在 active 里
      if (text == null || !text.trim()) continue;
      messages.push({ role: entry.role, content: text });
      layers.push({ name: entry.name, tokens: estimateTokens(text) });
      continue;
    }
    if (entry.identifier === 'chatHistory') {
      const history = (engine.recent || []).map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: String(t.text || ''),
      }));
      // 深度插入：挑几个常见深度（1..8）依次插入
      for (const d of insertedDepths()) pushDeep(history, d);
      const trimmed = applyContextBudget(history, preset.sampling?.openai_max_context, warnings);
      messages.push(...trimmed);
      layers.push({ name: '近期叙事', tokens: trimmed.reduce((s, m) => s + estimateTokens(m.content) + 4, 0), turns: trimmed.length });
      continue;
    }
    const filled = fillMarker(entry.identifier);
    if (filled) messages.push(...filled);
    else if (!MARKER_FILLERS[entry.identifier]) warnings.push(`未知 marker：${entry.identifier}，已跳过`);
  }

  // 没有 chatHistory marker 时：深度插入与历史追加到末尾
  if (!sequence.some((e) => e.marker && e.identifier === 'chatHistory')) {
    const history = (engine.recent || []).map((t) => ({
      role: t.role === 'user' ? 'user' : 'assistant',
      content: String(t.text || ''),
    }));
    for (const d of insertedDepths()) pushDeep(history, d);
    messages.push(...applyContextBudget(history, preset.sampling?.openai_max_context, warnings));
  }

  // 本回合永远最后
  const hintText = engine.hints?.length ? `\n【引擎裁定】\n${engine.hints.join('\n')}` : '';
  const last = `【玩家行动】\n${engine.action || '（静观其变）'}${hintText}`;
  messages.push({ role: 'user', content: last });
  layers.push({ name: '本回合', tokens: estimateTokens(last) });

  const totalTokens = layers.reduce((s, l) => s + (l.tokens || 0), 0);

  return {
    messages,
    meta: {
      mode: 'preset',
      presetName: preset.name,
      orderGroup: preset.orderGroup,
      layers,
      totalTokens,
      usedMacros: [...usedMacros],
      deepInserts: deepInserts.length,
    },
    warnings,
    sampling: preset.sampling || {},
  };
}

function macroCtx({ engine, charName, userName, style }) {
  const state = engine.state || {};
  const P = state.主角 || {};
  const W = state.世界 || {};
  return {
    charName,
    userName,
    persona: [P.性别, P.宗门, P.境界].filter(Boolean).join(' · '),
    description: [P.容貌, P.身形, P.衣着].filter(Boolean).join('，'),
    personality: style,
    scenario: `时间：${W.当前时间}；地点：${W.当前地点}；危机：${W.危机程度}`,
    time: W.当前时间 || '',
    date: `第 ${W.天数 || 1} 日`,
    input: engine.action || '',
  };
}

/**
 * 按 `openai_max_context` 裁历史。
 * **永远先裁最老的回合**，绝不裁 system 侧（那是世界法则与指令）。
 */
export function applyContextBudget(history, maxContext, warnings) {
  if (!Number.isFinite(maxContext) || maxContext <= 0) return history;
  // 给输出与 system 部分留出余量
  const budget = Math.max(200, Math.floor(maxContext * 0.6));
  const out = [...history];
  let used = out.reduce((s, m) => s + estimateTokens(m.content) + 4, 0);
  let dropped = 0;
  while (used > budget && out.length > 1) {
    const removed = out.shift();
    used -= estimateTokens(removed.content) + 4;
    dropped++;
  }
  if (dropped) warnings.push(`上下文超限，已裁掉最早的 ${dropped} 条历史`);
  return out;
}

/**
 * 把 ST 预设的采样参数收窄成 OpenAI 兼容端点认识的子集。
 *
 * 只放行 temperature / top_p / max_tokens / frequency_penalty / presence_penalty / seed；
 * top_k / top_a / min_p / repetition_penalty 这些非标准项一律不透传（严格端点会 400）。
 * 被丢掉的项由 UI 在预设详情里以「已忽略」列出，不静默。 
 */
export const OPENAI_SAMPLING_KEYS = ['temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed'];

export function stSamplingToOverride(sampling) {
  if (!sampling || typeof sampling !== 'object') return undefined;
  const out = {};
  for (const k of OPENAI_SAMPLING_KEYS) {
    if (Number.isFinite(sampling[k])) {
      out[k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())] = sampling[k];
    }
  }
  const maxOut = sampling.openai_max_tokens;
  if (Number.isFinite(maxOut) && maxOut > 0) out.maxTokens = Math.floor(maxOut);
  const keys = Object.keys(out);
  return keys.length ? out : undefined;
}
