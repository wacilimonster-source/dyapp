/**
 * 状态容器：不变量、归一化、快照。
 *
 * 设计原则：**归一化是幂等的**——normalize(normalize(s)) === normalize(s)。
 * 任何写入路径（创角、effect 落地、远程拉取、导入存档）结束后都必须跑一次。
 * @module engine/state
 */

import { clampField, PCT_MAX } from '../core/clamp.js';
import { parseRealm, realmLabel, realmDC } from './rules.js';
import { deriveTime, TIME_SLOTS } from './time.js';

/** 需要按 0–100 夹取的字段名（含关系类）。 */
export const PCT_FIELDS = new Set([
  '生命', '精血', '灵力', '修为', '神识', '道心',
  '好感', '好感度', '亲密', '亲密度', '熟练度', '成功率', '损耗度',
]);

/** 各集合的容量上限。 */
export const CAPS = Object.freeze({ 机遇: 20, 绝色榜: 20, 历史记录: 100 });

/** 冻结字段：首次写入后不再被 effect 改写（卡内规定"性格"禁止随剧情变化）。 */
export const FROZEN_KEYS = new Set(['性格']);

/** 深拷贝（结构化克隆；状态里只有 JSON 可表达的值）。 */
export function snapshot(state) {
  return JSON.parse(JSON.stringify(state));
}

/** 创角前的空白状态骨架。 */
export function emptyState() {
  return {
    世界: { 当前时间: '初春 · 清晨', 天数: 1, 时段: '清晨', 当前地点: '青云宗 · 后山', 天气: '细雨', 灵气: '稀薄', 危机程度: '无', 遭遇冷却: 3, 动向: {} },
    主角: {
      姓名: '陆沉', 性别: '男', 容貌: '', 身形: '', 衣着: '', 境界: '炼气一层', 境界DC: 1,
      宗门: '散修', 宗门贡献: 0, 所在界: '玄天界',
      生命: 100, 精血: 80, 灵力: 60, 修为: 0, 神识: 70, 道心: 50,
      神念: '寻常', 灵根: '凡品 · 单灵根', 状态: '无异常',
      气运: {}, 炼丹: emptyCraft(), 炼器: emptyCraft(), 储物袋: {}, 功法: {}, 器物: {},
    },
    道侣: {}, 灵宠: {}, 人物: {}, 机遇: {}, 绝色榜: {}, 玉简: {},
    $器灵台词: [], $frozen: {}, $log: [],
    $成就: {}, $统计: { 回合数: 0, 突破成功: 0, 突破失败: 0 }, $往昔: '',
  };
}

