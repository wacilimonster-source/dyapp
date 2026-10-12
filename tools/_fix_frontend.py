import io

NL = chr(10)


def edit(path, pairs):
    s = io.open(path, encoding='utf-8').read()
    for old, new, why in pairs:
        assert old in s, 'NOT MATCHED in %s: %s' % (path, why)
        s = s.replace(old, new, 1)
        print('  ok', why)
    io.open(path, 'w', encoding='utf-8', newline=NL).write(s)


# ============ F1: 引擎负责晋阶（rules.js 加 advanceRealm） ============
edit('prototype/engine/rules.js', [
    ("""/* ------------------------------ 道心与模糊感知 ------------------------------ */""",
     """/**
 * 下一个境界标签（引擎负责晋阶）。
 *
 * 为什么必须由引擎做：L0 协议明确禁止模型改境界，所以"突破成功"之后
 * 没有任何一方会去写 `主角.境界` —— 实测发现核心成长循环因此断掉
 * （修为清零、境界永远停在创角时的炼气一层）。
 *
 * 规则：小境界 +1；九层则进下一个大境界的一层；单值境界（渡劫/超脱…）直接进下一大境界。
 * 大境界所需的丹药/渡劫条件由叙事与道具负责，引擎只保证"境界确实前进了"。
 */
export function advanceRealm(label) {
  const { major, minor } = parseRealm(label);
  const idx = realmIndex(major);
  if (idx < 0 || idx >= REALM_ORDER.length - 1) {
    return REALM_ORDER[idx] === major ? null : null; // 已是最后一境
  }
  if (SINGLE_MINOR.has(major) || minor >= 9) {
    const nextMajor = REALM_ORDER[idx + 1];
    return nextMajor ? realmLabel(nextMajor, 1) : null;
  }
  return realmLabel(major, minor + 1);
}

/* ------------------------------ 道心与模糊感知 ------------------------------ */""",
     'rules.advanceRealm'),
])

# ============ F1: 突破胜利时写入境界 ============
edit('prototype/engine/turn.js', [
    ("import { cultivate, breakthroughChance, parseRealm, realmIndex } from './rules.js';",
     "import { advanceRealm, cultivate, breakthroughChance, parseRealm, realmIndex } from './rules.js';",
     'turn 引入 advanceRealm'),
    ("""    if (win) effects.push({ op: 'delta', target: '主角.修为', value: -100, reason: '突破消耗修为' });
    else effects.push({ op: 'delta', target: '主角.生命', value: -12, reason: '突破失败反噬' });""",
     """    if (win) {
      effects.push({ op: 'delta', target: '主角.修为', value: -100, reason: '突破消耗修为' });
      // 晋阶由引擎写：L0 禁止模型改境界，不写就永远停在原地（实测的断点）
      const before = state.主角.境界;
      const next = advanceRealm(before);
      if (next) {
        effects.push({ op: 'set', target: '主角.境界', value: next, reason: '突破成功' });
        hints.push(`境界变化：${before} → ${next}（引擎已结算并写入状态，正文里不要另写数值或重复宣布）。`);
      } else {
        hints.push('已至最高境界，修为虽消耗但境界不再前进。');
      }
    } else {
      effects.push({ op: 'delta', target: '主角.生命', value: -12, reason: '突破失败反噬' });
    }""",
     '突破成功写入境界'),
])

# ============ F2: 飘字接回 + 折叠时不定位到 (0,0) ============
edit('prototype/app.js', [
    ("""  function float(key, v, color) {
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
  }""",
     """  /**
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
  }""",
     'float 定位加固'),
    ("""    // 建议吸附到输入区上方（不再埋在叙事流里）
    const choices = result.choices || [];
    setSuggestions(choices);""",
     """    // 数值飘字：由引擎落地产出的事件驱动（applyAll 的 events）
    // 注意：effects 是"意图"，events 才是真正落地后的增量；飘字必须用后者
    for (const ev of result.events || []) {
      if (ev.kind === 'float' && ev.key) {
        const meta = D.RES.find((x) => x.key === ev.key);
        float(ev.key, ev.delta, meta ? meta.color : '#d4af37');
      }
    }

    // 建议吸附到输入区上方（不再埋在叙事流里）
    const choices = result.choices || [];
    setSuggestions(choices);""",
     '飘字接回 paintTurn'),
])

