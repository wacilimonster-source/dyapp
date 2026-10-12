/**
 * 仓库卫生守卫：**绝不允许密钥进入 git**。
 *
 * 直接对应需求"密钥不允许上传 github"。策略是"扫已跟踪文件的内容"，而不是只看
 * .gitignore —— 因为密钥最可能的泄漏方式是有人手滑把它粘进了某个源码/文档/配置里，
 * 那种情况下 .gitignore 完全帮不上忙。
 *
 * 模式用片段拼接而成，避免本文件自身命中规则（否则守卫会把自己当成泄漏）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SELF = 'tests/repo.hygiene.test.mjs';

/** 各种密钥前缀 + 足够长的随机串，才算"像真的密钥"。 */
const PATTERNS = [
  { name: 'OpenAI 风格', re: new RegExp('\\bsk' + '-[A-Za-z0-9_-]{24,}') },
  { name: 'GitHub PAT', re: new RegExp('\\bgh' + 'p_[A-Za-z0-9]{30,}') },
  { name: 'GitHub 细粒度 PAT', re: new RegExp('\\bgithub' + '_pat_[A-Za-z0-9_]{30,}') },
  { name: 'AWS Access Key', re: new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b') },
  { name: 'Google API Key', re: new RegExp('\\bAI' + 'za[0-9A-Za-z_-]{35}') },
  { name: 'Slack Token', re: new RegExp('\\bxox' + '[bpasr]-[A-Za-z0-9-]{20,}') },
];

/** 这些文件名一律不该被跟踪。 */
const FORBIDDEN_TRACKED = [
  /(^|\/)secrets\.json$/,
  /(^|\/)secrets\.enc$/,
  /(^|\/)install\.key$/,
  /(^|\/)install\.salt$/,
  /\.keystore$/,
  /\.jks$/,
  /(^|\/)keystore\.properties$/,
  /(^|\/)local\.properties$/,
  /(^|\/)\.env(\.|$)/,
];

const BINARY_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.zip', '.apk', '.aab', '.so', '.jar', '.keystore', '.jks', '.woff', '.woff2', '.ttf', '.icns']);

function trackedFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 });
  return out.toString('utf8').split('\0').filter(Boolean);
}

test('没有任何密钥形态的字符串被 git 跟踪', () => {
  const files = trackedFiles();
  assert.ok(files.length > 20, `跟踪文件数异常：${files.length}`);

  const hits = [];
  for (const rel of files) {
    if (rel === SELF) continue;
    if (BINARY_EXT.has(extname(rel).toLowerCase())) continue;
    const abs = resolve(ROOT, rel);
    let size = 0;
    try { size = statSync(abs).size; } catch { continue; }
    if (size > 8 * 1024 * 1024) continue; // 超大文件（卡原文）跳过，避免拖慢
    let text;
    try { text = readFileSync(abs, 'utf8'); } catch { continue; }
    if (text.includes('\0')) continue;

    for (const { name, re } of PATTERNS) {
      const m = text.match(re);
      if (m) {
        const line = text.slice(0, m.index).split('\n').length;
        // 只报位置与前缀，绝不回显可疑内容本身
        hits.push(`${rel}:${line} 命中「${name}」（${m[0].slice(0, 6)}… 长度 ${m[0].length}）`);
      }
    }
  }

  assert.deepEqual(hits, [], `发现疑似密钥，请立刻移除并轮换：\n${hits.join('\n')}`);
});

test('敏感的本地文件一律未被跟踪', () => {
  const files = trackedFiles();
  const bad = files.filter((f) => FORBIDDEN_TRACKED.some((re) => re.test(f)));
  assert.deepEqual(bad, [], `这些文件不该入库：${bad.join(', ')}`);
});

test('.gitignore 覆盖密钥与签名材料', () => {
  const gi = readFileSync(resolve(ROOT, '.gitignore'), 'utf8');
  for (const need of ['secrets.json', 'secrets.enc', 'install.key', '*.keystore', '*.jks', 'keystore.properties', 'local.properties']) {
    assert.ok(gi.includes(need), `.gitignore 应包含 ${need}`);
  }
});
