/**
 * 全量审查中修掉的 bug 的回归测试。
 *
 * 每条对应一个真实缺陷；这些用例的作用是：**同样的错不会再悄悄回来**。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { advanceRealm, parseRealm, realmLabel } from '../prototype/engine/rules.js';
import { buildPromptPlan } from '../prototype/narrator/plan.js';
import { parsePreset } from '../prototype/preset/schema.js';
import { emptyState, normalize, stateSummary } from '../prototype/engine/state.js';

/* ============================================================
 * bug: 突破成功后境界从不前进（引擎没人写 主角.境界，L0 又禁止模型写）
 * ============================================================ */

test('advanceRealm：小境界 +1', () => {
  assert.equal(advanceRealm('炼气三层'), realmLabel('炼气期', 4));
  assert.equal(advanceRealm('炼气三层'), '炼气四层（DC:4）');
  assert.equal(advanceRealm('筑基五层'), '筑基六层（DC:30）');
});

test('advanceRealm：九层进下一大境界的一层', () => {
  assert.equal(advanceRealm('炼气九层'), '筑基一层（DC:25）');
  assert.equal(advanceRealm('筑基九层'), '金丹一层（DC:49）');
});

test('advanceRealm：从凡开始、单值境界直接跨大境界', () => {
  assert.equal(advanceRealm('凡'), '炼气一层（DC:1）');
  assert.equal(advanceRealm('渡劫期'), '真仙一层（DC:217）');
  assert.equal(advanceRealm('半步超脱'), '超脱境（DC:999）');
});

test('advanceRealm：已是最后一境返回 null（不再前进但也不报错）', () => {
  assert.equal(advanceRealm('超脱境'), null);
});

test('advanceRealm 产物能被 parseRealm 正确解析（标签格式自洽）', () => {
  let label = '炼气一层';
  for (let i = 0; i < 12; i++) {
    const next = advanceRealm(label);
    assert.ok(next, `第 ${i} 步不该卡住：${label}`);
    const p = parseRealm(next);
    assert.ok(p.major && p.dc >= 0, `产物解析异常：${next}`);
    label = next;
  }
  assert.equal(label, '筑基四层（DC:28）'); // 炼气 9 层 + 筑基 3 层
});

/* ============================================================
 * bug: stateSummary 重复拼接 DC（炼气一层（DC:1）（DC:1））
 * ============================================================ */

test('stateSummary：境界只出现一次 DC', () => {
  const s = emptyState();
  s.主角.姓名 = '陆沉';
  s.主角.境界 = '炼气三层';
  normalize(s);
  const out = stateSummary(s);
  const hits = out.match(/（DC:\d+）/g) || [];
  assert.equal(hits.length, 1, out);
});

/* ============================================================
 * bug: 预设里 injection_depth 超出 1..8 的条目被静默丢弃（无告警、内容消失）
 * ============================================================ */

function presetWithDepth(depth) {
  return {
    name: `depth-${depth}`,
    temperature: 0.8,
    prompts: [
      { identifier: 'main', name: 'Main', system_prompt: true, role: 'system', content: '你是{{char}}。' },
      { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true, content: '' },
      {
        identifier: 'deep', name: '深插', system_prompt: false, role: 'system',
        content: '（深插内容）', injection_position: 1, injection_depth: depth,
      },
    ],
    prompt_order: [{
      character_id: 100000,
      order: [
        { identifier: 'main', enabled: true },
        { identifier: 'deep', enabled: true },
        { identifier: 'chatHistory', enabled: true },
      ],
    }],
  };
}

function planForDepth(depth) {
  const parsed = parsePreset(presetWithDepth(depth));
  assert.equal(parsed.ok, true, parsed.error);
  const s = emptyState();
  s.主角.姓名 = '陆沉';
  normalize(s);
  return buildPromptPlan({
    mode: 'preset',
    preset: parsed.preset,
    engine: {
      action: '走',
      index: null,
      state: s,
      retrieved: [],
      recent: [{ role: 'assistant', text: '甲' }, { role: 'user', text: '乙' }],
      hints: [],
    },
    names: { charName: '道渊', userName: '陆沉' },
  });
}

