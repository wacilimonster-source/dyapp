#!/usr/bin/env node
/**
 * 气运数据管道：_卡资产提取/regex8_creation.txt → prototype/data/luck.json
 *
 * 卡里的气运是写死在创角界面 JS 里的五个数组，本脚本原样搬出来，**不做任何文字加工**
 * （全角引号、换行、括号里的补充说明一律保留）—— 上一版就是因为顺手"改写"了描述，
 * 把卡里明写的代价删掉了，这次按字节对齐来防回归。
 *
 * 用法：node tools/build-luck.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, '_卡资产提取/regex8_creation.txt');
const OUT = resolve(ROOT, 'prototype/data/luck.json');

/** 池子：卡内变量名 → 输出键名 + 中文标签。顺序即卡内 allEroPresets 的拼接顺序。 */
const POOLS = [
  { src: 'restrictedFortunePresets', key: 'normal', label: '凡道气运' },
  { src: 'trueFortunePresets', key: 'true', label: '真气运' },
  { src: 'femaleEroPresets', key: 'eroFemale', label: '合欢·女', ero: 'female' },
  { src: 'maleEroPresets', key: 'eroMale', label: '合欢·男', ero: 'male' },
  { src: 'neutralEroPresets', key: 'eroNeutral', label: '合欢·通用', ero: 'neutral' },
];

/** 取出 `const NAME = [ ... ]` 的完整字面量（按括号配平，不看行）。 */
export function sliceArray(text, name) {
  const at = text.indexOf(`const ${name} = [`);
  if (at < 0) throw new Error(`找不到数组：${name}`);
  let depth = 0;
  for (let i = text.indexOf('[', at); i < text.length; i++) {
    const c = text[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return text.slice(text.indexOf('[', at), i + 1);
    }
  }
  throw new Error(`数组括号不配平：${name}`);
}

/**
 * 解析 `{ name: "…", desc: "…" }` 列表。
 * 卡内一律双引号 + 单行 desc；这里刻意写得严格：任何不符合的形状都直接报错，
 * 而不是静默跳过一条 —— 静默跳过就是"少了几条"的成因。
 */
export function parsePool(blockText, label) {
  const out = [];
  const re = /\{\s*name:\s*"((?:[^"\\]|\\.)*)"\s*,\s*desc:\s*"((?:[^"\\]|\\.)*)"\s*\}/g;
  let m;
  while ((m = re.exec(blockText))) {
    out.push({ name: unesc(m[1]), desc: unesc(m[2]) });
  }
  const objects = (blockText.match(/\{\s*name:/g) || []).length;
  if (objects !== out.length) {
    throw new Error(`${label}：数组里有 ${objects} 个 name 条目，只解析出 ${out.length} 条 —— 形状不匹配，拒绝静默丢条目`);
  }
  return out;
}

function unesc(s) {
  return s.replace(/\\(["'\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

function main() {
  const text = readFileSync(SRC, 'utf8');
  const pools = {};
  const labels = {};
  for (const p of POOLS) {
    pools[p.key] = parsePool(sliceArray(text, p.src), p.label);
    labels[p.key] = p.label;
  }

  // 卡内 roll 的真气运规则是"同下标顶掉凡道第 i 条"（regex8_creation.txt:2908）。
  // 这里把下标关系**显式记成名字**，避免将来任何人增删一条就让对应关系整体错位。
  const truePool = pools.true;
  pools.normal.forEach((e, i) => {
    if (truePool[i]) e.trueName = truePool[i].name;
  });
  // 凡池走完之后的真条（卡内下标 113–198）roll 永远抽不到，只能从气运库手选。
  const trueOnly = truePool.slice(pools.normal.length);

  const count = POOLS.reduce((s, p) => s + pools[p.key].length, 0);
  const payload = {
    generatedFrom: '_卡资产提取/regex8_creation.txt',
    note: '文本逐字照搬卡内原文（含代价与副作用描述），不得改写',
    count,
    labels,
    normal: pools.normal,
    true: truePool,
    trueOnlyCount: trueOnly.length,
    ero: { female: pools.eroFemale, male: pools.eroMale, neutral: pools.eroNeutral },
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  const bytes = statSync(OUT).size;
  const eroTotal = pools.eroFemale.length + pools.eroMale.length + pools.eroNeutral.length;
  console.log(`✅ 写出 ${OUT}（${(bytes / 1024).toFixed(0)} KB）`);
  console.log(`   凡道 ${pools.normal.length} · 真 ${truePool.length}（其中 roll 抽不到的 ${trueOnly.length}）· 合欢 ${eroTotal}`);
  console.log(`   合计 ${count} 条`);
  const named = new Set();
  const dup = [];
  for (const p of POOLS) for (const e of pools[p.key]) { if (named.has(e.name)) dup.push(e.name); named.add(e.name); }
  console.log(`   重名 ${dup.length ? dup.join('、') : '无'}`);
  console.log(`   空描述 ${POOLS.reduce((s, p) => s + pools[p.key].filter((e) => !e.desc.trim()).length, 0)} 条`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
