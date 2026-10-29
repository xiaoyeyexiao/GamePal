/* 桌游助手 · 房间同步（试水版：共享计分板 + 成员名单）
 * 与 index.html 的对接方式：
 *   GPRoom.bridge = { getState(), applyState(state), canRender() }
 *   GPRoom.init()  -> 探测有没有配套服务（顺带自动回到上次的房间）
 *   GPRoom.on('state' | 'status', fn)
 * 没有配套服务（例如线上静态版 / 直接双击打开文件）时，一切静默降级为单机模式。
 */
(function () {
  'use strict';

  // 设备号要持久：关掉应用再打开还是同一个“座位”，成员列表才不会分身
  let CLIENT_ID;
  try {
    CLIENT_ID = localStorage.getItem('gpDeviceId');
    if (!CLIENT_ID) {
      CLIENT_ID = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      localStorage.setItem('gpDeviceId', CLIENT_ID);
    }
  } catch (e) {
    CLIENT_ID = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  const POLL_MS = 1000;
  const POLL_HIDDEN_MS = 3000;
  const PUSH_DEBOUNCE = 120;
  const STORE_KEY = 'gpRoomCode';     // 记住所在房间：关掉应用再打开能自动回去
  const STORE_TTL = 12 * 3600 * 1000; // 与房间回收时间一致

  const listeners = { state: [], status: [], timer: [], assign: [] };

  let available = false;
  let inRoom = false;
  let code = null;
  let roomName = '';
  let maxPlayers = 0;
  let hostId = '';             // 房主的设备号
  let perm = { draw: 'all', timer: 'all', score: 'all' };
  let deckInfo = null;         // {remaining, total}，null 表示还没建词池
  let members = [];            // [{id, name, host, online}]
  let myName = '';             // 我的昵称（随每个请求上报给服务端登记）
  let version = 0;
  let base = null;             // 上一次从服务端拿到的状态（做三方合并的基准）
  let canUndo = false;
  let canRedo = false;
  let peers = 0;
  let online = false;
  let applying = false;
  let pollTimer = null;
  let flushTimer = null;
  let pendingNext = null;
  let busy = false;
  let timerCache = null;       // 共享计时器快照（最后操作者的引擎状态）
  let lastTver = -1;           // 已处理过的计时器版本
  let clockOffset = 0;         // 服务端时钟 - 本机时钟（毫秒），倒计时对时用
  let assignCache = null;      // 上一次发牌结果里属于我的那一份
  let lastAssignSeq = -1;      // 已渲染过的发牌序号

  // ---- 服务地址 ----
  // 正常情况下页面从 server.js 同源打开，BASE 为空串（相对路径）。
  // 但如果页面是从静态预览服务（如 WorkBuddy 预览的 12750 端口）打开的，
  // 同源没有 /api 接口，这时自动去试同主机的 8500 端口；试通了就记住，下次直接用。
  let BASE = '';
  const BASE_KEY = 'gpApiBase';

  function candidateBases() {
    const list = [''];
    try {
      const saved = localStorage.getItem(BASE_KEY);
      if (saved && !list.includes(saved)) list.push(saved);
    } catch (e) { }
    // https 页面里请求 http 会被浏览器拦掉，所以只在非 https 下给 8500 兜底
    try {
      if (location.protocol !== 'https:' && location.hostname) {
        const fb = location.protocol + '//' + location.hostname + ':8500';
        if (!list.includes(fb)) list.push(fb);
      }
    } catch (e) { }
    return list;
  }

  function setBase(b) {
    BASE = b;
    try { localStorage.setItem(BASE_KEY, b); } catch (e) { }
  }

  function loadCode() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || !o.code || !o.at) return null;
      if (Date.now() - o.at > STORE_TTL) { localStorage.removeItem(STORE_KEY); return null; }
      return String(o.code);
    } catch (e) { return null; }
  }
  function saveCode(c) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify({ code: c, at: Date.now() })); } catch (e) { }
  }
  function dropCode() {
    try { localStorage.removeItem(STORE_KEY); } catch (e) { }
  }
  function loadNick() {
    try { return localStorage.getItem('gpNick') || ''; } catch (e) { return ''; }
  }
  function saveNick(n) {
    try { localStorage.setItem('gpNick', n); } catch (e) { }
  }

  function emit(name, payload) {
    listeners[name].forEach(fn => { try { fn(payload); } catch (e) { } });
  }
  function status() {
    emit('status', {
      available, inRoom, code, roomName, maxPlayers, members,
      host: hostId, perm, deck: deckInfo,
      isHost: !inRoom || !hostId ? true : CLIENT_ID === hostId,
      myName: myName || loadNick(),   // 重开自动回房时昵称从本地缓存恢复
      online, peers, canUndo, canRedo, busy
    });
  }
  function bridge() { return window.GPRoomBridge || {}; }

  async function api(pathname, opt) {
    return apiBase(pathname, opt, BASE);
  }

  async function apiBase(pathname, opt, base) {
    const headers = Object.assign({
      'content-type': 'application/json',
      'x-client-id': CLIENT_ID
    }, (opt && opt.headers) || {});
    if (myName) headers['x-member-name'] = encodeURIComponent(myName); // HTTP 头不能有非 ASCII，编码后传输
    const res = await fetch(base + pathname, Object.assign({ headers }, opt || {}));
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) {
      const err = new Error((data && data.error) || ('http_' + res.status));
      err.status = res.status;
      err.maxPlayers = data && data.maxPlayers;
      throw err;
    }
    // 关键：静态预览服务常把 /api/* 也返回成 200 + HTML，
    // 以前会当成“成功”，于是出现“建房了但房间码是 ------”“按钮点了没反应”的假状态。
    if (!data || typeof data !== 'object') {
      const err = new Error('bad_response');
      err.status = 200;
      throw err;
    }
    return data;
  }

  // 房间视图必须带 code / state，否则视为接口异常（别把半成品当房间）
  function assertView(view) {
    if (!view || !view.code || !view.state) {
      const err = new Error('bad_response');
      err.status = 200;
      throw err;
    }
    return view;
  }

  // 吸收视图里的共享计时器：别人操作过（by ≠ 我）才广播给页面
  function absorbTimer(view) {
    if (view.now) clockOffset = view.now - Date.now();
    const t = view.timer || null;
    if (!t) return;
    if (t.tver === lastTver) return;
    lastTver = t.tver;
    timerCache = t;
    if (t.by !== CLIENT_ID) emit('timer', t);
  }

  // 吸收视图里的发牌结果：房主一键分词后，每个人在这里拿到自己那份
  function absorbAssign(view) {
    const a = view && view.assign;
    if (!a || !Number.isFinite(a.seq)) return;
    if (a.seq === lastAssignSeq) return;
    lastAssignSeq = a.seq;
    assignCache = a;
    if (Array.isArray(a.words) && a.words.length) emit('assign', a);
  }

  // 把服务端房间视图吸收进本地（含房名 / 成员表 / 权限 / 词池）
  function adopt(view) {
    if (!view || !view.state) return;
    version = view.version;
    base = view.state;
    roomName = view.name || roomName || '';
    maxPlayers = view.maxPlayers || maxPlayers || 0;
    hostId = view.host || hostId || '';
    if (view.perm) {
      perm = {
        draw: view.perm.draw === 'host' ? 'host' : 'all',
        timer: view.perm.timer === 'host' ? 'host' : 'all',
        score: view.perm.score === 'host' ? 'host' : 'all'
      };
    }
    deckInfo = view.deck || null;
    members = Array.isArray(view.members) ? view.members : members;
    peers = view.peers || 0;
    canUndo = !!view.canUndo;
    canRedo = !!view.canRedo;
    online = true;
    absorbTimer(view);
    absorbAssign(view);
    applying = true;
    try {
      if (bridge().applyState) bridge().applyState(view.state);
    } finally {
      applying = false;
    }
    status();
  }

  // 本地改动 → 带上 base 推到服务端
  function pushState(next) {
    if (!inRoom || applying) return;
    pendingNext = next;
    if (flushTimer) return;
    flushTimer = setTimeout(flush, PUSH_DEBOUNCE);
  }

  async function flush() {
    flushTimer = null;
    const next = pendingNext;
    pendingNext = null;
    if (!next || !inRoom) return;
    try {
      const view = await api('/api/rooms/' + code + '/state', {
        method: 'PUT',
        body: JSON.stringify({ base: base, next: next })
      });
      adopt(view);
    } catch (e) {
      if (e.status === 403) {
        // 权限不允许改分数：把本机拨回服务端的最新状态（本地改动作废）
        try { adopt(await api('/api/rooms/' + code, { method: 'GET' })); return; } catch (e2) { }
      }
      online = false;
      status();
    }
  }

  function schedule() {
    clearTimeout(pollTimer);
    const gap = document.hidden ? POLL_HIDDEN_MS : POLL_MS;
    pollTimer = setTimeout(poll, gap);
  }

  async function poll() {
    if (!inRoom) return;
    try {
      const view = await api('/api/rooms/' + code, { method: 'GET' });
      if (!inRoom) return;               // 请求途中已离开房间，别把界面又拉回房间
      const membersChanged = JSON.stringify(view.members || []) !== JSON.stringify(members);
      absorbTimer(view);                 // 计时器每次轮询都要检查（不走 version 通道）
      absorbAssign(view);                // 发牌同理：房主分词后其他人要立刻收到
      if ((view.version !== version || membersChanged) && !flushTimer) adopt(view);
      else {
        const changed = peers !== view.peers || canUndo !== !!view.canUndo || canRedo !== !!view.canRedo
          || JSON.stringify(view.deck || null) !== JSON.stringify(deckInfo);
        roomName = view.name || roomName;
        maxPlayers = view.maxPlayers || maxPlayers;
        hostId = view.host || hostId;
        if (view.perm) {
          perm = {
            draw: view.perm.draw === 'host' ? 'host' : 'all',
            timer: view.perm.timer === 'host' ? 'host' : 'all',
            score: view.perm.score === 'host' ? 'host' : 'all'
          };
        }
        deckInfo = view.deck || null;
        members = Array.isArray(view.members) ? view.members : members;
        peers = view.peers || 0;
        canUndo = !!view.canUndo;
        canRedo = !!view.canRedo;
        online = true;
        if (changed || membersChanged) status();
        else if (!online) status();
      }
    } catch (e) {
      if (e.status === 404) {
        // 房间过期或被清理：退出房间，保留当前分数继续单机
        inRoom = false;
        code = null;
        online = false;
        timerCache = null;
        lastTver = -1;
        dropCode();
        clearTimeout(pollTimer);
        status();
        return;
      }
      online = false;
      status();
    }
    if (inRoom) schedule();
  }

  function startPolling() {
    clearTimeout(pollTimer);
    schedule();
  }

  function enter(view) {
    inRoom = true;
    code = view.code;
    saveCode(code);
    adopt(view);
    startPolling();
  }

  // opts: { name, maxPlayers, hostName, perm }
  async function create(opts) {
    if (inRoom) return code;             // 已在房间里：不重复建房
    const o = opts || {};
    myName = String(o.hostName || myName || '').trim().slice(0, 20);
    saveNick(myName);
    busy = true; status();
    try {
      const view = assertView(await api('/api/rooms', {
        method: 'POST',
        body: JSON.stringify({
          name: String(o.name || '').trim().slice(0, 20),
          maxPlayers: Number(o.maxPlayers) || 8,
          hostName: myName,
          perm: o.perm || { draw: 'all', timer: 'all', score: 'all' }
        })
      }));
      enter(view);
      return code;
    } finally {
      busy = false;
      status();
    }
  }

  async function peek(roomCode) {
    const c = String(roomCode || '').trim().toUpperCase();
    return assertView(await api('/api/rooms/' + c, { method: 'GET' }));
  }

  async function join(roomCode, opts) {
    const o = opts || {};
    const c = String(roomCode || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,8}$/.test(c)) {
      const err = new Error('bad_code'); err.status = 0; throw err;
    }
    myName = String(o.name || myName || '').trim().slice(0, 20);
    saveNick(myName);
    busy = true; status();
    try {
      const view = await peek(c);        // GET 时带上昵称，服务端据此登记成员 / 校验人数
      enter(view);
      return code;
    } finally {
      busy = false;
      status();
    }
  }

  function leave() {
    const oldCode = code;
    inRoom = false;
    code = null;
    roomName = '';
    maxPlayers = 0;
    hostId = '';
    perm = { draw: 'all', timer: 'all', score: 'all' };
    deckInfo = null;
    members = [];
    timerCache = null;
    lastTver = -1;
    assignCache = null;
    lastAssignSeq = -1;
    version = 0;
    base = null;
    peers = 0;
    canUndo = false;
    canRedo = false;
    online = false;
    busy = false;
    pendingNext = null;
    dropCode();
    clearTimeout(pollTimer);
    clearTimeout(flushTimer);
    flushTimer = null;
    status();
    // 通知服务端把自己的“座位”让出来（尽力而为，失败也不影响本机退出）
    if (oldCode) {
      fetch(BASE + '/api/rooms/' + oldCode + '/leave', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-client-id': CLIENT_ID },
        body: JSON.stringify({ memberId: CLIENT_ID })
      }).catch(() => { });
    }
  }

  async function undo() {
    if (!inRoom || !canUndo) return;
    busy = true; status();
    try { adopt(await api('/api/rooms/' + code + '/undo', { method: 'POST', body: '{}' })); }
    catch (e) { online = false; }
    finally { busy = false; status(); }
  }

  async function redo() {
    if (!inRoom || !canRedo) return;
    busy = true; status();
    try { adopt(await api('/api/rooms/' + code + '/redo', { method: 'POST', body: '{}' })); }
    catch (e) { online = false; }
    finally { busy = false; status(); }
  }

  // ---- 共享词池 ----
  // 建池 / 重置：把所选分类的全部词交给服务端洗牌；sig 是分类签名，用来判断“分类变了没”
  async function buildDeck(words, sig) {
    if (!inRoom) throw new Error('not_in_room');
    const list = (Array.isArray(words) ? words : []).slice(0, 3000);
    const r = await api('/api/rooms/' + code + '/deck', {
      method: 'POST',
      body: JSON.stringify({ words: list, sig: String(sig || '') })
    });
    deckInfo = r.deck || deckInfo;
    status();
    return r;
  }

  // 抽词：从共享牌堆顶弹出，永不重复
  // opts.each = true 时是「发牌」：房间里每人各 count 个，服务端负责分配，回包里的 words 是「我这一份」
  async function drawWords(count, opts) {
    if (!inRoom) throw new Error('not_in_room');
    const r = await api('/api/rooms/' + code + '/draw', {
      method: 'POST',
      body: JSON.stringify({ count: Number(count) || 1, each: !!(opts && opts.each) })
    });
    deckInfo = r.deck || deckInfo;
    if (r.assign && Number.isFinite(r.assign.seq)) {
      // 自己发起的发牌：记下已渲染的序号，避免轮询时又弹一次
      lastAssignSeq = Math.max(lastAssignSeq, r.assign.seq);
      assignCache = r.assign;
    }
    status();
    return r;
  }

  // ---- 共享计时器 ----
  // 本机操作后把引擎快照推上去；服务端按权限校验（仅房主时非房主 403）
  async function pushTimer(snap) {
    if (!inRoom) throw new Error('not_in_room');
    try {
      const r = await api('/api/rooms/' + code + '/timer', {
        method: 'PUT',
        body: JSON.stringify({ snapshot: snap })
      });
      if (r.timer) { timerCache = r.timer; lastTver = r.timer.tver; }
      if (r.now) clockOffset = r.now - Date.now();
      return r;
    } catch (e) {
      if (e.status === 403) lastTver = -1;   // 本机改动被拒：下次轮询强制重新跟随服务端状态
      throw e;
    }
  }

  async function probe() {
    // 逐个候选地址试 /api/health，谁是真的房间服务就用谁
    available = false;
    for (const b of candidateBases()) {
      try {
        const data = await apiBase('/api/health', { method: 'GET' }, b);
        if (data && data.ok === true) {
          setBase(b);
          available = true;
          break;
        }
      } catch (e) { /* 换下一个地址 */ }
    }
    status();
    if (available && !inRoom) await rejoinSaved();
    return available;
  }

  // 关掉应用再打开：如果上次还在房间里，就自动回去（分数也从房间拉回来）
  async function rejoinSaved() {
    const c = loadCode();
    if (!c || inRoom) return false;
    try {
      const view = await peek(c);
      enter(view);
      return true;
    } catch (e) {
      if (e.status === 404) dropCode();   // 房间已被回收，清掉记录
      return false;
    }
  }

  window.GPRoom = {
    // 协议版本：index.html 会核对它，页面是新的而脚本被缓存成旧版时自动刷新一次
    proto: 33,
    get available() { return available; },
    get inRoom() { return inRoom; },
    get code() { return code; },
    get roomName() { return roomName; },
    get maxPlayers() { return maxPlayers; },
    get members() { return members; },
    get me() { return CLIENT_ID; },
    get host() { return hostId; },
    get perm() { return perm; },
    get deck() { return deckInfo; },
    get assign() { return assignCache; },
    get timer() { return timerCache; },
    get clockOffset() { return clockOffset; },
    get isHost() { return !inRoom || !hostId ? true : CLIENT_ID === hostId; },
    get myName() { return myName || loadNick(); },
    get canUndo() { return canUndo; },
    get canRedo() { return canRedo; },
    on(name, fn) { if (listeners[name]) listeners[name].push(fn); },
    _emit(name, payload) { emit(name, payload); },   // 测试钩子：手动触发事件（页面用）
    init: probe,
    create,
    join,
    peek,
    leave,
    pushState,
    pushTimer,
    undo,
    redo,
    buildDeck,
    drawWords,
    // 供测试注入
    __setBridge(b) { window.GPRoomBridge = b; }
  };
})();
