/* 《道渊》启动守卫
 *
 * 必须在所有其它脚本之前加载。作用有两个：
 *   1. 捕获启动期的语法/运行/未决 Promise 异常，记到 `window.__dyErrors`；
 *   2. 把致命错误显示成一条可读的提示，而不是留一个永远转圈的白屏。
 *
 * 为什么需要它：ESM 模块一旦在求值期抛错，整套界面就是"静默失灵"——
 * 按钮在、样式在，但点什么都没反应。没有这个守卫，用户只会看到"这 App 坏了"。
 */
(function () {
  'use strict';

  const errors = [];
  window.__dyErrors = errors;

  function record(kind, message, detail) {
    const item = { kind: kind, message: String(message || ''), detail: detail || '', at: Date.now() };
    errors.push(item);
    // 控制台留一份，便于远程排查
    try { console.error('[道渊启动]', kind, item.message, item.detail); } catch (e) { /* 忽略 */ }
    showBanner();
  }

  window.addEventListener('error', function (e) {
    // 资源加载失败（script/link）走这里，message 为空但有 target
    if (e && e.target && e.target !== window && e.target.tagName) {
      record('资源加载失败', (e.target.src || e.target.href || e.target.tagName), '');
      return;
    }
    record('脚本错误', (e && e.message) || '未知错误', (e && e.filename ? e.filename + ':' + e.lineno : ''));
  }, true);

  window.addEventListener('unhandledrejection', function (e) {
    const r = e && e.reason;
    record('未处理的 Promise 拒绝', (r && r.message) || r || '未知原因', (r && r.stack) || '');
  });

  /** 界面上给一条可见的提示（只在真的出错时出现）。 */
  function showBanner() {
    if (document.getElementById('dy-error-banner')) { updateBanner(); return; }
    const run = function () {
      if (document.getElementById('dy-error-banner')) { updateBanner(); return; }
      const el = document.createElement('div');
      el.id = 'dy-error-banner';
      el.style.cssText = [
        'position:fixed', 'left:50%', 'transform:translateX(-50%)', 'bottom:18px', 'z-index:9999',
        'max-width:min(680px,92vw)', 'padding:10px 14px', 'border-radius:10px',
        'background:rgba(40,14,16,.95)', 'border:1px solid rgba(255,122,107,.6)',
        'color:#ffd9d4', 'font:13px/1.6 "Noto Serif SC",serif', 'white-space:pre-wrap',
        'box-shadow:0 8px 30px rgba(0,0,0,.6)', 'cursor:pointer',
      ].join(';');
      el.title = '点击复制全部错误';
      el.addEventListener('click', function () {
        const text = errors.map(function (x) { return '[' + x.kind + '] ' + x.message + (x.detail ? ' @ ' + x.detail : ''); }).join('\n');
        try { navigator.clipboard.writeText(text); } catch (e) { /* 忽略 */ }
      });
      document.body.appendChild(el);
      updateBanner();
    };
    if (document.body) run(); else document.addEventListener('DOMContentLoaded', run);
  }

  function updateBanner() {
    const el = document.getElementById('dy-error-banner');
    if (!el) return;
    const first = errors[0];
    el.textContent = '启动出错（点击复制全部 ' + errors.length + ' 条）\n' +
      first.kind + '：' + first.message.slice(0, 200) + (first.detail ? '\n' + first.detail.slice(0, 200) : '');
  }

  // 给"无异常"一个明确信号：模块跑完后会置位，便于自检
  window.__dyBootOk = false;
  window.__dyMarkBootOk = function () { window.__dyBootOk = true; };
})();
