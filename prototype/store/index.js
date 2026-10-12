/**
 * 存档门面：同一套接口，两种后端。
 *
 *   壳（Windows / 安卓）→ Rust `save_*`，落应用私有目录，可被 GitHub 同步读到；
 *   浏览器预览         → localStorage，仅供界面调试。
 *
 * 两种后端的数据结构**完全一致**，所以浏览器里导出的包能直接在客户端导入。
 * @module store/index
 */

/** localStorage 后端（浏览器调试用）。 */
const local = {
  name: 'localStorage',
  prefix: 'dy.save.',
  indexKey: 'dy.saves',

  _ids() {
    try { return JSON.parse(localStorage.getItem(this.indexKey) || '[]'); } catch { return []; }
  },
  _setIds(ids) {
    try { localStorage.setItem(this.indexKey, JSON.stringify([...new Set(ids)])); } catch { /* 忽略配额错误 */ }
  },

  async list() {
    const out = [];
    for (const id of this._ids()) {
      try {
        const raw = localStorage.getItem(this.prefix + id);
        if (!raw) continue;
        const b = JSON.parse(raw);
        if (b && b.meta) out.push(b.meta);
      } catch { /* 坏档跳过，不影响其它档 */ }
    }
    return out.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  },

  async read(id) {
    const raw = localStorage.getItem(this.prefix + id);
    if (!raw) throw new Error(`本地没有存档「${id}」`);
    return JSON.parse(raw);
  },

  async write(id, bundle) {
    const now = Date.now();
    let created = now;
    try {
      const prev = JSON.parse(localStorage.getItem(this.prefix + id) || 'null');
      if (prev?.meta?.createdAt) created = prev.meta.createdAt;
    } catch { /* 首次写入 */ }
    const meta = {
      id,
      name: bundle?.meta?.name?.trim() || id,
      createdAt: created,
      updatedAt: now,
      saveVersion: 1,
      summary: bundle?.meta?.summary || '',
      playtimeMs: bundle?.meta?.playtimeMs || 0,
    };
    const payload = { meta, state: bundle.state, turns: bundle.turns || [], world: bundle.world || {} };
    try {
      localStorage.setItem(this.prefix + id, JSON.stringify(payload));
    } catch (e) {
      throw new Error(`浏览器存储写入失败（可能超出配额）：${e.message}`);
    }
    this._setIds([...this._ids(), id]);
    return meta;
  },

  async remove(id) {
    localStorage.removeItem(this.prefix + id);
    this._setIds(this._ids().filter((x) => x !== id));
  },

  async exportBundle(id) {
    return JSON.stringify(await this.read(id), null, 2);
  },

  async importBundle(json) {
    const b = JSON.parse(json);
    if (!b || !b.meta) throw new Error('存档包格式不对：缺少 meta');
    let id = String(b.meta.id || 'import').replace(/[^A-Za-z0-9_-]/g, '') || 'import';
    let n = 1;
    while (localStorage.getItem(this.prefix + id)) {
      n += 1;
      id = `${b.meta.id}-${n}`;
      if (n > 99) throw new Error('同 id 存档过多');
    }
    return this.write(id, b);
  },
};

/** 壳后端（Rust）。 */
const shell = {
  name: 'shell',
  async list() { return window.DYApp.save.list(); },
  async read(id) { return window.DYApp.save.read(id); },
  async write(id, bundle) { return window.DYApp.save.write(id, bundle); },
  async remove(id) { return window.DYApp.save.remove(id); },
  async exportBundle(id) { return window.DYApp.save.exportBundle(id); },
  async importBundle(json) { return window.DYApp.save.importBundle(json); },
};

/** 选后端：有壳用壳（存档在应用私有目录，可同步），否则退回 localStorage。 */
export function createStore() {
  const hasShell = typeof window !== 'undefined'
    && window.DYApp
    && typeof window.DYApp.available === 'function'
    && window.DYApp.available()
    && window.DYApp.save;
  const backend = hasShell ? shell : local;
  return {
    backend: backend.name,
    persistent: backend.name === 'shell',
    list: () => backend.list(),
    read: (id) => backend.read(id),
    write: (id, bundle) => backend.write(id, bundle),
    remove: (id) => backend.remove(id),
    exportBundle: (id) => backend.exportBundle(id),
    importBundle: (json) => backend.importBundle(json),
  };
}

/** 生成存档 id（本地时间，可读且不重复）。 */
export function newSaveId(prefix = 'save') {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
