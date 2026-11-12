/**
 * Socket.IO 通信协议（客户端与服务端共享的类型）。
 *
 * 原则：
 *  - 客户端永远不发送 seat，服务端根据会话确定座位；
 *  - 服务端只发送 PlayerView（经 toPlayerView 投影）与按座位过滤的事件；
 *  - 每次状态变化 version+1，客户端丢弃旧版本，发现跳号时调用 game:sync 全量同步。
 */
import type {
  CardId,
  ComboSignature,
  GameEvent,
  PlayerView,
  RulesConfig,
  Seat,
  WildAssignment,
} from '@guandan/engine';

export const DEFAULT_ROOM_ID = '666888';

export type ErrorCode =
  | 'RATE_LIMITED'
  | 'BAD_REQUEST'
  | 'NO_SESSION'
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'SEAT_TAKEN'
  | 'NOT_HOST'
  | 'NOT_SEATED'
  | 'NOT_IN_ROOM'
  | 'ALREADY_STARTED'
  | 'NOT_STARTED'
  | 'RULE_VIOLATION';

export type Ack<T = null> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly error: { readonly code: ErrorCode | string; readonly message: string } };

export type AckFn<T = null> = (res: Ack<T>) => void;

export interface HandshakeAuth {
  /** 断线重连凭证（首次连接为空，服务端在 session 事件中下发） */
  readonly token?: string;
  readonly nickname?: string;
}

export interface SessionInfo {
  readonly playerId: string;
  readonly token: string;
  readonly nickname: string;
  readonly roomId: string | null;
}

export type SeatKind = 'empty' | 'human' | 'bot';

export interface SeatInfo {
  readonly seat: Seat;
  readonly kind: SeatKind;
  readonly nickname: string | null;
  readonly playerId: string | null;
  readonly connected: boolean;
  /** 托管中（由 AI 代打） */
  readonly autoPlay: boolean;
  readonly readyForNext: boolean;
}

export type RoomStatus = 'lobby' | 'playing' | 'finished';

export interface RoomSnapshot {
  readonly roomId: string;
  readonly hostId: string;
  readonly status: RoomStatus;
  readonly seats: readonly [SeatInfo, SeatInfo, SeatInfo, SeatInfo];
  readonly members: readonly { playerId: string; nickname: string; connected: boolean }[];
  readonly config: RulesConfig;
  readonly you: { readonly playerId: string; readonly seat: Seat | null };
}

export const CHAT_MESSAGE_MAX_LENGTH = 300;
export const CHAT_HISTORY_LIMIT = 100;

export interface ChatMessage {
  readonly id: string;
  readonly roomId: string;
  readonly playerId: string;
  readonly nickname: string;
  readonly text: string;
  readonly sentAt: number;
}

/** 客户端提交的游戏动作（不含 seat） */
export type ClientGameAction =
  | { readonly type: 'tribute'; readonly card: CardId }
  | { readonly type: 'returnTribute'; readonly card: CardId }
  | {
      readonly type: 'play';
      readonly cards: readonly CardId[];
      readonly combo?: ComboSignature;
      readonly wildAssignments?: readonly WildAssignment[];
    }
  | { readonly type: 'pass' };

export interface GameUpdate {
  readonly roomId: string;
  readonly version: number;
  readonly view: PlayerView;
  /** 自上个版本以来本座位可见的事件（全量同步时为空） */
  readonly events: readonly GameEvent[];
  /** 当前行动截止时间（毫秒时间戳），无限时为 null */
  readonly deadline: number | null;
  /** 开局动画的服务端时间，重连时用于恢复进度。 */
  readonly dealing: { readonly startedAt: number; readonly serverNow: number } | null;
}

export const DEAL_ANIMATION = { shuffleMs: 2000, cardMs: 910, cardsPerPlayer: 27 } as const;
export const DEAL_DURATION_MS = DEAL_ANIMATION.shuffleMs + DEAL_ANIMATION.cardMs * DEAL_ANIMATION.cardsPerPlayer;

export interface ClientToServerEvents {
  'room:create': (p: { config?: Partial<RulesConfig> }, ack: AckFn<RoomSnapshot>) => void;
  'room:join': (p: { roomId: string }, ack: AckFn<RoomSnapshot>) => void;
  'room:leave': (ack: AckFn) => void;
  'room:sit': (p: { seat: Seat }, ack: AckFn) => void;
  'room:stand': (ack: AckFn) => void;
  'room:addBot': (p: { seat: Seat }, ack: AckFn) => void;
  'room:removeBot': (p: { seat: Seat }, ack: AckFn) => void;
  'room:start': (ack: AckFn) => void;
  'game:action': (p: ClientGameAction, ack: AckFn) => void;
  'game:ready': (ack: AckFn) => void;
  'game:autoplay': (p: { on: boolean }, ack: AckFn) => void;
  'game:sync': (ack: AckFn<GameUpdate | null>) => void;
  'chat:send': (p: { text: string }, ack: AckFn<ChatMessage>) => void;
  'chat:history': (ack: AckFn<readonly ChatMessage[]>) => void;
  'profile:rename': (p: { nickname: string }, ack: AckFn) => void;
}

export interface ServerToClientEvents {
  session: (s: SessionInfo) => void;
  'room:state': (s: RoomSnapshot) => void;
  'room:left': () => void;
  'game:update': (u: GameUpdate) => void;
  'chat:message': (message: ChatMessage) => void;
  notice: (n: { level: 'info' | 'warn'; message: string }) => void;
}

/** 服务端调参（也供客户端展示倒计时） */
export interface ServerTuning {
  readonly botDelayMs: number;
  readonly nextHandDelayMs: number;
  readonly lobbyGraceMs: number;
  readonly roomIdleMs: number;
  readonly rate: { readonly capacity: number; readonly refillPerSec: number; readonly maxViolations: number };
}

export const DEFAULT_TUNING: ServerTuning = {
  botDelayMs: 900,
  nextHandDelayMs: 15_000,
  lobbyGraceMs: 60_000,
  roomIdleMs: 10 * 60_000,
  rate: { capacity: 20, refillPerSec: 8, maxViolations: 60 },
};
