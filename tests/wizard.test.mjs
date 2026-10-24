import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyConnError } from '../prototype/ui/wizard.js';

test('测连分类：Key 相关', () => {
  assert.equal(classifyConnError(new Error('HTTP 401 Unauthorized')).kind, 'auth');
  assert.equal(classifyConnError('HTTP 403: 无权访问').kind, 'auth');
  assert.equal(classifyConnError('invalid api key').kind, 'auth');
  assert.equal(classifyConnError('API Key（在「模型配置」里填写）').kind, 'key-missing');
  const hint = classifyConnError('HTTP 401').hint;
  assert.ok(hint.length > 10, 'hint 要说人话而不是只给码');
});

test('测连分类：地址 / 路径 / 网络', () => {
  assert.equal(classifyConnError('请求超时（60s）').kind, 'addr');
  assert.equal(classifyConnError('dns lookup failed').kind, 'addr');
  assert.equal(classifyConnError('HTTP 404 Not Found').kind, 'path');
  assert.equal(classifyConnError('HTTP 429: 请求过于频繁').kind, 'net');
});

test('测连分类：没见过的错误原样带回（截断），空错误不炸', () => {
  const odd = classifyConnError('渠道说：余额不足');
  assert.equal(odd.kind, 'unknown');
  assert.ok(odd.hint.includes('余额不足'));
  const empty = classifyConnError('');
  assert.equal(empty.kind, 'unknown');
});
