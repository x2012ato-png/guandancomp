import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';
import { createGame, reduce, pendingActors, toPlayerView, eventsForSeat, SEATS, type GameState, type ScopedEvent, type Seat } from '@guandan/engine';
import { decisionToAction } from '@guandan/ai';
import { CHAT_HISTORY_LIMIT, CHAT_MESSAGE_MAX_LENGTH, DEAL_DURATION_MS, DEFAULT_ROOM_ID, DEFAULT_TUNING, type BotKind, type ChatMessage, type ClientToServerEvents, type ServerToClientEvents, type RoomSnapshot, type GameUpdate, type CoachAdvice, type AckFn } from '@guandan/protocol';
import { SessionStore, type Session } from './sessions.ts';
import { TokenBucket } from './rateLimit.ts';
import { parseAction, parseConfig, parseRoomId, parseSeat, sanitizeNickname } from './validate.ts';
import { PlayedCardsLog } from './playedCardsLog.ts';
import { botDelay, BOT_PLAY_DISPLAY_MS, isTwoHumanBotEndgame } from './botDelay.ts';
import { nextHandDeadline, toggleReady } from './nextHand.ts';
import { coachAdvice, hasCoach, shouldForcePass } from './coach.ts';
import { automatedPolicy } from './automation.ts';
import { runBackgroundCoach } from './backgroundCoach.ts';

