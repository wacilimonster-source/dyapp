/**
 * 往昔回顾（滚动摘要）。
 *
 * 长局里提示词只带最近若干回合（L4 预算），更早的剧情会被整体丢弃 —— 模型于是
 * "忘了"玩家去过哪、见过谁。这里把窗口之外的历史压成抽取式摘要（时间 · 地点 +
 * 正文开头），注入提示词的 L3.5 层，零额外模型调用、确定性可测。
 *
 * 边界：这是**抽取式**摘要，不做改写；等到需要语义级归纳时再换成模型摘要，
 * 接口保持不变（输入 turns，输出一段文本）。
 * @module memory/recap
 */

const clean = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();

/**
 * @param {Array<{role:string,text:string,scene?:object}>} turns
 * @param {{keep?:number, maxLines?:number, maxChars?:number, lineChars?:number}} [opts]
 *   keep：最近多少回合不进摘要（它们会原样进入 L4）
 * @returns {string} 摘要文本；无内容时返回 ''
 */
export function buildRecap(turns, opts = {}) {
  const keep = Number.isFinite(opts.keep) ? opts.keep : 8;
  const maxLines = Number.isFinite(opts.maxLines) ? opts.maxLines : 40;
  const maxChars = Number.isFinite(opts.maxChars) ? opts.maxChars : 900;
  const lineChars = Number.isFinite(opts.lineChars) ? opts.lineChars : 56;

  const arr = Array.isArray(turns) ? turns : [];
  const older = arr.slice(0, Math.max(0, arr.length - keep));
  const lines = [];
  for (const t of older) {
    if (!t || t.role !== 'assistant') continue;
    const text = clean(t.text);
    if (!text) continue;
    const s = t.scene || {};
    const where = [s.当前时间, s.当前地点].filter(Boolean).map(clean).join(' · ');
    lines.push(`· ${where ? `【${where}】` : ''}${text.slice(0, lineChars)}${text.length > lineChars ? '…' : ''}`);
  }
  if (!lines.length) return '';

  // 只保留最近的 maxLines 行（更早的再往下滚出摘要视野）
  let out = lines.slice(-maxLines).join('\n');
  if (out.length > maxChars) out = '…' + out.slice(out.length - maxChars);
  return out;
}
