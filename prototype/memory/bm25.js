/**
 * BM25 打分。319 条规模下无需任何索引库，内存倒排足够（毫秒级）。
 * @module memory/bm25
 */

import { termFreq, tokenize } from './tokenize.js';

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

/**
 * 建语料：预计算每篇的 tf、长度；以及全语料的 df。
 * @param {Array<{id:any, text:string}>} docs
 */
export function buildCorpus(docs) {
  const items = [];
  const df = new Map();
  let totalLen = 0;

  for (const d of docs) {
    const tokens = tokenize(d.text);
    const tf = termFreq(tokens);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    items.push({ id: d.id, len: tokens.length, tf, ref: d });
    totalLen += tokens.length;
  }

  const N = items.length || 1;
  const avgLen = totalLen / N || 1;
  const idf = new Map();
  for (const [t, n] of df) {
    // BM25 的 idf 变体，恒为正
    idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  return { items, idf, avgLen, N };
}

/** 单篇对 query 的 BM25 分数。 */
export function score(corpus, item, queryTf) {
  let sum = 0;
  for (const [t, qtf] of queryTf) {
    const f = item.tf.get(t);
    if (!f) continue;
    const idf = corpus.idf.get(t) || 0;
    const denom = f + BM25_K1 * (1 - BM25_B + BM25_B * (item.len / corpus.avgLen));
    sum += idf * ((f * (BM25_K1 + 1)) / denom) * Math.min(qtf, 3);
  }
  return sum;
}

/**
 * 检索并排序。
 * @returns {Array<{id:any, score:number, ref:object}>}
 */
export function search(corpus, queryTokens, { limit = 30 } = {}) {
  const queryTf = termFreq(queryTokens);
  if (!queryTf.size) return [];
  const scored = corpus.items
    .map((item) => ({ id: item.id, score: score(corpus, item, queryTf), ref: item.ref }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}
