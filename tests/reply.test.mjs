import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContactMessages } from '../prototype/narrator/reply.js';

const base = {
  name: '宫银叶',
  info: { 性别: '女', 境界: '筑基后期', 关系: '道侣', 好感度: 22 },
  history: [
    { 发送者: '我', 时间: 't1', 内容: '第一句' },
    { 发送者: '宫银叶', 时间: 't2', 内容: '第二句' },
    { 发送者: '我', 时间: 't3', 内容: '第三句' },
    { 发送者: '宫银叶', 时间: 't4', 内容: '第四句' },
    { 发送者: '宫银叶', 时间: 't5', 内容: '第五句' },
    { 发送者: '宫银叶', 时间: 't6', 内容: '第六句' },
  ],
  text: '后山的事你听说了吗',
};

test('玉简提示词：系统段带人物卡，玩家消息在最后', () => {
  const msgs = buildContactMessages(base);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('宫银叶'), '系统段要点名联系人');
  assert.ok(msgs[0].content.includes('道侣'), '关系要进系统段');
  assert.ok(msgs[0].content.includes('疏离') || msgs[0].content.includes('好感'), '好感分档要进系统段');
  assert.equal(msgs[msgs.length - 1].role, 'user');
  assert.equal(msgs[msgs.length - 1].content, '后山的事你听说了吗', '玩家消息必须最后');
});

test('玉简提示词：历史只带最近 N 条，且映射角色正确', () => {
  const msgs = buildContactMessages(base, { keep: 4 });
  const hist = msgs.slice(1, -1);
  assert.equal(hist.length, 4, '六条历史只保留最近四条');
  assert.equal(hist[0].content, '第三句');
  assert.equal(hist[0].role, 'user', '发送者为「我」→ user');
  assert.equal(hist[1].role, 'assistant', '对方的 → assistant');
});

test('玉简提示词：空历史与空消息都不炸', () => {
  const msgs = buildContactMessages({ name: '', info: {}, history: [], text: '' });
  assert.equal(msgs.length, 2, '只有 system + user 两条');
  assert.ok(msgs[1].content.length > 0, '空消息给个占位，不让 user 段为空串');
});
