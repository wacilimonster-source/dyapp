/**
 * 中英混合分词：不需要词典，对中文专名仍有较好命中。
 *
 * 中文用**二元切分（bigram）**："尸魔宗" → 尸魔 / 魔宗；同时把 ≤6 字的短段整体也作为
 * 一个 token 加入，弥补 bigram 对长专名的稀释。英文与数字按词切。
 * @module memory/tokenize
 */

const RE_WORD = /[A-Za-z][A-Za-z0-9_'’-]*|\d+(?:\.\d+)?/g;
const RE_CJK_RUN = /[\u4e00-\u9fff]+/g;

/** 中文停用字（单字 bigram 里噪音最大的几个）。 */
const STOP_BIGRAMS = new Set(['的了', '是在', '和与', '与和']);

export function tokenize(text) {
  const s = String(text == null ? '' : text);
  const out = [];
  if (!s) return out;

  for (const m of s.matchAll(RE_WORD)) out.push(m[0].toLowerCase());

  for (const seg of s.match(RE_CJK_RUN) || []) {
    if (seg.length === 1) { out.push(seg); continue; }
    for (let i = 0; i < seg.length - 1; i++) {
      const bg = seg.slice(i, i + 2);
      if (!STOP_BIGRAMS.has(bg)) out.push(bg);
    }
    if (seg.length <= 6) out.push(seg);
  }
  return out;
}

/** 词频表。 */
export function termFreq(tokens) {
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return tf;
}

/**
 * 把一组"必须命中"的专名（世界书 keys、在场人物名）也加进 query token，
 * 因为它们在 bigram 下会被切碎，整体加入能显著提升命中。
 */
export function augmentWithProperNouns(tokens, properNouns) {
  const out = tokens.slice();
  for (const n of properNouns || []) {
    const s = String(n || '').trim();
    if (s.length >= 2 && s.length <= 12) out.push(s);
  }
  return out;
}
