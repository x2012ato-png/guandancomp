import { randomBytes } from 'node:crypto';
import {
  DEFAULT_RULES,
  SEATS,
  beats,
  cardLabel,
  createGame,
  interpret,
  legalActions,
  partnerOf,
  pendingActors,
  rankLabel,
  reduce,
  resolvePlay,
  teamOf,
  toPlayerView,
  type CardId,
  type GameAction,
  type GameState,
  type Play,
  type RulesConfig,
  type ScopedEvent,
  type Seat,
} from '@guandan/engine';
import {
  analyzeAdvancedPlay,
  createAdvancedPolicy,
  createBeginnerPolicy,
  decisionToAction,
  type AIDecision,
  type AIPolicy,
} from '@guandan/ai';
import type { BotKind, CoachAdvice } from '@guandan/protocol';
import { formatPlay, parseHandInput, type PlayCategory } from './cardsText.ts';

const beginnerPolicy = createBeginnerPolicy();
const coachPolicy = createAdvancedPolicy({ search: false });

export interface DiscordSeatSlot {
  readonly seat: Seat;
  userId: string;
  username: string;
  bot: boolean;
  botKind: BotKind | null;
  auto: boolean;
}

export interface PlayerUiState {
  category: PlayCategory;
  page: number;
  /** 当玩家手动输入选牌存在多种合法牌型解释（如逢人配歧义）时暂存 */
  pendingInterpretations: readonly Play[] | null;
}

export interface DiscordRoom {
  readonly channelId: string;
  hostId: string;
  hostName: string;
  readonly config: RulesConfig;
  seats: [DiscordSeatSlot | null, DiscordSeatSlot | null, DiscordSeatSlot | null, DiscordSeatSlot | null];
  game: GameState | null;
  version: number;
  /** 频道内置顶/最新桌面消息的 ID，用于原地编辑更新桌面 */
  tableMessageId: string | null;
  /** 最近几条公开事件摘要，展示在公共牌桌 Embed 上 */
  recentLog: string[];
  /** 每位玩家的私密手牌面板筛选与分页状态 */
  readonly uiState: Map<string, PlayerUiState>;
}

export type RoomOpResult<T = DiscordRoom> =
  | { readonly ok: true; readonly room: T; readonly message?: string }
  | { readonly ok: false; readonly error: string };

export const SEAT_NAMES: Record<Seat, string> = {
  0: '1号位(红·东)',
  1: '2号位(蓝·南)',
  2: '3号位(红·西)',
  3: '4号位(蓝·北)',
};

export function seatDisplay(room: DiscordRoom, seat: Seat, mention = true): string {
  const slot = room.seats[seat];
  if (!slot) return `${SEAT_NAMES[seat]} [空位]`;
  if (slot.bot) return `${SEAT_NAMES[seat]} 🤖${slot.username}`;
  return `${SEAT_NAMES[seat]} ${mention ? `<@${slot.userId}>` : slot.username}`;
}

export function seatShortName(room: DiscordRoom, seat: Seat): string {
  const slot = room.seats[seat];
  if (!slot) return `${seat + 1}号位`;
  return `${seat + 1}号位(${slot.username})`;
}

export function getUiState(room: DiscordRoom, userId: string): PlayerUiState {
  let st = room.uiState.get(userId);
  if (!st) {
    st = { category: 'all', page: 0, pendingInterpretations: null };
    room.uiState.set(userId, st);
  }
  return st;
}

export function resetUiState(room: DiscordRoom, userId?: string): void {
  if (userId) {
    room.uiState.set(userId, { category: 'all', page: 0, pendingInterpretations: null });
    return;
  }
  for (const k of room.uiState.keys()) {
    room.uiState.set(k, { category: 'all', page: 0, pendingInterpretations: null });
  }
}

