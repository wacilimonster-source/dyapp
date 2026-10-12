/* 《道渊》独立版 · 安卓原型 — 应用逻辑
 * 版式判定：真机按屏幕宽度（>=700px 判为平板）；桌面可用右下角开关切换预览。
 */
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

  const state = deep(D.state);
  const turns = deep(D.turns);
  const app = $('#app');

  const PANELS = [
    { id: '主角', icon: '☯' }, { id: '道侣', icon: '💞' }, { id: '人物', icon: '👤' },
    { id: '灵宠', icon: '🐾' }, { id: '机遇', icon: '📜' }, { id: '绝色榜', icon: '🏮' },
    { id: '玉简', icon: '📱' }, { id: '背包', icon: '🎒' }, { id: '地图', icon: '🗺' },
    { id: '图鉴', icon: '📖' }, { id: '设置', icon: '⚙' },
  ];
  let curPanel = '主角';
  let forced = null;       // null | 'phone' | 'tablet'
  const isTablet = () => app.dataset.layout === 'tablet';

  /* ================= 版式 ================= */
  function applyLayout() {
    let layout;
    if (forced) layout = forced;
    else layout = window.innerWidth >= 700 ? 'tablet' : 'phone';
    app.dataset.layout = layout;
    app.dataset.device = layout;
    app.dataset.orient = window.innerHeight >= window.innerWidth ? 'portrait' : 'landscape';
    app.classList.toggle('preview', window.innerWidth >= 1100 && !forced ? true : window.innerWidth >= 1100);
  }
  window.addEventListener('resize', () => { applyLayout(); });
  window.addEventListener('orientationchange', () => setTimeout(applyLayout, 120));
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
  function applyCreate() {
    const g = createState;
    state.主角.姓名 = g.姓名 || '陆沉';
    state.主角.性别 = g.性别;
    state.主角.所在界 = g.出生界;
    state.主角.宗门 = g.出身 === '寒门散修' ? '散修' : g.出身 === '青云宗外门' || g.出身 === '宗门外门' ? '青云宗 · 外门' : '没落世家';
    if (g.灵根) { state.主角.灵根 = g.灵根.品 + ' · 单灵根'; state.主角.道心 = clamp(state.主角.道心 + (g.灵根.品 === '天品' ? 10 : 0), 0, 100); }
    g.气运.forEach((n) => { state.主角.气运[n] = { 类型: n.startsWith('真·') ? '主动' : '被动', 效果: '（创角所选气运）', 使用状态: '常驻', 压制状态: '正常', 真: n.startsWith('真·') }; });
    if (g.道侣) { state.道侣 = {}; state.道侣[g.道侣] = { 性别: '女', 种族: '人族', 状态: '正常', 境界: '筑基后期', 亲密: 20, 生命: 90, 灵力: 80, 修为: 60, 道心: 68, 性格: '尚未看清。', 外观: '——', 身高: '——', 背景: '命中注定要遇见的人。', 神通: '——', 心声: '（终于……见到你了。）' }; }
    // 重置叙事流为开局
    turns.length = 0;
    turns.push({
      role: 'assistant',
      text: `${state.主角.姓名}，${state.主角.所在界}的风，比你想的更冷一些。\n\n你睁开眼时，身下是青云宗后山的青石，衣袍还带着洗不净的皂角味。远处钟声三响，是外门晨课的时辰。\n\n你的道途，从这一刻开始。`,
      scene: { 当前时间: '初春 · 清晨', 当前地点: '青云宗 · 后山', 危机程度: '无' },
      choices: ['起身去上晨课', '先查看自己的储物袋', '往后山深处走走'],
    });
    state.世界.当前时间 = '初春 · 清晨';
    state.世界.当前地点 = '青云宗 · 后山';
    state.世界.危机程度 = '无';
    showScreen('s-game'); renderStream(); renderHUD(); renderSidebar();
  }
  $('#cr-back').addEventListener('click', () => {
    if (createState.step === 0) showScreen('s-boot'); else { createState.step--; renderCreate(); }
  });
  $('#cr-skip').addEventListener('click', () => { applyCreate(); });

  /* ================= HUD ================= */
  function barHTML(key, val, color, note) {
    const v = clamp(Number(val) || 0, 0, 100);
    return `<div class="bar" data-res="${key}"><div class="t"><span>${key}${note ? '<i> ' + note + '</i>' : ''}</span><b>${v}</b></div>
      <div class="track"><div class="fill" style="width:${v}%;background:${color}"></div></div></div>`;
  }
  function renderHUD() {
    const W = state.世界, P = state.主角;
    const lv = D.CRISIS[W.危机程度] || 0;
    $('#hud').innerHTML = `
      <div class="hud-row1">
        <span class="name">${esc(P.姓名)}</span>
        <span class="realm">${esc(P.境界)}（DC:${P.境界DC}）</span>
        <span class="spacer"></span>
        <button class="iconbtn" id="hud-menu" title="面板">☰</button>
      </div>
      <div class="hud-row2">
        <span>🕛 ${esc(W.当前时间)}</span><span>📍 ${esc(W.当前地点)}</span><span>🌧 ${esc(W.天气)}</span>
        <span class="crisis lv${lv}">危机 · ${esc(W.危机程度)}</span>
        <span>遭遇冷却 ${W.遭遇冷却}</span>
      </div>
      <div class="hud-bars">
        ${D.RES.map((r) => barHTML(r.key, P[r.key], r.color, r.key === '修为' && P.修为 >= 100 ? '瓶颈' : r.key === '道心' ? D.DAO_STAGE(P.道心) : '')).join('')}
      </div>`;
    $('#hud-menu').addEventListener('click', () => openPanel(curPanel));
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
    const ch = (t.choices || []).length ? `<div class="choices">${t.choices.map((c) => `<button class="choice" data-choice="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : '';
    return `<div class="msg assistant"><div class="who">道渊</div><div class="bubble">${esc(t.text)}</div>
      ${fx ? `<div class="fx">${fx}</div>` : ''}${ch}</div>`;
  }
  function renderStream() {
    const first = turns.find((t) => t.scene);
    $('#stream').innerHTML = (first ? sceneBanner(first.scene) : '') + turns.map(msgHTML).join('');
  }
  function scrollStream() { const s = $('#stream'); s.scrollTop = s.scrollHeight; }
  function appendTurn(t) {
    $('#stream').insertAdjacentHTML('beforeend', msgHTML(t));
    scrollStream();
  }
  function typeAssistant(t) {
    const wrap = document.createElement('div');
    wrap.className = 'msg assistant';
    const fx = (t.effects || []).filter((e) => e.op === 'delta' && /\.(生命|精血|灵力|修为|神识|道心|好感|亲密)$/.test(e.target))
      .map((e) => `<span class="fx-chip ${e.value >= 0 ? 'up' : 'down'}">${e.target.split('.').pop()} ${e.value >= 0 ? '+' : ''}${e.value}</span>`).join('');
    const ch = (t.choices || []).length ? `<div class="choices">${t.choices.map((c) => `<button class="choice" data-choice="${esc(c)}">${esc(c)}</button>`).join('')}</div>` : '';
    wrap.innerHTML = `<div class="who">道渊</div><div class="bubble typing"></div>${fx ? `<div class="fx">${fx}</div>` : ''}${ch}`;
    $('#stream').appendChild(wrap);
    const bubble = $('.bubble', wrap);
    const text = t.text, chunk = Math.max(1, Math.ceil(text.length / 42));
    let i = 0;
    const timer = setInterval(() => {
      i += chunk; bubble.textContent = text.slice(0, i); scrollStream();
      if (i >= text.length) { clearInterval(timer); bubble.textContent = text; bubble.classList.remove('typing'); scrollStream(); }
    }, 16);
  }

  /* ================= 行动区 ================= */
  const ACTS = [
    { k: '探索', i: '🧭', hot: true }, { k: '修炼', i: '🧘', hot: true }, { k: '突破', i: '⚡', hot: true },
    { k: '交流', i: '💬' }, { k: '玉简', i: '📱', panel: '玉简' }, { k: '地图', i: '🗺', panel: '地图' },
    { k: '背包', i: '🎒', panel: '背包' }, { k: '面板', i: '☰' },
  ];
  function renderActions() {
    $('#actions').innerHTML = `
      <div class="wheel">${ACTS.map((a) => `<button class="act ${a.hot ? 'hot' : ''}" data-act="${a.k}" ${a.panel ? `data-panel="${a.panel}"` : ''}><span class="i">${a.i}</span>${a.k}</button>`).join('')}</div>
      <div class="input-row"><input id="free-input" placeholder="写下你的行动……"><button class="send" id="send">发送</button></div>`;
    $('#send').addEventListener('click', sendFree);
    $('#free-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendFree(); });
  }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-act]');
    if (a) { doAction(a.dataset.act, a.dataset.panel); return; }
    const c = e.target.closest('[data-choice]');
    if (c) { freeText(c.dataset.choice); }
  });
  function doAction(kind, panel) {
    if (panel) { openPanel(panel); return; }
    if (kind === '突破') { judge(); return; }
    if (kind === '面板') { openPanel(curPanel); return; }
    if (kind === '探索') return freeText('四处探索，看看这附近有什么。');
    if (kind === '修炼') return cultivate();
    if (kind === '交流') return freeText('去找镇上的修士聊聊天。');
  }
  function advanceTime(days) {
    const t = ['清晨', '上午', '午后', '黄昏', '入夜'];
    const cur = state.世界.当前时间.split(' · ')[1] || '黄昏';
    let i = t.indexOf(cur); i = (i + 1) % t.length;
    state.世界.当前时间 = state.世界.当前时间.split(' · ')[0] + ' · ' + t[i];
  }
  function tickCooldown() {
    state.世界.遭遇冷却 = clamp(state.世界.遭遇冷却 - 1, 0, 15);
    if (state.世界.遭遇冷却 === 0) { state.世界.遭遇冷却 = 6; return true; }
    return false;
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

  function freeText(text) {
    turns.push({ role: 'user', text });
    appendTurn(turns[turns.length - 1]);
    const enc = tickCooldown();
    const r = enc ? ENCOUNTER : pick(REPLIES);
    setTimeout(() => {
      const t = { role: 'assistant', text: r.text, effects: r.fx, choices: r.choices, scene: { 当前时间: state.世界.当前时间, 当前地点: state.世界.当前地点, 危机程度: state.世界.危机程度 } };
      advanceTime(0);
      applyEffects(r.fx || []);
      turns.push(t); typeAssistant(t); renderHUD();
    }, 380);
  }
  function cultivate() {
    const P = state.主角;
    const gain = 16; // 黄品·炼气期
    turns.push({ role: 'user', text: '寻一处僻静，闭关修炼。' });
    appendTurn(turns[turns.length - 1]);
    state.世界.当前时间 = '七日后 · 午后';
    tickCooldown();
    const t = {
      role: 'assistant',
      text: `你在后山寻了处背风的洞穴，盘膝坐下。\n\n灵气如溪，一丝丝渗入经脉。七日里你只醒来两次，吃了半块干粮。丹田中那点火气，总算比先前凝实了些许。\n\n出关时，衣上结了薄薄的霜。`,
      effects: [{ op: 'delta', target: '主角.修为', value: gain, reason: '闭关修炼' }, { op: 'delta', target: '主角.灵力', value: 18, reason: '打坐回复' }, { op: 'delta', target: '主角.生命', value: -3, reason: '久坐少食' }],
      choices: ['继续闭关', '出山透透气', '检视修为进度'],
    };
    applyEffects(t.effects);
    turns.push(t); setTimeout(() => { typeAssistant(t); renderHUD(); }, 300);
  }
  function sendFree() {
    const el = $('#free-input'); const v = el.value.trim(); if (!v) return; el.value = '';
    freeText(v);
  }

  /* ================= 效果落地 ================= */
  function resolve(path) {
    const parts = path.split('.'); let o = state;
    for (let i = 0; i < parts.length - 1; i++) { if (o[parts[i]] == null) o[parts[i]] = {}; o = o[parts[i]]; }
    return { obj: o, key: parts[parts.length - 1] };
  }
  function applyEffects(effects) {
    (effects || []).forEach((e) => {
      const { obj, key } = resolve(e.target);
      if (e.op === 'delta') {
        const cur = Number(obj[key]) || 0;
        const max = key === '遭遇冷却' ? 15 : 100;
        obj[key] = clamp(cur + e.value, key === '遭遇冷却' ? 0 : 0, max);
        if (D.RES.some((r) => r.key === key)) float(key, e.value, D.RES.find((r) => r.key === key).color);
      } else if (e.op === 'set') obj[key] = e.value;
      else if (e.op === 'add' || e.op === 'remove') { /* 原型从简 */ }
    });
  }
  function float(key, v, color) {
    const bar = $(`[data-res="${key}"]`);
    if (!bar) return;
    const r = bar.getBoundingClientRect();
    const d = document.createElement('div');
    d.className = 'float'; d.style.color = color;
    d.textContent = (v >= 0 ? '+' : '') + v;
    d.style.left = (r.left + r.width * 0.5 - 10) + 'px';
    d.style.top = (r.top - 6) + 'px';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 1400);
  }

  /* ================= 判定演出 ================= */
  function judge() {
    const P = state.主角;
    const enemy = { nm: '后山 · 未知尸傀', dc: P.境界DC + 6 };
    const diff = enemy.dc - P.境界DC;
    const tier = D.DC_TIERS.find((t) => diff <= t.max);
    // 引擎掷骰：按 DC 差给压制系数
    const bonus = clamp(50 - diff * 3 + (P.道心 - 50) * 0.3 + P.灵力 * 0.2, 5, 92);
    const win = rnd(100) < bonus;
    const box = $('#judge-box');
    box.innerHTML = `
      <h3>道 争 · 判 定</h3>
      <div class="duel">
        <div class="side"><div class="nm">${esc(P.姓名)}</div><div class="dc">${P.境界DC}</div><div class="nm" style="color:var(--dim)">${esc(P.境界)}</div></div>
        <div class="vs">对 拼</div>
        <div class="side"><div class="nm">${esc(enemy.nm)}</div><div class="dc" style="color:var(--bad)">${enemy.dc}</div><div class="nm" style="color:var(--dim)">境界差 ${diff > 0 ? '+' + diff : diff}</div></div>
      </div>
      <div class="verdict ${win ? 'win' : 'lose'}">${win ? '胜' : '败'}</div>
      <div class="tier">${esc(tier.desc)}</div>
      <div class="desc">引擎掷骰：胜率 ${bonus.toFixed(0)}%（道心 ${P.道心} · 灵力 ${P.灵力} · 境界差 ${diff}）<br>—— 判定由本地引擎给出，模型只负责把这一战演得合理。</div>
      <button class="btn primary" id="judge-ok">承 认 结 果</button>`;
    $('#judge').classList.add('open');
    $('#judge-ok').addEventListener('click', () => {
      $('#judge').classList.remove('open');
      const t = win
        ? { role: 'assistant', text: '剑光起时，那具尸傀的关节发出令人牙酸的错位声。你抓住那一线破绽，青纹剑贯入它的眉心。\n\n它僵立片刻，颓然倒地。', effects: [{ op: 'delta', target: '主角.修为', value: 6, reason: '斗法所得' }, { op: 'delta', target: '主角.生命', value: -8, reason: '被尸气擦伤' }], choices: ['搜检尸身', '立刻离开', '查看伤势'] }
        : { role: 'assistant', text: '你终究慢了半步。尸气如针，刺入左肩，半边身子瞬间麻了。\n\n你咬破舌尖，借一丝血气催动灵力，狼狈地退出了它的攻击范围。', effects: [{ op: 'delta', target: '主角.生命', value: -18, reason: '尸气入体' }, { op: 'delta', target: '主角.灵力', value: -12, reason: '强行催动' }], choices: ['服下疗伤散', '遁走', '拼死再战'] };
      applyEffects(t.effects); turns.push(t); typeAssistant(t); renderHUD();
    });
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

  /* ================= 侧栏面板 ================= */
  function renderSidebar() {
    $('#sb-title').textContent = curPanel;
    $('#sb-tabs').innerHTML = PANELS.map((p) => `<button class="tab ${p.id === curPanel ? 'on' : ''}" data-tab="${p.id}">${p.icon} ${p.id}</button>`).join('');
    $('#sb-body').innerHTML = panelHTML(curPanel);
    $$('#sb-tabs [data-tab]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.tab)));
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
    renderRail();
  }
  function renderRail() {
    $('#rail').innerHTML = `<div class="logo">道渊</div>` +
      PANELS.map((p) => `<button class="rbtn ${p.id === curPanel ? 'on' : ''}" data-tab="${p.id}"><span class="i">${p.icon}</span>${p.id}</button>`).join('') +
      `<div class="spacer"></div><button class="rbtn" id="rail-home"><span class="i">⎋</span>主菜单</button>`;
    $$('#rail [data-tab]').forEach((b) => b.addEventListener('click', () => openPanel(b.dataset.tab)));
    $('#rail-home').addEventListener('click', () => showScreen('s-boot'));
  }
  function openPanel(name) {
    curPanel = name; renderSidebar();
    if (!isTablet()) { $('#sidebar').classList.add('open'); $('#scrim').classList.add('open'); }
  }
  function closePanel() { $('#sidebar').classList.remove('open'); $('#scrim').classList.remove('open'); }
  $('#sb-close').addEventListener('click', closePanel);
  $('#scrim').addEventListener('click', closePanel);

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
      return `<div class="cr-hint">内置百科 · 源自 319 条世界书。正文中出现的名词皆可点击查阅。</div>
        <div class="field"><input id="wiki-search" placeholder="搜索术语 / 人物 / 势力 / 地点……"></div>
        <div id="wiki-list">${wikiList('')}</div>`;
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
          <div class="kv"><span class="k">存档</span><span class="v">save-01 · 已游历 3 小时 · 12 回合</span></div>
        </div>
        ${rows.map(([t, d, on]) => `<div class="set-row"><div class="lbl">${esc(t)}<div class="d">${esc(d)}</div></div><div class="switch ${on ? 'on' : ''}"></div></div>`).join('')}
        ${updateSectionHTML()}
        <div class="sect-title">安 卓 适 配</div>
        <div class="card"><div class="kv"><span class="k">当前版式</span><span class="v">${isTablet() ? '平板（左导航 + 中叙事 + 右状态）' : '手机（单栏 + 抽屉）'}</span></div>
          <div class="kv"><span class="k">方向</span><span class="v">${app.dataset.orient === 'portrait' ? '竖屏' : '横屏'}</span></div>
          <div class="kv"><span class="k">安全区</span><span class="v">已启用 safe-area-inset 适配</span></div>
          <div class="kv"><span class="k">触控目标</span><span class="v">最小 44dp</span></div></div>`;
    }
    return '';
  }
  function wikiList(q) {
    const list = D.WORLD.filter((w) => !q || w.t.includes(q) || w.s.includes(q) || w.k.some((k) => k.includes(q)));
    if (!list.length) return `<div class="cr-hint">未找到「${esc(q)}」相关条目。</div>`;
    return list.map((w) => `<div class="wiki-item"><div class="h"><span class="t">${esc(w.t)}</span><span class="chip purple">${esc(w.c)}</span></div>
      <div class="s">${esc(w.s)}</div>
      <div style="margin-top:8px">${w.k.map((k) => `<span class="chip" style="margin:2px 4px 0 0">#${esc(k)}</span>`).join('')}</div></div>`).join('');
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
  // 启动时静默检查更新（可在设置里关闭；失败静默降级，不打扰玩家）
  if (window.DYUpdate.autoEnabled()) {
    window.DYUpdate.check().then(() => {
      renderUpdateChip();
      if (curPanel === '设置') renderSidebar();
    });
  }
})();
