/**
 * 玉简传讯的提示词构造（纯函数）。
 *
 * 回信必须是"这个人"说的：带上联系人卡与最近几条往来，模型才知道口吻与话题。
 * 抽成纯模块是为了能在 node --test 里锁三件事：
 *   1. 系统段确实包含姓名/关系/好感（不然回信没有"人味"）；
 *   2. 历史只带最近 N 条（控制 token，也避免长会话拖爆）；
 *   3. 玩家新消息一定在最后一条（不然模型会替玩家说话）。
 * @module narrator/reply
 */

/**
 * @param {{name:string, info?:{性别?:string, 境界?:string, 关系?:string, 好感度?:number},
 *          history?:Array<{发送者?:string, 时间?:string, 内容?:string}>, text:string}} input
 * @param {{keep?:number}} [opts] history 保留条数，默认 4
 * @returns {Array<{role:string, content:string}>}
 */
export function buildContactMessages(input, opts = {}) {
  const keep = Math.max(0, Number(opts.keep) || 4);
  const name = String((input && input.name) || '对方').trim() || '对方';
  const info = (input && input.info) || {};
  const text = String((input && input.text) || '').trim();
  const rel = String(info.关系 || '故识');
  const favor = Number(info.好感度);
  const favorDesc = !isNaN(favor)
    ? favor >= 80 ? '极亲近' : favor >= 60 ? '相当亲近' : favor >= 35 ? '还算熟络' : favor >= 15 ? '略有好感' : '尚存疏离'
    : '关系不明';
  const system = [
    `你在一次修仙题材文字游戏里代扮演「${name}」，通过传讯玉简与玩家（一位修士）互通短消息。`,
    `她的情况：${String(info.性别 || '女')} · ${String(info.境界 || '境界不明')} · 与玩家是${rel} · ${favorDesc}。`,
    '要求：以她的口吻回一条**短**消息（不超过 60 字），口语、可有动作或情绪描写（用括号）；',
    '不要旁白剧情推进、不要替玩家说话、不要输出 JSON 或任何格式标记；',
    '只输出这条消息本身。',
  ].join('\n');

  const history = (input.history || []).slice(-keep).map((h) => ({
    role: h && h.发送者 === '我' ? 'user' : 'assistant',
    content: String((h && h.内容) || '').trim(),
  })).filter((h) => h.content);

  return [
    { role: 'system', content: system },
    ...history,
    { role: 'user', content: text || '（你托人递去一枚玉简，没有附言。）' },
  ];
}
