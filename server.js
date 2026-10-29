'use strict';
/*
 * 桌游助手 · 本地房间服务（试水版）
 * 零依赖：只用 Node 内置模块，同时提供静态页面与房间同步接口。
 * 启动： node server.js        默认 http://127.0.0.1:8500
 *      PORT=8600 node server.js
 *
 * 设计要点
 * - 房间状态是一个 JSON 对象：{ players, roundCount, curRound }
 * - 客户端不是“整份覆盖”，而是把自己“已知的旧状态 base”和“新状态 next”一起发上来，
 *   服务端做逐格三方合并，避免两人同时加分时互相覆盖。
 * - 版本号 version 单调递增，客户端靠它判断是否需要重新拉取。
 * - 撤销/前进由服务端保存快照栈，所有客户端看到同一份历史。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 8500;
const ROOM_TTL = 12 * 3600 * 1000;   // 房间闲置 12 小时后回收
const PEER_WINDOW = 12000;           // 12 秒内有请求就算“在线”
const MEMBER_ACTIVE = 60 * 1000;     // 1 分钟内有请求就算“还占座位”

const rooms = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

// 去掉容易看错的 0/O/1/I
const ALPHABET = 'ACDEFGHJKLMNPQRTUVWXY23456789';

function makeCode() {
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}
const clone = o => JSON.parse(JSON.stringify(o));

function emptyState() {
  return { players: [], roundCount: 1, curRound: 0 };
}

// 成员表：谁在房间里（房主 / 昵称 / 是否在线），与计分板数据分开存
function activeMembers(room) {
  const now = Date.now();
  const list = [];
  room.members.forEach(m => { if (now - m.seen < MEMBER_ACTIVE) list.push(m); });
  list.sort((a, b) => a.joinedAt - b.joinedAt);
  return list;
}
function activeMemberCount(room) {
  return activeMembers(room).length;
}

/**
 * 登记成员：存在则刷新在线时间（必要时改昵称）；新人则检查人数上限。
 * 返回 null 表示成功，'room_full' 表示房间已满。
 */
function registerMember(room, memberId, name) {
  if (!memberId) return null;
  const now = Date.now();
  let m = room.members.get(memberId);
  if (m) {
    m.seen = now;
    if (name) m.name = name;
    return null;
  }
  if (activeMemberCount(room) >= room.maxPlayers) return 'room_full';
  room.members.set(memberId, {
    id: memberId,
    name: name || ('玩家' + (room.members.size + 1)),
    host: false,
    joinedAt: now,
    seen: now
  });
  return null;
}

function touch(room, memberId) {
  room.seen = Date.now();
  if (memberId) {
    const m = room.members.get(memberId);
    if (m) m.seen = Date.now();
  }
}

/**
 * 房主退出后把房主身份交给下一位：按入座顺序（joinedAt）取最早的还留在房间里的人。
 * 房间空了就不动，等调用方回收房间。
 */
function handOverHost(room) {
  const rest = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
  room.members.forEach(m => { m.host = false; });
  if (!rest.length) { room.hostId = ''; return; }
  const next = rest[0];
  next.host = true;
  room.hostId = next.id;
  room.version++;                       // 让所有客户端立刻拉到「房主换人了」
}

function normalize(st) {
  const out = {
    players: Array.isArray(st && st.players) ? st.players : [],
    roundCount: Math.max(1, Math.min(99, Number(st && st.roundCount) || 1)),
    curRound: 0
  };
  out.players = out.players.map((p, i) => ({
    id: p && p.id ? String(p.id) : 'p' + i + Math.random().toString(36).slice(2, 6),
    name: String((p && p.name) || '玩家' + (i + 1)).slice(0, 20),
    scores: Array.isArray(p && p.scores) ? p.scores.map(n => Number.isFinite(+n) ? Math.trunc(+n) : 0) : [],
    color: Number.isInteger(p && p.color) ? p.color : i % 8,
    pos: Number.isFinite(p && p.pos) ? p.pos : i
  }));
  out.curRound = Math.max(0, Math.min(out.roundCount - 1, Number(st && st.curRound) || 0));
  out.players.forEach(p => {
    while (p.scores.length < out.roundCount) p.scores.push(0);
    p.scores.length = out.roundCount;
  });
  return out;
}

/**
 * 三方合并：base = 客户端上次看到的，next = 客户端现在想写的，cur = 服务端此刻的
 * 只采用“客户端确实改动过”的格子，其余保持服务端现值。
 */
