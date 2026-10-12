/**
 * ST（SillyTavern）Chat Completion 预设的解析与校验。
 *
 * 格式依据实测：`SillyTavern/default/content/presets/openai/Default.json`
 * （62 个顶层键、`prompts[]` 12 条、`prompt_order[]` 按 dummyId 分组）。
 *
 * 三条原则：
 * 1. **原始 JSON 逐字节保留**（`raw`）——我们读不懂的字段也要留着，导出时原样写回，
 *    否则"用本 App 存一次，预设就废了"。
 * 2. **读不懂就告警，不静默丢**。
 * 3. **宽容包装**：有的客户端会套一层 `{preset:{…}}` 或 `{settings:{…}}`，都认。
 * @module preset/schema
 */

/**
 * **真正会生效**的采样/运行参数（会进请求体，或影响上下文与输出长度）。
 * UI 用这份清单判断"哪些项被忽略了"，所以它必须只包含我们真会用的。
 */
export const SUPPORTED_SAMPLING = [
  'temperature', 'top_p', 'frequency_penalty', 'presence_penalty', 'seed',
  'openai_max_tokens', 'openai_max_context',
  'squash_system_messages', 'use_sysprompt', 'names_behavior', 'stream_openai',
  'assistant_prefill', 'continue_prefill', 'continue_postfix',
];

/**
 * ST 里有、但我们**故意不透传**的采样参数。
 * 原因：top_k / top_a / min_p / repetition_penalty 不是 OpenAI 兼容端点的标准字段，
 * 严格端点收到未知字段会直接 400。解析时保留（好在预设详情里列出来），但不发送。
 */
export const KEPT_BUT_UNUSED_SAMPLING = ['top_k', 'top_a', 'min_p', 'repetition_penalty', 'n'];

/** 解析时接受的全部采样键 = 生效的 + 保留但不用的。 */
const ACCEPTED_SAMPLING = [...SUPPORTED_SAMPLING, ...KEPT_BUT_UNUSED_SAMPLING];

/** 固定文本片段：只在功能与我们有重叠时使用。 */
export const SUPPORTED_FRAGMENTS = [
  'impersonation_prompt', 'new_chat_prompt', 'new_example_chat_prompt',
  'continue_nudge_prompt', 'wi_format', 'scenario_format', 'personality_format',
  'group_nudge_prompt', 'new_group_chat_prompt', 'send_if_empty',
];

/** 明确忽略的键（供应商/模型/网络/群聊）。命中时给出可读提示。 */
const IGNORED_PREFIXES = [
  'openai_model', 'claude_model', 'openrouter_', 'ai21_model', 'mistralai_model',
  'chutes_', 'minimax_', 'electronhub_', 'custom_model', 'custom_url',
  'custom_include_', 'custom_exclude_', 'google_model', 'vertexai_model',
  'reverse_proxy', 'proxy_password', 'bias_preset_selected', 'max_context_unlocked',
  'show_external_models', 'media_inlining', 'bypass_status_check',
];

/** ST 用来分组 prompt_order 的占位 id；100000 = 普通聊天（我们只要这个）。 */
export const DUMMY_ID_DEFAULT = 100000;

/**
 * 解析一份预设。
 * @param {object|string} input JSON 对象或字符串
 * @returns {{ok:boolean, error?:string, preset?:object}}
 */
