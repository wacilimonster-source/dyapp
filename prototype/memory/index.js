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
 * 常驻法则（L1）的**分层优先级**。
 *
 * 为什么需要：卡里的 constant 条目里混着两类东西——
 *   一类是"每回合都要遵守的世界法则"（境界、DC、道心、时间、礼仪…），
 *   另一类是"教模型掷表生成 NPC/宗门/城市"的**程序化说明**。
 * 后者在独立版里已由引擎接管（遭遇引擎抽候选、气运/灵根由 fate 抽取），
 * 对模型只是噪音；而它们排在前面时会把真正要用的规则挤出预算
 * （实测：L1 2240 字预算被"NPC人物生成规则/宗门生成/城市生成"吃光，
 * 境界与具体数值一条都没进去）。
 *
 * 所以：程序化生成类**排除**，其余按 tier 排序（tier 小者优先）。
 */
export const CONSTANT_EXCLUDED = [
  /生成规则/, /宗门生成/, /城市生成/, /人物生成/, /遗迹生成/, /动态人物相遇/,
];

/** tier 越小越先塞进 L1；未命中的归 2 档。 */
export const CONSTANT_TIERS = [
  { tier: 0, re: /境界|具体数值|DC|道心|时间|礼仪|灵根|战斗|器物|神识|核心规则|灵石体系/ },
  { tier: 1, re: /介绍|势力|关键人物|周期性秘境|绝色榜|机遇/ },
  { tier: 3, re: /审查|铁律|元规则/ },
];

export function constantTier(entry) {
  const t = String(entry?.title || '');
  for (const { tier, re } of CONSTANT_TIERS) if (re.test(t)) return tier;
  return 2;
}

export function isConstantExcluded(entry) {
  const t = String(entry?.title || '');
  return CONSTANT_EXCLUDED.some((re) => re.test(t));
}

/**
 * @param {{entries:Array}} worldbook 由 tools/build-worldbook.mjs 生成
 * @param {{realm?:string}} [opts] 玩家所在界，用于过滤「玄天界/仙界」二选一条目
 */
export function buildIndex(worldbook, opts = {}) {
  const realm = opts.realm || '';
  const all = (worldbook?.entries || []).filter((e) => e && e.content);

  // 卡内标了 enabled=False 的条目，作者就是关掉的 —— 常驻也不给进提示词。
  // 原先写成 `(e.enabled !== false || e.constant)`，于是 25 条停用条目里有 9 条
  // 重新进了候选池，其中「玄天界灵石体系」还排在启用中的 DC/道心/时间 之前；
  // 预算一放宽，被作者关掉的内容就会挤掉核心规则。图鉴面板不受影响（那里是文档）。
  const usable = all.filter((e) => e.enabled !== false && !isPromptExcluded(e));
  const realmFit = usable.filter((e) => !e.realm || !realm || e.realm === realm);

  const constant = realmFit.filter((e) => e.constant && !isConstantExcluded(e));
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
      // 被排除出提示词的条目总数 = 机制条目 + 出生界不符 + 程序化生成类常驻条目
      excluded: all.length - constant.length - dynamic.length,
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
  // 「元规则/自查」类条目（卡里的"合理性审查"三重人格）降到最后排，并单独限量。
  // 为什么：它单条 2604 字，而 L1 预算（现 6000 字）里真正每回合要用的规则有二十几条
  // ——若不降级，光它一条就吃掉近半预算，境界/数值/礼仪/时间这些反而被挤掉。
  // 主方案第 3.8 节的意图是"保留叙事性自查"，所以不删，只是不许它抢位置。
  const demoted = (e) => constantTier(e) >= 3;
  const sorted = index.constant
    .slice()
    .sort((a, b) => constantTier(a) - constantTier(b)
      || (demoted(a) ? 1 : 0) - (demoted(b) ? 1 : 0)
      || (a.order || 100) - (b.order || 100));

  const regularCap = Math.max(200, Math.floor(maxChars * 0.45));
  const demotedCap = Math.max(150, Math.floor(maxChars * 0.25));
  const perEntryCap = (e) => (demoted(e) ? demotedCap : regularCap);

  const parts = [];
  const truncated = [];
  const skipped = [];
  let used = 0;
  for (const e of sorted) {
    const remaining = maxChars - used;
    if (remaining <= 0) { skipped.push(e.title); continue; }
    const room = Math.min(remaining, perEntryCap(e));
    if (e.content.length <= room) {
      parts.push(`【${e.title}】\n${e.content}`);
      used += e.content.length;
      continue;
    }
    parts.push(`【${e.title}】\n${e.content.slice(0, Math.max(0, room))}`);
    truncated.push(e.title);
    used += room;
  }
  // truncated 会告诉调用方哪些条目被截断；skipped 告诉哪些**一条都没进**——
  // 没有后者，"世界法则只进了 6/26 条"在界面上完全没有痕迹。
  return { text: parts.join('\n\n'), used, included: parts.length, total: sorted.length, truncated, skipped };
}