function appendEventsToLog(room: DiscordRoom, events: readonly ScopedEvent[]): void {
  if (!room.game) return;
  const level = room.game.level;
  for (const scoped of events) {
    const ev = scoped.event;
    switch (ev.type) {
      case 'handStarted':
        room.recentLog.push(`🎬 **第 ${ev.handNo} 局开始**！本局级牌：**${rankLabel(ev.level)}**（逢人配 ♥${rankLabel(ev.level)}✨）`);
        break;
      case 'antiTribute':
        room.recentLog.push(`🛡️ **抗贡**！${ev.seats.map((s) => seatShortName(room, s)).join('、')} 抓到双大王抗贡，直接由头游首出`);
        break;
      case 'tributeRequired':
        room.recentLog.push(
          `🎁 进入**${ev.kind === 'double' ? '双下进贡' : '单下进贡'}**阶段，等待 ${ev.payers.map((s) => seatShortName(room, s)).join('、')} 进贡`,
        );
        break;
      case 'tributePaid':
        room.recentLog.push(`📤 ${seatShortName(room, ev.from)} 进贡了 **${cardLabel(ev.card)}**`);
        break;
      case 'tributeAssigned':
        for (const l of ev.links) {
          room.recentLog.push(`📥 ${seatShortName(room, l.to)} 收到 ${seatShortName(room, l.from)} 的贡牌 **${cardLabel(l.card)}**`);
        }
        break;
      case 'tributeReturned':
        room.recentLog.push(
          `🔄 ${seatShortName(room, ev.from)} 向 ${seatShortName(room, ev.to)} 完成还贡${ev.card !== null && room.config.publicReturnCard ? ` (**${cardLabel(ev.card)}**)` : ''}`,
        );
        break;
      case 'played':
        room.recentLog.push(`🃏 ${seatShortName(room, ev.seat)} 出牌：${formatPlay(ev.play, level)}`);
        break;
      case 'passed':
        room.recentLog.push(`⏭️ ${seatShortName(room, ev.seat)} 不要`);
        break;
      case 'trickWon':
        room.recentLog.push(
          `👑 ${seatShortName(room, ev.seat)} 赢得本轮${ev.jiefeng ? `，对家 **${seatShortName(room, ev.leader)} 接风**首出` : `，继续首出`}`,
        );
        break;
      case 'playerFinished': {
        const badge = ['🏆头游', '🥈二游', '🥉三游', '末游'][ev.place - 1] ?? `第${ev.place}名`;
        room.recentLog.push(`🎉 ${seatShortName(room, ev.seat)} 出完手牌，夺得 **${badge}**！`);
        break;
      }
      case 'handOver': {
        const r = ev.result;
        const teamName = r.winTeam === 0 ? '🔴红队(1/3号)' : '🔵蓝队(2/4号)';
        const upText = r.upgrade === 3 ? '双下升 3 级' : r.upgrade === 2 ? '升 2 级' : '升 1 级';
        room.recentLog.push(
          `🏁 **第 ${r.handNo} 局结束**：${teamName} 获胜（${upText}），级牌更新为 红队 **${rankLabel(r.levelsAfter[0])}** : 蓝队 **${rankLabel(r.levelsAfter[1])}**`,
        );
        break;
      }
      case 'matchOver': {
        const teamName = ev.winner === 0 ? '🔴红队(1/3号)' : '🔵蓝队(2/4号)';
        room.recentLog.push(`🏆🎊 **整场比赛结束！恭喜 ${teamName} 成功过 A 夺冠！**`);
        break;
      }
    }
  }
  if (room.recentLog.length > 10) {
    room.recentLog = room.recentLog.slice(-10);
  }
}

export class DiscordRoomManager {
  private readonly rooms = new Map<string, DiscordRoom>();

  getRoom(channelId: string): DiscordRoom | null {
    return this.rooms.get(channelId) ?? null;
  }

