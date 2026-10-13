#!/usr/bin/env node
/**
 * 立绘数据管道：_卡资产提取/regex_scripts.json（脚本「XML状态栏」）→ prototype/data/portraits.json
 *
 * 卡里的人物立绘不写在世界书里，而是写在一个**已停用**的状态栏脚本的 JS 常量里：
 *   const charPortraits = { "瑶汐": "https://free-img.400040.xyz/…png", … }
 * 本脚本把这个映射原样搬出来，URL 一个字符都不改（改了就等于我们自己造图，历史证明会出错）。
 *
 * 用法：node tools/build-portraits.mjs
 */
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, '_卡资产提取/regex_scripts.json');
const OUT = resolve(ROOT, 'prototype/data/portraits.json');
const SCRIPT_NAME = 'XML状态栏';

/** 卡内立绘用的免费图床域名。出现别的域名说明卡更新了，需要同时放宽 CSP。 */
const KNOWN_HOSTS = ['free-img.400040.xyz'];

/** 取出 `const NAME = { … }` 的字面量（按花括号配平，字符串里的括号不算）。 */
export function sliceObject(text, name) {
  const at = text.indexOf(`const ${name} = {`);
  if (at < 0) throw new Error(`找不到对象常量：${name}`);
  const start = text.indexOf('{', at);
  let depth = 0;
  let inStr = null;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  throw new Error(`花括号不配平：${name}`);
}

/**
 * 解析 `"人名": "https://…"` 扁平映射。
 * 和 build-luck 同一套原则：形状对不上就报错，绝不静默少一条。
 */
export function parsePortraits(blockText) {
  const out = new Map();
  const dup = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(blockText))) {
    const name = unesc(m[1]).trim();
    const url = unesc(m[2]).trim();
    if (out.has(name)) dup.push(name);
    out.set(name, url);
  }
  // 键分隔符是 `"key": "value"` 里的那个 `": "`；URL 内部只有 `://`，不会误命中。
  const separators = (blockText.match(/"\s*:\s*"/g) || []).length;
  if (separators !== out.size + dup.length) {
    throw new Error(`块里有 ${separators} 组键值，只解析出 ${out.size + dup.length} 条 —— 形状不匹配，拒绝静默丢条目`);
  }
  const bad = [...out.entries()].filter(([, u]) => !/^https:\/\//.test(u));
  if (bad.length) throw new Error(`这些立绘 URL 不是 https：${bad.slice(0, 5).map(([n, u]) => `${n}→${u}`).join('、')}`);
  return { map: out, dup };
}

function unesc(s) {
  return s.replace(/\\(["'\\nt])/g, (_, c) => ({ n: '\n', t: '\t' })[c] ?? c);
}

function main() {
  const scripts = JSON.parse(readFileSync(SRC, 'utf8'));
  const script = scripts.find((s) => s.scriptName === SCRIPT_NAME);
  if (!script) throw new Error(`卡内没有脚本「${SCRIPT_NAME}」`);
  const block = sliceObject(script.replaceString || '', 'charPortraits');
  const { map, dup } = parsePortraits(block);
  if (map.size < 100) throw new Error(`只解析出 ${map.size} 条，明显少于卡内的 148 条，先查解析器`);

  const hosts = [...new Set([...map.values()].map((u) => new URL(u).host))].sort();
  const unknown = hosts.filter((h) => !KNOWN_HOSTS.includes(h));

  const payload = {
    generatedFrom: '_卡资产提取/regex_scripts.json',
    scriptName: SCRIPT_NAME,
    scriptDisabled: script.disabled === true,
    note: '人名→立绘外链，URL 逐字照搬卡内原文。卡用的是免费图床，链接可能失效，界面必须有兜底',
    count: map.size,
    hosts,
    map: Object.fromEntries(map),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  console.log(`✅ 写出 ${OUT}（${(statSync(OUT).size / 1024).toFixed(0)} KB）`);
  console.log(`   立绘 ${map.size} 条 · 图床 ${hosts.join('、')}${unknown.length ? `（未在白名单：${unknown.join('、')}）` : ''}`);
  console.log(`   卡内该脚本状态：${script.disabled === true ? '已停用' : '启用中'}`);
  console.log(`   重名 ${dup.length ? dup.join('、') : '无'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
