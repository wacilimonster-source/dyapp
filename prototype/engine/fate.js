/**
 * 抽取类机制：灵根品阶、气运演算。
 *
 * 气运这套规则是照原卡创角界面（`_卡资产提取/regex8_creation.txt`）逐条搬过来的，
 * 分支上标的行号就是卡内出处。要改动先确认卡里是不是也这样 —— 上一版就是因为
 * "自己发明了一套更爽的规则"（平铺全池、自选 3 条、代价删掉）而与原卡不一致。
 * @module engine/fate
 */

import { pickByChance, pickWeighted } from '../core/rng.js';
import { ROOT_TIERS } from './rules.js';

/** 抽灵根品阶（概率表在 engine/rules.js，与修炼产出同源）。 */
export function drawRoot(rng) {
  return pickByChance(rng, ROOT_TIERS);
}

/**
 * 三档难度对**整个创角表单**的影响（不只是气运演算）。
 * 重抽预算：simple 3 / normal 10 / hard 5（卡内 1246、3127、3143）
 * 候选个数：hard 5、其余 10（卡内 2948）；合欢模式下凡道固定只给 5（卡内 2936）
 * 真条：hard 永不出现（卡内 2844 的 `currentMode !== 'hard'`）
 * 自定义气运：卡内 normal/hard 直接隐藏该区块（3123、3136）
 * 道侣自选：卡内 normal/hard 隐藏 companionSection（3131、3137）
 * 起始境界：simple 自由填（realmInput）/ normal 下拉选（realmSelect，默认炼气期）
 *            / hard 固定「未修炼」且禁用（3138-3139）
 */
export const FATE_MODES = {
  simple: { 名: '随缘', 预算: 3, 候选: 10, 可出真: true, 可自定义: true, 可自选道侣: true, 境界: '输入' },
  normal: { 名: '正途', 预算: 10, 候选: 10, 可出真: true, 可自定义: false, 可自选道侣: false, 境界: '下拉' },
  hard: { 名: '逆天而行', 预算: 5, 候选: 5, 可出真: false, 可自定义: false, 可自选道侣: false, 境界: '未修炼' },
};

/** 合欢池按创角性别过滤（卡内 2938-2946）。 */
export function eroPool(luck, gender) {
  const g = String(gender || '');
  const n = luck.ero.neutral;
  if (/女|雌/.test(g)) return [...luck.ero.female, ...n];
  if (/男|雄/.test(g)) return [...luck.ero.male, ...n];
  return [...luck.ero.female, ...luck.ero.male, ...n];
}

/** 真条查表：按凡道条目上记录的 `trueName` 取，不靠数组下标 —— 顺序一变也不会错位。 */
function trueOf(luck, indexByName, entry) {
  if (!entry || !entry.trueName) return null;
  const i = indexByName.get(entry.trueName);
  return i == null ? null : luck.true[i];
}

/**
 * 一次「天机演算」：生成候选列表。
 *
 * @param {object} o
 * @param {object} o.luck        `luck.json` 解析后的数据
 * @param {() => number} [o.rng] 随机源（测试注入固定序列即可复现）
 * @param {'simple'|'normal'|'hard'} [o.mode]
 * @param {boolean} [o.ero]      「合欢秘辛」开关
 * @param {boolean} [o.cheat]    「逆天改命」开关
 * @param {string} [o.gender]    创角性别，决定合欢池过滤
 * @param {object} [o.lockedNormal] 已定下的凡道条，重 roll 时保留（卡内 lockedNormal）
 * @param {object} [o.lockedEro]    已定下的合欢条
 * @returns {{normal: object[], ero: object[], 预算: number}}
 */
export function rollFates(o) {
  const luck = o.luck;
  const rng = o.rng || Math.random;
  const mode = FATE_MODES[o.mode] ? o.mode : 'simple';
  const M = FATE_MODES[mode];
  const indexByName = new Map(luck.true.map((e, i) => [e.name, i]));
  const out = { normal: [], ero: [], 预算: M.预算 };
  const used = new Set();
  const canBeTrue = !!o.cheat && M.可出真;

  const take = (pool, want, isEro, locked) => {
    const bucket = isEro ? out.ero : out.normal;
    if (locked && !used.has(locked.name)) {
      used.add(locked.name);
      bucket.push({ name: locked.name, desc: locked.desc, 真: !!locked.真, 合欢: isEro });
    }
    let guard = 0;
    while (bucket.length < want && guard++ < want * 60) {
      const base = pool[Math.floor(rng() * pool.length)];
      if (!base) break;
      let e = base;
      let 真 = false;
      // 卡内 2908：命中 5% 才换成同下标真条；合欢条不参与这个分支
      if (!isEro && canBeTrue && rng() < 0.05) {
        const t = trueOf(luck, indexByName, base);
        if (t) { e = t; 真 = true; }
      }
      if (used.has(e.name)) continue;
      used.add(e.name);
      bucket.push({ name: e.name, desc: e.desc, 真, 合欢: isEro });
    }
  };

  if (o.ero) {
    take(luck.normal, 5, false, o.lockedNormal);                         // 卡内 2936
    take(eroPool(luck, o.gender), 5, true, o.lockedEro);                 // 卡内 2946
  } else {
    take(luck.normal, mode === 'hard' ? 5 : 10, false, o.lockedNormal);  // 卡内 2948-2949
  }
  return out;
}

/** 卡内的选中落盘格式：名号 `【A】 & 【B】`，描述之间用 `\n\n[合欢]: ` 分隔。 */
export function fateText(picked) {
  const names = (picked || []).map((p) => `【${p.name}】`).join(' & ');
  let desc = '';
  for (const p of picked || []) {
    if (desc) desc += p.合欢 ? '\n\n[合欢]: ' : '\n\n';
    desc += p.desc;
  }
  return { names, desc };
}

/**
 * 按名号在五个池子里查条目。气运库手选与旧档迁移都靠它。
 * @returns {null | {name:string,desc:string,真:boolean,合欢:('normal'|'female'|'male'|'neutral')}}
 */
export function findFate(luck, name) {
  const n = String(name || '');
  let i = luck.normal.findIndex((e) => e.name === n);
  if (i >= 0) return { ...luck.normal[i], 真: false, 合欢: 'normal' };
  i = luck.true.findIndex((e) => e.name === n);
  if (i >= 0) return { ...luck.true[i], 真: true, 合欢: 'normal' };
  for (const k of ['female', 'male', 'neutral']) {
    const j = luck.ero[k].findIndex((e) => e.name === n);
    if (j >= 0) return { ...luck.ero[k][j], 真: false, 合欢: k };
  }
  return null;
}

/**
 * 通用加权抽取（供动态遭遇等使用；气运演算走 `rollFates`，它必须照卡的 5% 规则）。
 * @param {Array<{name:string,desc:string,weight?:number}>} pool
 */
export function drawLuck(rng, pool, n = 1, filter = null) {
  const candidates = (pool || []).filter((l) => l && (!filter || filter(l)));
  const out = [];
  const used = new Set();
  let guard = 0;
  while (out.length < n && guard++ < 200) {
    const rest = candidates.filter((l) => !used.has(l.name));
    if (!rest.length) break;
    const picked = pickWeighted(rng, rest, rest.map((l) => l.weight ?? 1));
    used.add(picked.name);
    out.push(picked);
  }
  return out;
}
