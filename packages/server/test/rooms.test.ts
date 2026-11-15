import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io, type Socket } from 'socket.io-client';
import { CHAT_MESSAGE_MAX_LENGTH, DEAL_DURATION_MS, type ClientToServerEvents, type ServerToClientEvents, type SessionInfo, type GameUpdate } from '@guandan/protocol';
import { cardLabel, interpret } from '@guandan/engine';

type Client = Socket<ServerToClientEvents, ClientToServerEvents>;
let server: ChildProcess;
let logDirectory: string;
let logPath: string;
const clients: Client[] = [];
const port = 32000 + Math.floor(Math.random() * 20000);
function connect(token?: string, nickname?: string): Promise<{socket: Client; session: SessionInfo}> {
  return new Promise((resolve, reject) => {
    const socket: Client = io(`http://127.0.0.1:${port}`, { auth: { token, nickname }, reconnection: false, timeout: 3000 });
    clients.push(socket); socket.once('session', session => resolve({ socket, session })); socket.once('connect_error', reject);
  });
}
function waitForDeal(socket: Client): Promise<GameUpdate> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { socket.off('game:update', onUpdate); reject(new Error('Deal did not finish')); }, DEAL_DURATION_MS + 3000);
    const onUpdate = (update: GameUpdate) => { if (!update.dealing) { clearTimeout(timeout); socket.off('game:update', onUpdate); resolve(update); } };
    socket.on('game:update', onUpdate);
  });
}
beforeEach(async () => {
  logDirectory = mkdtempSync(join(tmpdir(), 'guandan-room-test-'));
  logPath = join(logDirectory, 'played_cards_log.md');
  server = spawn(process.execPath, ['packages/server/src/main.ts'], { env: { ...process.env, PORT: String(port), GUANDAN_PLAYED_CARDS_LOG: logPath, CORS_ORIGIN: 'https://coach.example' } });
  await new Promise<void>((resolve, reject) => { server.stdout!.on('data', chunk => { if (String(chunk).includes('listening')) resolve(); }); server.once('error', reject); server.once('exit', code => reject(new Error(`server exited ${code}`))); });
});
afterEach(async () => {
  clients.splice(0).forEach(c => c.disconnect());
  if (server && server.exitCode === null) {
    const exited = new Promise<void>(resolve => server.once('exit', () => resolve()));
    server.kill();
    await exited;
  }
  rmSync(logDirectory, { recursive: true, force: true });
});
describe('room service', () => {
  it('adds both AI types and sends coach guidance only to its human partner on their turn', async () => {
    const host = await connect(undefined, 'Coached player');
    const opponent = await connect(undefined, 'Opponent');
    const created = await host.socket.emitWithAck('room:create', { config: { firstLeader: 0 } });
    if (!created.ok) throw new Error('Room creation failed');
    expect((await opponent.socket.emitWithAck('room:join', {roomId: created.data.roomId})).ok).toBe(true);
    expect((await host.socket.emitWithAck('room:sit', {seat: 0})).ok).toBe(true);
    expect((await opponent.socket.emitWithAck('room:sit', {seat: 1})).ok).toBe(true);
    expect((await host.socket.emitWithAck('room:addBot', {seat: 2, botKind: 'coach'})).ok).toBe(true);
    const roomUpdate = new Promise<Parameters<ServerToClientEvents['room:state']>[0]>(resolve => {
      const onRoom: ServerToClientEvents['room:state'] = room => {
        if (room.seats[3].botKind === 'beginner') { host.socket.off('room:state', onRoom); resolve(room); }
      };
      host.socket.on('room:state', onRoom);
    });
    expect((await host.socket.emitWithAck('room:addBot', {seat: 3, botKind: 'beginner'})).ok).toBe(true);
    const room = await roomUpdate;
    expect(room.seats[2]).toMatchObject({kind: 'bot', botKind: 'coach', nickname: 'AI教练 3'});
    expect(room.seats[3]).toMatchObject({kind: 'bot', botKind: 'beginner', nickname: 'AI 4'});
    const dealt = waitForDeal(host.socket);
    const guidance = new Promise<Parameters<ServerToClientEvents['coach:advice']>[0]>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Coach analysis did not finish')), DEAL_DURATION_MS + 5000);
      host.socket.once('coach:advice', advice => { clearTimeout(timeout); resolve(advice); });
    });
    let leakedAdvice = false;
    opponent.socket.on('coach:advice', () => { leakedAdvice = true; });
    expect((await host.socket.emitWithAck('room:start')).ok).toBe(true);
    const duringDeal = await host.socket.emitWithAck('game:sync');
    expect(duringDeal.ok && duringDeal.data?.coachAdvice).toBeNull();
    const update = await dealt;
    expect(update.view.myDuty).toBe('play');
    expect(update.coachAdvice?.decision.type).toBe('play');
    expect(update.coachAdvice?.reasons.length).toBeGreaterThanOrEqual(2);
    const improved = await guidance;
    expect(improved.version).toBe(update.version);
    expect(improved.advice.pending).toBe(false);
    if (improved.advice.decision.type === 'play') expect(improved.advice.decision.play.cards.every(card => update.view.myHand.includes(card))).toBe(true);
    expect(improved.advice.reasons.some(reason => reason.includes('模拟比较了'))).toBe(true);
    expect(leakedAdvice).toBe(false);
    const other = await opponent.socket.emitWithAck('game:sync');
    expect(other.ok && other.data?.coachAdvice).toBeNull();
    host.socket.disconnect();
    const restored = await connect(host.session.token);
    const synced = await restored.socket.emitWithAck('game:sync');
    if (!synced.ok || !synced.data || synced.data.coachAdvice?.decision.type !== 'play') throw new Error('Missing restored advice');
    expect(synced.data.coachAdvice).toEqual(improved.advice);
    const play = synced.data.coachAdvice.decision.play;
    expect((await restored.socket.emitWithAck('game:action', {type:'play', cards:play.cards, combo:{type:play.combo.type,key:play.combo.key,...(play.combo.suit ? {suit:play.combo.suit} : {})}, wildAssignments:play.wildAssignments})).ok).toBe(true);
    const after = await restored.socket.emitWithAck('game:sync');
    expect(after.ok && after.data?.coachAdvice).toBeNull();
  }, DEAL_DURATION_MS + 10000);

  it('serves the latest log as JSON and handles missing files, read errors, and CORS', async () => {
    const url = `http://127.0.0.1:${port}/api/played-cards-log`;
    const missing = await fetch(url, { headers: { Origin: 'https://coach.example' } });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'LOG_NOT_FOUND' });
    expect(missing.headers.get('access-control-allow-origin')).toBe('https://coach.example');
    expect(missing.headers.get('cache-control')).toBe('no-store');
    writeFileSync(logPath, '# 第 1 局\n1. 出牌\n');
    const first = await fetch(url);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ format: 'markdown', content: '# 第 1 局\n1. 出牌\n' });
    writeFileSync(logPath, '# 第 2 局\n');
    const second = await fetch(url, { headers: { Origin: 'https://untrusted.example' } });
    expect(second.headers.get('access-control-allow-origin')).toBeNull();
    expect(await second.json()).toEqual({ format: 'markdown', content: '# 第 2 局\n' });
    const options = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'https://coach.example' } });
    expect(options.status).toBe(204);
    expect(options.headers.get('access-control-allow-methods')).toBe('GET, OPTIONS');
    const post = await fetch(url, { method: 'POST' });
    expect(post.status).toBe(405);
    expect(await post.json()).toEqual({ error: 'METHOD_NOT_ALLOWED' });
    rmSync(logPath);
    mkdirSync(logPath);
    const failed = await fetch(url);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: 'LOG_READ_FAILED' });
  });

  it('uses the fixed room code without replacing an existing room', async () => {
    const host = await connect(undefined, 'Host');
    const other = await connect(undefined, 'Other');
    const created = await host.socket.emitWithAck('room:create', {});
    expect(created.ok && created.data.roomId).toBe('666888');
    expect(created.ok && created.data.config.publicReturnCard).toBe(false);
    const duplicate = await other.socket.emitWithAck('room:create', {});
    expect(duplicate.ok).toBe(false);
    const joined = await other.socket.emitWithAck('room:join', {roomId: '666888'});
    expect(joined.ok && joined.data.hostId).toBe(host.session.playerId);
    expect((await host.socket.emitWithAck('room:leave')).ok).toBe(true);
    expect((await other.socket.emitWithAck('room:leave')).ok).toBe(true);
    const recreated = await other.socket.emitWithAck('room:create', {});
    expect(recreated.ok && recreated.data.roomId).toBe('666888');
  });

  it('keeps chat within the room, validates messages, and restores history on reconnect', async () => {
    const alice = await connect(undefined, 'Chat Alice');
    const bob = await connect(undefined, 'Chat Bob');
    const outsider = await connect(undefined, 'Chat Outsider');
    const created = await alice.socket.emitWithAck('room:create', {});
    if (!created.ok) throw new Error('Room creation failed');
    expect((await bob.socket.emitWithAck('room:join', {roomId:created.data.roomId})).ok).toBe(true);
    let leaked = false;
    outsider.socket.on('chat:message', () => { leaked = true; });
    const received = new Promise<Parameters<ServerToClientEvents['chat:message']>[0]>(resolve => bob.socket.once('chat:message', resolve));
    const sent = await alice.socket.emitWithAck('chat:send', {text:'  你好，牌友！  '});
    expect(sent.ok).toBe(true); if (!sent.ok) throw new Error('Message rejected');
    expect(await received).toEqual(sent.data);
    expect(sent.data).toMatchObject({roomId:created.data.roomId, playerId:alice.session.playerId, nickname:'Chat Alice', text:'你好，牌友！'});
    expect((await alice.socket.emitWithAck('chat:send', {text:'   '})).ok).toBe(false);
    expect((await alice.socket.emitWithAck('chat:send', {text:'x'.repeat(CHAT_MESSAGE_MAX_LENGTH+1)})).ok).toBe(false);
    const otherHistory = await outsider.socket.emitWithAck('chat:history');
    expect(otherHistory.ok).toBe(false);
    expect(leaked).toBe(false);
    bob.socket.disconnect();
    const restored = await connect(bob.session.token);
    const history = await restored.socket.emitWithAck('chat:history');
    expect(history.ok && history.data).toEqual([sent.data]);
    expect((await restored.socket.emitWithAck('room:leave')).ok).toBe(true);
    expect((await restored.socket.emitWithAck('chat:history')).ok).toBe(false);
    expect((await restored.socket.emitWithAck('chat:send', {text:'hello'})).ok).toBe(false);
  });

  it('restores an offline player by nickname and room, including their seat and hand', async () => {
    const host = await connect(undefined, 'Alice');
    const created = await host.socket.emitWithAck('room:create', {});
    if (!created.ok) throw new Error('Room creation failed');
    const roomId = created.data.roomId;
    const observer = await connect(undefined, 'Observer');
    expect((await observer.socket.emitWithAck('room:join', {roomId})).ok).toBe(true);
    expect((await observer.socket.emitWithAck('profile:rename', {nickname: 'Alice'})).ok).toBe(false);
    expect((await host.socket.emitWithAck('room:sit', {seat: 0})).ok).toBe(true);
    for (const seat of [1, 2, 3] as const) expect((await host.socket.emitWithAck('room:addBot', {seat})).ok).toBe(true);
    const firstUpdate = new Promise<GameUpdate>(resolve => host.socket.once('game:update', resolve));
    expect((await host.socket.emitWithAck('room:start')).ok).toBe(true);
    const original = await firstUpdate;
    const other = await connect(undefined, 'Alice');
    expect((await other.socket.emitWithAck('room:join', {roomId})).ok).toBe(false);
    const offline = new Promise<void>(resolve => {
      const onRoom: ServerToClientEvents['room:state'] = room => {
        if (room.members.some(member => member.playerId === host.session.playerId && !member.connected)) {
          observer.socket.off('room:state', onRoom); resolve();
        }
      };
      observer.socket.on('room:state', onRoom);
    });
    host.socket.disconnect();
    await offline;
    const session = new Promise<SessionInfo>(resolve => other.socket.once('session', resolve));
    const joined = await other.socket.emitWithAck('room:join', {roomId});
    expect(joined.ok).toBe(true); if (!joined.ok) return;
    expect(joined.data.you).toEqual({playerId: host.session.playerId, seat: 0});
    expect(joined.data.hostId).toBe(host.session.playerId);
    expect((await session).token).toBe(host.session.token);
    const synced = await other.socket.emitWithAck('game:sync');
    expect(synced.ok).toBe(true);
    if (synced.ok) expect(synced.data?.view.myHand).toEqual(original.view.myHand);
    other.socket.disconnect();
    const restored = await connect(host.session.token);
    const again = await restored.socket.emitWithAck('game:sync');
    expect(again.ok && again.data?.view.seat).toBe(0);
  });

  it('isolates hands, rejects out of turn actions and restores the seat on reconnect', async () => {
    const players = await Promise.all([connect(), connect(), connect(), connect()]);
    const created = await players[0]!.socket.emitWithAck('room:create', {}); expect(created.ok).toBe(true); if (!created.ok) return;
    const id = created.data.roomId;
    for (let i=1;i<4;i++) expect((await players[i]!.socket.emitWithAck('room:join',{roomId:id})).ok).toBe(true);
    for (let i=0;i<4;i++) expect((await players[i]!.socket.emitWithAck('room:sit',{seat:i as 0|1|2|3})).ok).toBe(true);
    const updates = players.map(p => new Promise<GameUpdate>(resolve => p.socket.once('game:update',resolve)));
    expect((await players[0]!.socket.emitWithAck('room:start')).ok).toBe(true);
    const views = await Promise.all(updates);
    for (let i=0;i<4;i++) { const v=views[i]!.view; expect(v.seat).toBe(i); expect(v.myHand).toHaveLength(27); expect(v.handCounts).toEqual([27,27,27,27]); expect(v).not.toHaveProperty('hands'); expect(v).not.toHaveProperty('rng'); }
    expect(new Set(views.flatMap(u=>u.view.myHand)).size).toBe(108);
    expect(views[0]!.dealing).not.toBeNull();
    const turn = views[0]!.view.turn!; const other = (turn+1)%4;
    const early = await players[turn]!.socket.emitWithAck('game:action',{type:'pass'});
    expect(early.ok).toBe(false); if (!early.ok) expect(early.error.message).toBe('请等待发牌结束');
    const token = players[other]!.session.token; players[other]!.socket.disconnect();
    const restored = await connect(token); const synced = await restored.socket.emitWithAck('game:sync');
    expect(synced.ok).toBe(true); if (synced.ok) { expect(synced.data?.view.seat).toBe(other); expect(synced.data?.view.myHand).toEqual(views[other]!.view.myHand); expect(synced.data?.dealing?.startedAt).toBe(views[0]!.dealing?.startedAt); }
    await waitForDeal(restored.socket);
    expect((await restored.socket.emitWithAck('game:action',{type:'pass'})).ok).toBe(false);
  },DEAL_DURATION_MS + 10000);

  it('waits for humans, accepts a pass, and still runs opted-in autoplay', async () => {
    const players = await Promise.all([connect(), connect(), connect(), connect()]);
    const created = await players[0]!.socket.emitWithAck('room:create', {});
    expect(created.ok).toBe(true); if (!created.ok) return;
    for (let i=1;i<4;i++) expect((await players[i]!.socket.emitWithAck('room:join',{roomId:created.data.roomId})).ok).toBe(true);
    for (let i=0;i<4;i++) expect((await players[i]!.socket.emitWithAck('room:sit',{seat:i as 0|1|2|3})).ok).toBe(true);
    const initial = new Promise<GameUpdate>(resolve => players[0]!.socket.once('game:update',resolve));
    expect((await players[0]!.socket.emitWithAck('room:start')).ok).toBe(true);
    const first = await initial;
    expect(first.deadline).toBeNull();
    const turn = first.view.turn!;
    expect((await players[turn]!.socket.emitWithAck('game:autoplay',{on:true})).ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const duringDeal = await players[0]!.socket.emitWithAck('game:sync');
    expect(duringDeal.ok).toBe(true); if (!duringDeal.ok || !duringDeal.data) throw new Error('Missing game');
    expect(duringDeal.data.version).toBe(first.version);
    expect(duringDeal.data.dealing).not.toBeNull();
    expect((await players[turn]!.socket.emitWithAck('game:autoplay',{on:false})).ok).toBe(true);
    await waitForDeal(players[0]!.socket);
    players[turn]!.socket.disconnect();
    await new Promise(resolve => setTimeout(resolve, 1200));
    const observer = players[(turn+1)%4]!.socket;
    const waiting = await observer.emitWithAck('game:sync');
    expect(waiting.ok).toBe(true); if (!waiting.ok || !waiting.data) throw new Error('Missing game');
    expect(waiting.data.version).toBe(first.version);
    expect(waiting.data.deadline).toBeNull();

    const restored = await connect(players[turn]!.session.token);
    const synced = await restored.socket.emitWithAck('game:sync');
    expect(synced.ok).toBe(true); if (!synced.ok || !synced.data) throw new Error('Missing game');
    const view = synced.data.view;
    const play = interpret([view.myHand[0]!], view.level, view.config)[0]!;
    expect((await restored.socket.emitWithAck('game:action', {type:'play', cards:play.cards, combo:{type:play.combo.type,key:play.combo.key,...(play.combo.suit ? {suit:play.combo.suit} : {})}, wildAssignments:play.wildAssignments})).ok).toBe(true);
    const follower = players[(turn+1)%4]!.socket;
    expect((await follower.emitWithAck('game:action',{type:'pass'})).ok).toBe(true);
    const logged = readFileSync(logPath, 'utf8');
    expect(logged).toContain('# 出牌记录：第 1 局');
    expect(logged).toContain(`座位 ${turn}） 出牌：${cardLabel(play.cards[0]!)}（ID ${play.cards[0]}）`);
    expect(logged).toContain(`座位 ${(turn+1)%4}） 不要`);
    expect(logged.indexOf('出牌：')).toBeLessThan(logged.indexOf('不要'));
    const logResponse = await fetch(`http://127.0.0.1:${port}/api/played-cards-log`);
    expect(logResponse.status).toBe(200);
    expect(await logResponse.json()).toEqual({ format: 'markdown', content: logged });
    const afterPass = await observer.emitWithAck('game:sync');
    expect(afterPass.ok).toBe(true); if (!afterPass.ok || !afterPass.data) throw new Error('Missing game');
    expect(afterPass.data.view.trick?.passed).toContain((turn+1)%4);
    const autoSeat = afterPass.data.view.turn!;
    const advanced = new Promise<GameUpdate>((resolve, reject) => {
      const timeout = setTimeout(() => { observer.off('game:update', onUpdate); reject(new Error('Autoplay did not act')); }, 5000);
      const onUpdate = (update: GameUpdate) => { if (update.version > afterPass.data!.version) { clearTimeout(timeout); observer.off('game:update', onUpdate); resolve(update); } };
      observer.on('game:update', onUpdate);
    });
    expect((await players[autoSeat]!.socket.emitWithAck('game:autoplay',{on:true})).ok).toBe(true);
    const automated = await advanced;
    expect(automated.version).toBeGreaterThan(afterPass.data.version);
    const action = automated.events.find(event => (event.type === 'played' || event.type === 'passed') && event.seat === autoSeat);
    expect(action).toBeDefined();
    expect(readFileSync(logPath, 'utf8')).toContain(`座位 ${autoSeat}） ${action?.type === 'played' ? '出牌：' : '不要'}`);
  },DEAL_DURATION_MS + 10000);
});
