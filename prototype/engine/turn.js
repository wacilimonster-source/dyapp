/**
 * 一回合编排。**引擎负责确定性，模型负责演出**——这里是两者握手的地方。
 *
 * 时序（详见 docs/05 第 4 节）：
 *   推进时间/冷却 → 检索 → 叙事(流式) → 裁决(JSON) → 落地 → 返回
 * @module engine/turn
 */

import { applyAll } from './effects.js';
import { normalize } from './state.js';
import {
  advanceRealm,
  breakthroughChance,
  cultivate,
  isCultivationFull,
  parseRealm,
} from './rules.js';
import { sceneClass, tick as encounterTick, pickCandidate } from './encounter.js';
import { resolveDuel, isCombatIntent } from './combat.js';
import { advanceTime, deriveTime, TIME_SLOTS, SEASONS } from './time.js';
import { retrieve } from '../memory/retrieve.js';
import { composeArbiter } from '../narrator/prompt.js';
import { buildPromptPlan, stSamplingToOverride } from '../narrator/plan.js';
import { streamNarrative, decide } from '../narrator/client.js';
import { parseTurnResult, sanitizeNarrative, stateBlockIndex } from '../narrator/parse.js';

export { advanceTime, deriveTime, TIME_SLOTS, SEASONS };

/* ------------------------- 引擎自算的意图 ------------------------- */

/**
 * 执行"引擎能算的部分"。返回 hints（喂给模型的事实）与已落地的 effects。
 * @param {{kind:string, text:string}} action
 */
export function resolveIntent(action, state, rng) {
  const hints = [];
  const effects = [];
  const kind = action?.kind || 'free';

  if (kind === 'cultivate') {
    const r = cultivate({
      rootText: state.主角.灵根,
      realmLabel: state.主角.境界,
    });
    const before = state.主角.修为;
    effects.push({ op: 'delta', target: '主角.修为', value: r.修为增量, reason: '闭关修炼' });
    effects.push({ op: 'delta', target: '主角.灵力', value: 15, reason: '打坐回复' });
    effects.push({ op: 'delta', target: '主角.生命', value: -2, reason: '久坐少食' });
    hints.push(`修炼结算：修为 ${before} → ${Math.min(100, before + r.修为增量)}（${r.品阶}灵根，本次 +${r.修为增量}），耗时 ${r.耗时天数} 日。这是引擎算出的结果，请把它写成闭关的经过，不要改数字。`);
    advanceTime(state.世界, r.耗时天数);
    hints.push(`时间推进到：${state.世界.当前时间}（第 ${state.世界.天数} 日）。`);
    return { hints, effects, days: r.耗时天数, preEffects: true };
  }

  if (kind === 'breakthrough') {
    // 修为未满 100 不具备突破条件（卡内规则：小境界圆满方可尝试）。
    // 引擎兜底：即使界面漏了拦截，也不掷骰、不耗时间。
    if (!isCultivationFull(state)) {
      hints.push('突破条件不足：修为未满 100。本次不进行突破判定，也不推进时间。');
      return { hints, effects, days: 0, preEffects: false, duel: null };
    }
    const { major } = parseRealm(state.主角.境界);
    const p = breakthroughChance({ 道心: state.主角.道心, rootText: state.主角.灵根, targetMajor: major });
    const win = rng() < p;
    hints.push(`突破判定：引擎掷骰，成功率 ${(p * 100).toFixed(0)}%，结果「${win ? '成功' : '失败'}」。请描写经脉游走与成败的经过，不要改结果。`);
    if (win) {
      effects.push({ op: 'delta', target: '主角.修为', value: -100, reason: '突破消耗修为' });
      // 晋阶由引擎写：L0 禁止模型改境界，不写就永远停在原地（实测的断点）
      const before = state.主角.境界;
      const next = advanceRealm(before);
      if (next) {
        effects.push({ op: 'set', target: '主角.境界', value: next, reason: '突破成功' });
        hints.push(`境界变化：${before} → ${next}（引擎已结算并写入状态，正文里不要另写数值或重复宣布）。`);
      } else {
        hints.push('已至最高境界，修为虽消耗但境界不再前进。');
      }
    } else {
      effects.push({ op: 'delta', target: '主角.生命', value: -12, reason: '突破失败反噬' });
    }
    advanceTime(state.世界, 3);
    hints.push(`时间推进到：${state.世界.当前时间}。`);
    return {
      hints,
      effects,
      days: 3,
      preEffects: true,
      duel: {
        win,
        chance: p,
        diff: 0,
        tier: { desc: '突破瓶颈：成功则晋阶，失败则受反噬' },
        opponentName: '瓶颈',
      },
    };
  }

  if (kind === 'duel' || (kind === 'free' && isCombatIntent(action.text))) {
    // 斗法：胜负与伤势由引擎定成硬事实，模型只写过程（卡里这块是模型裁量）
    const c = resolveDuel({ state, text: action.text || '', rng });
    effects.push(...c.effects);
    hints.push(...c.hints);
    advanceTime(state.世界, 1);
    hints.push(`时间推进到：${state.世界.当前时间}。`);
    return { hints, effects, days: 1, preEffects: true, duel: c.duel };
  }

  advanceTime(state.世界, 0);
  hints.push(`时间推进到：${state.世界.当前时间}。`);
  return { hints, effects, days: 0, preEffects: false };
}
/* ------------------------- 主流程 ------------------------- */