type Slot = { playerId: string; nickname: string; bot: boolean; botKind: BotKind | null; auto: boolean; ready: boolean } | null;
type Room = { messages: ChatMessage[]; id: string; host: string; members: Set<string>; seats: [Slot, Slot, Slot, Slot]; config: ReturnType<typeof parseConfig>; game: GameState | null; version: number; timer: ReturnType<typeof setTimeout> | null; deadline: number | null; nextHandDeadline: number | null; dealingStartedAt: number | null; lastBotPlayUntil: number | null };
const sessions = new SessionStore();
const rooms = new Map<string, Room>();
type AdviceJob = { version: number; seat: Seat; playerId: string; advice: CoachAdvice; cancel: () => void };
const adviceJobs = new WeakMap<Room, AdviceJob>();
const botJobs = new WeakMap<Room, () => void>();
const playedCardsLog = new PlayedCardsLog();
const corsOrigins = process.env.CORS_ORIGIN?.split(',').map(origin => origin.trim());
const clientDir = fileURLToPath(new URL('../../client/dist/', import.meta.url));
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2',
};
const http = createServer((req, res) => {
  const pathname = req.url?.split('?')[0] ?? '/';
  if (pathname === '/health') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('OK'); return; }
  if (pathname !== '/api/played-cards-log') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    let path: string;
    try { path = decodeURIComponent(pathname === '/' ? '/index.html' : pathname); }
    catch { res.writeHead(400); res.end(); return; }
    const file = resolve(clientDir, `.${path}`);
    if (!file.startsWith(clientDir.endsWith(sep) ? clientDir : clientDir + sep)) { res.writeHead(404); res.end(); return; }
    void readFile(file).then(content => {
      res.writeHead(200, { 'Content-Type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT' && error.code !== 'EISDIR') console.error('Failed to read client file', error);
      res.writeHead(error.code === 'ENOENT' || error.code === 'EISDIR' ? 404 : 500); res.end();
    });
    return;
  }
  const origin = req.headers.origin;
  if (!corsOrigins) res.setHeader('Access-Control-Allow-Origin', '*');
  else if (origin && corsOrigins.includes(origin)) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin'); }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Allow', 'GET, OPTIONS');
  if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS'); res.writeHead(204); res.end(); return; }
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'GET') { res.writeHead(405); res.end(JSON.stringify({ error: 'METHOD_NOT_ALLOWED' })); return; }
  try {
    const content = playedCardsLog.read();
    res.writeHead(200); res.end(JSON.stringify({ format: 'markdown', content }));
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    if (!missing) console.error('Failed to read played cards log', error);
    res.writeHead(missing ? 404 : 500); res.end(JSON.stringify({ error: missing ? 'LOG_NOT_FOUND' : 'LOG_READ_FAILED' }));
  }
});
const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, { cors: { origin: corsOrigins ?? true } });
const fail = (ack: AckFn<any>, code: string, message: string) => ack({ ok: false, error: { code, message } });
const ok = (ack: AckFn<any>, data: any = null) => ack({ ok: true, data });
const roomOf = (s: Session) => s.roomId ? rooms.get(s.roomId) : undefined;
const seatOf = (r: Room, s: Session): Seat | null => { const i = r.seats.findIndex(x => x?.playerId === s.playerId); return i < 0 ? null : i as Seat; };
function snapshot(r: Room, s: Session): RoomSnapshot {
  return { roomId: r.id, hostId: r.host, status: r.game ? r.game.phase === 'matchOver' ? 'finished' : 'playing' : 'lobby', config: r.config,
    seats: SEATS.map(seat => { const x = r.seats[seat]; return { seat, kind: x ? x.bot ? 'bot' : 'human' : 'empty', botKind: x?.botKind ?? null, nickname: x?.nickname ?? null, playerId: x?.playerId ?? null, connected: x ? x.bot || sessions.isOnline(x.playerId) : false, autoPlay: x?.auto ?? false, readyForNext: x?.ready ?? false }; }) as unknown as RoomSnapshot['seats'],
    members: [...r.members].map(id => sessions.get(id)).filter((x): x is Session => !!x).map(x => ({ playerId: x.playerId, nickname: x.nickname, connected: sessions.isOnline(x.playerId) })), you: { playerId: s.playerId, seat: seatOf(r, s) } };
}
function broadcastRoom(r: Room) { for (const id of r.members) { const s = sessions.get(id); if (s) for (const sid of s.sockets) io.to(sid).emit('room:state', snapshot(r, s)); } }
function cancelAdvice(r: Room) { adviceJobs.get(r)?.cancel(); adviceJobs.delete(r); }
function adviceFor(r: Room, seat: Seat): CoachAdvice | null {
  if (!r.game || r.dealingStartedAt !== null || !hasCoach(r.seats, seat) || toPlayerView(r.game, seat).myDuty !== 'play') return null;
  const playerId = r.seats[seat]!.playerId;
  const current = adviceJobs.get(r);
  if (current && current.version === r.version && current.seat === seat && current.playerId === playerId) return current.advice;
  cancelAdvice(r);
  const base = coachAdvice(r.game, r.seats, seat);
  if (!base) return null;
  const job: AdviceJob = { version: r.version, seat, playerId, advice: { ...base, pending: true }, cancel: () => {} };
  adviceJobs.set(r, job);
  job.cancel = runBackgroundCoach(toPlayerView(r.game, seat), result => {
    if (adviceJobs.get(r) !== job || !r.game || r.version !== job.version || !hasCoach(r.seats, seat) || r.seats[seat]?.playerId !== playerId || toPlayerView(r.game, seat).myDuty !== 'play') return;
    job.advice = { ...(result ?? base), pending: false };
    const session = sessions.get(playerId);
    if (session?.roomId === r.id) for (const sid of session.sockets) io.to(sid).emit('coach:advice', { roomId: r.id, version: job.version, advice: job.advice });
  });
  return job.advice;
}
function update(r: Room, seat: Seat, events: readonly ScopedEvent[] = []): GameUpdate { const serverNow = Date.now(); return { roomId: r.id, version: r.version, view: toPlayerView(r.game!, seat), coachAdvice: adviceFor(r, seat), events: eventsForSeat(events, seat), deadline: r.deadline, serverNow, lastBotPlayUntil: r.lastBotPlayUntil, dealing: r.dealingStartedAt === null ? null : { startedAt: r.dealingStartedAt, serverNow } }; }
function broadcastGame(r: Room, events: readonly ScopedEvent[] = []) { for (const id of r.members) { const s = sessions.get(id); if (!s) continue; const seat = seatOf(r, s); if (seat !== null) for (const sid of s.sockets) io.to(sid).emit('game:update', update(r, seat, events)); } }
function schedule(r: Room) {
  botJobs.get(r)?.(); botJobs.delete(r);
  if (r.timer) clearTimeout(r.timer); r.timer = null; r.deadline = null;
  if (r.game?.phase !== 'handOver') r.nextHandDeadline = null;
  if (!r.game || r.game.phase === 'matchOver') return;
  if (r.dealingStartedAt !== null) {
    const remaining = r.dealingStartedAt + DEAL_DURATION_MS - Date.now();
    if (remaining > 0) {
      r.timer = setTimeout(() => { r.dealingStartedAt = null; schedule(r); broadcastGame(r); }, remaining);
      return;
    }
    r.dealingStartedAt = null;
  }
  if (r.game.phase === 'handOver') {
    r.nextHandDeadline = nextHandDeadline(r.nextHandDeadline, Date.now(), DEFAULT_TUNING.nextHandDelayMs);
    r.deadline = r.nextHandDeadline;
    r.timer = setTimeout(() => startHand(r), Math.max(0, r.deadline - Date.now())); return;
  }
  const actors = pendingActors(r.game); if (!actors.length) return;
  const forcedPass = actors.find(seat => shouldForcePass(r.game!, r.seats, seat));
  if (forcedPass !== undefined) {
    r.timer = setTimeout(() => {
      if (!r.game || !shouldForcePass(r.game, r.seats, forcedPass)) return;
      const result = reduce(r.game, { type: 'pass', seat: forcedPass });
      if (result.ok) commit(r, result.state, result.events);
    }, 5_000);
    return;
  }
  const automated = actors.find(seat => { const slot = r.seats[seat]!; return slot.bot || slot.auto; });
  if (automated === undefined) return;
  const delay = r.seats[automated]?.bot ? botDelay(r.game, r.seats, DEFAULT_TUNING.botDelayMs) : DEFAULT_TUNING.botDelayMs;
  r.deadline = Date.now() + delay;
  r.timer = setTimeout(() => {
    if (!r.game) return;
    const seat = automated;
    const policy = automatedPolicy(r.seats[seat]!);
    const view = toPlayerView(r.game, seat);
    const decision = policy.decide(view);
    if (!decision) return;
    const version = r.version;
    const apply = (choice: typeof decision) => {
      if (!r.game || r.version !== version || !pendingActors(r.game).includes(seat) || !(r.seats[seat]?.bot || r.seats[seat]?.auto)) return;
      botJobs.delete(r);
      const result = reduce(r.game, decisionToAction(seat, choice));
      if (result.ok) commit(r, result.state, result.events); else console.error('AI action rejected', result.error);
    };
    if (r.seats[seat]?.botKind === 'coach' && view.myDuty === 'play') {
      botJobs.set(r, runBackgroundCoach(view, analysis => apply(analysis?.decision ?? decision)));
    } else apply(decision);
  }, delay);
}
function commit(r: Room, state: GameState, events: readonly ScopedEvent[]) { r.lastBotPlayUntil = r.game && isTwoHumanBotEndgame(r.game, r.seats) && (state.phase === 'handOver' || state.phase === 'matchOver') && events.some(event => event.event.type === 'played' && r.seats[event.event.seat]?.bot) ? Date.now() + BOT_PLAY_DISPLAY_MS : null; cancelAdvice(r); r.game = state; r.version++; try { playedCardsLog.record(r.id, r.seats, events); } catch (error) { console.error('Failed to write played cards log', error); } if (state.phase === 'handOver') for (const s of r.seats) if (s) s.ready = s.bot; schedule(r); broadcastRoom(r); broadcastGame(r, events); }
function startHand(r: Room) { if (!r.game) return; const result = reduce(r.game, { type: 'startHand' }); if (result.ok) { r.dealingStartedAt = Date.now(); commit(r, result.state, result.events); } }
function leave(s: Session) { const r = roomOf(s); if (!r) { s.roomId = null; return; } const seat = seatOf(r,s); if (seat !== null && adviceJobs.get(r)?.seat === seat) cancelAdvice(r); if (r.game && seat !== null && r.game.phase !== 'matchOver') { const slot = r.seats[seat]!; slot.bot = true; slot.botKind = 'beginner'; slot.auto = true; slot.playerId = `bot:${randomBytes(8).toString('hex')}`; slot.nickname += ' (AI)'; } else if (seat !== null) r.seats[seat] = null; r.members.delete(s.playerId); s.roomId = null; if (!r.members.size) { if (r.timer) clearTimeout(r.timer); botJobs.get(r)?.(); botJobs.delete(r); rooms.delete(r.id); return; } if (r.host === s.playerId) r.host = [...r.members][0]!; schedule(r); broadcastRoom(r); }
io.on('connection', socket => {
  const auth = socket.handshake.auth; let s = sessions.byTokenOrNull(auth.token) ?? sessions.create(sanitizeNickname(auth.nickname));
  s.sockets.add(socket.id); s.lastSeen = Date.now(); const bucket = new TokenBucket(DEFAULT_TUNING.rate.capacity, DEFAULT_TUNING.rate.refillPerSec);
  socket.emit('session', { playerId: s.playerId, token: s.token, nickname: s.nickname, roomId: s.roomId });
  const existing = roomOf(s); if (existing) { broadcastRoom(existing); const seat = seatOf(existing,s); if (seat !== null && existing.game) socket.emit('game:update', update(existing,seat)); }
  function guard(ack: AckFn<any>): boolean { if (typeof ack !== 'function') return false; if (!bucket.take()) { fail(ack,'RATE_LIMITED','操作太频繁'); if (bucket.violations >= DEFAULT_TUNING.rate.maxViolations) socket.disconnect(true); return false; } return true; }
  socket.on('room:create', (p, ack) => { if (!guard(ack)) return; if (s.roomId) return fail(ack,'BAD_REQUEST','请先离开当前房间'); const id = DEFAULT_ROOM_ID; if (rooms.has(id)) return fail(ack,'BAD_REQUEST','房间 666888 已存在，请加入现有房间'); const r: Room = { messages: [], id, host:s.playerId, members:new Set([s.playerId]), seats:[null,null,null,null], config:parseConfig(p?.config), game:null, version:0,timer:null,deadline:null,nextHandDeadline:null,dealingStartedAt:null,lastBotPlayUntil:null }; rooms.set(id,r); s.roomId=id; ok(ack,snapshot(r,s)); broadcastRoom(r); });
  socket.on('room:join', (p,ack) => {
    if (!guard(ack)) return;
    if (s.roomId) return fail(ack,'BAD_REQUEST','请先离开当前房间');
    const id = parseRoomId(p?.roomId); const r = id && rooms.get(id);
    if (!r) return fail(ack,'ROOM_NOT_FOUND','房间不存在');
    const matches = [...r.members].map(id => sessions.get(id)).filter((member): member is Session => !!member && member.nickname === s.nickname);
    if (matches.length > 1) return fail(ack,'BAD_REQUEST','房间内昵称重复，无法恢复会话');
    const previous = matches[0];
    if (previous) {
      if (previous.sockets.size) return fail(ack,'BAD_REQUEST','该昵称已在房间中使用');
      s.sockets.delete(socket.id); s.lastSeen = Date.now();
      s = previous; s.sockets.add(socket.id); s.lastSeen = Date.now();
      socket.emit('session',{playerId:s.playerId,token:s.token,nickname:s.nickname,roomId:s.roomId});
      ok(ack,snapshot(r,s)); broadcastRoom(r);
      const seat = seatOf(r,s); if (seat !== null && r.game) socket.emit('game:update',update(r,seat));
      return;
    }
    if (r.members.size >= 4 || r.game) return fail(ack,'ROOM_FULL','房间已满或游戏已开始');
    r.members.add(s.playerId); s.roomId=r.id; ok(ack,snapshot(r,s)); broadcastRoom(r);
  });
  socket.on('room:leave', ack => { if (!guard(ack)) return; leave(s); for (const sid of s.sockets) io.to(sid).emit('room:left'); ok(ack); });
  socket.on('room:sit', (p,ack) => { if (!guard(ack)) return; const r=roomOf(s), seat=parseSeat(p?.seat); if (!r) return fail(ack,'NOT_IN_ROOM','不在房间'); if (r.game) return fail(ack,'ALREADY_STARTED','游戏已开始'); if (seat === null) return fail(ack,'BAD_REQUEST','无效座位'); if (r.seats[seat]) return fail(ack,'SEAT_TAKEN','座位已占'); const old=seatOf(r,s); if (old !== null) r.seats[old]=null; r.seats[seat]={playerId:s.playerId,nickname:s.nickname,bot:false,botKind:null,auto:false,ready:false}; ok(ack); broadcastRoom(r); });
  socket.on('room:stand', ack => { if (!guard(ack)) return; const r=roomOf(s); if (!r) return fail(ack,'NOT_IN_ROOM','不在房间'); if (r.game) return fail(ack,'ALREADY_STARTED','游戏已开始'); const seat=seatOf(r,s); if (seat !== null) r.seats[seat]=null; ok(ack); broadcastRoom(r); });
  const bot = (p: {seat: Seat; botKind?: BotKind}, ack: AckFn, add: boolean) => { if (!guard(ack)) return; const r=roomOf(s), seat=parseSeat(p?.seat); if (!r) return fail(ack,'NOT_IN_ROOM','不在房间'); if (r.host!==s.playerId) return fail(ack,'NOT_HOST','只有房主可以操作'); if (r.game) return fail(ack,'ALREADY_STARTED','游戏已开始'); if (seat===null) return fail(ack,'BAD_REQUEST','无效座位'); if (add && p.botKind !== undefined && p.botKind !== 'beginner' && p.botKind !== 'coach') return fail(ack,'BAD_REQUEST','无效 AI 类型'); if (add && r.seats[seat] || !add && !r.seats[seat]?.bot) return fail(ack,'SEAT_TAKEN','座位不可用'); const botKind = p.botKind ?? 'beginner'; r.seats[seat]=add ? {playerId:`bot:${randomBytes(8).toString('hex')}`,nickname:`${botKind === 'coach' ? 'AI教练' : 'AI'} ${seat+1}`,bot:true,botKind,auto:true,ready:true} : null; ok(ack); broadcastRoom(r); };
  socket.on('room:addBot',(p,a)=>bot(p,a,true)); socket.on('room:removeBot',(p,a)=>bot(p,a,false));
  socket.on('room:start', ack => { if (!guard(ack)) return; const r=roomOf(s); if (!r) return fail(ack,'NOT_IN_ROOM','不在房间'); if (r.host!==s.playerId) return fail(ack,'NOT_HOST','只有房主可以开始'); if (r.game) return fail(ack,'ALREADY_STARTED','游戏已开始'); if (r.seats.some(x=>!x)) return fail(ack,'BAD_REQUEST','请坐满四个座位'); r.game=createGame(r.config,randomBytes(16).toString('hex')); startHand(r); ok(ack); });
  socket.on('game:action',(p,ack)=>{ if (!guard(ack)) return; const r=roomOf(s); if (!r?.game) return fail(ack,'NOT_STARTED','游戏未开始'); if (r.dealingStartedAt !== null) return fail(ack,'BAD_REQUEST','请等待发牌结束'); const seat=seatOf(r,s); if (seat===null) return fail(ack,'NOT_SEATED','请先入座'); const action=parseAction(p); if (!action) return fail(ack,'BAD_REQUEST','无效动作'); const result=reduce(r.game,{...action,seat}); if (!result.ok) return fail(ack,result.error.code,result.error.message); commit(r,result.state,result.events); ok(ack); });
  socket.on('game:ready',ack=>{ if (!guard(ack)) return; const r=roomOf(s); if (!r?.game || r.game.phase!=='handOver') return fail(ack,'BAD_REQUEST','当前不能准备'); const seat=seatOf(r,s); if (seat===null) return fail(ack,'NOT_SEATED','请先入座'); toggleReady(r.seats,seat); ok(ack); broadcastRoom(r); });
  socket.on('game:autoplay',(p,ack)=>{ if (!guard(ack)) return; const r=roomOf(s); if (!r?.game || typeof p?.on !== 'boolean') return fail(ack,'BAD_REQUEST','无效请求'); const seat=seatOf(r,s); if (seat===null) return fail(ack,'NOT_SEATED','请先入座'); r.seats[seat]!.auto=p.on; schedule(r); broadcastRoom(r); broadcastGame(r); ok(ack); });
  socket.on('game:sync',ack=>{ if (!guard(ack)) return; const r=roomOf(s); const seat=r && seatOf(r,s); ok(ack,r?.game && seat !== null && seat !== undefined ? update(r,seat) : null); });
  socket.on('chat:history', ack => { if (!guard(ack)) return; const r=roomOf(s); if (!r) return fail(ack,'NOT_IN_ROOM','不在房间'); ok(ack,r.messages); });
  socket.on('chat:send', (p,ack) => {
    if (!guard(ack)) return;
    const r=roomOf(s); if (!r) return fail(ack,'NOT_IN_ROOM','不在房间');
    if (typeof p?.text !== 'string' || !p.text.trim() || p.text.length > CHAT_MESSAGE_MAX_LENGTH) return fail(ack,'BAD_REQUEST',`请输入 1 到 ${CHAT_MESSAGE_MAX_LENGTH} 个字符`);
    const message: ChatMessage = { id:randomBytes(12).toString('hex'), roomId:r.id, playerId:s.playerId, nickname:s.nickname, text:p.text.trim(), sentAt:Date.now() };
    r.messages.push(message); if (r.messages.length > CHAT_HISTORY_LIMIT) r.messages.shift();
    for (const id of r.members) { const member=sessions.get(id); if (member) for (const sid of member.sockets) io.to(sid).emit('chat:message',message); }
    ok(ack,message);
  });
  socket.on('profile:rename',(p,ack)=>{ if (!guard(ack)) return; const nickname=sanitizeNickname(p?.nickname); const r=roomOf(s); if (r && [...r.members].some(id=>id!==s.playerId && sessions.get(id)?.nickname===nickname)) return fail(ack,'BAD_REQUEST','该昵称已在房间中使用'); s.nickname=nickname; if (r) { const seat=seatOf(r,s); if (seat!==null) r.seats[seat]!.nickname=s.nickname; broadcastRoom(r); } socket.emit('session',{playerId:s.playerId,token:s.token,nickname:s.nickname,roomId:s.roomId}); ok(ack); });
  socket.on('disconnect',()=>{ s.sockets.delete(socket.id); s.lastSeen=Date.now(); const r=roomOf(s); if (r) broadcastRoom(r); });
});
// Retain offline rooms for reconnects, then reclaim them and their timers.
setInterval(() => {
  const now = Date.now();
  for (const r of rooms.values()) {
    const members = [...r.members].map(id => sessions.get(id)).filter((s): s is Session => !!s);
    if (members.every(s => s.sockets.size === 0 && now - s.lastSeen > DEFAULT_TUNING.roomIdleMs)) {
      if (r.timer) clearTimeout(r.timer);
      cancelAdvice(r); botJobs.get(r)?.(); botJobs.delete(r);
      rooms.delete(r.id);
      for (const s of members) s.roomId = null;
    }
  }
  sessions.sweep(DEFAULT_TUNING.roomIdleMs);
}, 60_000).unref();
const port = Number(process.env.PORT ?? 3001); http.listen(port, '0.0.0.0', () => console.log(`Guandan server listening on ${port}`));
