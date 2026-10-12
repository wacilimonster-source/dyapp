/**
 * 规则表与规则函数。**全部纯函数**，随机源以参数注入。
 * 数据来源：docs/附录B·状态数据模型.md（从卡内条目提取后固化）。
 * @module engine/rules
 */

import { clamp } from '../core/clamp.js';

/* ------------------------------ 境界 ------------------------------ */

/** 十五大境界，顺序即晋升顺序。 */
export const REALM_ORDER = [
  '凡', '炼气期', '筑基期', '金丹期', '元婴期', '化神期', '炼虚期',
  '合体期', '大乘期', '渡劫期', '真仙境', '金仙境', '玄仙境',
  '仙帝境', '半步超脱', '超脱境',
];

/** DC 表：[小境界一层的 DC, 小境界九层的 DC]（单值境界则两值相同）。 */
export const REALM_DC = Object.freeze({
  凡: [0, 0],
  炼气期: [1, 10], 筑基期: [25, 34], 金丹期: [49, 58], 元婴期: [73, 82],
  化神期: [97, 106], 炼虚期: [121, 130], 合体期: [145, 154], 大乘期: [169, 178],
  渡劫期: [182, 182], 真仙境: [217, 226], 金仙境: [241, 250], 玄仙境: [265, 274],
  仙帝境: [289, 298], 半步超脱: [666, 666], 超脱境: [999, 999],
});

/** 小境界中文数字。 */
export const MINOR_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
const CN_NUM = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 单值境界（不再分小境界层）。 */
const SINGLE_MINOR = new Set(['凡', '渡劫期', '半步超脱', '超脱境']);

/**
 * 大境界的"词根"（去掉 期/境 后缀），按长度倒序。
 * 为什么需要：状态里存的是拼在一起的标签（"筑基三层"），而 REALM_DC 的键带后缀
 * （"筑基期"）。直接 startsWith 会全部落空，必须先用词根匹配。
 */
const MAJOR_BASES = REALM_ORDER
  .filter((r) => r !== '凡')
  .map((r) => ({ realm: r, base: r.replace(/[期境]$/, '') }))
  .sort((a, b) => b.base.length - a.base.length);

/**
 * 解析境界标签。
 * "炼气三层" → { major:'炼气期', minor:3, dc:3 }
 * "金丹二层（DC:50）" → { major:'金丹期', minor:2, dc:50 }
 * "凡" → { major:'凡', minor:1, dc:0 }
 * 无法识别时返回 major:'凡' 并带 unknown:true（由调用方决定是否告警）。
 */
export function parseRealm(label) {
  const s = String(label || '').trim().replace(/[（(]\s*DC\s*[:：]\s*\d+\s*[)）]/gi, '').trim();
  if (!s || s === '凡' || s === '凡人') return { major: '凡', minor: 1, dc: 0 };

  const hit = MAJOR_BASES.find((b) => s.startsWith(b.base));
  const major = hit ? hit.realm : '凡';
  const m = s.match(/([一二三四五六七八九])\s*层/);
  const minor = m ? CN_NUM[m[1]] || 1 : 1;
  return { major, minor, dc: realmDC(major, minor), unknown: !hit };
}

/** 由大境界 + 小境界层数算 DC。 */
export function realmDC(major, minor = 1) {
  const band = REALM_DC[major];
  if (!band) return 0;
  const [lo, hi] = band;
  if (lo === hi) return lo;
  const idx = clamp(minor, 1, 9) - 1;
  return lo + idx;
}

/** 大境界的词根名（"炼气期" → "炼气"），用于拼标签。 */
export function majorBase(major) {
  return String(major || '').replace(/[期境]$/, '');
}

/** 生成规范境界标签："炼气三层（DC:3）"。 */
export function realmLabel(major, minor = 1) {
  if (SINGLE_MINOR.has(major)) return `${major}（DC:${realmDC(major, 1)}）`;
  return `${majorBase(major)}${MINOR_CN[clamp(minor, 1, 9) - 1]}层（DC:${realmDC(major, minor)}）`;
}

/** 大境界序号（用于比较与"跨几大境界"）。 */
export function realmIndex(major) {
  const i = REALM_ORDER.indexOf(major);
  return i < 0 ? 0 : i;
}

