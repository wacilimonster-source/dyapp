/**
 * 器灵台词：从卡内带来的现成台词里抽一条（纯引擎，不调模型）。
 *
 * 卡的初始状态里有 '$器灵台词'（data.js），一直没人消费——这里是它的统一出口。
 * 抽成纯模块是为了两点可测：不重复上一条（连续两次别吐同一句）、空表安全返回 null。
 * @module engine/voice
 */

/**
 * @param {string[]} lines 台词池
 * @param {{rng?:()=>number, avoid?:string}} [opts] rng 可注入以便测试；avoid 是上一条（尽量避开）
 * @returns {string|null} 池为空返回 null
 */
export function pickSpiritLine(lines, opts = {}) {
  const pool = (Array.isArray(lines) ? lines : []).filter((x) => typeof x === 'string' && x.trim());
  if (!pool.length) return null;
  const rng = typeof opts.rng === 'function' ? opts.rng : Math.random;
  const avoid = opts.avoid;
  if (pool.length > 1 && avoid) {
    const rest = pool.filter((x) => x !== avoid);
    if (rest.length) return rest[Math.floor(rng() * rest.length) % rest.length];
  }
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

/**
 * 按场合挑台词：台词池按「突破/闲谈」两类标注存放（卡里没有标注就全部当闲谈用）。
 * 现在的数据形状是纯字符串数组，所以 occasion 暂时只是语义占位，等台词库分家后生效。
 * @param {string[]|object} lines
 * @param {'breakthrough'|'idle'|'timeline'} occasion
 * @param {{rng?:()=>number, avoid?:string}} [opts]
 */
export function pickSpiritLineFor(lines, occasion, opts = {}) {
  if (lines && !Array.isArray(lines) && typeof lines === 'object') {
    const pool = lines[occasion] && lines[occasion].length ? lines[occasion] : lines.idle || [];
    return pickSpiritLine(pool, opts);
  }
  return pickSpiritLine(lines, opts);
}