# ============ F5: 建议条在载入/创角/重渲时重置 ============
edit('prototype/app.js', [
    ("""      currentSaveId = id;
      renderStream(); renderHUD(); renderSidebar();""",
     """      currentSaveId = id;
      setSuggestions([]);          // 换档后不能留着上一局的建议（会误导操作）
      renderStream(); renderHUD(); renderSidebar();""",
     'loadSave 清建议'),
    ("""    showScreen('s-game'); renderStream(); renderHUD(); renderSidebar();
    autosave();
  }""",
     """    setSuggestions([]);            // 新档开局不继承上一局的建议
    showScreen('s-game'); renderStream(); renderHUD(); renderSidebar();
    autosave();
  }""",
     'applyCreate 清建议'),
    ("""  function renderStream() {
    const first = turns.find((t) => t.scene);
    $('#stream').innerHTML = (first ? sceneBanner(first.scene) : '') + turns.map(msgHTML).join('');
  }""",
     """  function renderStream() {
    const first = turns.find((t) => t.scene);
    $('#stream').innerHTML = (first ? sceneBanner(first.scene) : '') + turns.map(msgHTML).join('');
    // 重渲整条叙事流时按最后一轮的建议同步吸附条，避免与屏幕内容对不上
    const last = [...turns].reverse().find((t) => t.role === 'assistant' && (t.choices || []).length);
    setSuggestions(last ? last.choices : []);
  }""",
     'renderStream 同步建议'),
])

# ============ F3: 并发回合守卫 ============
edit('prototype/app.js', [
    ("""  async function runEngineTurn(action, opts = {}) {
    const { bubble, wrap } = newAssistantBubble();""",
     """  /** 回合进行中标志：流式期间重复点建议/主行动会并发跑两个回合，状态互相覆盖。 */
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
    const { bubble, wrap } = newAssistantBubble();""",
     '回合并发守卫'),
])

# ============ F4: Esc 关判定层要等价于"承认结果" ============
edit('prototype/app.js', [
    ("""    $('#judge').classList.add('open');
    const ok = $('#judge-ok');
    const handler = () => {
      $('#judge').classList.remove('open');
      ok.removeEventListener('click', handler);
      if (typeof onAck === 'function') onAck();
    };
    ok.addEventListener('click', handler);
  }""",
     """    $('#judge').classList.add('open');
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
  }""",
     'judge 记录 ack'),
    ("""  /* ================= 判定演出 ================= */""",
     """  /* ================= 判定演出 ================= */
  /** 覆盖层待确认的回调：Esc 关闭时必须补跑，否则该回合白跑。 */
  let judgeAck = null;""",
     'judgeAck 变量'),
    ("""    if (e.key === 'Escape') {
      if ($('#judge').classList.contains('open')) { $('#judge').classList.remove('open'); return; }""",
     """    if (e.key === 'Escape') {
      if ($('#judge').classList.contains('open')) {
        // 判定层：走"承认结果"而不是直接隐藏，否则叙事与存档都会缺这一回合
        if (typeof judgeAck === 'function') judgeAck();
        else $('#judge').classList.remove('open');
        return;
      }""",
     'Esc 走 ack'),
])