/** 跨越了几个大境界（正数表示 a 高于 b）。 */
export function crossMajorRealm(aMajor, bMajor) {
  return realmIndex(aMajor) - realmIndex(bMajor);
}

/* ------------------------------ DC 压制 ------------------------------ */

export const DC_TIERS = Object.freeze([
  { max: 2, desc: '同层博弈，胜负看战术 · 法宝 · 临场' },
  { max: 3, desc: '越一小境界，高阶微弱优势' },
  { max: 6, desc: '越两小境界，压制初显' },
  { max: 9, desc: '越三小境界，同阶绝对压制' },
  { max: 15, desc: '越一大境界，触发「精神灵压律」' },
  { max: Infinity, desc: '越数个大境界，绝对压制律 + 不可逆伤害律' },
]);

/** DC 差 → 压制阶梯。 */
export function dcTier(diff) {
  const d = Math.abs(Number(diff) || 0);
  return DC_TIERS.find((t) => d <= t.max);
}

/* ------------------------------ 修为与修炼 ------------------------------ */

/** 灵根品阶修炼加成（每次修炼的修为增量）。 */
export const ROOT_GAIN = Object.freeze({
  天品: { 炼气: 30, 筑基化神: 20, 炼虚大乘: 15, 真仙仙帝: 10 },
  地品: { 炼气: 26, 筑基化神: 17, 炼虚大乘: 13, 真仙仙帝: 8 },
  玄品: { 炼气: 21, 筑基化神: 14, 炼虚大乘: 10, 真仙仙帝: 7 },
  黄品: { 炼气: 16, 筑基化神: 11, 炼虚大乘: 8, 真仙仙帝: 6 },
  凡品: { 炼气: 10, 筑基化神: 7, 炼虚大乘: 5, 真仙仙帝: 3 },
});

/** 灵根品阶概率（创角抽灵根用）。 */
export const ROOT_TIERS = Object.freeze([
  { 品: '天品', 概率: 0.01, 修炼: '炼气 +30 / 筑基–化神 +20 / 炼虚–大乘 +15 / 真仙–仙帝 +10' },
  { 品: '地品', 概率: 0.04, 修炼: '炼气 +26 / 筑基–化神 +17 / 炼虚–大乘 +13 / 真仙–仙帝 +8' },
  { 品: '玄品', 概率: 0.15, 修炼: '炼气 +21 / 筑基–化神 +14 / 炼虚–大乘 +10 / 真仙–仙帝 +7' },
  { 品: '黄品', 概率: 0.35, 修炼: '炼气 +16 / 筑基–化神 +11 / 炼虚–大乘 +8 / 真仙–仙帝 +6' },
  { 品: '凡品', 概率: 0.45, 修炼: '炼气 +10 / 筑基–化神 +7 / 炼虚–大乘 +5 / 真仙–仙帝 +3' },
]);

/** 从灵根描述里取品阶（"黄品 · 单灵根（火）" → "黄品"）。 */
export function rootTier(rootText) {
  const m = String(rootText || '').match(/(天|地|玄|黄|凡)品/);
  return m ? `${m[1]}品` : '凡品';
}

/** 境界 → 修炼加成档位。 */
export function gainBand(major) {
  const i = realmIndex(major);
  if (i <= realmIndex('炼气期')) return '炼气';
  if (i <= realmIndex('化神期')) return '筑基化神';
  if (i <= realmIndex('大乘期')) return '炼虚大乘';
  return '真仙仙帝';
}

/** 单次修炼的基础天数（40 日以内；境界越高越久）。 */
export function cultivateDays(major) {
  const band = gainBand(major);
  return { 炼气: 30, 筑基化神: 45, 炼虚大乘: 60, 真仙仙帝: 90 }[band];
}

/**
 * 一次修炼的产出。
 * @param {{rootText:string, realmLabel:string, days?:number}} input
 * @returns {{修为增量:number, 耗时天数:number, 品阶:string}}
 */
