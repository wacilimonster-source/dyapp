/**
 * 检索：召回 → 规则重排 → token 预算裁剪。
 *
 * 重排是**乘性**的，且每条命中都带 reason，便于排查"为什么这条没被注入"。
 * @module memory/retrieve
 */

import { search } from './bm25.js';
import { augmentWithProperNouns, tokenize } from './tokenize.js';

/** 中文大致 1 token ≈ 1.6 字（够用的粗估，只用于预算裁剪）。 */
export const CHARS_PER_TOKEN = 1.6;

export function estimateTokens(text) {
  return Math.ceil(String(text || '').length / CHARS_PER_TOKEN);
}

export const DEFAULT_WEIGHTS = Object.freeze({
  titleHit: 2.0,
  keyHit: 1.8,
  placeHit: 1.3,
  npcTitleHit: 1.6,
  npcCategoryHit: 1.5,
});

/**
 * @param {object} index buildIndex() 的产物
 * @param {{action?:string, place?:string, npcs?:string[], realm?:string, recent?:string}} ctx
 * @param {{tokenBudget?:number, recall?:number, weights?:object}} [opts]
 */
export function retrieve(index, ctx = {}, opts = {}) {
  const weights = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
  const tokenBudget = Number.isFinite(opts.tokenBudget) ? opts.tokenBudget : 1200;
  const recall = Number.isFinite(opts.recall) ? opts.recall : 40;
  if (!index || !index.corpus) return { items: [], usedTokens: 0, dropped: 0, query: [] };

  const npcs = (ctx.npcs || []).filter(Boolean);
  const properNouns = [...npcs];
  if (ctx.place) properNouns.push(ctx.place);

  const baseQuery = tokenize([ctx.action, ctx.recent, ctx.place, npcs.join(' '), ctx.realm].filter(Boolean).join('\n'));
  const query = augmentWithProperNouns(baseQuery, properNouns);

  const recalled = search(index.corpus, query, { limit: recall });
  const querySet = new Set(query);
  const place = String(ctx.place || '');
  // 地点是「青石镇 · 醉仙楼」这种拼接串，整串 includes 几乎永远失配。
  // 拆成段（≥2 字）分别匹配，命中任一段即算地点相关。
  const placeSegs = place
    .split(/[·\/|,，>—-]/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);

  const reranked = recalled.map((r) => {
    const e = index.byId.get(r.id) || {};
    let mult = 1;
    const why = [];

    const title = String(e.title || '');
    const name = String(e.name || '');
    const keys = [...(e.keys || []), ...(e.secondaryKeys || [])];

    // 标题命中查询词
    let titleHit = false;
    for (const q of querySet) {
      if (q.length >= 2 && (title.includes(q) || name.includes(q))) { titleHit = true; break; }
    }
    if (titleHit) { mult *= weights.titleHit; why.push('标题命中'); }

    // keys 命中（触发词是查询词，或触发词就是当前地点/其中一段）
    const keyHit = keys.some((k) => querySet.has(String(k)) || placeSegs.includes(String(k)));
    if (keyHit) { mult *= weights.keyHit; why.push('触发词命中'); }

    // 当前地点的任一段出现在正文里
    if (placeSegs.some((seg) => (e.content || '').includes(seg))) { mult *= weights.placeHit; why.push('地点相关'); }

    // 在场人物名出现在标题
    const npcInTitle = npcs.find((n) => n && n.length >= 2 && (title.includes(n) || name.includes(n)));
    if (npcInTitle) { mult *= weights.npcTitleHit; why.push(`在场：${npcInTitle}`); }
    else if (e.category === '人物' && npcs.length) { mult *= weights.npcCategoryHit; why.push('人物类'); }

    return { ...r, score: r.score * mult, why, entry: e };
  });

  reranked.sort((a, b) => b.score - a.score);

  // 按预算裁剪；同标题去重
  const items = [];
  const seen = new Set();
  let usedTokens = 0;
  let dropped = 0;
  for (const r of reranked) {
    const e = r.entry;
    const key = e.title || String(r.id);
    if (seen.has(key)) continue;
    const cost = estimateTokens(e.content) + estimateTokens(e.title) + 4;
    if (usedTokens + cost > tokenBudget) { dropped++; continue; }
    seen.add(key);
    usedTokens += cost;
    items.push({
      id: r.id,
      title: e.title,
      category: e.category,
      content: e.content,
      score: Number(r.score.toFixed(4)),
      why: r.why,
      tokens: cost,
    });
    if (items.length >= 40) break;
  }

  return { items, usedTokens, dropped, query: [...new Set(query)].slice(0, 40) };
}