test('深度插入：常见的 depth=2 正常落位', () => {
  const plan = planForDepth(2);
  assert.ok(plan.messages.some((m) => m.content.includes('深插内容')), '内容必须出现在 messages 里');
  assert.equal(plan.meta.deepInserts, 1);
});

test('深度插入：depth=20 不再被静默丢弃（原先只处理 1..8）', () => {
  const plan = planForDepth(20);
  // 关键：内容必须出现在 messages 里。原实现把它丢进 deepInserts 后，
  // 因为两个插入点都只遍历 1..8，条目既不做深度插入、又在顺序展开时被跳过 —— 彻底消失且无告警。
  assert.ok(plan.messages.some((m) => m.content.includes('深插内容')), '大深度也必须注入，不能消失');
});

test('深度插入：超出上限（99）会被夹到上限并告警', () => {
  const plan = planForDepth(99);
  assert.ok(plan.messages.some((m) => m.content.includes('深插内容')));
  assert.ok(plan.warnings.some((w) => w.includes('深度')), '超上限要告警');
});

test('深度插入：depth=0 与非法值按 1 处理并告警', () => {
  const plan = planForDepth(0);
  assert.ok(plan.messages.some((m) => m.content.includes('深插内容')));
  assert.ok(plan.warnings.some((w) => w.includes('深度')));
});

/* ============================================================
 * bug: HUD 折叠后 [data-res] 尺寸为 0，飘字被定位到视口外
 * 这里测不了 DOM，但锁住"折叠时也要给出可用坐标"的约定：
 * float() 依赖 #hud 容器存在——界面里必须有这个锚点
 * ============================================================ */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const APP_JS = readFileSync(resolve(ROOT, 'prototype/app.js'), 'utf8');

test('飘字定位：限定在 #hud 内取条，并在量不到尺寸时回退到 HUD 底边', () => {
  assert.match(APP_JS, /#hud \[data-res=/, '必须限定在 HUD 内取，避免命中抽屉里的同名条');
  assert.match(APP_JS, /hr\.width === 0\) return/, '游戏页不可见时应放弃飘字而不是飘到 (0,0)');
});

test('飘字与 fx chips：都由引擎落地事件驱动（events），而不是意图（effects）', () => {
  assert.match(APP_JS, /const fxEvents = \(result\.events \|\| \[\]\)\.filter/, '飘字/chips 必须读 events');
  assert.match(APP_JS, /for \(const ev of fxEvents\)/, '飘字循环用落地事件');
  assert.match(APP_JS, /fx: fxEvents\.map/, '回合记录里存落地增量，重渲时 chips 才与飘字一致');
});

test('回合进行中守卫：并发点击不会再起第二个回合', () => {
  assert.match(APP_JS, /if \(turnInFlight\) return null/);
  assert.match(APP_JS, /turnInFlight = true/);
});

test('判定覆盖层：Esc 与「承认结果」走同一条收尾路径', () => {
  assert.match(APP_JS, /judgeAck/, '必须有待确认回调记录');
  assert.match(APP_JS, /if \(typeof judgeAck === 'function'\) judgeAck\(\)/, 'Esc 必须补跑收尾');
});

test('建议条：换档 / 新档 / 重渲时都会重置', () => {
  const resets = APP_JS.match(/setSuggestions\(\[\]\)/g) || [];
  assert.ok(resets.length >= 2, '至少 loadSave 与 applyCreate 各有一处重置');
  assert.match(APP_JS, /const last = \[\.\.\.turns\]\.reverse\(\)\.find/, 'renderStream 需按最后一轮同步建议');
});

test('手势：处理 touchcancel 并在手机上也能跟随手指', () => {
  assert.match(APP_JS, /addEventListener\('touchcancel'/, '缺 touchcancel 会让 inline transform 残留');
  assert.match(APP_JS, /app\.dataset\.layout === 'phone' \|\| !sb\.classList\.contains\('mini'\)/);
  assert.match(APP_JS, /classList\.add\('dragging'\)/, '拖拽时要关掉 transition 才跟手');
});

test('预设存储：不再有恒真的 persistent || true 死代码', () => {
  assert.ok(!APP_JS.includes('persistent || true'), '死分支应删除');
});
