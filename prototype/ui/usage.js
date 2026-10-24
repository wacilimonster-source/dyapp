/**
 * 每回合账单：用量的记录、汇总与展示格式。
 *
 * 为什么做成纯模块：记录与格式化是纯逻辑，抽出来才能在 node --test 里锁行为
 * （"≈3.2k tok"这种字符串一旦手写在界面层就没法回归测试了）。
 *
 * usage 的形状来自壳的 `usage` 事件（app/src-tauri/src/llm.rs 的 extract_usage）：
 * `{ promptTokens, completionTokens, totalTokens, cachedTokens }`，缺的字段是 null。
 * @module ui/usage
 */

/** 一份新的空账本。 */
export function emptyUsage() {
  return { total: { prompt: 0, completion: 0, cached: 0, cachedSeen: false, calls: 0, ms: 0 }, days: {}, saves: {} };
}

const today = () => new Date().toISOString().slice(0, 10);

function blankBucket() {
  return { prompt: 0, completion: 0, cached: 0, cachedSeen: false, calls: 0, ms: 0 };
}

/**
 * 记一笔（纯函数：不改入参，返回新账本）。
 * @param {object} book 账本
 * @param {{saveId?:string, usage?:object, ms?:number, kind?:string}} ev
 *   usage 缺省（渠道不给）时只计时长与次数，token 记 0。
 */
export function record(book, ev) {
  // 深复制，避免和入参共享任何引用
  const next = {
    total: { ...book.total },
    days: Object.fromEntries(Object.entries(book.days || {}).map(([k, v]) => [k, { ...v }])),
    saves: Object.fromEntries(Object.entries(book.saves || {}).map(([k, v]) => [k, { ...v }])),
  };
  const u = ev && ev.usage ? ev.usage : null;
  const prompt = Number(u && u.promptTokens) || 0;
  const completion = Number(u && u.completionTokens) || 0;
  const cached = Number(u && u.cachedTokens) || 0;
  const ms = Math.max(0, Number(ev && ev.ms) || 0);
  const day = today();
  const saveId = ev && ev.saveId ? String(ev.saveId) : '';

  const add = (bucket) => {
    bucket.prompt += prompt;
    bucket.completion += completion;
    bucket.cached += cached;
    // cachedTokens 是 null（渠道不报）还是 0（真没命中）必须区分：
    // 前者显示"无数据"，后者才是 0%——否则玩家会误以为缓存坏了
    if (u && u.cachedTokens != null) bucket.cachedSeen = true;
    bucket.calls += 1;
    bucket.ms += ms;
  };
  add(next.total);
  const d = (next.days[day] = next.days[day] || blankBucket());
  add(d);
  if (saveId) {
    const sv = (next.saves[saveId] = next.saves[saveId] || blankBucket());
    add(sv);
  }
  return next;
}

/** 千位人性化：1320 → "1.3k"，320 → "320"。 */
function tok(n) {
  if (!n) return '0';
  if (n >= 1000) return (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k';
  return String(n);
}

/**
 * 回合尾那行账单。
 * @param {{usage?:object, ms?:number}} ev
 * @returns {string} 例如 "≈1.3k tok · 8.4s · 缓存命中 41%"；渠道不给 usage 时只报耗时
 */
export function formatBill(ev) {
  const ms = Math.max(0, Number(ev && ev.ms) || 0);
  const sec = (ms / 1000).toFixed(ms >= 10000 ? 0 : 1) + 's';
  const u = ev && ev.usage;
  const prompt = Number(u && u.promptTokens) || 0;
  const completion = Number(u && u.completionTokens) || 0;
  if (!prompt && !completion) return sec;
  let out = `≈${tok(prompt + completion)} tok（入 ${tok(prompt)} / 出 ${tok(completion)}）· ${sec}`;
  if (u && u.cachedTokens && prompt) {
    out += ` · 缓存命中 ${Math.round((Number(u.cachedTokens) / prompt) * 100)}%`;
  }
  return out;
}

/**
 * 「设置 → 用量」的汇总行。
 * @returns {{calls:number, tokens:string, avgSec:string, today:string, cached:string}}
 */
export function summary(book) {
  const t = (book && book.total) || blankBucket();
  const day = (book && book.days && book.days[today()]) || blankBucket();
  const avg = t.calls ? t.ms / t.calls : 0;
  return {
    calls: t.calls,
    tokens: `${tok(t.prompt + t.completion)} tok（入 ${tok(t.prompt)} / 出 ${tok(t.completion)}）`,
    avgSec: t.calls ? `${(avg / 1000).toFixed(1)}s` : '—',
    today: `${tok(day.prompt + day.completion)} tok · ${day.calls} 次`,
    cached: t.prompt && t.cachedSeen ? `${Math.round((t.cached / t.prompt) * 100)}%` : '无数据',
  };
}

/** 账本只留最近 90 天的按日明细与最近 20 个存档的分档明细（防 localStorage 无限膨胀）。 */
export function compact(book) {
  const days = Object.entries(book.days || {}).sort().slice(-90);
  const saves = Object.entries(book.saves || {}).slice(-20);
  return {
    total: { ...book.total },
    days: Object.fromEntries(days),
    saves: Object.fromEntries(saves),
  };
}