function emptyCraft() {
  return { 阶级: '未入门', 熟练度: 0, 成功率: 8, 次数: 0 };
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * 归一化：夹数值、补缺字段、裁容量、清单条。
 * @param {object} state
 * @returns {object} 同一个对象（原地修改，便于链式调用）
 */
export function normalize(state) {
  if (!isPlainObject(state)) return emptyState();

  // 顶层集合必须存在
  for (const k of ['道侣', '灵宠', '人物', '机遇', '绝色榜', '玉简']) {
    if (!isPlainObject(state[k])) state[k] = {};
  }
  if (!Array.isArray(state.$器灵台词)) state.$器灵台词 = [];
  if (!isPlainObject(state.$frozen)) state.$frozen = {};
  if (!Array.isArray(state.$log)) state.$log = [];
  if (!isPlainObject(state.$成就)) state.$成就 = {};
  if (!isPlainObject(state.$统计)) state.$统计 = {};
  if (typeof state.$往昔 !== 'string') state.$往昔 = '';
  for (const k of ['回合数', '突破成功', '突破失败']) {
    state.$统计[k] = Math.max(0, Math.floor(Number(state.$统计[k]) || 0));
  }

  // 世界
  const W = (state.世界 = isPlainObject(state.世界) ? state.世界 : {});
  W.当前时间 = str(W.当前时间, '初春 · 清晨');
  W.当前地点 = str(W.当前地点, '未知之地');
  W.天气 = str(W.天气, '晴');
  W.灵气 = str(W.灵气, '寻常');
  W.危机程度 = ['无', '低', '中', '高'].includes(W.危机程度) ? W.危机程度 : '无';
  W.遭遇冷却 = clampField('遭遇冷却', W.遭遇冷却, 3);
  // 时间由引擎独占：只保存 天数/时段，展示文本由它们派生
  W.天数 = Math.max(1, Math.floor(Number(W.天数) || 1));
  W.时段 = TIME_SLOTS.includes(W.时段) ? W.时段 : '清晨';
  W.当前时间 = deriveTime(W);
  if (!isPlainObject(W.动向)) W.动向 = {};

  // 主角
  const P = (state.主角 = isPlainObject(state.主角) ? state.主角 : {});
  P.姓名 = str(P.姓名, '陆沉');
  P.性别 = str(P.性别, '男');
  P.所在界 = P.所在界 === '仙界' ? '仙界' : '玄天界';
  for (const k of ['容貌', '身形', '衣着', '宗门', '神念', '灵根', '状态']) P[k] = str(P[k], P[k] === undefined ? '' : P[k]);
  if (!P.状态) P.状态 = '无异常';
  for (const k of PCT_FIELDS) if (k in P) P[k] = clampField(k, P[k], 0);
  P.宗门贡献 = clampField('宗门贡献', P.宗门贡献, 0);
  for (const k of ['气运', '储物袋', '功法', '器物']) if (!isPlainObject(P[k])) P[k] = {};
  for (const k of ['炼丹', '炼器']) P[k] = normalizeCraft(P[k]);
  // 境界与 DC 保持一致
  const parsed = parseRealm(P.境界);
  P.境界 = realmLabel(parsed.major, parsed.minor);
  P.境界DC = realmDC(parsed.major, parsed.minor);

  // 储物袋：数量 ≤0 剔除
  for (const [k, v] of Object.entries(P.储物袋)) {
    if (!isPlainObject(v)) { delete P.储物袋[k]; continue; }
    v.数量 = clampField('数量', v.数量, 0);
    v.描述 = str(v.描述, '');
    if (v.数量 <= 0) delete P.储物袋[k];
  }

  // 人物 / 道侣 / 灵宠：关系数值
  for (const [name, npc] of Object.entries(state.人物)) {
    if (!isPlainObject(npc)) { delete state.人物[name]; continue; }
    for (const k of PCT_FIELDS) if (k in npc) npc[k] = clampField(k, npc[k], 0);
    npc.关系阶段 = str(npc.关系阶段, '陌生');
  }
  for (const map of ['道侣', '灵宠']) {
    for (const [name, c] of Object.entries(state[map])) {
      if (!isPlainObject(c)) { delete state[map][name]; continue; }
      for (const k of PCT_FIELDS) if (k in c) c[k] = clampField(k, c[k], 0);
    }
  }

  // 机遇：保留最近 N 条（对象插入序即时间序）
  state.机遇 = tail(state.机遇, CAPS.机遇);
  state.绝色榜 = tail(state.绝色榜, CAPS.绝色榜);

  // 玉简：历史记录保留最近 N 条
  for (const [name, c] of Object.entries(state.玉简)) {
    if (!isPlainObject(c)) { delete state.玉简[name]; continue; }
    c.好感度 = clampField('好感度', c.好感度, 0);
    c.历史记录 = isPlainObject(c.历史记录) ? tail(c.历史记录, CAPS.历史记录) : {};
  }

  return state;
}

function normalizeCraft(v) {
  const c = isPlainObject(v) ? v : {};
  return {
    阶级: str(c.阶级, '未入门'),
    熟练度: clampField('熟练度', c.熟练度, 0),
    成功率: clampField('成功率', c.成功率, 8),
    次数: clampField('数量', c.次数, 0),
  };
}

/** 保留对象的最后 n 个键。 */
function tail(obj, n) {
  const keys = Object.keys(obj || {});
  if (keys.length <= n) return obj || {};
  const out = {};
  for (const k of keys.slice(keys.length - n)) out[k] = obj[k];
  return out;
}

function str(v, dflt) {
  return typeof v === 'string' && v.trim() ? v.trim() : String(v ?? '').trim() || dflt;
}

/** 该路径是否已被冻结（如 性格）。 */
export function isFrozen(state, path) {
  return !!(state.$frozen && state.$frozen[path]);
}

/** 冻结某路径。 */
export function freeze(state, path) {
  if (!state.$frozen) state.$frozen = {};
  state.$frozen[path] = true;
}

/** 生成给模型看的紧凑状态摘要（对应技术架构 L3 层）。 */
export function stateSummary(state) {
  const P = state?.主角 || {};
  const W = state?.世界 || {};
  const who = Object.entries(state?.人物 || {})
    .map(([k, v]) => `${k}（好感${v.好感 ?? '?'}·${v.关系阶段 || '?'}）`)
    .join('；') || '无';
  const dai = Object.keys(state?.道侣 || {}).join('、') || '无';
  const pet = Object.keys(state?.灵宠 || {}).join('、') || '无';
  return [
    // 境界标签由 engine 的 realmLabel 生成，本身已含（DC:n），这里不再拼
    `${P.姓名} · ${P.境界} · ${P.宗门} · ${P.所在界}`,
    `时间：${W.当前时间}｜地点：${W.当前地点}｜天气：${W.天气}｜危机：${W.危机程度}`,
    `生命${P.生命} 精血${P.精血} 灵力${P.灵力} 修为${P.修为} 神识${P.神识} 道心${P.道心}`,
    `灵根：${P.灵根}｜状态：${P.状态}｜气运：${Object.keys(P.气运 || {}).join('、') || '无'}`,
    `道侣：${dai}｜灵宠：${pet}｜在场人物：${who}`,
  ].join('\n');
}

export { PCT_MAX };