# ============ F8/F9: 键盘与弹层的边界 ============
edit('prototype/app.js', [
    ("""    // 1–4 选行动建议
    if (/^[1-4]$/.test(e.key) && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {""",
     """    // 1–4 选行动建议（判定/预览覆盖层打开时不响应，否则会"隔着遮罩"发起新回合）
    if (/^[1-4]$/.test(e.key)
      && !$('#judge').classList.contains('open')
      && !e.isComposing
      && !/^(INPUT|TEXTAREA|SELECT)$/.test((document.activeElement || {}).tagName || '')) {""",
     '数字键边界'),
    ("""  function openPanel(name, { reset = false } = {}) {
    const switching = name !== curPanel || reset;""",
     """  function openPanel(name, { reset = false } = {}) {
    closeMoreSheet();   // 切面板时收起「更多」，否则弹层会悬在行动区上方
    const switching = name !== curPanel || reset;""",
     'openPanel 收弹层'),
    ("""    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {""",
     """    if (e.altKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      closeMoreSheet();""",
     'Alt 切面板收弹层'),
])

# ============ F6: 手势 touchcancel + 手机也能拖拽 ============
edit('prototype/app.js', [
    ("""    head.addEventListener('touchmove', (e) => {
      if (y0 == null) return;
      const dy = e.touches[0].clientY - y0;
      const sb = $('#sidebar');
      if (dy > 0 && !$('#sidebar').classList.contains('mini')) {
        sb.style.transform = 'translateX(0) translateY(' + Math.min(dy, 120) + 'px)';
      }
    }, { passive: true });
    head.addEventListener('touchend', (e) => {
      const sb = $('#sidebar');
      const dy = y0 == null ? 0 : (e.changedTouches[0].clientY - y0);
      sb.style.transform = '';
      y0 = null;
      // 手机：下滑关闭抽屉；平板：下滑收起右栏
      if (dy > 70) {
        if (app.dataset.layout === 'tablet') toggleSide(true); else closePanel();
      }
    });""",
     """    const resetDrag = (sb) => { sb.style.transform = ''; sb.classList.remove('dragging'); };
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
    });""",
     '手势健壮性'),
])

# ============ 优化：去掉恒真的死代码 ============
edit('prototype/app.js', [
    ("""      CHAT_PRESETS = presetStore.persistent || true ? await presetStore.list() : [];""",
     """      CHAT_PRESETS = await presetStore.list();""",
     '去掉 persistent||true 死代码'),
])

# ============ F7: 深度插入任意深度 + 超范围告警 ============
edit('prototype/narrator/plan.js', [
    ("""      if (entry.injectionPosition === 1) {
        deepInserts.push({ depth: entry.injectionDepth, role: entry.role, content: r.text });
      } else {""",
     """      if (entry.injectionPosition === 1) {
        // 深度必须夹到合法范围，并记下越界项——原先只处理 1..8，
        // depth=20 的条目会既不做深度插入、又在顺序展开时被跳过，静默消失
        let d = Math.floor(Number(entry.injectionDepth));
        if (!Number.isFinite(d) || d < 1) {
          warnings.push(`「${entry.name}」的注入深度 ${entry.injectionDepth} 非法，已按 1 处理`);
          d = 1;
        } else if (d > 32) {
          warnings.push(`「${entry.name}」的注入深度 ${d} 超出支持范围（最多 32），已按 32 处理`);
          d = 32;
        }
        deepInserts.push({ depth: d, role: entry.role, content: r.text });
      } else {""",
     '深度夹取与告警'),
    ("""      // 深度插入：挑几个常见深度（1..8）依次插入
      for (let d = 1; d <= 8; d++) pushDeep(history, d);""",
     """      // 按实际出现的深度插入（不再硬编码 1..8）
      for (const d of [...new Set(deepInserts.map((x) => x.depth))].sort((a, b) => a - b)) pushDeep(history, d);""",
     'chatHistory 深度'),
    ("""    for (let d = 1; d <= 8; d++) pushDeep(history, d);""",
     """    for (const d of [...new Set(deepInserts.map((x) => x.depth))].sort((a, b) => a - b)) pushDeep(history, d);""",
     '无 chatHistory 时的深度'),
])

print('前端修复完成')
