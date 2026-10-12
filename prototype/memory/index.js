/**
 * 世界书索引：常驻条目（L1）与可检索条目（L2）分开。
 *
 * 关键取舍：`constant` 条目**不参与 Top-K 竞争**——它们按卡内设定本来就该常驻，
 * 让它们参与检索只会挤掉真正相关的动态条目。
 * @module memory/index
 */

import { buildCorpus } from './bm25.js';

/**
 * **机制条目**：卡片自己那套"让模型吐状态标记"的说明。
 *
 * 它们必须**永不进入提示词**——否则模型会照做，把 `<data_block>` /
 * `<UpdateVariable>` 这类标记吐进正文（实测踩到过：真机上正文里出现了
 * `<threat_level>` / `<inventory>` / `<skills>` 一整块）。
 * 这些机制在独立版里已由本地引擎接管，对模型来说是有害的噪音。
 * 但它们在「图鉴」里仍然可见（那是文档，不是提示词）。
 */
export const PROMPT_EXCLUDED = [
  /mvu/i, /initvar/i, /变量/, /状态栏/i, /StatusPlaceHolder/i, /data_block/i,
];

export function isPromptExcluded(entry) {
  const title = String(entry?.title || '');
  return entry?.category === '变量' || PROMPT_EXCLUDED.some((re) => re.test(title));
}

/**
 * @param {{entries:Array}} worldbook 由 tools/build-worldbook.mjs 生成
 * @param {{realm?:string}} [opts] 玩家所在界，用于过滤「玄天界/仙界」二选一条目
 */
export function buildIndex(worldbook, opts = {}) {
  const realm = opts.realm || '';
  const all = (worldbook?.entries || []).filter((e) => e && e.content);

  const usable = all.filter((e) => (e.enabled !== false || e.constant) && !isPromptExcluded(e));
  const realmFit = usable.filter((e) => !e.realm || !realm || e.realm === realm);

  const constant = realmFit.filter((e) => e.constant);
  const dynamic = realmFit.filter((e) => !e.constant);

  const corpus = buildCorpus(
    dynamic.map((e) => ({
      id: e.id,
      // 标题与触发词权重更高：重复计入即可（BM25 的 tf 天然放大）
      text: [e.title, e.title, e.name, e.name, (e.keys || []).join(' '), e.content].join('\n'),
    })),
  );

  const byId = new Map(dynamic.map((e) => [e.id, e]));

  return {
    realm,
    constant,
    entries: dynamic,
    byId,
    corpus,
    stats: {
      total: all.length,
      excluded: all.length - usable.length,
      constant: constant.length,
      searchable: dynamic.length,
      filteredByRealm: all.length - realmFit.length,
    },
  };
}

/**
 * 常驻条目拼成 L1 世界法则文本。
 *
 * 保证**至少收录一条**：世界书里单条常驻正文可能就超过预算，此时截断该条而不是
 * 一条都不给——L1 为空会让模型完全失去世界法则，比截断糟得多。
 */
export function constantText(index, { maxChars = 6000 } = {}) {
  const sorted = index.constant.slice().sort((a, b) => (a.order || 100) - (b.order || 100));
  const parts = [];
  let used = 0;
  for (const e of sorted) {
    const remaining = maxChars - used;
    if (remaining <= 0) break;
    if (e.content.length <= remaining) {
      parts.push(`【${e.title}】\n${e.content}`);
      used += e.content.length;
      continue;
    }
    if (parts.length === 0) {
      parts.push(`【${e.title}】\n${e.content.slice(0, Math.max(0, remaining))}`);
      used = maxChars;
    }
    break;
  }
  return { text: parts.join('\n\n'), used, included: parts.length, total: sorted.length };
}
