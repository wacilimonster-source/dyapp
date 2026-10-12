/**
 * 创角：把玩家的六步选择落成一个初始 GameState。
 *
 * 为什么放在引擎层：出身加成、灵石数量、道侣建档、真·气运抽取都是**确定性规则**，
 * 之前散在界面层（app.js）里手写，既不可单测、也和引擎的规则表重复维护。
 * 现在只依赖 core/ 与 engine/ 模块，测试可注入 rng 复现。
 * @module engine/create
 */

import { clamp } from '../core/clamp.js';
import { pick } from '../core/rng.js';
import { emptyState, normalize } from './state.js';
import { drawRoot, hitTrueLuck } from './fate.js';

/** 抽灵根品阶（概率表在 engine/rules.js，与修炼产出同源）。 */
export function drawRootTier(rng) {
  return drawRoot(rng);
}

/**
 * 真·气运抽取：5% 命中才升格；已存在的名字跳过（不重复）。
 * @returns {null | {name:string, 向:string, desc:string, 真:true}} 未命中返回 null
 */
export function drawTrueLuck(rng, pool, existing = [], chance = 0.05) {
  if (!hitTrueLuck(rng, chance)) return null;
  const taken = new Set((existing || []).map((l) => l && l.name));
  let guard = 0;
  while (guard++ < 100) {
    const base = pick(rng, pool);
    if (!base) return null;
    const name = `真·${base.name}`;
    if (!taken.has(name)) {
      return { name, 向: base.向, desc: base.desc, 真: true };
    }
  }
  return null;
}

/** 道侣默认模板；没有预设设定时兜底用。 */
export function defaultPartnerTemplate() {
  return {
    性别: '女', 种族: '人族', 状态: '正常', 境界: '筑基后期',
    亲密: 20, 生命: 90, 灵力: 80, 修为: 60, 道心: 68,
    性格: '尚未看清。', 外观: '——', 身高: '——',
    背景: '命中注定要遇见的人。', 神通: '——', 心声: '（终于……见到你了。）',
  };
}

const deep = (o) => JSON.parse(JSON.stringify(o));

/**
 * 创角选择 → 初始状态（已归一化）。
 * @param {{姓名?:string, 性别?:string, 出身?:string, 灵根?:object|null, 气运?:string[], 道侣?:string, 出生界?:string}} g
 * @param {{partnerPreset?:object}} [opts] partnerPreset：名字 → 预设人物卡（来自 data.js 的示例存档）
 */
export function applyCreateState(g, opts = {}) {
  const fresh = emptyState();

  fresh.主角.姓名 = g.姓名 || '陆沉';
  fresh.主角.性别 = g.性别 || '男';
  fresh.主角.所在界 = g.出生界 || '玄天界';
  fresh.主角.宗门 = g.出身 === '寒门散修' ? '散修'
    : g.出身 === '宗门外门' ? '青云宗 · 外门'
      : g.出身 === '没落世家' ? '没落世家' : '散修';
  if (g.出生界 === '仙界') fresh.主角.境界 = '真仙一层';
  fresh.主角.灵根 = g.灵根 ? `${g.灵根.品} · 单灵根` : '凡品 · 单灵根';
  if (g.出身 === '寒门散修') fresh.主角.道心 = 58;
  if (g.出身 === '宗门外门') fresh.主角.宗门贡献 = 120;
  if (g.灵根 && g.灵根.品 === '天品') fresh.主角.道心 = clamp(fresh.主角.道心 + 10, 0, 100);

  for (const n of g.气运 || []) {
    fresh.主角.气运[n] = {
      类型: n.startsWith('真·') ? '主动' : '被动',
      效果: '（创角所选气运）',
      使用状态: '常驻',
      压制状态: '正常',
      真: n.startsWith('真·'),
    };
  }

  const 灵石 = g.出身 === '没落世家' ? 36 : 16;
  fresh.主角.储物袋['下品灵石'] = { 描述: '修仙界通用硬通货', 数量: 灵石 };
  fresh.主角.储物袋['聚气丹'] = { 描述: '服之可缓缓回复灵力', 数量: 3 };
  fresh.主角.储物袋['疗伤散'] = { 描述: '外伤止血，聊胜于无', 数量: 2 };
  fresh.主角.功法['青云吐纳诀'] = { 类型: '筑基功法', 境界: '炼气期', 熟练度: 0, 描述: '青云宗外门入门吐纳之法，中正平和。' };
  fresh.主角.器物['青纹剑'] = { 等级: '下品法器', 类型: '飞剑', 损耗度: 0, 状态: '完好', 描述: '剑身一道青纹，注入灵力可御使三丈。' };

  if (g.道侣) {
    const preset = opts.partnerPreset && opts.partnerPreset[g.道侣];
    // 选了预设角色就带出真实设定（此前一律套模板，"选了林若悠也不认识她"）
    fresh.道侣[g.道侣] = preset && typeof preset === 'object'
      ? deep(preset)
      : defaultPartnerTemplate();
    // 玉简同步建档：否则创角后打开「玉简」面板会因空数据而崩溃
    fresh.玉简[g.道侣] = {
      性别: fresh.道侣[g.道侣].性别 || '女',
      境界: fresh.道侣[g.道侣].境界 || '筑基后期',
      关系: '道侣',
      好感度: clamp(Number(fresh.道侣[g.道侣].亲密) || 20, 0, 100),
      历史记录: {},
    };
  }

  return normalize(fresh);
}

/** 第 0 回合的开局叙事。 */
export function openingTurn(state) {
  return {
    role: 'assistant',
    text: `${state.主角.姓名}，${state.主角.所在界}的风，比你想的更冷一些。\n\n你睁开眼时，身下是青云宗后山的青石，衣袍还带着洗不净的皂角味。远处钟声三响，是外门晨课的时辰。\n\n你的道途，从这一刻开始。`,
    scene: { 当前时间: state.世界.当前时间, 当前地点: state.世界.当前地点, 危机程度: state.世界.危机程度 },
    choices: ['起身去上晨课', '先查看自己的储物袋', '往后山深处走走'],
  };
}
