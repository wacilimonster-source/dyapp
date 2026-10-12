/* 《道渊》独立版 · 前端 ↔ 壳桥接
 *
 * 同一份 UI 要在两种环境下跑：
 *   - 浏览器（原型预览）：没有壳，所有壳能力降级为"不可用"提示；
 *   - Tauri 壳（Windows / 安卓）：通过 invoke 调 Rust。
 *
 * 这样界面代码不需要写 if (isTauri)，只问 `DYApp.available()`。
 */
window.DYApp = (function () {
  'use strict';

  const tauri = window.__TAURI__ || null;
  const invoke = tauri && tauri.core ? tauri.core.invoke : null;
  const listen = tauri && tauri.event ? tauri.event.listen : null;

  function available() {
    return typeof invoke === 'function';
  }

  function requireShell() {
    if (!available()) {
      throw new Error('此功能需要在桌面端或安卓客户端内运行（当前是浏览器预览）');
    }
  }

  async function call(cmd, args) {
    requireShell();
    return invoke(cmd, args || {});
  }

  /* ---------------- 模型配置（Key 只在本地） ---------------- */
  const llm = {
    get: () => call('llm_settings_get'),
    set: (settings) => call('llm_settings_set', { settings }),
    setKey: (apiKey) => call('llm_key_set', { apiKey }),
    clearKey: () => call('llm_key_clear'),
    models: () => call('llm_models'),
    /** 流式对话：onEvent({type:'delta'|'reasoning'|'usage'|'done'|'error', data}) */
    async stream(req, onEvent) {
      requireShell();
      const requestId = req.requestId;
      const unlisten = await listen('api://' + requestId, (e) => onEvent(e.payload));
      try {
        await invoke('llm_chat_stream', { req });
      } finally {
        // 收到 done/error 后由调用方决定何时解绑；这里兜底，避免监听器泄漏
        setTimeout(() => { try { unlisten(); } catch (e) {} }, 5000);
      }
    },
    completeJson: (req) => call('llm_complete_json', { req }),
  };

  /* ---------------- 存档 ---------------- */
  const save = {
    list: () => call('save_list'),
    read: (saveId) => call('save_read', { saveId }),
    write: (saveId, bundle) => call('save_write', { saveId, bundle }),
    remove: (saveId) => call('save_delete', { saveId }),
    exportBundle: (saveId) => call('save_export', { saveId }),
    importBundle: (bundleJson) => call('save_import', { bundleJson }),
  };

  /* ---------------- 预设（ST Chat Completion 预设） ---------------- */
  const preset = {
    list: () => call('preset_list'),
    read: (id) => call('preset_read', { id }),
    write: (id, raw, name) => call('preset_write', { id, raw, name: name || null }),
    remove: (id) => call('preset_delete', { id }),
    rename: (id, name) => call('preset_rename', { id, name }),
    /** 导入原文 JSON；id 冲突自动加后缀，不覆盖已有预设 */
    importRaw: (raw, name) => call('preset_import', { raw, name: name || null }),
    dir: () => call('preset_dir'),
  };

  /* ---------------- 多端进度同步（GitHub） ---------------- */
  const sync = {
    getConfig: () => call('sync_config_get'),
    setConfig: (config) => call('sync_config_set', { config }),
    setToken: (token) => call('sync_token_set', { token }),
    clearToken: () => call('sync_token_clear'),
    localSaves: () => call('sync_local_saves'),
    remoteSaves: () => call('sync_remote_saves'),
    push: (saveId, force) => call('sync_push', { saveId, force: !!force }),
    pull: (saveId, force) => call('sync_pull', { saveId, force: !!force }),
    pushAll: () => call('sync_push_all'),
  };

  return { available, llm, sync, save, preset, platform: tauri ? 'tauri' : 'web' };
})();
