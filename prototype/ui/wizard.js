/**
 * 首启向导的测连错误分类（纯函数）。
 *
 * 为什么需要它：把 401/超时/404 翻译成人话，玩家才知道该改哪一格。
 * 拉模型列表（/models）通不代表对话通——中转渠道常按路由分开鉴权，
 * 所以测连必须真发一次对话。抽成纯模块便于用假错误串回归测试。
 * @module ui/wizard
 */

/**
 * @param {string|Error} err 错误消息或对象
 * @returns {{kind:'auth'|'key-missing'|'addr'|'path'|'net'|'unknown', title:string, hint:string}}
 *   auth：鉴权失败（Key 不对/没权限）；addr：连不上（地址错或网络不通）；
 *   path：路径不对；net：请求被限流或网络抖动；unknown：没见过的样子
 */
export function classifyConnError(err) {
  const msg = String((err && err.message) || err || '').trim();
  const has = (...ws) => ws.some((w) => msg.includes(w));

  if (!msg) {
    return { kind: 'unknown', title: '连接失败', hint: '没有拿到明确的错误信息，请重试一次。' };
  }
  if (has('API Key', '未配置', 'NotConfigured')) {
    return { kind: 'key-missing', title: '还没填 API Key', hint: '这一步需要 Key 才能测连；本地推理渠道（如 Ollama）可回去把渠道选成免 Key 的。' };
  }
  if (has('401', '403', 'Unauthorized', 'invalid api key', 'invalid_api_key', '无权', '鉴权')) {
    return { kind: 'auth', title: 'Key 不对或没有权限', hint: '检查 Key 是否复制完整、是否过期，以及它有没有这个模型的调用权限。' };
  }
  if (has('404', 'not found', 'Not Found', '找不到')) {
    return { kind: 'path', title: '路径不对', hint: '接口地址一般以 /v1 结尾，对话路径一般是 /chat/completions。检查有没有多写或少写。' };
  }
  if (has('超时', 'timeout', 'timed out', 'Timeout', '请求超时')) {
    return { kind: 'addr', title: '连不上（超时）', hint: '多半是接口地址写错了，或当前网络到不了这个地址。' };
  }
  if (has('dns', 'DNS', '解析', '连接失败', 'Connection', 'connection', 'network', '网络')) {
    return { kind: 'addr', title: '网络不通', hint: '先确认手机能上网，再检查接口地址拼写（https:// 开头，不要有空格）。' };
  }
  if (has('429', '限流', '过于频繁', 'rate limit', 'Too Many Requests')) {
    return { kind: 'net', title: '被限流了', hint: '渠道暂时拒绝请求，稍等片刻再点一次测连即可。' };
  }
  return { kind: 'unknown', title: '连接失败', hint: msg.slice(0, 120) };
}