function merge(base, next, cur) {
  const nx = normalize(next);
  if (!base) return nx;
  const out = clone(cur);
  const baseP = new Map((base.players || []).map(p => [p.id, p]));
  const nextP = new Map(nx.players.map(p => [p.id, p]));

  // 删除：base 里有、next 里没了（并发新加的玩家要保留）
  out.players = out.players.filter(p => nextP.has(p.id) || !baseP.has(p.id));
  // 新增：next 里有、base 里没有
  nextP.forEach(np => {
    if (!baseP.has(np.id) && !out.players.some(p => p.id === np.id)) out.players.push(clone(np));
  });
  // 字段与每个回合的分数
  out.players.forEach(rp => {
    const bp = baseP.get(rp.id);
    const np = nextP.get(rp.id);
    if (!np) return;
    if (bp && np.name !== bp.name) rp.name = np.name;
    if (bp && np.color !== bp.color) rp.color = np.color;
    if (bp && np.pos !== bp.pos) rp.pos = np.pos;
    if (!bp) return;
    const bs = bp.scores || [];
    const n = Math.max(np.scores.length, bs.length, (rp.scores || []).length);
    if (!Array.isArray(rp.scores)) rp.scores = [];
    for (let i = 0; i < n; i++) {
      if (np.scores[i] !== bs[i]) rp.scores[i] = np.scores[i];
      else if (rp.scores[i] === undefined && np.scores[i] !== undefined) rp.scores[i] = np.scores[i];
    }
  });
  if (nx.roundCount !== base.roundCount) out.roundCount = nx.roundCount;
  if (nx.curRound !== base.curRound) out.curRound = nx.curRound;
  return normalize(out);
}

function pushHistory(room) {
  room.history = room.history.slice(0, room.hIndex + 1);
  room.history.push(clone(room.state));
  if (room.history.length > 100) room.history.shift();
  room.hIndex = room.history.length - 1;
}

function peerCount(room) {
  const now = Date.now();
  let n = 0;
  room.members.forEach(m => { if (now - m.seen < PEER_WINDOW) n++; });
  return n;
}

// 上一轮「发牌」结果：每个人只看自己那一份（服务端只回给请求者自己的词）
function assignFor(room, cid) {
  const a = room.assign;
  if (!a) return null;
  const mine = cid && a.map ? a.map[cid] : null;
  return {
    seq: a.seq,
    n: a.n,
    by: a.by || '',
    members: a.members || 0,
    at: a.at || 0,
    words: Array.isArray(mine) ? mine : []
  };
}

function roomView(room, cid) {
  const now = Date.now();
  const members = [];
  room.members.forEach(m => members.push({
    id: m.id,
    name: m.name,
    host: !!m.host,
    online: now - m.seen < PEER_WINDOW
  }));
  members.sort((a, b) => a.joinedAt - b.joinedAt);
  return {
    code: room.code,
    name: room.name,
    maxPlayers: room.maxPlayers,
    host: room.hostId,
    perm: room.perm,
    members,
    version: room.version,
    state: room.state,
    deck: room.deck ? { remaining: room.deck.length, total: room.deckTotal, sig: room.deckSig || '' } : null,
    assign: assignFor(room, cid),
    timer: room.timer,
    now: Date.now(),
    peers: peerCount(room),
    canUndo: room.hIndex > 0,
    canRedo: room.hIndex < room.history.length - 1
  };
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type,x-client-id,x-member-name',
    'access-control-allow-methods': 'GET,POST,PUT,OPTIONS',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 2e6) req.destroy();
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
  });
}