/**
 * @param {{action:{kind:string,text:string}, state:object, index:object, llm:object,
 *          rng:()=>number, recent?:Array, onDelta?:Function, onPhase?:Function,
 *          fallbackNarratives?:string[]}} input
 */
export async function runTurn(input) {
  const {
    action, state, index, llm, rng,
    recent = [], recap = '', onDelta, onPhase, fallbackNarratives = [],
    chat = null,
  } = input;

  const text = String(action?.text || '').trim();
  const logs = [];
  onPhase?.('engine');

  const intent = resolveIntent(action, state, rng);
  const hints = [...intent.hints];

  // 遭遇：冷却归零就抽一个候选，交给模型演
  let encounter = null;
  const cooldown = encounterTick(state.世界, { reset: 6 });
  if (cooldown.fired && index) {
    const entry = pickCandidate(index.entries, {
      realm: state.主角.境界,
      scene: sceneClass(state.世界.当前地点),
    }, rng);
    if (entry) {
      encounter = { name: entry.name || entry.title, title: entry.title, category: entry.category };
      hints.push(`动态遭遇：本回合发生一次偶遇，对方是「${encounter.name}」（见相关设定条目）。请让这次相遇显得自然，不要凭空发明与设定冲突的身份。`);
    }
  }

  // 检索（含遭遇对象与在场人物）
  const npcs = [
    ...Object.keys(state.人物 || {}),
    ...Object.keys(state.道侣 || {}),
    ...Object.keys(state.灵宠 || {}),
  ];
  if (encounter) npcs.push(encounter.name);

  let retrieved = [];
  let retrieveMeta = null;
  try {
    const r = retrieve(index, {
      action: `${text} ${hints.join(' ')}`,
      place: state.世界.当前地点,
      npcs,
      realm: state.主角.境界,
      recent: recent.slice(-4).map((t) => t.text).join(' '),
    });
    retrieved = r.items;
    retrieveMeta = { usedTokens: r.usedTokens, dropped: r.dropped, count: r.items.length };
  } catch (e) {
    logs.push(`检索失败，已降级为只注入常驻法则：${e?.message || e}`);
  }

  const duel = intent.duel || null;

  // 叙事：默认模式与预设模式在这里分岔，但产出的都是同一种 PromptPlan
  onPhase?.('narrating');
  const plan = buildPromptPlan({
    mode: chat?.mode === 'preset' && chat.preset ? 'preset' : 'default',
    preset: chat?.preset,
    engine: { action: text || '（静观其变）', index, state, retrieved, recent, hints, recap },
    names: { charName: chat?.charName, userName: chat?.userName, style: chat?.style },
    rng,
  });
  const messages = plan.messages;
  const meta = plan.meta;
  for (const w of plan.warnings || []) logs.push(`预设：${w}`);

  // 流式期间就截断：一旦模型开始吐状态标记，界面立即停止追加，
  // 避免玩家眼看着正文里长出一整块 XML。
  const onDeltaSafe = onDelta
    ? (chunk, full) => {
      const cut = stateBlockIndex(full);
      onDelta(chunk, cut >= 0 ? full.slice(0, cut) : full);
    }
    : undefined;

  const streamed = await streamNarrative(llm, messages, onDeltaSafe, {
    // 预设里的采样参数覆盖应用默认（决策：预设管"怎么说话"）
    sampling: stSamplingToOverride(plan.sampling),
  });
  let narrative = sanitizeNarrative(streamed.text);
  let source = streamed.ok ? 'llm' : 'fallback';

  if (!streamed.ok) {
    const f = fallbackNarratives.length ? fallbackNarratives[Math.floor(rng() * fallbackNarratives.length)] : '';
    narrative = f || '（离线模式：未接入大模型，本回合只推进了时间与冷却。）';
    if (streamed.error) logs.push(`叙事降级：${streamed.error}`);
  }

  // 裁决：拿 effects。优先用裁决模型（更便宜），没配就退回叙事模型。
  let effects = [];
  let scene = {};
  let choices = [];
  if (streamed.ok) {
    onPhase?.('arbitrating');
    const arb = composeArbiter({
      action: text,
      narrative,
      state,
      recent,
      retrieved,
      scene: { 当前时间: state.世界.当前时间, 当前地点: state.世界.当前地点, 危机程度: state.世界.危机程度 },
    });
    let d = await decide(llm, arb, { useArbiter: !!input.arbiterConfigured });
    if (!d.ok && input.arbiterConfigured) d = await decide(llm, arb, { useArbiter: false });
    if (d.ok) {
      const parsed = parseTurnResult(d.raw);
      effects = parsed.effects;
      scene = parsed.scene;
      choices = parsed.choices;
      logs.push(...parsed.logs);
    } else {
      logs.push(`裁决失败，本次状态未更新：${d.error}`);
    }
  }

  // 引擎自算的效果先落地，模型给的效果后落地（模型可能再次修改，比如被毒伤叠加）
  const merged = intent.preEffects ? [...intent.effects, ...effects] : effects;
  onPhase?.('applying');
  const applied = applyAll(state, merged);

  // 场景：地点/危机/天气由模型决定；时间由引擎独占
  if (scene.当前地点) state.世界.当前地点 = scene.当前地点;
  if (scene.危机程度) state.世界.危机程度 = scene.危机程度;
  if (scene.天气) state.世界.天气 = scene.天气;
  if (scene.灵气) state.世界.灵气 = scene.灵气;
  normalize(state);

  logs.push(...applied.logs);
  if (logs.length) state.$log = [...(state.$log || []), ...logs].slice(-200);

  onPhase?.('done');

  return {
    narrative,
    kind: action?.kind || 'free',
    // 本回合叙事调用的用量（渠道给了才有）：界面用它出"账单行"并累计
    usage: streamed.usage || null,
    effects: merged,
    applied: { applied: applied.applied, skipped: applied.skipped },
    events: applied.events,
    scene: {
      当前时间: state.世界.当前时间,
      当前地点: state.世界.当前地点,
      危机程度: state.世界.危机程度,
      天气: state.世界.天气,
    },
    choices: choices.length ? choices : defaultChoices(state),
    encounter,
    duel,
    source,
    meta: { prompt: meta, retrieve: retrieveMeta, plan },
    logs,
  };
}

function defaultChoices(state) {
  const indoor = sceneClass(state.世界.当前地点) === 'indoor';
  return indoor
    ? ['打听消息', '留神四周的人', '起身离开']
    : ['继续前行', '观察四周', '原地调息'];
}
