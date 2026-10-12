/**
 * 提示词分层编排。
 *
 * 层的顺序与稳定性是刻意设计的：**L0/L1 每回合完全一样**，放在最前面用于命中
 * 前缀缓存（prompt cache）；动态内容一律排在后面。
 * @module narrator/prompt
 */

import { estimateTokens } from '../memory/retrieve.js';
import { stateSummary } from '../engine/state.js';
import { constantText } from '../memory/index.js';

export const LAYER_BUDGET = Object.freeze({
  L0: 260,
  L1: 1400,
  L2: 1200,
  L3: 260,
  L4: 1600,
  L5: 260,
});

/** L0：协议层。措辞要短、要硬——这是模型唯一必须遵守的部分。 */
export const L0_PROTOCOL = [
  '你是《道渊》的叙事引擎。',
  '只输出剧情正文。禁止输出 JSON、HTML、XML、状态栏、变量块、系统说明或思维过程。',
  '特别禁止输出任何尖括号标记，例如 <data_block>、<UpdateVariable>、<StatusPlaceHolderImpl/>、<threat_level>、<inventory>、<skills> 等——状态由本地引擎维护，你不需要报告任何数值。',
  '境界、数值、时间、遭遇全部由本地引擎裁定；你不计算、不改写数值。',
  '不替玩家做决定；不描写玩家未选择的行为；不剧透玩家尚未接触的设定。',
  '文风：玄天界修仙，第三人称限知视角，中文，冷静克制，重细节与留白。每段 150–400 字。',
].join('\n');

/**
 * 组装叙事请求的 messages。
 * @param {{action:string, index?:object, state:object, retrieved?:Array, recent?:Array<{role:string,text:string}>,
 *          hints?:string[], budget?:object}} input
 */
export function composeNarrative({ action, index, state, retrieved = [], recent = [], hints = [], budget = {} }) {
  const B = { ...LAYER_BUDGET, ...budget };
  const messages = [];
  const meta = { layers: [], droppedTurns: 0 };

  messages.push({ role: 'system', content: L0_PROTOCOL });
  meta.layers.push({ name: 'L0', tokens: estimateTokens(L0_PROTOCOL) });

  // L1 世界法则：常驻条目，永不裁剪（只受 maxChars 限制）
  if (index) {
    const L1 = constantText(index, { maxChars: Math.round(B.L1 * 1.6) });
    if (L1.text) {
      const content = `【世界法则 · 常驻】\n${L1.text}`;
      messages.push({ role: 'system', content });
      meta.layers.push({ name: 'L1', tokens: estimateTokens(content), included: L1.included, total: L1.total });
    }
  }

  // L2 检索记忆：本回合命中的设定（超过 L2 预算的条目在 retrieve 阶段已被裁掉）
  if (retrieved.length) {
    const { content, tokens } = retrievedBlock(retrieved);
    messages.push({ role: 'system', content });
    meta.layers.push({ name: 'L2', tokens, items: retrieved.length });
  }

  // L3 状态摘要
  const summary = stateSummary(state);
  const L3 = `【当前状态】\n${summary}`;
  messages.push({ role: 'system', content: L3 });
  meta.layers.push({ name: 'L3', tokens: estimateTokens(L3) });

  // L4 近况：从最近往回塞，超出预算就丢最早的
  const recentKept = [];
  let l4Tokens = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const t = recent[i];
    const text = String(t.text || '');
    const cost = estimateTokens(text) + 6;
    if (l4Tokens + cost > B.L4) { meta.droppedTurns = i + 1; break; }
    l4Tokens += cost;
    recentKept.unshift({ role: t.role === 'user' ? 'user' : 'assistant', content: text });
  }
  messages.push(...recentKept);
  meta.layers.push({ name: 'L4', tokens: l4Tokens, turns: recentKept.length });

  // L5 本回合
  const hintText = hints.length ? `\n【引擎裁定】\n${hints.join('\n')}` : '';
  const L5 = `【玩家行动】\n${action}${hintText}`;
  messages.push({ role: 'user', content: L5 });
  meta.layers.push({ name: 'L5', tokens: estimateTokens(L5) });

  meta.totalTokens = meta.layers.reduce((s, l) => s + (l.tokens || 0), 0);
  return { messages, meta };
}

/** 把检索结果拼成一段可注入的文本（放在 L2 位置）。 */
export function retrievedBlock(items) {
  if (!items || !items.length) return { content: '', tokens: 0 };
  const body = items.map((i) => `【${i.title}】\n${i.content}`).join('\n\n');
  const content = `【本回合相关设定】\n${body}`;
  return { content, tokens: estimateTokens(content) };
}

/**
 * 组装"裁决请求"的 messages：要求模型只返回 JSON。
 * 用第二次调用换取干净正文 + 强约束状态。
 */
export function composeArbiter({ action, narrative, state, recent = [], retrieved = [], scene }) {
  const sys = [
    '你是《道渊》的状态裁决器。只输出一个 JSON 对象，不要任何解释、不要代码围栏。',
    'JSON 形状：',
    '{"effects":[{"op":"delta|set|add|remove","target":"主角.灵力","value":-12,"reason":"施展御剑术"}],',
    ' "scene":{"当前时间":"初春·黄昏","当前地点":"青石镇·醉仙楼","危机程度":"低","天气":"细雨"},',
    ' "choices":["继续修炼","去坊市看看"]}',
    '',
    'target 用扁平点路径，可用前缀：世界 / 主角 / 道侣.<名> / 灵宠.<名> / 人物.<名> / 机遇.<名> / 绝色榜.<名> / 玉简.<名>。',
    'op 语义：delta=数值增减（只能用于数值字段）、set=覆盖、add=新增条目、remove=删除条目。',
    '铁律：',
    '1. 只记录**正文里真实发生过**的变化，不要凭空创造；',
    '2. 所有百分比字段的取值范围是 0–100，越界会被引擎截断；',
    '3. 禁止修改「性格」这类固定设定；',
    '4. 若本回合没有任何状态变化，effects 返回空数组；',
    '5. choices 给 2–4 条、每条不超过 20 字的下一步行动建议。',
  ].join('\n');

  const ctx = [
    `【当前状态】\n${stateSummary(state)}`,
    scene ? `【本回合场景】\n${JSON.stringify(scene)}` : '',
    retrieved.length ? `【本回合相关设定】\n${retrieved.map((r) => `【${r.title}】${r.content.slice(0, 300)}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');

  const recentText = recent.slice(-3).map((t) => `${t.role === 'user' ? '玩家' : '叙事'}：${String(t.text || '').slice(0, 300)}`).join('\n');

  const user = [
    `【玩家行动】\n${action}`,
    recentText ? `【近况】\n${recentText}` : '',
    `【本回合正文】\n${narrative}`,
    '请输出本次状态变更的 JSON。',
  ].filter(Boolean).join('\n\n');

  return [
    { role: 'system', content: sys },
    { role: 'system', content: ctx },
    { role: 'user', content: user },
  ];
}