function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'content-length': buf.length
    });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;
  const cid = req.headers['x-client-id'] || u.searchParams.get('cid') || '';

  if (req.method === 'OPTIONS') { send(res, 204, {}); return; }

  // 健康检查：客户端用它判断“有没有配套服务”
  if (p === '/api/health') { send(res, 200, { ok: true, rooms: rooms.size }); return; }

  if (p === '/api/rooms' && req.method === 'POST') {
    const body = await readBody(req);
    let code = makeCode();
    while (rooms.has(code)) code = makeCode();
    // 页面权限：每个功能区“所有人可操作”还是“仅房主操作”
    const perm = {
      draw: body.perm && body.perm.draw === 'host' ? 'host' : 'all',
      timer: body.perm && body.perm.timer === 'host' ? 'host' : 'all',
      score: body.perm && body.perm.score === 'host' ? 'host' : 'all'
    };
    const hostId = req.headers['x-client-id'] || body.memberId || '';
    const room = {
      code,
      name: String(body.name || '').trim().slice(0, 20) || '桌游房间',
      maxPlayers: Math.max(2, Math.min(20, Number(body.maxPlayers) || 8)),
      perm,
      hostId,
      deck: null,          // 共享词池：洗好的词数组，null 表示还没建
      deckTotal: 0,
      assign: null,        // 上一轮发牌结果 {seq, n, by, at, members, map:{成员id:[词]}}
      assignSeq: 0,
      timer: null,         // 共享计时器快照：最后操作者的引擎状态（tver 单调递增）
      tver: 0,
      version: 1, state: emptyState(), history: [], hIndex: -1,
      members: new Map(), seen: Date.now(), createdAt: Date.now()
    };
    pushHistory(room);
    rooms.set(code, room);
    // 建房者即房主，第一个成员
    room.members.set(hostId || 'host', {
      id: hostId || 'host',
      name: String(body.hostName || '').trim().slice(0, 20) || '房主',
      host: true,
      joinedAt: Date.now(),
      seen: Date.now()
    });
    send(res, 200, roomView(room, hostId || 'host'));
    return;
  }

  const mLeave = p.match(/^\/api\/rooms\/([A-Z0-9]{4,8})\/leave$/i);
  if (mLeave && req.method === 'POST') {
    const room = rooms.get(mLeave[1].toUpperCase());
    if (room) {
      const body = await readBody(req);
      const mid = body.memberId || cid;
      const wasHost = !!mid && mid === room.hostId;
      room.members.delete(mid);
      room.seen = Date.now();
      if (wasHost) handOverHost(room);   // 房主走了：按入座顺序把房主交给下一位
      // 房间里一个人都不剩了，直接把房间回收，房间码释放
      if (!room.members.size) rooms.delete(room.code);
    }
    send(res, 200, { ok: true });
    return;
  }

  // 页面权限校验：perm 里设为 'host' 的功能，只有房主能操作
  function hostOnly(room, area) {
    if (!room.perm || room.perm[area] !== 'host') return false;
    return cid !== room.hostId;
  }

  const m = p.match(/^\/api\/rooms\/([A-Z0-9]{4,8})(?:\/(state|undo|redo|deck|draw|timer))?$/i);
  if (m) {
    const code = m[1].toUpperCase();
    const room = rooms.get(code);
    if (!room) { send(res, 404, { error: 'room_not_found' }); return; }

    // 成员登记：老成员刷新在线时间，新成员检查人数上限
    let mname = '';
    try { mname = decodeURIComponent(String(req.headers['x-member-name'] || '').trim()).slice(0, 20); } catch (e) { }
    if (cid) {
      const reg = registerMember(room, cid, mname);
      if (reg) { send(res, 403, { error: reg, maxPlayers: room.maxPlayers }); return; }
    }
    touch(room, cid);
    const action = m[2];

    if (!action && req.method === 'GET') { send(res, 200, roomView(room, cid)); return; }

    if (action === 'state' && req.method === 'PUT') {
      const body = await readBody(req);
      if (hostOnly(room, 'score')) {
        // 计分权限归房主时，非房主仍然可以「翻回合看分」——这属于查看，不算改分。
        // 允许的条件很苛刻：合并后除 curRound（当前看第几回合）之外，其他字段必须和现在完全一样。
        const merged = merge(body.base || null, body.next || {}, room.state);
        const onlyView = JSON.stringify(Object.assign({}, merged, { curRound: room.state.curRound }))
          === JSON.stringify(room.state);
        if (!onlyView) { send(res, 403, { error: 'forbidden_host' }); return; }
        room.state.curRound = merged.curRound;
        room.version++;
        send(res, 200, roomView(room, cid));
        return;
      }
      const before = clone(room.state);
      room.state = merge(body.base || null, body.next || {}, room.state);
      room.version++;
      if (JSON.stringify(before) !== JSON.stringify(room.state)) pushHistory(room);
      send(res, 200, roomView(room, cid));
      return;
    }

    if (action === 'undo' && req.method === 'POST') {
      if (hostOnly(room, 'score')) { send(res, 403, { error: 'forbidden_host' }); return; }
      if (room.hIndex > 0) {
        room.hIndex--;
        room.state = clone(room.history[room.hIndex]);
        room.version++;
      }
      send(res, 200, roomView(room, cid));
      return;
    }

    if (action === 'redo' && req.method === 'POST') {
      if (hostOnly(room, 'score')) { send(res, 403, { error: 'forbidden_host' }); return; }
      if (room.hIndex < room.history.length - 1) {
        room.hIndex++;
        room.state = clone(room.history[room.hIndex]);
        room.version++;
      }
      send(res, 200, roomView(room, cid));
      return;
    }

    // 建词池 / 重置词池：客户端把所选分类的全部词发上来，服务端洗牌
    if (action === 'deck' && req.method === 'POST') {
      if (hostOnly(room, 'draw')) { send(res, 403, { error: 'forbidden_host' }); return; }
      const body = await readBody(req);
      const words = (Array.isArray(body.words) ? body.words : [])
        .map(w => String(w || '').trim().slice(0, 30)).filter(Boolean);
      if (!words.length) { send(res, 400, { error: 'bad_words' }); return; }
      // Fisher–Yates 洗牌
      for (let i = words.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = words[i]; words[i] = words[j]; words[j] = t;
      }
      room.deck = words;
      room.deckTotal = words.length;
      room.deckSig = String(body.sig || '').slice(0, 200);   // 分类签名：客户端用来判断“分类变了没”
      room.assign = null;                                   // 词池重建，上一轮的发牌作废
      room.version++;
      send(res, 200, { ok: true, deck: { remaining: room.deck.length, total: room.deckTotal, sig: room.deckSig } });
      return;
    }

    // 抽词：从牌堆顶弹出，不放回 —— 谁都不可能抽到重复的词
    if (action === 'draw' && req.method === 'POST') {
      if (hostOnly(room, 'draw')) { send(res, 403, { error: 'forbidden_host' }); return; }
      if (!room.deck || !room.deck.length) { send(res, 400, { error: 'deck_empty' }); return; }
      const body = await readBody(req);
      const n = Math.max(1, Math.min(20, Number(body.count) || 1));
      const deckView = () => ({ remaining: room.deck.length, total: room.deckTotal, sig: room.deckSig || '' });

      // 普通抽词：只给请求者本人 n 个
      if (body.each !== true) {
        const words = room.deck.splice(0, n);
        room.version++;
        send(res, 200, { ok: true, words, deck: deckView(), assign: assignFor(room, cid) });
        return;
      }

      // 发牌（房主一键给全房间分词）：房间里每人各 n 个，词与词之间绝不重复。
      // 按座位轮流发，牌不够时也是人人有份、不会有人被漏掉。
      // 注意用「所有成员」而不是「最近活跃的成员」：手机切后台/锁屏一会儿就不算在线了，
      // 但人还在房间里，等他们回到页面时应该能看到自己那份。
      const seats = [...room.members.values()].filter(m => m.id).sort((a, b) => a.joinedAt - b.joinedAt);
      if (!seats.length && cid) seats.push({ id: cid });
      if (!seats.length) { send(res, 400, { error: 'no_member' }); return; }
      const take = Math.min(n * seats.length, room.deck.length);
      const popped = room.deck.splice(0, take);
      const map = {};
      seats.forEach(m => { map[m.id] = []; });
      for (let i = 0; i < popped.length; i++) {
        const seat = seats[i % seats.length];
        if (map[seat.id].length < n) map[seat.id].push(popped[i]);
      }
      room.assignSeq++;
      room.assign = { seq: room.assignSeq, n, by: cid, at: Date.now(), members: seats.length, map };
      room.version++;
      send(res, 200, {
        ok: true,
        words: map[cid] || [],
        deck: deckView(),
        assign: assignFor(room, cid),
        dealt: { members: seats.length, each: n }
      });
      return;
    }

    // 共享计时器：保存最后操作者的引擎快照，其他设备照着渲染
    if (action === 'timer' && req.method === 'PUT') {
      if (hostOnly(room, 'timer')) { send(res, 403, { error: 'forbidden_host' }); return; }
      const body = await readBody(req);
      const snap = body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
      if (!snap) { send(res, 400, { error: 'bad_snapshot' }); return; }
      room.timer = {
        mode: snap.mode === 'relay' ? 'relay' : 'normal',
        cfg: snap.cfg && typeof snap.cfg === 'object' ? snap.cfg : {},
        phases: Array.isArray(snap.phases) ? snap.phases.slice(0, 64) : [],
        pi: Math.max(0, Math.min(63, Number(snap.pi) || 0)),
        state: ['idle', 'running', 'paused', 'between', 'done'].indexOf(snap.state) >= 0 ? snap.state : 'idle',
        endTs: Number(snap.endTs) || 0,
        remainMs: Math.max(0, Number(snap.remainMs) || 0),
        tver: ++room.tver,
        by: cid,
        at: Date.now()
      };
      send(res, 200, { ok: true, timer: room.timer, now: Date.now() });
      return;
    }
  }

  if (p.startsWith('/api/')) { send(res, 404, { error: 'not_found' }); return; }
  serveStatic(req, res, p);
});

setInterval(() => {
  const now = Date.now();
  rooms.forEach((room, code) => {
    if (now - room.seen > ROOM_TTL) rooms.delete(code);
  });
}, 10 * 60 * 1000).unref();

server.listen(PORT, '0.0.0.0', () => {
  console.log('[桌游助手] 房间服务已启动: http://127.0.0.1:' + PORT + '/');
  console.log('  同一 WiFi 下的手机可用本机内网 IP 访问，例如 http://192.168.x.x:' + PORT + '/');
});