export function cultivate({ rootText, realmLabel: label, days }) {
  const { major } = parseRealm(label);
  const tier = rootTier(rootText);
  const band = gainBand(major);
  const table = ROOT_GAIN[tier] || ROOT_GAIN.凡品;
  const perSession = table[band];
  const baseDays = cultivateDays(major);
  const useDays = Number.isFinite(days) && days > 0 ? days : baseDays;
  const 修为增量 = Math.max(0, Math.round((perSession * useDays) / baseDays));
  return { 修为增量, 耗时天数: useDays, 品阶: tier };
}

/** 修为满 100 即"圆满"，可尝试突破。 */
export function isCultivationFull(state) {
  return Number(state?.主角?.修为) >= 100;
}

/**
 * 突破成功率。
 * @param {{道心:number, rootText:string, 丹药加成?:number, targetMajor?:string}} input
 */
export function breakthroughChance({ 道心, rootText, 丹药加成 = 0, targetMajor }) {
  const tier = rootTier(rootText);
  const rootBonus = { 天品: 0.15, 地品: 0.1, 玄品: 0.05, 黄品: 0, 凡品: -0.05 }[tier] ?? 0;
  const daoBonus = (clamp(Number(道心) || 0, 0, 100) - 50) / 200; // ±0.25
  // 炼虚期起需要悟法则 + 渡劫，成功率整体下调
  const highRealmPenalty = targetMajor && realmIndex(targetMajor) >= realmIndex('炼虚期') ? -0.15 : 0;
  const p = 0.5 + daoBonus + rootBonus + clamp(Number(丹药加成) || 0, 0, 0.3) + highRealmPenalty;
  return clamp(p, 0.05, 0.95);
}

/**
 * 下一个境界标签（引擎负责晋阶）。
 *
 * 为什么必须由引擎做：L0 协议明确禁止模型改境界，所以"突破成功"之后
 * 没有任何一方会去写 `主角.境界` —— 实测发现核心成长循环因此断掉
 * （修为清零、境界永远停在创角时的炼气一层）。
 *
 * 规则：小境界 +1；九层则进下一个大境界的一层；单值境界（渡劫/超脱…）直接进下一大境界。
 * 大境界所需的丹药/渡劫条件由叙事与道具负责，引擎只保证"境界确实前进了"。
 */
export function advanceRealm(label) {
  const { major, minor } = parseRealm(label);
  const idx = realmIndex(major);
  if (idx < 0 || idx >= REALM_ORDER.length - 1) {
    return REALM_ORDER[idx] === major ? null : null; // 已是最后一境
  }
  if (SINGLE_MINOR.has(major) || minor >= 9) {
    const nextMajor = REALM_ORDER[idx + 1];
    return nextMajor ? realmLabel(nextMajor, 1) : null;
  }
  return realmLabel(major, minor + 1);
}

/* ------------------------------ 道心与模糊感知 ------------------------------ */

/** 道心四境。 */
export function daoStage(v) {
  const n = clamp(Number(v) || 0, 0, 100);
  if (n <= 25) return '凡心';
  if (n <= 50) return '初窥门径';
  if (n <= 75) return '澄澈';
  return '磐石';
}

export const DAO_STAGES = Object.freeze(['凡心', '初窥门径', '澄澈', '磐石']);

/** 模糊感知（卡设定：主角无法感知精确数值，UI 默认显示这个）。 */
export const VAGUE_LEVELS = Object.freeze([
  { min: 80, label: '充盈' },
  { min: 30, label: '稳固' },
  { min: 20, label: '不足' },
  { min: 10, label: '枯竭' },
  { min: 1, label: '濒危' },
  { min: 0, label: '归零' },
]);

export function vague(v) {
  const n = Math.max(0, Number(v) || 0);
  return VAGUE_LEVELS.find((l) => n >= l.min).label;
}

/** 危机四档。 */
export const CRISIS_LEVELS = Object.freeze([
  { label: '无', lv: 0 }, { label: '低', lv: 1 }, { label: '中', lv: 2 }, { label: '高', lv: 3 },
]);

export function crisisLevel(text) {
  const t = String(text || '无').trim();
  return (CRISIS_LEVELS.find((c) => c.label === t) || CRISIS_LEVELS[0]).lv;
}
