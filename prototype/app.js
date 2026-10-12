/* 《道渊》独立版 · 应用逻辑（ESM 模块）
 *
 * 分层：本文件只做**界面编排**；规则与状态在 engine/，检索在 memory/，提示词在 narrator/，
 * 存档在 store/。所有确定性计算都不在这里。
 *
 * 版式判定：真机按屏幕宽度（>=700px 判为平板）；桌面可用右下角开关切换预览。
 */
import { normalize as normalizeState, snapshot, emptyState } from './engine/state.js';
import { applyAll } from './engine/effects.js';
import { runTurn } from './engine/turn.js';
import { daoStage, vague, crisisLevel } from './engine/rules.js';
import { buildIndex } from './memory/index.js';
import { tokenize } from './memory/tokenize.js';
import { createStore, newSaveId } from './store/index.js';
import { parsePreset, toStPreset, SUPPORTED_SAMPLING } from './preset/schema.js';
import { SUPPORTED_MACROS } from './preset/macros.js';
import { createPresetStore, safePresetId } from './preset/store.js';
import { buildPromptPlan, stSamplingToOverride } from './narrator/plan.js';
import { retrieve } from './memory/retrieve.js';

(function () {
  'use strict';
  const D = window.DY;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const deep = (o) => JSON.parse(JSON.stringify(o));
  const rnd = (n) => Math.floor(Math.random() * n);
  const pick = (a) => a[rnd(a.length)];

  /** 权威状态：一切写入都过引擎归一化。 */
  const state = normalizeState(deep(D.state));
  const turns = deep(D.turns);
  const app = $('#app');

  /** 世界书索引（异步加载，未就绪时为 null —— 引擎会降级为只注入常驻法则）。 */
  let WORLD_INDEX = null;
  let WORLDBOOK = null;
  /** 存档后端（壳 / localStorage）。 */
  const store = createStore();
  const presetStore = createPresetStore();

  /* ---------- 对话模式与预设 ---------- */
  const CHAT_PREFS_KEY = 'dy.chat';
  const CHAT = loadChatPrefs();
  let CHAT_PRESETS = [];      // 预设列表
  let CHAT_PRESET = null;     // 当前启用预设的解析视图
  let CHAT_PRESET_RAW = null; // 原始 JSON 文本

  function defaultChatPrefs() {
    return { mode: 'default', presetId: '', charName: '道渊', userName: '' };
  }
  function loadChatPrefs() {
    try { return Object.assign(defaultChatPrefs(), JSON.parse(localStorage.getItem(CHAT_PREFS_KEY) || '{}')); }
    catch { return defaultChatPrefs(); }
  }
  function saveChatPrefs() {
    try { localStorage.setItem(CHAT_PREFS_KEY, JSON.stringify(CHAT)); } catch { /* 忽略配额 */ }
  }

  /** 拉预设列表，并重新解析当前选中的那份。 */
  async function refreshPresets() {
    try {
      CHAT_PRESETS = await presetStore.list();
    } catch (e) {
      CHAT_PRESETS = [];
      console.warn('[preset] 列表读取失败：', e.message);
    }
    CHAT_PRESET = null;
    CHAT_PRESET_RAW = null;
    if (CHAT.presetId) {
      const found = CHAT_PRESETS.find((x) => x.id === CHAT.presetId);
      if (!found) {
        CHAT.presetId = '';           // 预设被删了
        CHAT.mode = 'default';
        saveChatPrefs();
      } else {
        try {
          CHAT_PRESET_RAW = await presetStore.read(CHAT.presetId);
          const parsed = parsePreset(CHAT_PRESET_RAW);
          if (parsed.ok) {
            CHAT_PRESET = { ...parsed.preset, name: found.name, id: found.id };
          } else {
            console.warn('[preset] 解析失败：', parsed.error);
          }
        } catch (e) {
          console.warn('[preset] 读取失败：', e.message);
        }
      }
    }
  }

  /** 组装一份"当前设置下会发出去"的提示词计划（供预览，不真的发请求）。 */
  function buildPreviewPlan() {
    const lastUser = [...turns].reverse().find((t) => t.role === 'user');
    let retrieved = [];
    try {
      retrieved = retrieve(WORLD_INDEX, {
        action: lastUser ? lastUser.text : '',
        place: state.世界.当前地点,
        npcs: [...Object.keys(state.人物 || {}), ...Object.keys(state.道侣 || {})],
        realm: state.主角.境界,
        recent: turns.slice(-4).map((t) => t.text).join(' '),
      }).items;
    } catch { /* 预览容错：检索失败就不展示 L2 */ }
    return buildPromptPlan({
      mode: CHAT.mode === 'preset' && CHAT_PRESET ? 'preset' : 'default',
      preset: CHAT_PRESET,
      engine: {
        action: lastUser ? lastUser.text : '（尚无玩家行动）',
        index: WORLD_INDEX,
        state,
        retrieved,
        recent: turns.slice(-8).map((t) => ({ role: t.role, text: t.text })),
        hints: [],
      },
      names: { charName: CHAT.charName, userName: CHAT.userName || state.主角.姓名 },
    });
  }
  let currentSaveId = newSaveId();

  async function loadWorldbook() {
    try {
      const res = await fetch('data/worldbook.json', { cache: 'force-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      WORLDBOOK = await res.json();
      WORLD_INDEX = buildIndex(WORLDBOOK, { realm: state.主角.所在界 });
      return WORLDBOOK;
    } catch (e) {
      console.warn('[worldbook] 加载失败，检索降级为只注入常驻法则：', e.message);
      return null;
    }
  }

  const PANELS = [
    { id: '主角', icon: '☯' }, { id: '道侣', icon: '💞' }, { id: '人物', icon: '👤' },
    { id: '灵宠', icon: '🐾' }, { id: '机遇', icon: '📜' }, { id: '绝色榜', icon: '🏮' },
    { id: '玉简', icon: '📱' }, { id: '背包', icon: '🎒' }, { id: '地图', icon: '🗺' },
    { id: '图鉴', icon: '📖' }, { id: '存档', icon: '💾' }, { id: '模型', icon: '🔌' }, { id: '同步', icon: '☁' },
    { id: '设置', icon: '⚙' },
  ];
  let curPanel = '主角';
  /** 面板分组：常用的直接可见，其余收进「更多」——手机抽屉里 14 个 tab 横滑很难发现 */
  const PANELS_COMMON = ['主角', '道侣', '人物', '机遇', '背包'];
  /** 底部主行动：每回合真会点的 4 个；其余进「更多」 */
  const MAIN_ACTS = [
    { k: '探索', i: '🧭', hot: true },
    { k: '修炼', i: '🧘', hot: true },
    { k: '突破', i: '⚡', hot: true },
    { k: '交流', i: '💬' },
  ];
  const MORE_ACTS = [
    { k: '玉简', i: '📱', panel: '玉简' }, { k: '地图', i: '🗺', panel: '地图' },
    { k: '背包', i: '🎒', panel: '背包' }, { k: '人物', i: '👤', panel: '人物' },
    { k: '机遇', i: '📜', panel: '机遇' }, { k: '绝色榜', i: '🏮', panel: '绝色榜' },
    { k: '灵宠', i: '🐾', panel: '灵宠' }, { k: '面板', i: '☰' },
  ];
  let forced = null;       // null | 'phone' | 'tablet'
  const isTablet = () => app.dataset.layout === 'tablet';

  /* ================= 版式 ================= */
  /** 左栏 / 右栏是否被用户手动收起（null = 自动：平板竖屏默认收右栏）。 */
  let railCollapsed = false;
  let sideCollapsed = null;

  function applyLayout() {
    let layout;
    if (forced) layout = forced;
    else layout = window.innerWidth >= 700 ? 'tablet' : 'phone';
    app.dataset.layout = layout;
    app.dataset.device = layout;
    app.dataset.orient = window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
    app.classList.toggle('preview', window.innerWidth >= 1100);
    applyCollapse();
  }

  /**
   * 折叠联动。
   *
   * 平板竖屏（如 800×1280）时左右栏固定占掉 406px，中栏只剩 394px——比手机还窄。
   * 所以竖屏默认收起右栏，需要时点一下再展开。
   */
  function applyCollapse() {
    const tablet = app.dataset.layout === 'tablet';
    const portrait = app.dataset.orient === 'portrait';
    const rail = $('#rail');
    const side = $('#sidebar');
    if (!rail || !side) return;
    rail.classList.toggle('mini', !tablet || railCollapsed);
    side.classList.toggle('mini', !tablet || (sideCollapsed === null ? portrait : sideCollapsed));
  }

  function toggleRail() {
    railCollapsed = !railCollapsed;
    applyCollapse();
  }
  function toggleSide(force) {
    const side = $('#sidebar');
    if (!side) return;
    const nowMini = side.classList.contains('mini');
    sideCollapsed = typeof force === 'boolean' ? !force : !nowMini ? true : false;
    applyCollapse();
  }

  // 版式重算：三重保险。
  // 实测踩过坑——只监听 window.resize 时，视口宽度变了却不触发（旋转屏幕/分屏/软键盘
  // 在安卓 WebView 上都会这样），版式就停在错误的那一套，左栏不出现、右栏变全屏遮罩。
  window.addEventListener('resize', () => applyLayout());
  window.addEventListener('orientationchange', () => setTimeout(applyLayout, 120));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) applyLayout(); });
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => applyLayout()).observe(document.documentElement);
  }
  if (window.visualViewport) {
    // 软键盘弹出/收起、旋转都会触发这个，比 window.resize 可靠
    window.visualViewport.addEventListener('resize', () => applyLayout());
  }
  $$('#devbar button').forEach((b) => b.addEventListener('click', () => {
    forced = b.dataset.layoutSet;
    $$('#devbar button').forEach((x) => x.classList.toggle('on', x === b));
    app.classList.add('preview');
    applyLayout();
    if (forced === 'phone') closePanel();
    renderSidebar();
  }));
  applyLayout();

  /* ================= 屏幕导航 ================= */
  function showScreen(id) {
    $$('.screen').forEach((s) => s.classList.toggle('active', s.id === id));
    if (id === 's-game') { renderHUD(); renderActions(); renderSidebar(); }
  }
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    const dest = go.dataset.go;
    if (dest === 'create') { startCreate(); }
    else if (dest === 'game') { showScreen('s-game'); scrollStream(); }
    else if (dest === 'panels') { showScreen('s-game'); openPanel(go.dataset.panel || '主角'); }
  });
  $('#btn-about').addEventListener('click', () => alert(
    '《道渊》独立版 · 产品原型 v0.1\n\n' +
    '本原型用于验证界面结构与安卓（手机/平板）适配，不含 AI 调用。\n\n' +
    '原著：《道渊》· Discord 类脑社区 · 玖神\n' +
    '禁止商用 / 二传 / 倒卖；二创须经授权并署名。\n' +
    '内容与原作角色卡完全一致，默认开启，不做删改。'));

  /* ================= 创角向导 ================= */
  const createState = { step: 0, 姓名: '', 性别: '男', 出身: '', 灵根: null, 气运: [], 道侣: '', 出生界: '玄天界' };
  const STEPS = ['身份', '灵根', '气运', '道侣', '出生界', '确认'];
  const ORIGINS = [
    { n: '寒门散修', d: '无依无靠，道心 +8，初始无宗门' },
    { n: '宗门外门', d: '青云宗外门弟子，初始贡献 120' },
    { n: '没落世家', d: '家道中落，初始灵石 +20，心高气傲' },
    { n: '仙缘遗孤', d: '身负未解身世，气运抽取 +1 次' },
  ];
  const LUCK_TMP = deep(D.LUCK_POOL);

  function startCreate() { createState.step = 0; showScreen('s-create'); renderCreate(); }
  function renderCreate() {
    const st = createState.step;
    $('#cr-steps').innerHTML = STEPS.map((_, i) =>
      `<div class="st ${i === st ? 'on' : i < st ? 'done' : ''}"></div>`).join('');
    const body = $('#cr-body');
    const foot = $('#cr-foot');

    if (st === 0) {
      body.innerHTML = `
        <div class="cr-step-label">第一步 / 六</div>
        <div class="cr-title">你 是 谁</div>
        <div class="cr-hint">姓名会写进世界对你的称呼；出身决定初始道心与宗门归属，之后不可更改。</div>
        <div class="field"><label>道号 / 姓名</label><input id="f-name" value="${esc(createState.姓名)}" placeholder="如：陆沉"></div>
        <div class="field"><label>性别</label><div class="opts">
          ${['男', '女', '不定'].map((g) => `<button class="opt ${createState.性别 === g ? 'on' : ''}" data-set="性别" data-v="${g}">${g}</button>`).join('')}
        </div></div>
        <div class="field"><label>出身背景</label><div class="opts">
          ${ORIGINS.map((o) => `<button class="opt ${createState.出身 === o.n ? 'on' : ''}" data-set="出身" data-v="${o.n}">${o.n}<span class="d">${o.d}</span></button>`).join('')}
        </div></div>`;
      foot.innerHTML = `<button class="btn primary" id="cr-next">下 一 步</button>`;
      $('#f-name').addEventListener('input', (e) => (createState.姓名 = e.target.value));
    } else if (st === 1) {
      body.innerHTML = `
        <div class="cr-step-label">第二步 / 六</div>
        <div class="cr-title">灵 根 抽 取</div>
        <div class="cr-hint">灵根品阶决定修炼产出。天品万中无一，凡品亦可登顶——只是慢些。</div>
        <div class="spin ${createState.spinning ? 'spinning' : ''}"><div class="ring">
          <div><div class="val" id="root-val" style="${createState.灵根 ? 'color:' + createState.灵根.色 : ''}">${createState.灵根 ? createState.灵根.品 : '？'}</div>
          <div class="cap">${createState.灵根 ? '灵根品阶' : '待 抽 取'}</div></div>
        </div></div>
        ${createState.灵根 ? `<div class="card"><div class="kv"><span class="k">修炼产出</span><span class="v">${createState.灵根.修炼}</span></div>
          <div class="kv"><span class="k">出现概率</span><span class="v">${(createState.灵根.概率 * 100).toFixed(0)}%</span></div></div>` : ''}`;
      foot.innerHTML = `<button class="btn" id="cr-roll">${createState.灵根 ? '重 抽' : '抽 取 灵 根'}</button>
        <button class="btn primary" id="cr-next" ${createState.灵根 ? '' : 'disabled style="opacity:.5"'}>下 一 步</button>`;
      $('#cr-roll').addEventListener('click', rollRoot);
    } else if (st === 2) {
      body.innerHTML = `
        <div class="cr-step-label">第三步 / 六</div>
        <div class="cr-title">气 运 抉 择</div>
        <div class="cr-hint">可自选至多 3 条气运。每条气运都会真实改变规则——请量力而行。</div>
        <div class="opts">${LUCK_TMP.map((l) => `
          <button class="opt ${createState.气运.includes(l.name) ? 'on' : ''}" data-luck="${esc(l.name)}">
            ${l.真 ? '<span class="chip gold" style="margin-right:4px">真</span>' : ''}${esc(l.name)}
            <span class="d">${esc(l.向)}向 · ${esc(l.desc)}</span></button>`).join('')}</div>
        <div class="cr-hint" style="margin-top:12px">已选 ${createState.气运.length} / 3</div>`;
      foot.innerHTML = `<button class="btn" id="cr-real">真·气运（5%）</button><button class="btn primary" id="cr-next">下 一 步</button>`;
      $('#cr-real').addEventListener('click', () => {
        const base = pick(D.LUCK_POOL);
        LUCK_TMP.unshift({ name: '真·' + base.name, 向: base.向, desc: base.desc, 真: true });
        renderCreate();
      });
    } else if (st === 3) {
      body.innerHTML = `
        <div class="cr-step-label">第四步 / 六</div>
        <div class="cr-title">天 定 道 侣</div>
        <div class="cr-hint">可留空。留空则由天道在旅途中自行安排——她会在某个雨天遇见你。</div>
        <div class="field"><label>道侣姓名（可选）</label><input id="f-partner" value="${esc(createState.道侣)}" placeholder="留空即随机"></div>
        <div class="opts">
          ${['林若悠', '宫银叶', '苏琉璃'].map((n) => `<button class="opt ${createState.道侣 === n ? 'on' : ''}" data-set="道侣" data-v="${n}">${n}<span class="d">预设角色</span></button>`).join('')}
        </div>`;
      foot.innerHTML = `<button class="btn primary" id="cr-next">下 一 步</button>`;
      $('#f-partner').addEventListener('input', (e) => (createState.道侣 = e.target.value));
    } else if (st === 4) {
      body.innerHTML = `
        <div class="cr-step-label">第五步 / 六</div>
        <div class="cr-title">出 生 之 界</div>
        <div class="cr-hint">玄天界灵气稀薄、步步凶险；仙界资源丰沛，却已无你的位置。</div>
        <div class="opts">
          ${[['玄天界', '低阶起点，机缘与危险并存（推荐）'], ['仙界', '高阶起点，开局即有名分与旧敌']].map(([n, d]) =>
        `<button class="opt ${createState.出生界 === n ? 'on' : ''}" data-set="出生界" data-v="${n}">${n}<span class="d">${d}</span></button>`).join('')}
        </div>`;
      foot.innerHTML = `<button class="btn primary" id="cr-next">下 一 步</button>`;
    } else {
      const g = createState;
      body.innerHTML = `
        <div class="cr-step-label">第六步 / 六</div>
        <div class="cr-title">确 认 仙 缘</div>
        <div class="cr-hint">确认后生成初始状态快照，并进入第 0 回合的开局叙事。</div>
        <div class="card">
          <div class="kv"><span class="k">姓名</span><span class="v">${esc(g.姓名 || '陆沉')}</span></div>
          <div class="kv"><span class="k">性别</span><span class="v">${esc(g.性别)}</span></div>
          <div class="kv"><span class="k">出身</span><span class="v">${esc(g.出身 || '宗门外门')}</span></div>
          <div class="kv"><span class="k">灵根</span><span class="v">${g.灵根 ? g.灵根.品 + ' 灵根' : '未抽取'}</span></div>
          <div class="kv"><span class="k">气运</span><span class="v">${g.气运.length ? g.气运.map(esc).join(' · ') : '无'}</span></div>
          <div class="kv"><span class="k">道侣</span><span class="v">${esc(g.道侣) || '天道自定'}</span></div>
          <div class="kv"><span class="k">出生界</span><span class="v">${esc(g.出生界)}</span></div>
        </div>`;
      foot.innerHTML = `<button class="btn" id="cr-back">修 改</button><button class="btn primary" id="cr-start">开 始 仙 途</button>`;
      $('#cr-back').addEventListener('click', () => { createState.step = 0; renderCreate(); });
      $('#cr-start').addEventListener('click', () => { applyCreate(); showScreen('s-game'); scrollStream(); });
    }

    // 通用：选项按钮
    $$('#cr-body [data-set]').forEach((b) => b.addEventListener('click', () => {
      createState[b.dataset.set] = b.dataset.v; renderCreate();
    }));
    $$('#cr-body [data-luck]').forEach((b) => b.addEventListener('click', () => {
      const n = b.dataset.luck, i = createState.气运.indexOf(n);
      if (i >= 0) createState.气运.splice(i, 1);
      else if (createState.气运.length < 3) createState.气运.push(n);
      renderCreate();
    }));
    const next = $('#cr-next');
    if (next) next.addEventListener('click', () => {
      if (createState.step === 0 && !createState.姓名.trim()) createState.姓名 = '陆沉';
      if (createState.step === 0 && !createState.出身) createState.出身 = '宗门外门';
      createState.step = Math.min(STEPS.length - 1, createState.step + 1); renderCreate();
    });
  }
  function rollRoot() {
    createState.spinning = true; renderCreate();
    setTimeout(() => {
      let r = Math.random(), acc = 0, tier = D.ROOT_TIERS[D.ROOT_TIERS.length - 1];
      for (const t of D.ROOT_TIERS) { acc += t.概率; if (r <= acc) { tier = t; break; } }
      createState.灵根 = tier; createState.spinning = false; renderCreate();
    }, 900);
  }
  /**
   * 创角产物 → 初始 GameState 快照。
   * 用引擎的 emptyState 起手，所有数值最后过一次 normalize，保证与游戏中的状态同构。
   */
  function applyCreate() {
    const g = createState;
    const fresh = emptyState();

    fresh.主角.姓名 = g.姓名 || '陆沉';
    fresh.主角.性别 = g.性别 || '男';
    fresh.主角.所在界 = g.出生界 || '玄天界';
    fresh.主角.宗门 = g.出身 === '寒门散修' ? '散修'
      : (g.出身 === '宗门外门' || g.出身 === '青云宗外门') ? '青云宗 · 外门'
        : g.出身 === '没落世家' ? '没落世家' : '散修';
    if (g.出生界 === '仙界') fresh.主角.境界 = '真仙一层';
    fresh.主角.灵根 = g.灵根 ? `${g.灵根.品} · 单灵根` : '凡品 · 单灵根';
    if (g.出身 === '寒门散修') fresh.主角.道心 = 58;
    if (g.出身 === '宗门外门' || g.出身 === '青云宗外门') fresh.主角.宗门贡献 = 120;
    if (g.灵根 && g.灵根.品 === '天品') fresh.主角.道心 = clamp(fresh.主角.道心 + 10, 0, 100);

    for (const n of g.气运 || []) {
      fresh.主角.气运[n] = {
        类型: n.startsWith('真·') ? '主动' : '被动',
        效果: '（创角所选气运）',
        使用状态: '常驻',
        压制状态: '正常',
        真: n.startsWith('真·'),
      };
    }

    const 灵石 = g.出身 === '没落世家' ? 36 : 16;
    fresh.主角.储物袋['下品灵石'] = { 描述: '修仙界通用硬通货', 数量: 灵石 };
    fresh.主角.储物袋['聚气丹'] = { 描述: '服之可缓缓回复灵力', 数量: 3 };
    fresh.主角.储物袋['疗伤散'] = { 描述: '外伤止血，聊胜于无', 数量: 2 };
    fresh.主角.功法['青云吐纳诀'] = { 类型: '筑基功法', 境界: '炼气期', 熟练度: 0, 描述: '青云宗外门入门吐纳之法，中正平和。' };
    fresh.主角.器物['青纹剑'] = { 等级: '下品法器', 类型: '飞剑', 损耗度: 0, 状态: '完好', 描述: '剑身一道青纹，注入灵力可御使三丈。' };

    if (g.道侣) {
      fresh.道侣[g.道侣] = {
        性别: '女', 种族: '人族', 状态: '正常', 境界: '筑基后期',
        亲密: 20, 生命: 90, 灵力: 80, 修为: 60, 道心: 68,
        性格: '尚未看清。', 外观: '——', 身高: '——',
        背景: '命中注定要遇见的人。', 神通: '——', 心声: '（终于……见到你了。）',
      };
    }

    normalizeState(fresh);
    // 原地替换当前状态（state 被大量闭包共享，不能换引用）
    for (const k of Object.keys(state)) delete state[k];
    Object.assign(state, fresh);

    turns.length = 0;
    turns.push({
      role: 'assistant',
      text: `${state.主角.姓名}，${state.主角.所在界}的风，比你想的更冷一些。\n\n你睁开眼时，身下是青云宗后山的青石，衣袍还带着洗不净的皂角味。远处钟声三响，是外门晨课的时辰。\n\n你的道途，从这一刻开始。`,
      scene: { 当前时间: state.世界.当前时间, 当前地点: state.世界.当前地点, 危机程度: state.世界.危机程度 },
      choices: ['起身去上晨课', '先查看自己的储物袋', '往后山深处走走'],
    });

    currentSaveId = newSaveId('save');
    if (WORLDBOOK) WORLD_INDEX = buildIndex(WORLDBOOK, { realm: state.主角.所在界 });

    setSuggestions([]);            // 新档开局不继承上一局的建议
    showScreen('s-game'); renderStream(); renderHUD(); renderSidebar();
    autosave();
  }
  $('#cr-back').addEventListener('click', () => {
    if (createState.step === 0) showScreen('s-boot'); else { createState.step--; renderCreate(); }
  });
  $('#cr-skip').addEventListener('click', () => { applyCreate(); });

  /* ================= HUD ================= */
  /** 神视模式：默认关闭，六维只显示模糊语（卡设定"主角无法感知精确数值"）。 */
  let showExact = false;

  function barHTML(key, val, color, note) {
    const v = clamp(Number(val) || 0, 0, 100);
    const shown = showExact ? String(v) : vague(v);
    return `<div class="bar" data-res="${key}"><div class="t"><span>${key}${note ? '<i> ' + note + '</i>' : ''}</span><b>${shown}</b></div>
      <div class="track"><div class="fill" style="width:${v}%;background:${color}"></div></div></div>`;
  }
  /** 正文字号三档（只影响文字，不影响版式）。 */
  let currentFont = (function () {
    try { return localStorage.getItem('dy.font') || 'm'; } catch { return 'm'; }
  })();
  app.dataset.font = currentFont;

  /** 六维是否展开（手机默认收起，只留 8px 聚合条）。 */
  let hudExpanded = (function () {
    try { return localStorage.getItem('dy.hudExpanded') === '1'; } catch { return false; }
  })();

  function renderHUD() {
    const W = state.世界, P = state.主角;
    const lv = crisisLevel(W.危机程度);
    $('#hud').innerHTML = `
      <div class="hud-row1">
        <span class="name">${esc(P.姓名)}</span>
        <!-- 境界标签已含 DC（engine 的 realmLabel 生成），此处不再拼接 -->
        <span class="realm">${esc(P.境界)}</span>
        <span class="spacer"></span>
        <button class="iconbtn rail-toggle" id="rail-toggle" title="收起/展开左栏">⇤</button>
        <button class="iconbtn" id="hud-menu" title="面板">☰</button>
      </div>
      <div class="hud-row2">
        <span>🕛 ${esc(W.当前时间)}</span><span>📍 ${esc(W.当前地点)}</span><span>🌧 ${esc(W.天气)}</span>
        <span class="crisis lv${lv}">危机 · ${esc(W.危机程度)}</span>
        <span>遭遇冷却 ${W.遭遇冷却}</span>
      </div>
      <div class="agg" id="hud-agg" title="点击展开/收起六维" aria-label="展开六维">
        ${D.RES.map((r) => `<span style="flex:${Math.max(1, clamp(Number(P[r.key]) || 0, 0, 100))};background:${r.color}"></span>`).join('')}
      </div>
      <div class="hud-bars ${hudExpanded ? '' : 'collapsed'}" id="hud-bars">
        ${D.RES.map((r) => barHTML(r.key, P[r.key], r.color, r.key === '修为' && P.修为 >= 100 ? '瓶颈' : r.key === '道心' ? daoStage(P.道心) : '')).join('')}
      </div>`;
    $('#hud-menu').addEventListener('click', () => openPanel(curPanel));
    // 聚合条 = 六维的折叠开关
    const agg = $('#hud-agg');
    if (agg) agg.addEventListener('click', () => {
      hudExpanded = !hudExpanded;
      try { localStorage.setItem('dy.hudExpanded', hudExpanded ? '1' : '0'); } catch { /* 忽略 */ }
      renderHUD();
    });
    const rt = $('#rail-toggle');
    if (rt) rt.addEventListener('click', () => toggleRail());
  }

  /* ================= 叙事流 ================= */
  function sceneBanner(s) {
    if (!s) return '';
    return `<div class="scene-banner">${Object.entries(s).map(([k, v]) => `<span>${esc(k)} · ${esc(v)}</span>`).join('')}</div>`;
  }
  function msgHTML(t) {
    if (t.role === 'user') return `<div class="msg user"><div class="who">你</div><div class="bubble">${esc(t.text)}</div></div>`;
    const fx = (t.effects || []).filter((e) => e.op === 'delta' && /\.(生命|精血|灵力|修为|神识|道心|好感|亲密)$/.test(e.target))
      .map((e) => `<span class="fx-chip ${e.value >= 0 ? 'up' : 'down'}">${e.target.split('.').pop()} ${e.value >= 0 ? '+' : ''}${e.value}</span>`).join('');
    return `<div class="msg assistant"><div class="who">道渊</div><div class="bubble">${esc(t.text)}</div>
      ${fx ? `<div class="fx">${fx}</div>` : ''}</div>`;
  }
  function renderStream() {
    const first = turns.find((t) => t.scene);
    $('#stream').innerHTML = (first ? sceneBanner(first.scene) : '') + turns.map(msgHTML).join('');
    // 重渲整条叙事流时按最后一轮的建议同步吸附条，避免与屏幕内容对不上
    const last = [...turns].reverse().find((t) => t.role === 'assistant' && (t.choices || []).length);
    setSuggestions(last ? last.choices : []);
  }
  function scrollStream() { const s = $('#stream'); s.scrollTop = s.scrollHeight; }
  function appendTurn(t) {
    $('#stream').insertAdjacentHTML('beforeend', msgHTML(t));
    scrollStream();
  }

  /* ================= 行动区 ================= */
  /** 本回合的行动建议：吸附在输入区上方，不再埋在叙事流里要往回滚。 */
  let SUGGESTIONS = [];

  function renderSuggestions() {
    const el = $('#sugg');
    if (!el) return;
    el.innerHTML = SUGGESTIONS.map((c, i) =>
      `<button class="c" data-choice="${esc(c)}"><span class="k">${i + 1}</span>${esc(c)}</button>`).join('');
  }

  function setSuggestions(list) {
    SUGGESTIONS = Array.isArray(list) ? list.slice(0, 4) : [];
    renderSuggestions();
  }

  function renderActions() {
    $('#actions').innerHTML = `
      <div class="sugg" id="sugg"></div>
      <div class="row-main">
        ${MAIN_ACTS.map((a) => `<button class="act ${a.hot ? 'hot' : ''}" data-act="${a.k}"><span class="i">${a.i}</span>${a.k}</button>`).join('')}
        <button class="act" id="more-btn" title="更多入口"><span class="i">⋯</span><span class="more-l">更多</span></button>
      </div>
      <div class="input-row"><input id="free-input" placeholder="写下你的行动……"><button class="send" id="send">发送</button></div>
      <div class="more-sheet" id="more-sheet">
        <div class="grid">${MORE_ACTS.map((a) => `<button class="act" data-act="${a.k}" ${a.panel ? `data-panel="${a.panel}"` : ''}><span class="i">${a.i}</span>${a.k}</button>`).join('')}</div>
      </div>`;
    $('#send').addEventListener('click', sendFree);
    $('#free-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendFree(); });
    $('#more-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      $('#more-sheet').classList.toggle('open');
    });
    renderSuggestions();
  }

  /** 点别处或选中入口后收起「更多」。 */
  function closeMoreSheet() {
    const m = $('#more-sheet');
    if (m) m.classList.remove('open');
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a) { doAction(a.dataset.act, a.dataset.panel); return; }
    const c = e.target.closest('[data-choice]');
    if (c) { freeText(c.dataset.choice); }
  });
  function doAction(kind, panel) {
    closeMoreSheet();
    if (panel) { openPanel(panel); return; }
    if (kind === '突破') { breakthrough(); return; }
    if (kind === '面板') { openPanel(curPanel); return; }
    if (kind === '探索') return freeText('四处探索，看看这附近有什么。');
    if (kind === '修炼') return cultivate();
    if (kind === '交流') return freeText('去找镇上的修士聊聊天。');
  }
  const REPLIES = [
    { text: '你顺着青石路往镇中走。雨后的坊市飘着湿腥的土味，摊贩们把灵材摊在油布上，时不时抬眼打量你这一身旧袍。\n\n一个卖符纸的老者冲你笑了笑：「小友面生。这年头，面生的人最容易出事——尤其，别往后山去。」', fx: [{ op: 'delta', target: '主角.神识', value: 2, reason: '留意四周' }], choices: ['追问「后山什么事」', '买两张符纸', '不理会，继续走'] },
    { text: '你在一处茶摊坐下，要了碗最便宜的粗茶。邻桌两个散修正低声争执着什么，提到「采药人」「魂灯灭了」几个字眼，见你望过去，立刻收声。\n\n这镇子，藏着事。', fx: [{ op: 'delta', target: '主角.灵力', value: 4, reason: '歇息' }], choices: ['凑过去听', '结账离开', '记住那两张脸'] },
    { text: '你试着引动丹田的那一缕灵力。它细如游丝，却在你掌心凝出一星暗红的火苗——黄品灵根的极限，也就到这了。\n\n火苗熄灭，你的呼吸沉了下去。慢，但未必不是好事。', fx: [{ op: 'delta', target: '主角.灵力', value: -5, reason: '灵力耗散' }, { op: 'delta', target: '主角.修为', value: 2, reason: '试炼所得' }], choices: ['继续练手', '打坐回复灵力', '收功'] },
  ];
  const ENCOUNTER = {
    text: '天色忽然暗了一分。\n\n巷口不知何时立着一个身影，一袭藕荷色衣裙，眉眼含笑，身后却有一道蓬松的影子一闪而没。\n\n「咦，」她歪头看你，声音软得像化了糖，「炼气三层的小家伙，身上怎么有这么沉的气？」',
    fx: [{ op: 'delta', target: '人物.苏琉璃.好感', value: 3, reason: '初次相遇' }],
    choices: ['拱手行礼，报上名号', '不动声色，先退半步', '反问她是谁'],
  };

  /** 走引擎跑一回合：推进 → 检索 → 叙事(流式) → 裁决 → 落地 → 刷界面。 */
  /** 回合进行中标志：流式期间重复点建议/主行动会并发跑两个回合，状态互相覆盖。 */
  let turnInFlight = false;

  async function runEngineTurn(action, opts = {}) {
    if (turnInFlight) return null;      // 一个回合没跑完，忽略新的
    turnInFlight = true;
    const actionsEl = $('#actions');
    if (actionsEl) actionsEl.classList.add('busy');
    try {
      return await runEngineTurnInner(action, opts);
    } finally {
      turnInFlight = false;
      if (actionsEl) actionsEl.classList.remove('busy');
    }
  }

  async function runEngineTurnInner(action, opts = {}) {
    const { bubble, wrap } = newAssistantBubble();
    const llm = window.DYApp.available() && LLM.ready ? window.DYApp.llm : null;
    let result;
    try {
      result = await runTurn({
        action,
        state,
        index: WORLD_INDEX,
        llm,
        rng: Math.random,
        recent: turns.slice(-8).map((t) => ({ role: t.role, text: t.text })),
        arbiterConfigured: !!(LLM.settings && LLM.settings.arbiter && LLM.settings.arbiter.model),
        onDelta: (_chunk, full) => { bubble.textContent = full; scrollStream(); },
        fallbackNarratives: REPLIES.map((r) => r.text),
        chat: {
          mode: CHAT.mode,
          preset: CHAT_PRESET,
          charName: CHAT.charName || '道渊',
          userName: CHAT.userName || state.主角.姓名,
        },
      });
    } catch (e) {
      bubble.classList.remove('typing');
      bubble.textContent = '回合执行失败：' + ((e && e.message) || e);
      turns.push({ role: 'assistant', text: bubble.textContent });
      return null;
    }

    if (opts.holdForJudge && result.duel) {
      // 突破：先把判定结果交给玩家确认，再揭示正文
      showJudge(result.duel, () => paintTurn(bubble, wrap, result));
      return result;
    }
    paintTurn(bubble, wrap, result);
    return result;
  }

  /** 把一回合的结果画进叙事流。 */
  function paintTurn(bubble, wrap, result) {
    bubble.classList.remove('typing');
    bubble.textContent = result.narrative;

    const fx = (result.effects || []).filter(
      (e) => e.op === 'delta' && /\.(生命|精血|灵力|修为|神识|道心|好感|亲密|亲密度)$/.test(e.target),
    );
    if (fx.length) {
      wrap.insertAdjacentHTML('beforeend', `<div class="fx">${fx.map((e) =>
        `<span class="fx-chip ${e.value >= 0 ? 'up' : 'down'}">${e.target.split('.').pop()} ${e.value >= 0 ? '+' : ''}${e.value}</span>`).join('')}</div>`);
    }
    if (result.encounter) {
      wrap.insertAdjacentHTML('beforeend', `<div class="fx"><span class="fx-chip">偶遇 · ${esc(result.encounter.name)}</span></div>`);
    }
    // 数值飘字：由引擎落地产出的事件驱动（applyAll 的 events）
    // 注意：effects 是"意图"，events 才是真正落地后的增量；飘字必须用后者
    for (const ev of result.events || []) {
      if (ev.kind === 'float' && ev.key) {
        const meta = D.RES.find((x) => x.key === ev.key);
        float(ev.key, ev.delta, meta ? meta.color : '#d4af37');
      }
    }

    // 建议吸附到输入区上方（不再埋在叙事流里）
    const choices = result.choices || [];
    setSuggestions(choices);

    turns.push({ role: 'assistant', text: result.narrative, effects: result.effects, choices, scene: result.scene });
    scrollStream();
    renderHUD();
    if (!['设置', '模型', '同步', '存档'].includes(curPanel)) renderSidebar();
    autosave();
  }

  /* ================= 存档 ================= */
  const SAVE = { list: [], log: '', busy: false };

  function buildBundle() {
    return {
      meta: {
        id: currentSaveId,
        name: `${state.主角.姓名} · ${state.主角.境界}`,
        summary: `${state.世界.当前地点} · ${state.世界.当前时间} · 第 ${state.世界.天数} 日`,
      },
      state: snapshot(state),
      turns,
      world: {
        绝色榜: Object.keys(state.绝色榜 || {}),
        人物: Object.keys(state.人物 || {}),
        足迹: [...new Set(turns.filter((t) => t.scene && t.scene.当前地点).map((t) => t.scene.当前地点))],
      },
    };
  }

  /** 自动存档：每回合结束落一次（状态已由引擎归一化）。 */
  let autosaveTimer = null;
  function autosave() {
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => { saveNow(true); }, 400);
  }

  async function saveNow(silent = false) {
    try {
      const meta = await store.write(currentSaveId, buildBundle());
      SAVE.log = `已保存 ${meta.id}（${new Date(meta.updatedAt).toLocaleString('zh-CN')}）`;
    } catch (e) {
      SAVE.log = '保存失败：' + ((e && e.message) || e);
      if (!silent) console.warn('[store]', SAVE.log);
    }
    if (!silent) { await refreshSaves(); renderSidebar(); }
  }

  async function refreshSaves() {
    try {
      SAVE.list = await store.list();
    } catch (e) {
      SAVE.log = '读取存档列表失败：' + ((e && e.message) || e);
    }
  }

  async function loadSave(id) {
    try {
      const b = await store.read(id);
      if (!b || !b.state) throw new Error('该存档没有状态数据');
      const next = normalizeState(deep(b.state));
      // 原地替换：state 被大量闭包共享，不能换引用
      for (const k of Object.keys(state)) delete state[k];
      Object.assign(state, next);
      turns.length = 0;
      if (Array.isArray(b.turns)) turns.push(...b.turns);
      currentSaveId = id;
      setSuggestions([]);          // 换档后不能留着上一局的建议（会误导操作）
      renderStream(); renderHUD(); renderSidebar();
      SAVE.log = `已读取 ${id}`;
    } catch (e) {
      SAVE.log = '读档失败：' + ((e && e.message) || e);
      renderSidebar();
    }
  }

  async function deleteSave(id) {
    try {
      await store.remove(id);
      SAVE.log = `已删除 ${id}`;
    } catch (e) {
      SAVE.log = '删除失败：' + ((e && e.message) || e);
    }
    await refreshSaves();
    renderSidebar();
  }

  async function exportSave() {
    try {
      await saveNow(true);
      const json = await store.exportBundle(currentSaveId);
      const blob = new Blob([json], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${currentSaveId}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      SAVE.log = '已导出存档包（可在任意端导入）';
    } catch (e) {
      SAVE.log = '导出失败：' + ((e && e.message) || e);
    }
    renderSidebar();
  }

  async function importSaveFile(file) {
    try {
      const text = await file.text();
      const meta = await store.importBundle(text);
      SAVE.log = `已导入为 ${meta.id}（不会覆盖已有存档）`;
    } catch (e) {
      SAVE.log = '导入失败：' + ((e && e.message) || e);
    }
    await refreshSaves();
    renderSidebar();
  }

  async function freeText(text, kind = 'free') {
    // 守卫必须在**写用户回合之前**：否则连点 3 次会记下 3 个用户回合，
    // 而引擎只跑 1 次 —— 叙事流里留下两个没有回复的空提问。
    if (turnInFlight) return null;
    turns.push({ role: 'user', text });
    appendTurn(turns[turns.length - 1]);
    renderHUD();
    return runEngineTurn({ kind, text });
  }
  function cultivate() {
    // 修为增量、耗时天数全部由引擎算（engine/rules.js 的灵根品阶表）
    return freeText('寻一处僻静，闭关修炼。', 'cultivate');
  }

  async function breakthrough() {
    if (turnInFlight) return null;
    const text = '冲击瓶颈，尝试突破。';
    turns.push({ role: 'user', text });
    appendTurn(turns[turns.length - 1]);
    renderHUD();
    return runEngineTurn({ kind: 'breakthrough', text }, { holdForJudge: true });
  }
  function sendFree() {
    const el = $('#free-input'); const v = el.value.trim(); if (!v) return; el.value = '';
    freeText(v);
  }

  /* ================= 效果落地（全部交给引擎） ================= */
  /** 落地 effect 并把引擎事件翻译成界面动画。 */
  function applyEffects(effects) {
    const r = applyAll(state, effects || []);
    for (const ev of r.events || []) {
      if (ev.kind === 'float' && ev.key) {
        const meta = D.RES.find((x) => x.key === ev.key);
        float(ev.key, ev.delta, meta ? meta.color : '#d4af37');
      } else if (ev.kind === 'realm') {
        float('修为', 0, '#d4af37');
      }
    }
    if (r.logs.length) {
      console.warn('[engine] 跳过', r.logs.length, '条无效效果：', r.logs);
    }
    return r;
  }
  /**
   * 数值飘字。
   *
   * 两个实测坑：
   * 1. HUD 六维默认是折叠的（`.hud-bars.collapsed { display:none }`），
   *    此时对应条的 getBoundingClientRect 全是 0 —— 飘字会被放到视口左上角之外，
   *    玩家什么也看不到。所以量不到尺寸时退回到 HUD 底边居中飘。
   * 2. 同名 `data-res` 在 HUD 与抽屉面板里都有，必须限定在 HUD 内取。
   */
  function float(key, v, color) {
    const bar = $(`#hud [data-res="${key}"]`);
    let cx = 0, top = 0;
    const r = bar ? bar.getBoundingClientRect() : null;
    if (r && r.width > 0) {
      cx = r.left + r.width * 0.5;
      top = r.top - 6;
    } else {
      const hud = $('#hud');
      const hr = hud ? hud.getBoundingClientRect() : null;
      if (!hr || hr.width === 0) return;      // 游戏页未显示时不飘
      cx = hr.left + hr.width * 0.5;
      top = hr.bottom - 14;
    }
    const d = document.createElement('div');
    d.className = 'float'; d.style.color = color;
    d.textContent = (v >= 0 ? '+' : '') + v;
    d.style.left = (cx - 10) + 'px';
    d.style.top = top + 'px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1400);
  }

  /* ================= 判定演出 ================= */
  /** 覆盖层待确认的回调：Esc 关闭时必须补跑，否则该回合白跑。 */
  let judgeAck = null;
  /**
   * 判定覆盖层。**面板上的数字没有一个来自模型** —— 全部由 engine/turn.js 掷骰得出，
   * 模型只负责把成败的过程演得合理。
   * @param {{win:boolean, chance:number, diff:number, tier?:{desc:string}, opponentName?:string}} duel
   * @param {Function} onAck 玩家点「承认结果」后的回调
   */
  function showJudge(duel, onAck) {
    const P = state.主角;
    const diff = Number(duel.diff ?? 0);
    const tier = duel.tier || D.DC_TIERS.find((t) => Math.abs(diff) <= t.max) || { desc: '' };
    const chance = Number(duel.chance ?? 0.5);
    const win = !!duel.win;
    const aDc = P.境界DC;
    const bDc = aDc + diff;
    const box = $('#judge-box');
    box.innerHTML = `
      <h3>道 争 · 判 定</h3>
      <div class="duel">
        <div class="side"><div class="nm">${esc(P.姓名)}</div><div class="dc">${aDc}</div>
          <div class="nm" style="color:var(--dim)">${esc(P.境界)}</div></div>
        <div class="vs">对 拼</div>
        <div class="side"><div class="nm">${esc(duel.opponentName || '瓶颈')}</div>
          <div class="dc" style="color:var(--bad)">${bDc}</div>
          <div class="nm" style="color:var(--dim)">境界差 ${diff > 0 ? '+' + diff : diff}</div></div>
      </div>
      <div class="verdict ${win ? 'win' : 'lose'}">${win ? '成' : '败'}</div>
      <div class="tier">${esc(tier.desc)}</div>
      <div class="desc">引擎掷骰：成功率 ${(chance * 100).toFixed(0)}%（道心 ${P.道心} · 灵力 ${P.灵力} · 境界差 ${diff}）<br>
        —— 判定由本地引擎给出，模型只负责把这一场演得合理。</div>
      <button class="btn primary" id="judge-ok">承 认 结 果</button>`;
    $('#judge').classList.add('open');
    const ok = $('#judge-ok');
    const handler = () => {
      $('#judge').classList.remove('open');
      ok.removeEventListener('click', handler);
      judgeAck = null;
      if (typeof onAck === 'function') onAck();
    };
    // Esc 也必须走同一条路径：否则本回合的正文与状态推进就永久丢了
    // （runTurn 里状态已落地，但叙事没写进流里、也没存档）
    judgeAck = handler;
    ok.addEventListener('click', handler);
  }

  /* ================= 检查更新 ================= */
  function updateSectionHTML() {
    const U = window.DYUpdate, s = U.state;
    const verLabel = 'v' + U.VERSION;
    let msg = '从 GitHub Releases 检查新版本';
    if (s.status === 'checking') msg = '正在检查更新……';
    else if (s.status === 'latest') msg = '已是最新版本（' + verLabel + '）';
    else if (s.status === 'none') msg = '尚无发布版本，当前为最新开发版';
    else if (s.status === 'error') msg = '检查失败：' + esc(s.error) + '（不影响离线游玩）';
    else if (s.status === 'newer') msg = '发现新版本 ' + esc(s.latestTag) + '（当前 ' + verLabel + '）';

    let tail = '';
    if (s.status === 'newer') {
      tail = `<div class="card" style="margin-top:10px">
          <div style="display:flex;align-items:center;gap:8px">
            <b style="color:var(--gold)">${esc(s.latestName || s.latestTag)}</b>
            <span class="chip gold" style="margin-left:auto">${esc(s.latestTag)}</span></div>
          ${s.notes ? `<div class="upd-notes">${esc(s.notes).slice(0, 700)}</div>` : ''}
          <div style="display:flex;gap:8px;margin-top:12px">
            <a class="btn primary" href="${esc(s.apk || s.url)}" target="_blank" rel="noopener">${s.apk ? '下载 APK' : '前往发布页'}</a>
            <a class="btn" href="${esc(U.PAGE)}" target="_blank" rel="noopener">全部版本</a>
          </div></div>`;
    }
    return `<div class="sect-title">版 本 与 更 新</div>
      <div class="set-row">
        <div class="lbl">当前版本 ${verLabel}<div class="d">${msg}</div></div>
        <button class="btn" id="upd-btn" style="flex:none;min-width:94px;padding:9px 14px">${s.status === 'checking' ? '检查中…' : '检查更新'}</button>
      </div>
      <div class="set-row">
        <div class="lbl">启动时自动检查更新<div class="d">仅读取版本号与更新说明，不上传任何本地数据</div></div>
        <div class="switch ${U.autoEnabled() ? 'on' : ''}" id="upd-auto"></div>
      </div>
      ${tail}`;
  }
  function renderUpdateChip() {
    const U = window.DYUpdate, s = U.state;
    const bv = $('#boot-ver'), el = $('#update-chip');
    if (bv) bv.textContent = `原型 v${U.VERSION} · 安卓手机 / 平板 · 未连接 LLM`;
    if (!el) return;
    if (s.status !== 'newer') { el.innerHTML = ''; return; }
    el.innerHTML = `<div class="chip gold upd-chip" id="upd-chip">发现新版本 ${esc(s.latestTag)} · 查看</div>`;
    $('#upd-chip').addEventListener('click', () => { showScreen('s-game'); openPanel('设置'); });
  }

  /* ================= 大模型接入（能力由壳提供，浏览器内降级） ================= */
  const LLM = { shell: false, ready: false, settings: null, secrets: null, error: '' };

  async function refreshLlm() {
    LLM.shell = window.DYApp.available();
    if (!LLM.shell) { LLM.ready = false; return; }
    try {
      const r = await window.DYApp.llm.get();
      LLM.settings = r.settings;
      LLM.secrets = r.secrets;
      const s = r.settings || {};
      LLM.ready = !!(r.secrets && r.secrets.llmKeySet)
        && !!(s.narrator && s.narrator.model)
        && !!(s.provider && s.provider.baseUrl);
      LLM.error = '';
    } catch (e) {
      LLM.error = String((e && e.message) || e);
      LLM.ready = false;
    }
  }

  function newAssistantBubble() {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    wrap.innerHTML = '<div class="who">道渊</div><div class="bubble typing"></div>';
    $('#stream').appendChild(wrap);
    return { wrap, bubble: $('.bubble', wrap) };
  }

  /* ================= 多端进度同步（能力由壳提供） ================= */
  const SYNC = { shell: false, config: null, secrets: null, local: [], remote: [], log: '', error: '' };

  async function refreshSync() {
    SYNC.shell = window.DYApp.available();
    if (!SYNC.shell) return;
    try {
      const r = await window.DYApp.sync.getConfig();
      SYNC.config = r.config;
      SYNC.secrets = r.secrets;
      SYNC.error = '';
    } catch (e) {
      SYNC.error = String((e && e.message) || e);
    }
  }

  function shellNote() {
    return `<div class="card" style="margin-bottom:12px;border-color:rgba(255,176,102,.4)">
      <b style="color:var(--warn)">当前是浏览器预览</b>
      <div style="color:var(--dim);font-size:.8rem;margin-top:6px">这一页的能力由桌面端 / 安卓客户端提供（在 Rust 侧实现）。浏览器里只能看界面，无法真正读写本地密钥、存档与 GitHub。</div></div>`;
  }

  /** 拉本机/远端存档列表。远端只有"仓库 + 令牌都配好"时才查，避免首次打开就报错。 */
  async function loadSyncLists() {
    if (!SYNC.shell) return;
    try { SYNC.local = await window.DYApp.sync.localSaves(); } catch (e) { SYNC.local = []; }
    const c = SYNC.config || {}, s = SYNC.secrets || {};
    if (c.repo && s.syncTokenSet) {
      try { SYNC.remote = await window.DYApp.sync.remoteSaves(); SYNC.error = ''; }
      catch (e) { SYNC.remote = []; SYNC.error = String((e && e.message) || e); }
    } else {
      SYNC.remote = [];
    }
    // 只在同步面板打开时才重建：这个方法在启动时会跑一次，
    // 无条件重建会把用户正在别的面板里填的表单冲掉（真机上实测到了）。
    if (curPanel === '同步') renderSidebar();
  }

  /** 请求头 ↔ 文本框（每行「名: 值」）。 */
  function headersToText(map) {
    const o = map && typeof map === 'object' ? map : {};
    return Object.entries(o).map(([k, v]) => `${k}: ${v}`).join('\n');
  }
  function textToHeaders(text) {
    const out = {};
    for (const line of String(text || '').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf(':');
      if (i <= 0) continue;
      const k = t.slice(0, i).trim();
      const v = t.slice(i + 1).trim();
      if (k && v) out[k] = v;
    }
    return out;
  }
  /** 随机会话 ID：只在本机生成与使用。 */
  function newSessionId() {
    const hex = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
    return `${hex(8)}-${hex(4)}-4${hex(3)}-a${hex(3)}-${hex(12)}`;
  }

  /* ================= 对话模式与预设（UI） ================= */

  function samplingSummary(sm) {
    if (!sm || typeof sm !== 'object') return '（预设未带采样参数，沿用应用设置）';
    const keys = Object.keys(sm).filter((k) => SUPPORTED_SAMPLING.includes(k));
    if (!keys.length) return '（预设未带采样参数，沿用应用设置）';
    return keys.map((k) => `${k}=${sm[k]}`).join('  ');
  }

  function chatModeSectionHTML() {
    const isPreset = CHAT.mode === 'preset';
    const cur = CHAT_PRESETS.find((p) => p.id === CHAT.presetId);
    let detail = '';
    if (isPreset) {
      if (CHAT_PRESET) {
        const enabled = (CHAT_PRESET.order || []).filter((o) => o.enabled).length || CHAT_PRESET.entries.length;
        const ignored = Object.keys(CHAT_PRESET.sampling || {}).filter((k) => !SUPPORTED_SAMPLING.includes(k));
        const warns = CHAT_PRESET.warnings || [];
        detail = `<div class="card" style="margin-top:10px">
            <div class="kv"><span class="k">名称</span><span class="v">${esc(CHAT_PRESET.name || (cur && cur.id) || '')}</span></div>
            <div class="kv"><span class="k">条目</span><span class="v">共 ${CHAT_PRESET.entries.length} 条 · 启用 ${enabled} 条 · 顺序组 ${esc(String(CHAT_PRESET.orderGroup))}</span></div>
            <div class="kv"><span class="k">采样</span><span class="v">${esc(samplingSummary(CHAT_PRESET.sampling))}</span></div>
            ${ignored.length ? `<div class="kv"><span class="k">已忽略</span><span class="v">${esc(ignored.join(' / '))}</span></div>` : ''}
            ${warns.length ? `<div class="upd-notes" style="margin-top:8px">${esc(warns.join(String.fromCharCode(10)))}</div>` : ''}
          </div>`;
      } else {
        detail = `<div class="cr-hint">${CHAT.presetId ? '预设读取失败，详见控制台。' : '还没有预设。导入一份 ST 的 Chat Completion 预设 JSON 即可。'}</div>`;
      }
    }
    return `<div class="sect-title">对 话 模 式</div>
      <div class="opts">
        <button class="opt ${!isPreset ? 'on' : ''}" data-chatmode="default">默认对话<span class="d">引擎内置分层：世界法则 + 检索 + 状态摘要 + 近况 + 本回合</span></button>
        <button class="opt ${isPreset ? 'on' : ''}" data-chatmode="preset">使用预设<span class="d">导入 ST 酒馆的 Chat Completion 预设，提示词完全按预设展开</span></button>
      </div>
      ${isPreset ? `
      <div class="field"><label>当前预设</label>
        <select id="chat-preset">
          <option value="">（未选择）</option>
          ${CHAT_PRESETS.map((pr) => `<option value="${esc(pr.id)}" ${CHAT.presetId === pr.id ? 'selected' : ''}>${esc(pr.name)}</option>`).join('')}
        </select></div>
      <div style="display:flex;gap:8px">
        <button class="btn" id="preset-import">导入 JSON</button>
        <button class="btn" id="preset-paste">粘贴 JSON</button>
        <button class="btn" id="preset-del">删除当前</button>
      </div>
      <input type="file" id="preset-file" accept="application/json,.json" style="display:none">
      ${detail}
      <div class="field" style="margin-top:12px"><label>角色名 {{char}} · AI 扮演谁</label>
        <input id="chat-char" value="${esc(CHAT.charName)}" placeholder="道渊"></div>
      <div class="field"><label>用户名 {{user}} · 玩家是谁</label>
        <input id="chat-user" value="${esc(CHAT.userName)}" placeholder="留空则用主角姓名"></div>
      <div class="cr-hint">已实现的宏：${esc(SUPPORTED_MACROS.join('　'))}。未实现的宏会原样保留，并在预览里列出。</div>
      ` : ''}
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="btn" id="chat-preview">预览将发送的提示词</button>
        ${isPreset ? '<button class="btn" id="chat-export">导出为 ST 预设</button>' : ''}
      </div>`;
  }

  async function importPresetText(text, name) {
    const parsed = parsePreset(text);
    if (!parsed.ok) { alert('导入失败：' + parsed.error); return; }
    try {
      const meta = await presetStore.importRaw(text, name || 'ST 预设');
      CHAT.presetId = meta.id;
      CHAT.mode = 'preset';
      saveChatPrefs();
      await refreshPresets();
      renderSidebar(true);
      if ((parsed.preset.warnings || []).length) {
        alert('导入成功，但有提示：' + String.fromCharCode(10) + parsed.preset.warnings.join(String.fromCharCode(10)));
      }
    } catch (e) {
      alert('导入失败：' + e.message);
    }
  }

  function showPreview() {
    let plan;
    try { plan = buildPreviewPlan(); } catch (e) { alert('预览生成失败：' + e.message); return; }
    const rows = plan.messages.map((m, i) =>
      `<div class="kv"><span class="k">[${i + 1}] ${esc(m.role)}</span><span class="v">${esc(m.content.length > 200 ? m.content.slice(0, 200) + '…' : m.content)}</span></div>`).join('');
    const layers = (plan.meta.layers || []).map((l) => `${esc(l.name)}:${l.tokens == null ? '?' : l.tokens}`).join('　');
    const warns = plan.warnings || [];
    // 常驻法则被截断的条目：写进告警栏，不然用户看不出"少了一截"
    const cut = (plan.meta.layers || [])
      .filter((l) => (l.truncated || []).length)
      .flatMap((l) => l.truncated);
    if (cut.length) warns.push(`以下常驻条目超出预算被截断（保留开头）：${cut.join('、')}`);
    $('#judge-box').innerHTML = `<h3>将 发 送 的 提 示 词</h3>
      <div class="cr-hint" style="text-align:left">${plan.meta.mode === 'preset' ? '预设「' + esc(plan.meta.presetName || '') + '」' : '默认对话'} · 共 ${plan.messages.length} 条 · 约 ${plan.meta.totalTokens} tok</div>
      <div style="max-height:46vh;overflow:auto;text-align:left;margin:10px 0">${rows}</div>
      <div class="cr-hint" style="text-align:left">分层：${layers}</div>
      ${warns.length ? `<div class="upd-notes" style="margin-top:10px;text-align:left">${esc(warns.join(String.fromCharCode(10)))}</div>` : ''}
      <button class="btn primary" id="preview-ok" style="margin-top:14px">关 闭</button>`;
    $('#judge').classList.add('open');
    $('#preview-ok').addEventListener('click', () => $('#judge').classList.remove('open'));
  }

  function exportAsStPreset() {
    const raw = JSON.stringify(toStPreset({ name: '道渊 · 默认' }), null, 2);
    const blob = new Blob([raw], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'daoyuan-default-preset.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  /* ================= 侧栏面板 ================= */
  /**
   * 面板是否正在被编辑。
   *
   * 背景异步回来时会调 renderSidebar()（世界书加载完、同步列表拉到、更新检查返回），
   * 而重建 innerHTML 会把用户**正在输入的表单冲掉**——在真机上实测到了这个丢失。
   * 所以：只要用户动过表单，就不许背景刷新重建面板。
   */
  let sbDirty = false;
  function sidebarTouched() { return sbDirty; }

  let moreTabsOpen = false;

  function renderSidebar(force = false) {
    if (!force && sbDirty) return; // 用户在填表，别覆盖他
    $('#sb-title').textContent = curPanel;
    const common = PANELS.filter((p) => PANELS_COMMON.includes(p.id));
    const more = PANELS.filter((p) => !PANELS_COMMON.includes(p.id));
    const chip = (p) => `<button class="tab ${p.id === curPanel ? 'on' : ''}" data-tab="${p.id}">${p.icon} ${p.id}</button>`;
    $('#sb-tabs').innerHTML =
      `<span class="g-label">常用</span>${common.map(chip).join('')}` +
      `<button class="tab more" data-moretabs="1">${moreTabsOpen ? '收起 ▴' : '＋ 更多 ▾'}</button>` +
      `<span class="grp-more" style="display:${moreTabsOpen ? 'contents' : 'none'}">` +
        `<span class="g-label">更多</span>${more.map(chip).join('')}</span>`;
    $('#sb-body').innerHTML = panelHTML(curPanel);
    $$('#sb-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.tab)));
    const mt = $('#sb-tabs [data-moretabs]');
    if (mt) mt.addEventListener('click', () => { moreTabsOpen = !moreTabsOpen; renderSidebar(true); });
    const ci = $('#chat-input-field');
    if (ci) {
      ci.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(ci.value); });
      $('#chat-send').addEventListener('click', () => sendChat(ci.value));
    }
    // 图鉴搜索
    const ws = $('#wiki-search');
    if (ws) ws.addEventListener('input', () => { $('#wiki-list').innerHTML = wikiList(ws.value.trim()); });
    // 设置开关（排除需要独立持久化的更新开关）
    $$('#sb-body .switch:not(#upd-auto)').forEach((s) => s.addEventListener('click', () => s.classList.toggle('on')));
    // 字号三档
    $$('#sb-body [data-font]').forEach((b) => b.addEventListener('click', () => {
      currentFont = b.dataset.font;
      app.dataset.font = currentFont;
      try { localStorage.setItem('dy.font', currentFont); } catch { /* 忽略 */ }
      renderSidebar(true);
    }));
    // 「神视模式」：只影响显示，不影响任何计算
    $$('#sb-body .switch[data-set]').forEach((sw) => sw.addEventListener('click', () => {
      if (sw.dataset.set === '神视模式') {
        showExact = sw.classList.contains('on');
        renderHUD();
      }
    }));
    // 检查更新
    const ub = $('#upd-btn');
    if (ub) ub.addEventListener('click', async () => {
      ub.textContent = '检查中…';
      await window.DYUpdate.check();
      renderSidebar(); renderUpdateChip();
    });
    const ua = $('#upd-auto');
    if (ua) ua.addEventListener('click', () => {
      const on = !ua.classList.contains('on');
      ua.classList.toggle('on', on);
      window.DYUpdate.setAuto(on);
    });

    /* ---------- 存档面板 ---------- */
    if ($('#sv-save')) {
      $('#sv-save').addEventListener('click', () => saveNow(false));
      $('#sv-export').addEventListener('click', exportSave);
      $('#sv-import').addEventListener('click', () => $('#sv-file').click());
      $('#sv-file').addEventListener('change', async (e) => {
        const f = e.target.files && e.target.files[0];
        if (f) await importSaveFile(f);
      });
      $$('#sb-body [data-sv-load]').forEach((b) => b.addEventListener('click', () => loadSave(b.dataset.svLoad)));
      $$('#sb-body [data-sv-del]').forEach((b) => b.addEventListener('click', () => {
        if (confirm(`删除存档「${b.dataset.svDel}」？此操作不可恢复。`)) deleteSave(b.dataset.svDel);
      }));
    }

    /* ---------- 模型配置面板 ---------- */
    if ($('#cfg-save')) {
      // 预设按钮：只改输入框，保存时统一提交
      $$('#sb-body [data-prov]').forEach((b) => b.addEventListener('click', () => {
        $$('#sb-body [data-prov]').forEach((x) => x.classList.toggle('on', x === b));
        const base = $('#cfg-base'), path = $('#cfg-path');
        if (base) base.value = b.dataset.base || '';
        if (path) path.value = '/chat/completions';
        // 该渠道要求额外请求头：自动补一条，值随机、仅本机
        let auto = {};
        try { auto = JSON.parse(b.dataset.headers || '{}'); } catch { auto = {}; }
        const ta = $('#cfg-headers');
        if (ta) {
          const filled = Object.entries(auto).map(([k, v]) => `${k}: ${v === 'uuid' ? newSessionId() : v}`);
          if (filled.length) ta.value = filled.join('\n');
        }
      }));

      const readForm = () => {
        const active = $('#sb-body [data-prov].on') || $('#sb-body [data-prov]');
        const pid = active ? active.dataset.prov : 'custom';
        const num = (v, d) => { const n = parseFloat(v); return isNaN(n) ? d : n; };
        const maxRaw = $('#cfg-max').value.trim();
        const prev = LLM.settings || {};
        return {
          provider: {
            id: pid,
            name: { openai: 'OpenAI', ollama: 'Ollama（本地）', custom: '自定义（OpenAI 兼容）' }[pid] || pid,
            baseUrl: $('#cfg-base').value.trim(),
            endpointPath: $('#cfg-path').value.trim() || '/chat/completions',
            systemRole: 'system',
            supportsStream: true,
            requiresApiKey: pid !== 'ollama',
            defaultHeaders: textToHeaders($('#cfg-headers').value),
          },
          narrator: {
            model: $('#cfg-model').value.trim(),
            temperature: num($('#cfg-temp').value, 0.85),
            topP: num($('#cfg-topp').value, 0.95),
            maxTokens: maxRaw === '' ? null : Math.max(1, parseInt(maxRaw, 10) || 0),
            extraBody: (prev.narrator && prev.narrator.extraBody) || {},
          },
          arbiter: $('#cfg-arbiter').value.trim()
            ? { model: $('#cfg-arbiter').value.trim(), temperature: 0.3, topP: 0.9, maxTokens: null, extraBody: {} }
            : null,
          timeoutSecs: (prev && prev.timeoutSecs) || 600,
        };
      };

      /** 保存表单；`withKey` 为 true 时把非空的 Key 一并落盘（留空表示不改动）。 */
      const persistForm = async (withKey) => {
        await window.DYApp.llm.set(readForm());
        if (withKey) {
          const key = $('#cfg-key').value.trim();
          if (key) await window.DYApp.llm.setKey(key);
        }
        await refreshLlm();
      };

      $('#cfg-save').addEventListener('click', async () => {
        try { await persistForm(true); renderSidebar(); }
        catch (e) { $('#cfg-log').textContent = '保存失败：' + ((e && e.message) || e); }
      });

      $('#cfg-test').addEventListener('click', async () => {
        const log = $('#cfg-log');
        log.textContent = '正在连接……';
        try {
          // 先用表单里的地址试，避免"改了 baseUrl 却没保存"导致的误判
          await persistForm(true);
          const list = await window.DYApp.llm.models();
          $('#cfg-models').innerHTML = `<div class="sect-title">可 用 模 型 <span class="n">${list.length}</span></div>` +
            `<div style="display:flex;flex-wrap:wrap;gap:6px">${list.slice(0, 60).map((m) => `<span class="chip purple">${esc(m)}</span>`).join('')}</div>`;
          log.textContent = `连接成功，返回 ${list.length} 个模型。`;
        } catch (e) {
          log.textContent = '连接失败：' + ((e && e.message) || e);
        }
      });

      $('#cfg-clearkey').addEventListener('click', async () => {
        try { await window.DYApp.llm.clearKey(); await refreshLlm(); renderSidebar(); }
        catch (e) { $('#cfg-log').textContent = '清除失败：' + ((e && e.message) || e); }
      });
      // ---- 对话模式与预设 ----
      $$('#sb-body [data-chatmode]').forEach((b) => b.addEventListener('click', async () => {
        CHAT.mode = b.dataset.chatmode;
        saveChatPrefs();
        await refreshPresets();
        renderSidebar(true);
      }));
      const selPreset = $('#chat-preset');
      if (selPreset) selPreset.addEventListener('change', async () => {
        CHAT.presetId = selPreset.value;
        if (CHAT.presetId) CHAT.mode = 'preset';
        saveChatPrefs();
        await refreshPresets();
        renderSidebar(true);
      });
      const ce = $('#chat-char');
      if (ce) ce.addEventListener('input', () => { CHAT.charName = ce.value; saveChatPrefs(); });
      const cu = $('#chat-user');
      if (cu) cu.addEventListener('input', () => { CHAT.userName = cu.value; saveChatPrefs(); });
      const pImport = $('#preset-import');
      const pFile = $('#preset-file');
      if (pImport && pFile) {
        pImport.addEventListener('click', () => pFile.click());
        pFile.addEventListener('change', async () => {
          const f = pFile.files && pFile.files[0];
          if (!f) return;
          await importPresetText(await f.text(), f.name.replace(/\.json$/i, ''));
        });
      }
      const pPaste = $('#preset-paste');
      if (pPaste) pPaste.addEventListener('click', async () => {
        const t = prompt('粘贴 ST 的 Chat Completion 预设 JSON：');
        if (t) await importPresetText(t, 'ST 预设');
      });
      const pDel = $('#preset-del');
      if (pDel) pDel.addEventListener('click', async () => {
        if (!CHAT.presetId) return;
        if (!confirm('删除预设「' + CHAT.presetId + '」？')) return;
        await presetStore.remove(CHAT.presetId);
        CHAT.presetId = '';
        CHAT.mode = 'default';
        saveChatPrefs();
        await refreshPresets();
        renderSidebar(true);
      });
      const pView = $('#chat-preview');
      if (pView) pView.addEventListener('click', showPreview);
      const pExport = $('#chat-export');
      if (pExport) pExport.addEventListener('click', exportAsStPreset);
    }

    /* ---------- 进度同步面板 ---------- */
    if ($('#sy-save')) {
      const collect = () => ({
        repo: $('#sy-repo').value.trim(),
        branch: $('#sy-branch').value.trim() || 'main',
        basePath: $('#sy-path').value.trim() || 'saves',
        autoPush: $('#sy-auto').classList.contains('on'),
      });
      $('#sy-save').addEventListener('click', async () => {
        try {
          const cfg = collect();
          await window.DYApp.sync.setConfig(cfg);
          const token = $('#sy-token').value.trim();
          if (token) await window.DYApp.sync.setToken(token);
          await refreshSync();
          renderSidebar();
        } catch (e) { SYNC.error = String((e && e.message) || e); renderSidebar(); }
      });
      $('#sy-clear').addEventListener('click', async () => {
        try { await window.DYApp.sync.clearToken(); await refreshSync(); renderSidebar(); }
        catch (e) { SYNC.error = String((e && e.message) || e); renderSidebar(); }
      });
      $('#sy-refresh').addEventListener('click', async () => {
        SYNC.log = '正在查询…'; renderSidebar(); await loadSyncLists();
      });
      $('#sy-pushall').addEventListener('click', async () => {
        SYNC.log = '正在推送全部存档…'; renderSidebar();
        try {
          const r = await window.DYApp.sync.pushAll();
          const rows = (r.saves || []).map((s) => `${s.id}：${s.error ? '失败 - ' + s.error : '上传 ' + (s.uploaded || []).length + ' 个文件'}`);
          SYNC.log = '推送完成\n' + rows.join('\n');
        } catch (e) { SYNC.log = ''; SYNC.error = String((e && e.message) || e); }
        await loadSyncLists(); renderSidebar();
      });
      $$('#sb-body [data-sy-push]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.syPush;
        SYNC.log = `推送 ${id}…`; renderSidebar();
        try {
          const r = await window.DYApp.sync.push(id, false);
          SYNC.log = (r.uploaded && r.uploaded.length) ? `${id}：已上传 ${r.uploaded.join('、')}` : `${id}：内容无变化，无需上传`;
        } catch (e) {
          // 远端更新 → 询问是否强制
          if (confirm(String((e && e.message) || e) + '\n\n要改为强制推送（覆盖远端）吗？')) {
            try {
              const r2 = await window.DYApp.sync.push(id, true);
              SYNC.log = `${id}：已强制推送（${(r2.uploaded || []).join('、') || '无变化'}）`
                + (r2.remoteBackup ? `\n覆盖前的远端副本已备份到存档目录内的 ${r2.remoteBackup}/` : '');
            } catch (e2) { SYNC.log = '强制推送失败：' + ((e2 && e2.message) || e2); }
          } else { SYNC.log = '已取消。'; }
        }
        renderSidebar();
      }));
      $$('#sb-body [data-sy-pull]').forEach((b) => b.addEventListener('click', async () => {
        const id = b.dataset.syPull;
        SYNC.log = `拉取 ${id}…`; renderSidebar();
        try {
          const r = await window.DYApp.sync.pull(id, false);
          SYNC.log = `${id}：已写入 ${(r.written || []).join('、')}` + (r.backup ? `\n覆盖前的本机副本已备份到 ${r.backup}` : '');
        } catch (e) {
          if (confirm(String((e && e.message) || e) + '\n\n要改为强制拉取（覆盖本机）吗？')) {
            try { const r2 = await window.DYApp.sync.pull(id, true); SYNC.log = `${id}：已强制拉取，备份 ${r2.backup || '无'}`; }
            catch (e2) { SYNC.log = '强制拉取失败：' + ((e2 && e2.message) || e2); }
          } else { SYNC.log = '已取消。'; }
        }
        renderSidebar();
      }));
    }
    renderRail();
  }
  function renderRail() {
    $('#rail').innerHTML = `<div class="logo">道渊</div>` +
      PANELS.map((p) => `<button class="rbtn ${p.id === curPanel ? 'on' : ''}" data-tab="${p.id}"><span class="i">${p.icon}</span>${p.id}</button>`).join('') +
      `<div class="spacer"></div><button class="rbtn" id="rail-home"><span class="i">⎋</span>主菜单</button>`;
    $$('#rail [data-tab]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.tab)));
    $('#rail-home').addEventListener('click', () => showScreen('s-boot'));
  }
  function openPanel(name, { reset = false } = {}) {
    closeMoreSheet();   // 切面板时收起「更多」，否则弹层会悬在行动区上方
    const switching = name !== curPanel || reset;
    curPanel = name;
    // 平板上打开面板时，把收起的右栏自动展开——不然点了图标什么也不发生
    if (app.dataset.layout === 'tablet' && $('#sidebar') && $('#sidebar').classList.contains('mini')) {
      sideCollapsed = false;
      applyCollapse();
    }
    // 只有真的换了面板才允许清掉编辑态并强制重建；
    // 重复点同一个 tab 不该把用户正在填的内容冲掉。
    if (switching) sbDirty = false;
    renderSidebar(switching);
    if (!isTablet()) { $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); }
  }
  function closePanel() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); }
  $('#sb-close').addEventListener('click', closePanel);
  $('#scrim').addEventListener('click', closePanel);
  const sc = $('#side-collapse');
  if (sc) sc.addEventListener('click', () => toggleSide(true));

  // 点空白处收起「更多」弹层
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#more-sheet') && !e.target.closest('#more-btn')) closeMoreSheet();
  });

  /* ---------- 键盘（平板带键盘 / 桌面） ---------- */
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if ($('#judge').classList.contains('open')) {
        // 判定层：走"承认结果"而不是直接隐藏，否则叙事与存档都会缺这一回合
        if (typeof judgeAck === 'function') judgeAck();
        else $('#judge').classList.remove('open');
        return;
      }
      if ($('#sidebar').classList.contains('open')) { closePanel(); return; }
      closeMoreSheet();
      return;
    }
    // 1–4 选行动建议（判定/预览覆盖层打开时不响应，否则会"隔着遮罩"发起新回合）
    if (/^[1-4]$/.test(e.key)
      && !$('#judge').classList.contains('open')
      && !e.isComposing
      && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {
      const btn = $$('#sugg .c')[Number(e.key) - 1];
      if (btn) { e.preventDefault(); btn.click(); }
      return;
    }
    // Alt+←/→ 循环面板
    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      closeMoreSheet();
      const i = PANELS.findIndex((p) => p.id === curPanel);
      const next = PANELS[(i + (e.key === 'ArrowRight' ? 1 : PANELS.length - 1) + PANELS.length) % PANELS.length];
      if (next) { e.preventDefault(); openPanel(next.id); }
    }
  });

  /* ---------- 手势：抽屉内下滑关闭 ---------- */
  (function bindSwipeClose() {
    const head = document.querySelector('#sidebar .sb-head');
    if (!head) return;
    let y0 = null;
    head.addEventListener('touchstart', (e) => { y0 = e.touches[0].clientY; }, { passive: true });
    const resetDrag = (sb) => { sb.style.transform = ''; sb.classList.remove('dragging'); };
    head.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const sb = $('#sidebar');
      // 手机上 .mini 是恒有的（折叠态），原先的 !mini 守卫让拖拽反馈在手机上完全失效
      const draggable = app.dataset.layout === 'phone' || !sb.classList.contains('mini');
      if (!draggable) return;
      const dy = e.touches[0].clientY - y0;
      if (dy > 0) {
        sb.classList.add('dragging');   // 关掉 transition，跟随手指才不黏
        sb.style.transform = 'translateX(0) translateY(' + Math.min(dy, 120) + 'px)';
      }
    }, { passive: true });
    head.addEventListener('touchend', (e) => {
      const sb = $('#sidebar');
      const dy = y0 == null ? 0 : (e.changedTouches[0].clientY - y0);
      resetDrag(sb);
      y0 = null;
      // 手机：下滑关闭抽屉；平板：下滑收起右栏
      if (dy > 70) {
        if (app.dataset.layout === 'tablet') toggleSide(true); else closePanel();
      }
    });
    // 手势被系统打断（来电/返回手势/滚动接管）时也要复位，
    // 否则 inline transform 会残留，抽屉一直斜挂着
    head.addEventListener('touchcancel', () => {
      resetDrag($('#sidebar'));
      y0 = null;
    });
  })();

  // 编辑态跟踪：在面板里输入 → 置脏；点任意按钮 → 视为编辑结束（但不清空输入框的值）
  $('#sb-body').addEventListener('input', () => { sbDirty = true; });
  $('#sb-body').addEventListener('change', () => { sbDirty = true; });
  // 捕获阶段：必须早于按钮自身的处理器，否则处理器里同步调的 renderSidebar 仍会被挡
  $('#sb-body').addEventListener('click', (e) => {
    if (!e.target.closest('input, textarea, select')) sbDirty = false;
  }, true);

  function panelHTML(id) {
    const P = state.主角, W = state.世界;
    if (id === '主角') {
      return `
        <div class="card" style="margin-bottom:12px">
          <div class="pcard">
            <div class="portrait">${esc(P.姓名[0])}</div>
            <div class="meta">
              <div class="nm">${esc(P.姓名)} <span style="color:var(--purple);font-size:.86rem">${esc(P.境界)}</span></div>
              <div style="color:var(--dim);font-size:.8rem">${esc(P.宗门)} · ${esc(P.所在界)}</div>
              <div class="chips" style="margin-top:8px">
                <span class="chip gold">灵根 · ${esc(P.灵根)}</span>
                <span class="chip ${P.状态 === '无异常' ? 'ok' : 'bad'}">${esc(P.状态)}</span>
              </div>
            </div>
          </div>
          ${D.RES.map((r) => barHTML(r.key, P[r.key], r.color, r.key === '道心' ? D.DAO_STAGE(P.道心) : '')).join('')}
        </div>
        <div class="sect-title">容 貌 形 止</div>
        <div class="card"><div class="kv"><span class="k">容貌</span><span class="v">${esc(P.容貌)}</span></div>
          <div class="kv"><span class="k">身形</span><span class="v">${esc(P.身形)}</span></div>
          <div class="kv"><span class="k">衣着</span><span class="v">${esc(P.衣着)}</span></div>
          <div class="kv"><span class="k">神念</span><span class="v">${esc(P.神念)}</span></div>
          <div class="kv"><span class="k">宗门贡献</span><span class="v">${P.宗门贡献}</span></div></div>
        <div class="sect-title">☯ 气 运 <span class="n">${Object.keys(P.气运).length}</span></div>
        ${Object.entries(P.气运).map(([k, v]) => `<div class="card" style="margin-bottom:8px">
          <div style="display:flex;align-items:center;gap:6px">${v.真 ? '<span class="chip gold">真</span>' : ''}<b style="color:var(--gold)">${esc(k)}</b>
            <span class="chip" style="margin-left:auto">${esc(v.类型)}</span></div>
          <div style="color:var(--dim);font-size:.82rem;margin-top:6px">${esc(v.效果)}</div>
          <div style="margin-top:8px"><span class="chip ${v.使用状态 === '常驻' ? 'ok' : ''}">${esc(v.使用状态)}</span></div></div>`).join('')}
        <div class="sect-title">📖 功 法 · 器 物</div>
        <div class="card">
          ${Object.entries(P.功法).map(([k, v]) => `<div class="kv"><span class="k">《${esc(k)}》</span><span class="v">${esc(v.类型)} · 熟练 ${v.熟练度}%</span></div>`).join('')}
          ${Object.entries(P.器物).map(([k, v]) => `<div class="kv"><span class="k">${esc(k)}</span><span class="v">${esc(v.等级)} · 损耗 ${v.损耗度}% · ${esc(v.状态)}</span></div>`).join('')}
        </div>
        <div class="sect-title">⚗ 炼 丹 · 炼 器</div>
        <div class="card">
          <div class="kv"><span class="k">炼丹</span><span class="v">${esc(P.炼丹.阶级)} · 熟练 ${P.炼丹.熟练度}% · 成率 ${P.炼丹.成功率}%</span></div>
          <div class="kv"><span class="k">炼器</span><span class="v">${esc(P.炼器.阶级)} · 熟练 ${P.炼器.熟练度}% · 成率 ${P.炼器.成功率}%</span></div>
        </div>`;
    }
    if (id === '道侣') {
      const list = Object.entries(state.道侣);
      if (!list.length) return `<div class="cr-hint">你尚未结下道侣。机缘来时，天道自会安排。</div>`;
      return list.map(([k, c]) => `
        <div class="card" style="margin-bottom:12px">
          <div class="pcard">
            <div class="portrait">${esc(k[0])}</div>
            <div class="meta"><div class="nm">${esc(k)} <span style="color:var(--purple);font-size:.84rem">${esc(c.境界)}</span></div>
              <div class="heart">亲密 ${'❤'.repeat(Math.round(c.亲密 / 20))}${'♡'.repeat(5 - Math.round(c.亲密 / 20))} ${c.亲密}</div>
              <div style="color:var(--dim);font-size:.78rem;margin-top:4px">${esc(c.性别)} · ${esc(c.种族)} · ${esc(c.状态)}</div></div>
          </div>
          ${D.RES.slice(0, 5).map((r) => barHTML(r.key, c[r.key], r.color)).join('')}
          <div class="sect-title">性 情 · 背 景</div>
          <div class="kv"><span class="k">性格</span><span class="v">${esc(c.性格)}</span></div>
          <div class="kv"><span class="k">外观</span><span class="v">${esc(c.外观)} · ${esc(c.身高)}</span></div>
          <div class="kv"><span class="k">背景</span><span class="v">${esc(c.背景)}</span></div>
          <div class="kv"><span class="k">神通</span><span class="v">${esc(c.神通)}</span></div>
          <div class="whisper floaty">心声 · ${esc(c.心声)}</div>
        </div>`).join('');
    }
    if (id === '人物') {
      const STAGES = ['陌生', '试探期', '松动期', '信任期', '至诚羁绊'];
      return Object.entries(state.人物).map(([k, c]) => {
        const si = STAGES.indexOf(c.关系阶段);
        return `<div class="card" style="margin-bottom:12px">
          <div class="pcard"><div class="portrait">${esc(k[0])}</div>
            <div class="meta"><div class="nm">${esc(k)} <span style="color:var(--purple);font-size:.84rem">${esc(c.境界)}</span></div>
              <div style="color:var(--dim);font-size:.8rem">${esc(c.头衔)}</div>
              <div class="chips" style="margin-top:6px"><span class="chip ${si >= 3 ? 'ok' : ''}">关系 · ${esc(c.关系阶段)}</span></div></div></div>
          ${barHTML('好感', c.好感, '#ff7ea8')}
          <div class="stage-ladder">${STAGES.map((_, i) => `<span class="s ${i <= si ? 'on' : ''}"></span>`).join('')}</div>
          <div class="kv" style="margin-top:8px"><span class="k">性格</span><span class="v">${esc(c.性格)}</span></div>
          <div class="kv"><span class="k">描述</span><span class="v">${esc(c.描述)}</span></div>
        </div>`;
      }).join('');
    }
    if (id === '灵宠') {
      return Object.entries(state.灵宠).map(([k, c]) => `
        <div class="card" style="margin-bottom:12px">
          <div class="pcard"><div class="portrait">🦊</div>
            <div class="meta"><div class="nm">${esc(k)} <span style="color:var(--purple);font-size:.84rem">${esc(c.境界)}</span></div>
              <div style="color:var(--dim);font-size:.8rem">${esc(c.种族)} · ${esc(c.容貌外观)}</div></div></div>
          ${barHTML('亲密度', c.亲密度, '#ff7ea8')}${barHTML('生命', c.生命, '#e05555')}${barHTML('灵力', c.灵力, '#5aa9ff')}
          <div class="kv"><span class="k">性格</span><span class="v">${esc(c.性格)}</span></div>
          <div class="kv"><span class="k">神通</span><span class="v">${esc(c.神通)}</span></div>
          <div class="whisper floaty">心声 · ${esc(c.心声)}</div>
        </div>`).join('');
    }
    if (id === '机遇') {
      return Object.entries(state.机遇).map(([k, o]) => `
        <div class="opp-card"><div class="top"><span class="nm">${esc(k)}</span><span class="chip ${o.难度 === '低' ? 'ok' : o.难度 === '高' ? 'bad' : ''}">难度 · ${esc(o.难度)}</span></div>
          <div class="kv"><span class="k">目标</span><span class="v">${esc(o.目标)}</span></div>
          <div class="kv"><span class="k">机缘</span><span class="v">${esc(o.机缘)}</span></div>
          <div class="quote">${esc(o.引言)}</div></div>`).join('') +
        `<div class="cr-hint" style="text-align:center">最多保留最近 20 条机遇，完成即归档。</div>`;
    }
    if (id === '绝色榜') {
      return `<div class="cr-hint">仙子排行榜 · 遇到即解锁。红颜为虚名，仙途方为真。</div>
        <div class="grid-cards">${Object.entries(state.绝色榜).map(([k, b]) => `
          <div class="bcard ${b.解锁 ? '' : 'lock'}"><div class="rk">第 ${esc(b.排名)} 位</div>
            <div class="nm">${esc(b.解锁 ? k : '？ ？ ？')}</div>
            <div class="tt">${esc(b.头衔)}</div>
            <div class="pz">${esc(b.仙姿)}</div>
            <div class="pz" style="color:var(--faint)">群芳谱 · ${esc(b.群芳谱)}</div></div>`).join('')}</div>`;
    }
    if (id === '玉简') {
      const [nm, c] = Object.entries(state.玉简)[0];
      const recs = Object.entries(c.历史记录).map(([_, m]) => `
        <div class="line ${m.发送者 === '我' ? 'me' : ''}"><div class="t">${esc(m.时间)}</div><div class="b">${esc(m.内容)}</div></div>`).join('');
      return `<div class="cr-hint">玉简 · 修仙界的传讯之物。发信将由 AI 生成回信。</div>
        <div class="phone-shell">
          <div class="top"><span style="font-size:1.1rem">📱</span><b style="color:var(--gold)">${esc(nm)}</b>
            <span class="chip purple" style="margin-left:auto">${esc(c.关系)} · 好感 ${c.好感度}</span></div>
          <div class="chat" id="chat-log">${recs}</div>
          <div class="chat-input"><input id="chat-input-field" placeholder="传讯……"><button class="send" id="chat-send" style="min-width:52px;min-height:40px;border-radius:999px;border:1px solid rgba(212,175,55,.5);background:var(--gold-soft);color:var(--gold)">送</button></div>
        </div>`;
    }
    if (id === '背包') {
      const ICON = { 下品灵石: '💠', 聚气丹: '⚪', 疗伤散: '🧪', 干粮: '🥖' };
      return `<div class="cr-hint">储物袋 · 数量归零自动清理。</div>
        <div class="bag">${Object.entries(P.储物袋).map(([k, v]) => `
          <div class="item"><div class="ic">${ICON[k] || '📦'}</div><div class="nm">${esc(k)}</div><div class="ct">×${v.数量}</div>
            <div class="ct" style="color:var(--faint);font-size:.66rem;margin-top:2px">${esc(v.描述)}</div></div>`).join('')}</div>
        <div class="sect-title">器 物</div>
        <div class="bag">${Object.entries(P.器物).map(([k, v]) => `
          <div class="item"><div class="ic">🗡</div><div class="nm">${esc(k)}</div><div class="ct">${esc(v.等级)}</div>
            <div class="ct" style="color:${v.损耗度 > 60 ? 'var(--bad)' : 'var(--dim)'}">损耗 ${v.损耗度}%</div></div>`).join('')}</div>`;
    }
    if (id === '地图') {
      const regs = [
        { n: '中央神州', s: '宗门林立，灵气最盛', on: false }, { n: '南离火洲', s: '火山连绵，体修乐土', on: false },
        { n: '北冥雪原', s: '广寒宫所在，万年玄冰', on: false }, { n: '东极青木域', s: '九尾天狐族封地', on: false },
        { n: '青石镇', s: '当前所在 · 边陲小镇', on: true }, { n: '蓬莱仙岛', s: '未探索', lock: true },
        { n: '庚金剑冢', s: '未探索', lock: true },
      ];
      return `<div class="cr-hint">玄天界 · 已探索区域点亮，可前往。</div>
        <div class="mapreg">${regs.map((r) => `<div class="r ${r.on ? 'on' : ''} ${r.lock ? 'lock' : ''}">
          <span style="font-size:1.1rem">${r.lock ? '🔒' : r.on ? '📍' : '🗺'}</span>
          <div class="nm">${esc(r.n)}<div class="sub">${esc(r.s)}</div></div>
          ${r.on ? '<span class="chip gold">所在</span>' : r.lock ? '' : '<span class="chip">可前往</span>'}</div>`).join('')}</div>`;
    }
    if (id === '图鉴') {
      const total = WORLDBOOK ? WORLDBOOK.entries.length : D.WORLD.length;
      return `<div class="cr-hint">内置百科 · 源自 ${total} 条世界书${WORLDBOOK ? '' : '（当前为内置样例，世界书未加载）'}。与叙事检索同一套分词，命中口径一致。</div>
        <div class="field"><input id="wiki-search" placeholder="搜索术语 / 人物 / 势力 / 地点……"></div>
        <div id="wiki-list">${wikiList('')}</div>`;
    }
    if (id === '存档') {
      const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '—');
      const backendNote = store.persistent
        ? '存档写在应用私有目录，可被「同步」面板推送到 GitHub 实现多端互通。'
        : '当前是浏览器预览：存档只在本机 localStorage，换浏览器或清缓存就没了。装进客户端后才会落到应用私有目录。';
      return `
        <div class="cr-hint">${backendNote}</div>
        <div class="card" style="margin-bottom:12px">
          <div class="kv"><span class="k">当前档</span><span class="v">${esc(currentSaveId)}</span></div>
          <div class="kv"><span class="k">后端</span><span class="v">${esc(store.backend)}${store.persistent ? ' · 持久' : ' · 临时'}</span></div>
          <div class="kv"><span class="k">进度</span><span class="v">第 ${state.世界.天数} 日 · ${esc(state.世界.当前地点)} · ${turns.length} 条记录</span></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn primary" id="sv-save">保 存</button>
          <button class="btn" id="sv-export">导出</button>
          <button class="btn" id="sv-import">导入</button>
        </div>
        <input type="file" id="sv-file" accept="application/json,.json" style="display:none">
        <div class="sect-title">存 档 列 表 <span class="n">${SAVE.list.length}</span></div>
        ${SAVE.list.length ? SAVE.list.map((m) => `<div class="set-row">
            <div class="lbl">${esc(m.name || m.id)}<div class="d">${esc(m.summary || '')} · ${fmt(m.updatedAt)}</div></div>
            <button class="btn" data-sv-load="${esc(m.id)}" style="flex:none;min-width:58px;padding:8px 10px">读取</button>
            <button class="btn" data-sv-del="${esc(m.id)}" style="flex:none;min-width:58px;padding:8px 10px">删除</button>
          </div>`).join('') : '<div class="cr-hint">本机暂无存档。点「保存」创建第一个。</div>'}
        ${SAVE.log ? `<div class="upd-notes" style="margin-top:12px">${esc(SAVE.log)}</div>` : ''}`;
    }

    if (id === '模型') {
      const s = LLM.settings || {
        provider: { id: 'openai', baseUrl: 'https://api.openai.com/v1', endpointPath: '/chat/completions' },
        narrator: { model: '', temperature: 0.85, topP: 0.95, maxTokens: null },
        arbiter: null,
      };
      const p = s.provider, n = s.narrator || {};
      const sec = LLM.secrets || {};
      const presets = { openai: 'OpenAI', opencodego: 'opencodego', ollama: 'Ollama（本地）', custom: '自定义 OpenAI 兼容' };
      return `${LLM.shell ? '' : shellNote()}
        <div class="cr-hint">API Key <b>只保存在本机</b>（安卓为应用私有目录），不进存档、不进同步、不上传任何服务器。请求由客户端本机直发。</div>
        <div class="field"><label>接口预设</label>
          <div class="opts">${Object.keys(presets).map((k) =>
        `<button class="opt ${p.id === k ? 'on' : ''}" data-prov="${k}" data-base="${esc((D.PROVIDER_PRESETS[k] || {}).baseUrl || '')}" data-headers="${esc(JSON.stringify((D.PROVIDER_PRESETS[k] || {}).autoHeaders || {}))}">${presets[k]}</button>`).join('')}</div>
        </div>
        <div class="field"><label>接口地址 base URL</label><input id="cfg-base" value="${esc(p.baseUrl || '')}" placeholder="https://api.openai.com/v1"></div>
        <div class="field"><label>对话路径</label><input id="cfg-path" value="${esc(p.endpointPath || '/chat/completions')}"></div>
        <div class="field"><label>API Key${sec.llmKeySet ? ' · 已保存 ' + esc(sec.llmKeyHint) : ''}</label>
          <input id="cfg-key" type="password" autocomplete="off" placeholder="${sec.llmKeySet ? '留空则不改动' : 'sk-…'}"></div>
        <div class="field"><label>附加请求头（每行一条「名: 值」，可留空）</label>
          <textarea id="cfg-headers" rows="3" placeholder="x-opencode-session: &lt;你的会话 ID&gt;">${esc(headersToText(p.defaultHeaders))}</textarea>
          <div class="cr-hint" style="margin-top:4px">部分渠道强制要求额外头（如 opencodego 的 x-opencode-session）。会话 ID 随机生成、只在本机使用。</div></div>
        <div class="field"><label>叙事模型（主）</label><input id="cfg-model" value="${esc(n.model || '')}" placeholder="gpt-4o"></div>
        <div class="opts">
          <div class="field" style="margin:0"><label>温度</label><input id="cfg-temp" value="${n.temperature != null ? n.temperature : 0.85}"></div>
          <div class="field" style="margin:0"><label>top_p</label><input id="cfg-topp" value="${n.topP != null ? n.topP : 0.95}"></div>
          <div class="field" style="margin:0"><label>max_tokens（可空）</label><input id="cfg-max" value="${n.maxTokens == null ? '' : n.maxTokens}"></div>
        </div>
        <div class="field"><label>裁决模型（辅，可空）</label><input id="cfg-arbiter" value="${esc((s.arbiter && s.arbiter.model) || '')}" placeholder="gpt-4o-mini"></div>
        ${chatModeSectionHTML()}
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn primary" id="cfg-save">保 存</button>
          <button class="btn" id="cfg-test">测试 · 拉取模型</button>
        </div>
        <div style="margin-top:8px"><button class="btn" id="cfg-clearkey" style="width:100%">清 除 Key</button></div>
        ${(LLM.secrets && LLM.secrets.decryptError) ? `<div class="card" style="margin-top:10px;border-color:rgba(255,122,107,.5)">
          <b style="color:var(--bad)">密钥文件无法解密</b>
          <div style="color:var(--dim);font-size:.8rem;margin-top:6px">${esc(LLM.secrets.decryptError)}</div>
          <div class="cr-hint" style="margin-top:6px">常见原因：文件被改动过、或从另一台设备直接拷了 secrets.enc 过来。重新填写 API Key 会覆盖它（旧内容届时不可恢复）。</div>
        </div>` : ''}
        <div id="cfg-log" class="cr-hint" style="margin-top:12px">${LLM.error ? '壳通信失败：' + esc(LLM.error)
          : LLM.ready ? '<span style="color:var(--ok)">状态：已就绪 —— 行动将走大模型生成。</span>'
            : '状态：未配置完整 —— 行动暂用离线示例文本。'}</div>
        <div id="cfg-models"></div>`;
    }

    if (id === '同步') {
      const c = SYNC.config || { repo: '', branch: 'main', basePath: 'saves', autoPush: false };
      const sec = SYNC.secrets || {};
      const fmt = (t) => (t ? new Date(t).toLocaleString('zh-CN') : '—');
      return `${SYNC.shell ? '' : shellNote()}
        <div class="cr-hint">用你自己的 GitHub 仓库当同步盘，多端进度互通。<b>令牌只存本机</b>；<b>建议用私有仓库</b>，令牌权限只需该仓库的 Contents 读写。</div>
        <div class="field"><label>仓库（owner/repo）</label><input id="sy-repo" value="${esc(c.repo || '')}" placeholder="your-name/dyapp-saves"></div>
        <div class="opts">
          <div class="field" style="margin:0"><label>分支</label><input id="sy-branch" value="${esc(c.branch || 'main')}"></div>
          <div class="field" style="margin:0"><label>目录</label><input id="sy-path" value="${esc(c.basePath || 'saves')}"></div>
        </div>
        <div class="field"><label>GitHub 令牌${sec.syncTokenSet ? ' · 已保存 ' + esc(sec.syncTokenHint) : ''}</label>
          <input id="sy-token" type="password" autocomplete="off" placeholder="${sec.syncTokenSet ? '留空则不改动' : 'ghp_… 或 github_pat_…'}"></div>
        <div class="set-row"><div class="lbl">推送后自动同步<div class="d">每次存档后自动推送（默认关闭）</div></div><div class="switch ${c.autoPush ? 'on' : ''}" id="sy-auto"></div></div>
        <div style="display:flex;gap:8px;margin-top:12px">
          <button class="btn primary" id="sy-save">保 存</button>
          <button class="btn" id="sy-clear">清除令牌</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:8px">
          <button class="btn" id="sy-refresh">刷新存档列表</button>
          <button class="btn" id="sy-pushall">全部推送</button>
        </div>
        <div class="sect-title">本 机 存 档 <span class="n">${SYNC.local.length}</span></div>
        ${SYNC.local.length ? SYNC.local.map((s) => `<div class="set-row">
            <div class="lbl">${esc(s.id)}<div class="d">更新于 ${fmt(s.updatedAt)}</div></div>
            <button class="btn" data-sy-push="${esc(s.id)}" style="flex:none;min-width:70px;padding:8px 10px">推送</button>
            <button class="btn" data-sy-pull="${esc(s.id)}" style="flex:none;min-width:70px;padding:8px 10px">拉取</button>
          </div>`).join('') : '<div class="cr-hint">本机暂无存档。</div>'}
        <div class="sect-title">远 端 存 档 <span class="n">${SYNC.remote.length}</span></div>
        ${SYNC.remote.length ? SYNC.remote.map((r) => `<div class="set-row"><div class="lbl">${esc(r.name)}<div class="d">${r.isDir ? '存档目录' : Math.round((r.size || 0) / 1024) + ' KB'}</div></div></div>`).join('') : '<div class="cr-hint">远端暂无内容（点「刷新存档列表」查询）。</div>'}
        ${SYNC.log ? `<div class="upd-notes" style="margin-top:12px">${esc(SYNC.log)}</div>` : ''}
        ${SYNC.error ? `<div class="cr-hint" style="color:var(--bad)">${esc(SYNC.error)}</div>` : ''}`;
    }

    if (id === '设置') {
      const rows = [
        ['暗色 · 鎏金主题', '沿用卡片状态栏配色', true], ['神视模式', '显示精确数值而非模糊语', false],
        ['流式输出', 'SSE 逐字返回叙事', true],
        ['前缀缓存优化', '稳定 L0/L1 降低成本', true], ['每日提醒', '游戏内时间推进提醒', false],
      ];
      return `<div class="set-row"><div class="lbl">内容尺度 · 与原作角色卡完全一致<div class="d">默认开启，不提供内容开关、不做内容删改</div></div><span class="chip ok">已启用</span></div>
        <div class="card" style="margin:12px 0">
          <div class="kv"><span class="k">叙事模型</span><span class="v">gpt-4o · 强档（用户自带 Key）</span></div>
          <div class="kv"><span class="k">裁决模型</span><span class="v">gpt-4o-mini · 快档（效果抽取）</span></div>
          <div class="kv"><span class="k">存档</span><span class="v">${esc(currentSaveId)} · 第 ${state.世界.天数} 日 · ${turns.length} 条记录 · ${esc(store.backend)}${store.persistent ? '' : '（临时）'}</span></div>
        </div>
        <div class="set-row"><div class="lbl">正文字号<div class="d">只影响正文与列表，不影响版式</div></div>
          <div style="display:flex;gap:6px">
            ${['s', 'm', 'l'].map((f) => `<button class="tab ${currentFont === f ? 'on' : ''}" data-font="${f}">${({ s: '小', m: '中', l: '大' })[f]}</button>`).join('')}
          </div></div>
        ${rows.map(([t, d, on]) => `<div class="set-row"><div class="lbl">${esc(t)}<div class="d">${esc(d)}</div></div><div class="switch ${on ? 'on' : ''}" data-set="${esc(t)}"></div></div>`).join('')}
        ${updateSectionHTML()}
        <div class="sect-title">安 卓 适 配</div>
        <div class="card"><div class="kv"><span class="k">当前版式</span><span class="v">${isTablet() ? '平板（左导航 + 中叙事 + 右状态）' : '手机（单栏 + 抽屉）'}</span></div>
          <div class="kv"><span class="k">方向</span><span class="v">${app.dataset.orient === 'portrait' ? '竖屏' : '横屏'}</span></div>
          <div class="kv"><span class="k">安全区</span><span class="v">已启用 safe-area-inset 适配</span></div>
          <div class="kv"><span class="k">触控目标</span><span class="v">最小 44dp</span></div></div>`;
    }
    return '';
  }
  /** 图鉴数据源：优先真实世界书（319 条），否则退回内置样例。 */
  function wikiEntries() {
    if (WORLDBOOK && Array.isArray(WORLDBOOK.entries) && WORLDBOOK.entries.length) {
      return WORLDBOOK.entries.map((e) => ({
        title: e.title, name: e.name, category: e.category, realm: e.realm,
        keys: e.keys || [], content: e.content, constant: e.constant,
      }));
    }
    return D.WORLD.map((w) => ({
      title: w.t, name: w.t, category: w.c, realm: '', keys: w.k || [], content: w.s, constant: false,
    }));
  }

  /** 图鉴搜索：与检索层同样的分词口径，命中判断一致，便于对照排查。 */
  function wikiSearch(entries, q) {
    const query = String(q || '').trim();
    if (!query) {
      // 默认先给可检索条目，常驻规则压在后面
      return [...entries].sort((a, b) => Number(a.constant) - Number(b.constant)).slice(0, 40);
    }
    const qt = new Set(tokenize(query));
    const scored = [];
    for (const e of entries) {
      let s = 0;
      if (e.title.includes(query)) s += 100;
      if ((e.name || '').includes(query)) s += 80;
      if ((e.keys || []).some((k) => k.includes(query))) s += 60;
      if ((e.content || '').includes(query)) s += 20;
      if (!s) {
        const et = new Set(tokenize(`${e.title} ${e.name}`));
        let hit = 0;
        for (const t of qt) if (et.has(t)) hit++;
        s = hit * 4;
      }
      if (s > 0) scored.push({ e, s });
    }
    scored.sort((a, b) => b.s - a.s);
    return scored.slice(0, 40).map((x) => x.e);
  }

  function wikiList(q) {
    const entries = wikiEntries();
    const list = wikiSearch(entries, q);
    if (!list.length) return `<div class="cr-hint">未找到「${esc(q)}」相关条目。</div>`;
    return list.map((w) => `<div class="wiki-item">
        <div class="h"><span class="t">${esc(w.title)}</span>
          <span class="chip purple">${esc(w.category)}</span>
          ${w.constant ? '<span class="chip gold">常驻</span>' : ''}
          ${w.realm ? `<span class="chip">${esc(w.realm)}</span>` : ''}</div>
        <div class="s">${esc(w.content.slice(0, 160))}${w.content.length > 160 ? '…' : ''}</div>
        ${w.content.length > 160 ? `<details style="margin-top:8px"><summary style="cursor:pointer;color:var(--gold);font-size:.8rem">展开全文（${w.content.length} 字）</summary>
          <div class="s" style="white-space:pre-wrap">${esc(w.content)}</div></details>` : ''}
        ${w.keys.length ? `<div style="margin-top:8px">${w.keys.slice(0, 8).map((k) => `<span class="chip" style="margin:2px 4px 0 0">#${esc(k)}</span>`).join('')}</div>` : ''}
      </div>`).join('');
  }
  function sendChat(text) {
    const v = (text || '').trim(); if (!v) return;
    const [nm, c] = Object.entries(state.玉简)[0];
    const id = Object.keys(c.历史记录).length + 1;
    c.历史记录[id] = { 发送者: '我', 时间: '此刻', 内容: v };
    const reply = pick([
      '「你倒是敢问。」——她顿了顿，「后山的事，别一个人去。」',
      '「灵石先记账上。」语气听着不耐烦，回信却来得很快。',
      '「……嗯。你自己小心。」',
    ]);
    c.历史记录[id + 1] = { 发送者: nm, 时间: '片刻后', 内容: reply };
    renderSidebar();
    const log = $('#chat-log'); if (log) log.scrollTop = log.scrollHeight;
  }

  /* ================= 启动 ================= */
  renderStream(); renderHUD(); renderActions(); renderSidebar();
  showScreen('s-boot');
  renderUpdateChip();

  // 世界书（319 条）异步加载：就绪后重建索引，并刷新图鉴面板
  loadWorldbook().then((wb) => {
    if (wb) {
      console.info(`[worldbook] 已载入 ${wb.count} 条，可检索 ${WORLD_INDEX.stats.searchable} 条 / 常驻 ${WORLD_INDEX.stats.constant} 条`);
      if (curPanel === '图鉴') renderSidebar();
    }
  });

  // 存档列表
  refreshSaves().then(() => { if (curPanel === '存档') renderSidebar(); });

  // 预设列表（本机配置，不参与同步）
  refreshPresets().then(() => { if (curPanel === '模型') renderSidebar(); });

  applyCollapse();

  // 启动自检：跑到这里说明模块求值没有抛错
  if (typeof window.__dyMarkBootOk === 'function') window.__dyMarkBootOk();

  // 壳能力探测：在 Tauri 里读本地模型配置与同步配置；浏览器里保持降级
  refreshLlm();
  refreshSync().then(() => loadSyncLists());

  // 启动时静默检查更新（可在设置里关闭；失败静默降级，不打扰玩家）
  if (window.DYUpdate.autoEnabled()) {
    window.DYUpdate.check().then(() => {
      renderUpdateChip();
      if (curPanel === '设置') renderSidebar();
    });
  }
})();
