/**
 * 游戏内时间。**时间由引擎独占**：模型可以通过 `scene` 描述氛围，但改不动时间。
 * 卡内要求"用现代词表达"，所以存的是「季节 · 时段」这种可读文本。
 * @module engine/time
 */

export const TIME_SLOTS = Object.freeze(['清晨', '上午', '午后', '黄昏', '入夜']);

/** 12 个节气式分段，每 10 天进一格。 */
export const SEASONS = Object.freeze([
  '初春', '仲春', '暮春', '初夏', '仲夏', '暮夏',
  '初秋', '仲秋', '暮秋', '初冬', '仲冬', '暮冬',
]);

/** 由 天数 / 时段 派生展示用时间文本。 */
export function deriveTime(world) {
  const day = Math.max(1, Math.floor(Number(world?.天数) || 1));
  const slot = TIME_SLOTS.includes(world?.时段) ? world.时段 : '清晨';
  const season = SEASONS[Math.floor((day - 1) / 10) % SEASONS.length];
  return `${season} · ${slot}`;
}

/**
 * 推进时间。
 * @param {object} world
 * @param {number} days 跨过的整数天；0 表示只走一个时段
 */
export function advanceTime(world, days = 0) {
  const d = Math.max(0, Math.floor(Number(days) || 0));
  const day = Math.max(1, Math.floor(Number(world.天数) || 1));
  if (d > 0) {
    world.天数 = day + d;
    world.时段 = TIME_SLOTS[0];
  } else {
    const cur = TIME_SLOTS.indexOf(world.时段);
    const next = cur < 0 ? 0 : cur + 1;
    if (next >= TIME_SLOTS.length) {
      world.天数 = day + 1;
      world.时段 = TIME_SLOTS[0];
    } else {
      world.时段 = TIME_SLOTS[next];
    }
  }
  world.当前时间 = deriveTime(world);
  return { text: world.当前时间, days: d || 1, day: world.天数 };
}