export function parsePreset(input) {
  let data = input;
  if (typeof data === 'string') {
    try { data = JSON.parse(data); } catch (e) {
      return { ok: false, error: '不是合法 JSON：' + e.message };
    }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '预设根节点必须是一个对象' };
  }
  // 宽容包装
  for (const wrap of ['preset', 'settings']) {
    if (!Array.isArray(data.prompts) && data[wrap] && typeof data[wrap] === 'object') {
      data = data[wrap];
    }
  }
  if (!Array.isArray(data.prompts) || !data.prompts.length) {
    return { ok: false, error: '预设里没有 prompts 数组（这看起来不像 ST 的 Chat Completion 预设）' };
  }

  const warnings = [];
  const entries = [];
  const seen = new Set();

  for (const p of data.prompts) {
    if (!p || typeof p !== 'object') { warnings.push('prompts 里有一项不是对象，已跳过'); continue; }
    const identifier = String(p.identifier || '').trim();
    if (!identifier) { warnings.push(`有一条 prompt 缺少 identifier（name=${p.name || '?'}），已跳过`); continue; }
    if (seen.has(identifier)) warnings.push(`identifier 重复：${identifier}（后者不覆盖前者）`);
    seen.add(identifier);
    entries.push({
      identifier,
      name: String(p.name || identifier),
      role: normRole(p.role),
      content: typeof p.content === 'string' ? p.content : '',
      /** ST 语义：true = 内置条目（可重置），false = 用户自建 */
      builtin: p.system_prompt !== false,
      marker: p.marker === true,
      injectionPosition: Number.isFinite(p.injection_position) ? p.injection_position : 0,
      injectionDepth: Number.isFinite(p.injection_depth) ? p.injection_depth : 4,
      injectionOrder: Number.isFinite(p.injection_order) ? p.injection_order : 100,
      injectionTrigger: Array.isArray(p.injection_trigger)
        ? p.injection_trigger.filter((t) => typeof t === 'string' && t.trim())
        : [],
      forbidOverrides: p.forbid_overrides === true,
    });
  }

  if (!entries.length) {
    return { ok: false, error: 'presets 里没有一条带 identifier 的有效条目' };
  }

  const { order, whichGroup } = resolveOrder(data.prompt_order, warnings);

  const sampling = {};
  const ignored = [];
  for (const [k, v] of Object.entries(data)) {
    if (k === 'prompts' || k === 'prompt_order') continue;
    if (ACCEPTED_SAMPLING.includes(k)) { sampling[k] = v; continue; }
    if (SUPPORTED_FRAGMENTS.includes(k)) { sampling[k] = v; continue; }
    if (IGNORED_PREFIXES.some((p) => k.startsWith(p))) { ignored.push(k); continue; }
    ignored.push(k);
  }

  return {
    ok: true,
    preset: {
      raw: data,
      entries,
      order,
      orderGroup: whichGroup,
      sampling,
      ignoredKeys: ignored,
      warnings,
    },
  };
}

function normRole(role) {
  const r = String(role || '').toLowerCase();
  return ['system', 'user', 'assistant'].includes(r) ? r : 'system';
}

/**
 * 取生效的条目顺序。
 * prompt_order 是 `[{character_id, order:[{identifier, enabled}]}]`；
 * 优先 100000（普通聊天），否则取第一组；再否则按 prompts 原顺序全启用。
 */
export function resolveOrder(promptOrder, warnings) {
  if (!Array.isArray(promptOrder) || !promptOrder.length) {
    warnings.push('预设没有 prompt_order，已按 prompts 的原始顺序全部启用');
    return { order: null, whichGroup: 'fallback' };
  }
  const group = promptOrder.find((g) => g && g.character_id === DUMMY_ID_DEFAULT) || promptOrder[0];
  if (!group || !Array.isArray(group.order)) {
    warnings.push('prompt_order 结构不对，已按 prompts 的原始顺序全部启用');
    return { order: null, whichGroup: 'fallback' };
  }
  if (group.character_id !== DUMMY_ID_DEFAULT) {
    warnings.push(`预设里没有 character_id=${DUMMY_ID_DEFAULT} 的顺序组，已改用第 1 组（可能来自群聊配置）`);
  }
  const order = group.order
    .filter((o) => o && typeof o.identifier === 'string')
    .map((o) => ({ identifier: o.identifier, enabled: o.enabled !== false }));
  return { order, whichGroup: group.character_id };
}

/** 生成一份"默认模式"的等价 ST 预设（决策 D9：反向导出）。 */
export function toStPreset({ name = '道渊 · 默认', main = '', postHistory = '' } = {}) {
  return {
    name,
    temperature: 0.85,
    frequency_penalty: 0,
    presence_penalty: 0,
    top_p: 0.95,
    openai_max_context: 32000,
    openai_max_tokens: 2048,
    stream_openai: true,
    prompts: [
      { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: main },
      { identifier: 'worldInfoBefore', name: 'World Info (before)', system_prompt: true, marker: true, content: '' },
      { identifier: 'worldInfoAfter', name: 'World Info (after)', system_prompt: true, marker: true, content: '' },
      { identifier: 'personaDescription', name: 'Persona Description', system_prompt: true, marker: true, content: '' },
      { identifier: 'scenario', name: 'Scenario', system_prompt: true, marker: true, content: '' },
      { identifier: 'dialogueExamples', name: 'Chat Examples', system_prompt: true, marker: true, content: '' },
      { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true, content: '' },
      { identifier: 'jailbreak', name: 'Post-History Instructions', system_prompt: true, role: 'system', content: postHistory },
    ],
    prompt_order: [
      {
        character_id: DUMMY_ID_DEFAULT,
        order: [
          { identifier: 'main', enabled: true },
          { identifier: 'worldInfoBefore', enabled: true },
          { identifier: 'personaDescription', enabled: true },
          { identifier: 'scenario', enabled: true },
          { identifier: 'worldInfoAfter', enabled: true },
          { identifier: 'dialogueExamples', enabled: false },
          { identifier: 'chatHistory', enabled: true },
          { identifier: 'jailbreak', enabled: true },
        ],
      },
    ],
  };
}
