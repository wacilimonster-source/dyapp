#!/usr/bin/env node
/**
 * 世界书数据管道：_卡资产提取/worldbook_full.json → prototype/data/worldbook.json
 *
 * 为什么要这一步：原始导出是"酒馆世界书"形状（17 个字段、中文/英文混杂、无分类），
 * 而 App 需要的是**可检索的条目**：稳定的 id、标题、分类、触发词、正文、是否常驻。
 *
 * 用法：node tools/build-worldbook.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, '_卡资产提取/worldbook_full.json');
const OUT = resolve(ROOT, 'prototype/data/worldbook.json');

/** 从标题前缀与关键词推导分类。顺序敏感：先专有类别，再兜底。 */
export function classify(title, keys) {
  const t = title || '';
  if (/灵宠/.test(t)) return '灵宠';
  if (/人物|妖族人物/.test(t)) return '人物';
  if (/势力|宗门/.test(t)) return '势力';
  if (/地点|秘境|遗迹|城市/.test(t)) return '地点';
  if (/物品|功法|器物|法宝|丹药/.test(t)) return '物品';
  if (/境界|修炼|雷劫|法则|劫/.test(t)) return '境界';
  if (/mvu|initvar|变量|状态栏|Data ?Block/i.test(t)) return '变量';
  return '规则';
}

/** 出生界归属：用于按玩家所在界过滤（卡内是"内容控制开关"二选一）。 */
export function realmOf(title) {
  const t = title || '';
  if (/仙界/.test(t)) return '仙界';
  if (/玄天界/.test(t)) return '玄天界';
  return '';
}

/** 标题去掉分类前缀，得到干净的展示名。 */
export function cleanTitle(title) {
  return String(title || '')
    .replace(/^(详细人物|人物详情|人物详细|详情人物|仙界人物详情|仙界地点详情|地点详情|势力详情|势力详细|详细势力|妖族势力|妖族人物|详细物品|详细灵宠|详细|地点)\s*[:：]\s*/, '')
    .trim();
}

function main() {
  const raw = JSON.parse(readFileSync(SRC, 'utf8'));
  const byCategory = {};
  const seen = new Set();

  const entries = raw
    .filter((e) => (e.content || '').trim().length > 0)
    .map((e, i) => {
      const title = (e.comment || '').trim() || `未命名条目 ${i}`;
      const category = classify(title, e.keys);
      byCategory[category] = (byCategory[category] || 0) + 1;
      seen.add(category);

      const keys = (e.keys || []).filter((k) => typeof k === 'string' && k.trim());
      const secondaryKeys = (e.secondary_keys || []).filter((k) => typeof k === 'string' && k.trim());
      const content = String(e.content || '').replace(/\{\{user\}\}/g, '玩家').trim();

      return {
        id: i,
        title,
        name: cleanTitle(title),
        category,
        realm: realmOf(title),
        keys,
        secondaryKeys,
        content,
        constant: !!e.constant,
        enabled: e.enabled !== false,
        position: e.position === 'before_char' ? 'before_char' : 'after_char',
        order: Number.isFinite(e.insertion_order) ? e.insertion_order : 100,
        len: content.length,
      };
    });

  const payload = {
    generatedFrom: '_卡资产提取/worldbook_full.json',
    count: entries.length,
    categories: byCategory,
    entries,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload), 'utf8');

  const bytes = readFileSync(OUT).length;
  console.log(`✅ 写出 ${OUT}`);
  console.log(`   条目 ${entries.length} · ${(bytes / 1024).toFixed(0)} KB`);
  console.log(`   分类 ${JSON.stringify(byCategory)}`);
  console.log(`   常驻 ${entries.filter((e) => e.constant).length} · 卡内禁用 ${entries.filter((e) => !e.enabled).length}`);
  console.log(`   总正文 ${entries.reduce((s, e) => s + e.len, 0).toLocaleString()} 字`);
}

// 直接执行时才跑（被 import 做单测时不跑）
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main();
}
