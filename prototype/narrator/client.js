/**
 * 叙事客户端：包装"壳提供的大模型能力"，让上层不关心桥接细节。
 *
 * `llm` 参数是本模块唯一的依赖注入点——测试里传一个假实现即可，无需真网络。
 * @module narrator/client
 */

/**
 * @typedef {object} LlmLike
 * @property {(req:object, onEvent:(ev:object)=>void) => Promise<void>} stream
 * @property {(req:object) => Promise<unknown>} completeJson
 */

/**
 * 流式生成叙事。
 * @param {LlmLike} llm
 * @param {Array<{role:string,content:string}>} messages
 * @param {(chunk:string, full:string)=>void} onDelta
 * @param {{requestId:string, useArbiter?:boolean, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, text:string, usage?:object, error?:string}>}
 *   `usage` 是渠道给的用量（prompt/completion/cached tokens），不给就没有这个字段。
 */
export async function streamNarrative(llm, messages, onDelta, opts) {
  if (!llm || typeof llm.stream !== 'function') {
    return { ok: false, text: '', error: '未接入大模型（当前为离线模式）' };
  }
  let full = '';
  let err = null;
  let usage = null;
  const requestId = opts?.requestId || `req-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  try {
    await llm.stream(
      { requestId, messages, stream: true, jsonMode: false, useArbiter: !!opts?.useArbiter, sampling: opts?.sampling },
      (ev) => {
        if (!ev) return;
        if (ev.type === 'delta' && ev.data && typeof ev.data.text === 'string') {
          full += ev.data.text;
          onDelta?.(ev.data.text, full);
        } else if (ev.type === 'usage' && ev.data) {
          usage = ev.data;
        } else if (ev.type === 'error') {
          err = new Error((ev.data && ev.data.message) || '流式返回出错');
        }
      },
    );
  } catch (e) {
    err = e;
  }
  if (err) return { ok: false, text: full, error: String(err.message || err) };
  if (!full.trim()) return { ok: false, text: '', error: '模型没有返回内容' };
  return usage ? { ok: true, text: full, usage } : { ok: true, text: full };
}

/**
 * 非流式裁决：要求模型返回严格 JSON。
 * @returns {Promise<{ok:boolean, raw?:unknown, error?:string}>}
 */
export async function decide(llm, messages, opts) {
  if (!llm || typeof llm.completeJson !== 'function') {
    return { ok: false, error: '未接入大模型（当前为离线模式）' };
  }
  const requestId = opts?.requestId || `arb-${Date.now()}-${Math.floor(Math.random() * 1e4)}`;
  try {
    const raw = await llm.completeJson({
      requestId,
      messages,
      stream: false,
      jsonMode: true,
      useArbiter: !!opts?.useArbiter,
    });
    return { ok: true, raw };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}