  createOrGetRoom(
    channelId: string,
    hostId: string,
    hostName: string,
    config: RulesConfig = DEFAULT_RULES,
  ): DiscordRoom {
    const existing = this.rooms.get(channelId);
    if (existing) return existing;
    const room: DiscordRoom = {
      channelId,
      hostId,
      hostName,
      config,
      seats: [null, null, null, null],
      game: null,
      version: 0,
      tableMessageId: null,
      recentLog: [],
      uiState: new Map(),
    };
    room.seats[0] = {
      seat: 0,
      userId: hostId,
      username: hostName,
      bot: false,
      botKind: null,
      auto: false,
    };
    this.rooms.set(channelId, room);
    return room;
  }

  deleteRoom(channelId: string): boolean {
    return this.rooms.delete(channelId);
  }

  seatOfUser(room: DiscordRoom, userId: string): Seat | null {
    const idx = room.seats.findIndex((s) => s !== null && !s.bot && s.userId === userId);
    return idx < 0 ? null : (idx as Seat);
  }

  sit(channelId: string, userId: string, username: string, seat: Seat): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room) return { ok: false, error: '当前频道还没有牌桌，请先使用 `/guandan create` 创建牌桌' };
    if (room.game && room.game.phase !== 'matchOver') {
      return { ok: false, error: '游戏已经开始，无法更换座位' };
    }
    const target = room.seats[seat];
    if (target && !target.bot && target.userId !== userId) {
      return { ok: false, error: `${SEAT_NAMES[seat]} 已被 ${target.username} 占用` };
    }
    const prevSeat = this.seatOfUser(room, userId);
    if (prevSeat !== null) {
      room.seats[prevSeat] = null;
    }
    room.seats[seat] = {
      seat,
      userId,
      username,
      bot: false,
      botKind: null,
      auto: false,
    };
    room.version++;
    return { ok: true, room, message: `已入座 **${SEAT_NAMES[seat]}**` };
  }

  stand(channelId: string, userId: string): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room) return { ok: false, error: '当前频道没有牌桌' };
    if (room.game && room.game.phase !== 'matchOver') {
      return { ok: false, error: '对局进行中无法离座（可使用托管或重开牌桌）' };
    }
    const seat = this.seatOfUser(room, userId);
    if (seat === null) return { ok: false, error: '你当前不在任何座位上' };
    room.seats[seat] = null;
    room.version++;
    return { ok: true, room, message: `已离开 **${SEAT_NAMES[seat]}**` };
  }

  fillBots(channelId: string, mode: 'standard' | 'coach_partner' = 'coach_partner'): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room) return { ok: false, error: '当前频道没有牌桌' };
    if (room.game && room.game.phase !== 'matchOver') {
      return { ok: false, error: '游戏已经开始' };
    }

    const humanSeats = SEATS.filter((s) => room.seats[s] && !room.seats[s]!.bot);
    const coachSeats = new Set<Seat>();
    if (mode === 'coach_partner') {
      for (const hs of humanSeats) {
        const partner = partnerOf(hs);
        if (!room.seats[partner]) coachSeats.add(partner);
      }
    }

    let added = 0;
    for (const s of SEATS) {
      if (!room.seats[s]) {
        const botKind: BotKind = coachSeats.has(s) ? 'coach' : 'beginner';
        room.seats[s] = {
          seat: s,
          userId: `bot:${s}:${randomBytes(4).toString('hex')}`,
          username: `${botKind === 'coach' ? 'AI教练' : 'AI选手'}${s + 1}`,
          bot: true,
          botKind,
          auto: true,
        };
        added++;
      }
    }
    room.version++;
    return {
      ok: true,
      room,
      message: added > 0 ? `已为 ${added} 个空位补齐 AI（对家优先配置为 AI教练）` : '四个座位已满',
    };
  }

  clearBots(channelId: string): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room) return { ok: false, error: '当前频道没有牌桌' };
    if (room.game && room.game.phase !== 'matchOver') {
      return { ok: false, error: '游戏进行中不能移除 AI' };
    }
    for (const s of SEATS) {
      if (room.seats[s]?.bot) room.seats[s] = null;
    }
    room.version++;
    return { ok: true, room, message: '已移除所有 AI' };
  }

  startGame(channelId: string, seed: number | string = randomBytes(16).toString('hex')): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room) return { ok: false, error: '当前频道没有牌桌' };
    if (room.seats.some((s) => s === null)) {
      this.fillBots(channelId, 'coach_partner');
    }
    if (!room.seats.some((s) => s !== null && !s.bot)) {
      return { ok: false, error: '至少需要 1 名真人玩家入座才能开局' };
    }
    const base = createGame(room.config, seed);
    const started = reduce(base, { type: 'startHand' });
    if (!started.ok) return { ok: false, error: started.error.message };
    room.game = started.state;
    room.recentLog = [];
    resetUiState(room);
    appendEventsToLog(room, started.events);
    this.drainBots(room);
    room.version++;
    return { ok: true, room };
  }

  nextHand(channelId: string): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room || !room.game) return { ok: false, error: '游戏尚未开始' };
    if (room.game.phase !== 'handOver') {
      return { ok: false, error: '当前不在局间结算阶段' };
    }
    const res = reduce(room.game, { type: 'startHand' });
    if (!res.ok) return { ok: false, error: res.error.message };
    room.game = res.state;
    room.recentLog = [];
    resetUiState(room);
    appendEventsToLog(room, res.events);
    this.drainBots(room);
    room.version++;
    return { ok: true, room };
  }

  applyPlayerAction(channelId: string, userId: string, action: GameAction): RoomOpResult {
    const room = this.rooms.get(channelId);
    if (!room || !room.game) return { ok: false, error: '游戏尚未开始' };
    const seat = this.seatOfUser(room, userId);
    if (seat === null) return { ok: false, error: '你不在本桌座位上' };
    if ('seat' in action && action.seat !== seat) {
      return { ok: false, error: '座位不匹配' };
    }
    const res = reduce(room.game, action);
    if (!res.ok) {
      return { ok: false, error: res.error.message };
    }
    room.game = res.state;
    resetUiState(room, userId);
    appendEventsToLog(room, res.events);
    this.drainBots(room);
    room.version++;
    return { ok: true, room };
  }

  /**
   * 玩家通过文本/Modal输入牌面或编号出牌（若存在多种合法牌型解释，暂存到 uiState 供下拉菜单消歧）
   */
  playFromTextInput(
    channelId: string,
    userId: string,
    rawInput: string,
  ):
    | { readonly ok: true; readonly status: 'played'; readonly room: DiscordRoom; readonly playText: string }
    | { readonly ok: true; readonly status: 'ambiguous'; readonly room: DiscordRoom; readonly options: readonly Play[] }
    | { readonly ok: false; readonly error: string } {
    const room = this.rooms.get(channelId);
    if (!room || !room.game) return { ok: false, error: '游戏尚未开始' };
    const seat = this.seatOfUser(room, userId);
    if (seat === null) return { ok: false, error: '你不在本桌座位上' };
    const game = room.game;
    const hand = game.hands[seat];

    const parsed = parseHandInput(rawInput, hand, game.level);
    if (!parsed.ok) {
      return { ok: false, error: parsed.message };
    }

    if (game.phase === 'tribute' || game.phase === 'return') {
      if (parsed.cards.length !== 1) {
        return { ok: false, error: '进贡或还贡只能选择 1 张牌' };
      }
      const card = parsed.cards[0]!;
      const action: GameAction =
        game.phase === 'tribute' ? { type: 'tribute', seat, card } : { type: 'returnTribute', seat, card };
      const res = this.applyPlayerAction(channelId, userId, action);
      if (!res.ok) return res;
      return { ok: true, status: 'played', room, playText: cardLabel(card) };
    }

    if (game.phase !== 'playing' || !game.trick) {
      return { ok: false, error: '当前不是出牌阶段' };
    }
    if (game.turn !== seat) {
      return { ok: false, error: '还没轮到你出牌' };
    }

    const toBeat = game.trick.lastPlay?.play.combo ?? null;
    const resolved = resolvePlay(parsed.cards, game.level, game.config, { toBeat });
    if (!resolved.ok) {
      if (resolved.error.code === 'AMBIGUOUS_COMBO') {
        const allCandidates = interpret(parsed.cards, game.level, game.config);
        const candidates = toBeat ? allCandidates.filter((p) => beats(p.combo, toBeat)) : allCandidates;
        const ui = getUiState(room, userId);
        ui.pendingInterpretations = candidates;
        return { ok: true, status: 'ambiguous', room, options: candidates };
      }
      return { ok: false, error: resolved.error.message };
    }

    const p = resolved.play;
    const playText = formatPlay(p, game.level);
    const res = this.applyPlayerAction(channelId, userId, {
      type: 'play',
      seat,
      cards: p.cards,
      combo: { type: p.combo.type, key: p.combo.key, ...(p.combo.suit ? { suit: p.combo.suit } : {}) },
      wildAssignments: p.wildAssignments,
    });
    if (!res.ok) return res;
    return { ok: true, status: 'played', room, playText };
  }

  /**
   * 获取当前轮到行动的真人玩家的 AI 教练建议（无论对家是否为 AI 教练，在 Discord 中都可以随时点击查看建议）
   */
  getAdviceForUser(channelId: string, userId: string): { ok: true; advice: CoachAdvice; decision: AIDecision } | { ok: false; error: string } {
    const room = this.rooms.get(channelId);
    if (!room || !room.game) return { ok: false, error: '游戏尚未开始' };
    const seat = this.seatOfUser(room, userId);
    if (seat === null) return { ok: false, error: '你不在本桌座位上' };
    const view = toPlayerView(room.game, seat);
    if (!view.myDuty) {
      return { ok: false, error: '当前还没轮到你行动' };
    }
    if (view.myDuty === 'play') {
      const analysis = analyzeAdvancedPlay(view, { search: false });
      if (analysis) {
        const decision: AIDecision =
          analysis.decision.type === 'pass'
            ? { type: 'pass' }
            : { type: 'play', play: analysis.decision.play };
        return { ok: true, advice: analysis, decision };
      }
    }
    const decision = coachPolicy.decide(view);
    if (!decision) return { ok: false, error: '当前没有可用建议' };
    const fallbackAdvice: CoachAdvice = {
      decision: decision.type === 'play' ? { type: 'play', play: decision.play } : { type: 'pass' },
      reasons: ['按当前手牌结构推荐最优解'],
    };
    return { ok: true, advice: fallbackAdvice, decision };
  }

  /**
   * 自动执行所有当前轮到行动的 AI（或托管玩家）动作，直到需要真人玩家行动或本局结束。
   */
  drainBots(room: DiscordRoom): number {
    let steps = 0;
    const maxSteps = 200;
    while (room.game && steps < maxSteps) {
      const actors = pendingActors(room.game);
      const botSeat = actors.find((s) => {
        const slot = room.seats[s];
        return slot !== null && (slot.bot || slot.auto);
      });
      if (botSeat === undefined) break;

      const slot = room.seats[botSeat]!;
      const policy: AIPolicy = slot.bot && slot.botKind === 'coach' ? coachPolicy : beginnerPolicy;
      const view = toPlayerView(room.game, botSeat);
      let decision = policy.decide(view);
      if (!decision) {
        const fallback = legalActions(room.game, botSeat)[0];
        if (!fallback) break;
        const res = reduce(room.game, fallback);
        if (!res.ok) break;
        room.game = res.state;
        appendEventsToLog(room, res.events);
        steps++;
        continue;
      }

      const action = decisionToAction(botSeat, decision);
      const res = reduce(room.game, action);
      if (!res.ok) break;
      room.game = res.state;
      appendEventsToLog(room, res.events);
      steps++;
    }
    return steps;
  }
}
