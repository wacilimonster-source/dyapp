#!/usr/bin/env node
/**
 * 真实 ESM 语法检查。
 *
 * 为什么不用 `node --check`：实测它对 **.js 文件里的 ES 模块**会漏报——
 * 我们真的踩到了：app.js 里一个字符串字面量混进了裸换行，浏览器直接
 * `SyntaxError: Invalid or unexpected token` 整个模块不执行（界面静默失灵），
 * 而 `node --check prototype/app.js` 返回 0。
 *
 * 这里用 `vm.SourceTextModule` 做真正的模块解析（只解析、不执行），
 * 与浏览器的判定一致。
 *
 * 用法：node tools/check-syntax.mjs [目录...]   默认检查 prototype/
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2);
const roots = (targets.length ? targets : ['prototype']).map((p) => resolve(ROOT, p));

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = roots.flatMap((r) => (statSync(r).isDirectory() ? walk(r) : [r]));
let failed = 0;

for (const file of files.sort()) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const src = readFileSync(file, 'utf8');
  try {
    // 只解析不执行；不解析 import 的依赖（那些文件本身也会被逐个检查）
    new vm.SourceTextModule(src, { identifier: rel });
    console.log(`  ok  ${rel}`);
  } catch (e) {
    failed++;
    console.error(`  ✗   ${rel}\n      ${String(e.message).split('\n')[0]}`);
  }
}

console.log(`\n检查 ${files.length} 个文件，失败 ${failed} 个`);
process.exit(failed ? 1 : 0);
