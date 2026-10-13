/**
 * 立绘数据保真守卫：卡内「XML状态栏」脚本里的 charPortraits ↔ prototype/data/portraits.json。
 *
 * 只守一件事：**URL 必须逐字来自卡内原文**。图床是作者自建的免费线路，链接本来就短命，
 * 我们唯一能负责的是"卡里写的是哪张图就指向哪张图"，不自己拼路径、不改域名、不换后缀。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceObject, parsePortraits } from '../tools/build-portraits.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, '_卡资产提取/regex_scripts.json');
const DATA = resolve(ROOT, 'prototype/data/portraits.json');

const scripts = JSON.parse(readFileSync(SRC, 'utf8'));
const script = scripts.find((s) => s.scriptName === 'XML状态栏');
const card = parsePortraits(sliceObject(script.replaceString, 'charPortraits')).map;
const data = JSON.parse(readFileSync(DATA, 'utf8'));
const mine = new Map(Object.entries(data.map));

test('条数与卡内一致（改动必须先重跑 tools/build-portraits.mjs）', () => {
  assert.equal(card.size, 148, '卡内原文的条数变了，先确认是不是卡更新');
  assert.equal(mine.size, card.size);
  assert.equal(data.count, mine.size, 'count 与实际条数不符');
});

test('每一条人名与 URL 都和卡内逐字相同（不多不少不换）', () => {
  const missing = [...card.keys()].filter((n) => !mine.has(n));
  const extra = [...mine.keys()].filter((n) => !card.has(n));
  const altered = [...card.entries()].filter(([n, u]) => mine.has(n) && mine.get(n) !== u).map(([n]) => n);
  assert.deepEqual(missing, [], '这些人的立绘被弄丢了');
  assert.deepEqual(extra, [], '这些立绘卡内根本没有（自造的）');
  assert.deepEqual(altered, [], '这些 URL 被改写过');
});

test('全部走 https，且只用卡内那一个图床域名', () => {
  assert.deepEqual(data.hosts, ['free-img.400040.xyz']);
  for (const [n, u] of mine) {
    assert.ok(u.startsWith('https://free-img.400040.xyz/'), `${n} 的链接形态不对：${u}`);
  }
});

test('卡内那个脚本是停用状态（数据只是素材，不代表卡当前会显示图）', () => {
  assert.equal(script.disabled, true);
  assert.equal(data.scriptDisabled, true);
});

test('抽查若干张：名号对得上卡里的写法', () => {
  for (const name of ['瑶汐', '林雪', '广慧', '姬昊天', '白疏影']) {
    assert.ok(mine.has(name), `卡内立绘表里应有 ${name}`);
  }
});
