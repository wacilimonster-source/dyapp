/* 《道渊》独立版 · 检查更新模块
 * 数据源：GitHub Releases（wacilimonster-source/dyapp）
 * 设计约束：
 *  1. 只在用户主动点击、或"启动时自动检查"开启时联网；除此之外全离线。
 *  2. 只读取版本号与更新说明，不上传任何本地数据（无存档、无设备信息）。
 *  3. 任何失败都降级为提示，绝不阻塞游戏。
 *  4. 真机（Tauri / Capacitor）里把 DOWNLOAD 换成"下载 APK + 触发安装"即可。
 */
window.DYUpdate = (function () {
  'use strict';

  const REPO = 'wacilimonster-source/dyapp';
  const API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
  const PAGE = 'https://github.com/' + REPO + '/releases';
  const VERSION = '0.3.0';                 // 当前版本，发版时同步 VERSION 文件
  const LS_AUTO = 'dy.update.auto';
  const TIMEOUT_MS = 8000;

  const state = {
    status: 'idle',   // idle | checking | latest | newer | none | error
    latestTag: '',
    latestName: '',
    notes: '',
    url: PAGE,
    apk: '',
    /** 本次要装的附件：{ apk: {name,url,size}|null, win: {...}|null } */
    asset: { apk: null, win: null },
    error: null,
    checkedAt: 0,
  };

  /** "v1.2.3-beta" → [1,2,3]；解析不出返回 null */
  function parseVer(s) {
    const m = String(s == null ? '' : s).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)/);
    return m ? [+m[1], +m[2], +m[3]] : null;
  }
  /** a>b 返回 1，a<b 返回 -1，相等或不可比返回 0 */
  function cmp(a, b) {
    const x = parseVer(a), y = parseVer(b);
    if (!x || !y) return 0;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
    return 0;
  }

  function autoEnabled() {
    try { return localStorage.getItem(LS_AUTO) !== '0'; } catch (e) { return true; }
  }
  function setAuto(on) {
    try { localStorage.setItem(LS_AUTO, on ? '1' : '0'); } catch (e) {}
  }

  let inflight = null;
  function check() {
    if (inflight) return inflight;               // 并发去重
    state.status = 'checking';
    state.error = null;
    inflight = (async function () {
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, TIMEOUT_MS);
      try {
        const res = await fetch(API, {
          headers: { Accept: 'application/vnd.github+json' },
          signal: ctrl ? ctrl.signal : undefined,
          cache: 'no-store',
        });
        clearTimeout(timer);
        if (res.status === 404) { state.status = 'none'; state.checkedAt = Date.now(); return state; }
        if (res.status === 403) throw new Error('请求过于频繁（GitHub 限流），稍后再试');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const rel = await res.json();
        const tag = rel.tag_name || rel.name || '';
        state.latestTag = tag;
        state.latestName = rel.name || tag;
        state.notes = String(rel.body || '').trim();
        state.url = rel.html_url || PAGE;
        const assets = rel.assets || [];
        // 未签名的 APK 装上会被系统直接拒绝，挑附件时必须避开它
        const pick = function (re, rejectRe) {
          return assets.find(function (a) {
            return re.test(a.name) && !(rejectRe && rejectRe.test(a.name));
          }) || null;
        };
        const apk = pick(/\.apk$/i, /unsigned/i);
        const win = pick(/windows.*\.exe$/i, null) || pick(/\.exe$/i, null);
        state.asset = { apk: apk, win: win };
        state.apk = apk ? apk.browser_download_url : '';
        state.status = cmp(tag, VERSION) > 0 ? 'newer' : 'latest';
      } catch (err) {
        clearTimeout(timer);
        state.status = 'error';
        state.error = err && err.name === 'AbortError' ? '请求超时'
          : (err && err.message) || '网络不可用';
      } finally {
        state.checkedAt = Date.now();
        inflight = null;
      }
      return state;
    })();
    return inflight;
  }

  return {
    VERSION: VERSION,
    REPO: REPO,
    PAGE: PAGE,
    get state() { return state; },
    check: check,
    autoEnabled: autoEnabled,
    setAuto: setAuto,
    cmp: cmp,
    parseVer: parseVer,
  };
})();
