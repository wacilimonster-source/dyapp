/**
 * 预设存储门面：壳后端（Rust，配置目录）与浏览器后端（localStorage）同一套接口。
 *
 * 归属本机配置，**不进存档、不参与 GitHub 同步**（决策 D6）：预设里常含个人文本。
 * @module preset/store
 */

const LS_PREFIX = 'dy.preset.';
const LS_INDEX = 'dy.presets';

const local = {
  name: 'localStorage',
  _ids() {
    try { return JSON.parse(localStorage.getItem(LS_INDEX) || '[]'); } catch { return []; }
  },
  _setIds(ids) {
    try { localStorage.setItem(LS_INDEX, JSON.stringify([...new Set(ids)])); } catch { /* 配额 */ }
  },
  async list() {
    const out = [];
    for (const id of this._ids()) {
      const raw = localStorage.getItem(LS_PREFIX + id);
      if (!raw) continue;
      out.push({ id, name: this._name(id, raw), updatedAt: 0, size: raw.length });
    }
    return out;
  },
  _name(id, raw) {
    try {
      const v = JSON.parse(raw);
      const n = v?.name || v?.preset?.name;
      return typeof n === 'string' && n.trim() ? n.trim() : id;
    } catch { return id; }
  },
  async read(id) {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (raw == null) throw new Error('本地没有这个预设：' + id);
    return raw;
  },
  async write(id, raw) {
    JSON.parse(raw); // 校验
    localStorage.setItem(LS_PREFIX + id, raw);
    this._setIds([...this._ids(), id]);
    return { id, name: this._name(id, raw), updatedAt: Date.now(), size: raw.length };
  },
  async remove(id) {
    localStorage.removeItem(LS_PREFIX + id);
    this._setIds(this._ids().filter((x) => x !== id));
  },
  async rename(id, name) {
    const raw = localStorage.getItem(LS_PREFIX + id);
    if (raw == null) throw new Error('本地没有这个预设：' + id);
    let v = {};
    try { v = JSON.parse(raw); } catch { v = {}; }
    v.name = name;
    localStorage.setItem(LS_PREFIX + id, JSON.stringify(v));
    return { id, name, updatedAt: Date.now(), size: raw.length };
  },
  async dir() { return '(浏览器 localStorage)'; },
};

const shell = {
  name: 'shell',
  async list() { return window.DYApp.preset.list(); },
  async read(id) { return window.DYApp.preset.read(id); },
  async write(id, raw, name) { return window.DYApp.preset.write(id, raw, name); },
  async remove(id) { return window.DYApp.preset.remove(id); },
  async rename(id, name) { return window.DYApp.preset.rename(id, name); },
  async importRaw(raw, name) { return window.DYApp.preset.importRaw(raw, name); },
  async dir() { return window.DYApp.preset.dir(); },
};

export function createPresetStore() {
  const hasShell = typeof window !== 'undefined'
    && window.DYApp && typeof window.DYApp.available === 'function'
    && window.DYApp.available() && window.DYApp.preset;
  const backend = hasShell ? shell : local;
  return {
    backend: backend.name,
    persistent: backend.name === 'shell',
    list: () => backend.list(),
    read: (id) => backend.read(id),
    remove: (id) => backend.remove(id),
    rename: (id, name) => backend.rename(id, name),
    dir: () => backend.dir(),
    /** 导入：壳走不覆盖语义的 preset_import；浏览器自行加后缀 */
    async importRaw(raw, name) {
      JSON.parse(raw);
      if (backend.importRaw) return backend.importRaw(raw, name);
      const base = String(name || 'preset').replace(/[^A-Za-z0-9_-]/g, '') || 'preset';
      let id = base;
      let n = 1;
      while (localStorage.getItem(LS_PREFIX + id)) {
        n += 1;
        id = `${base}-${n}`;
        if (n > 99) throw new Error('同名预设过多');
      }
      return backend.write(id, raw, name);
    },
    write: (id, raw, name) => backend.write(id, raw, name),
  };
}

/** 预设 id：只允许安全字符。 */
export function safePresetId(name, fallback = 'preset') {
  const s = String(name || '').trim().replace(/[^A-Za-z0-9_-]/g, '');
  return s || fallback;
}
