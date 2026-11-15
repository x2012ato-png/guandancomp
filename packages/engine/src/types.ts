/**
 * 规则引擎的全部公开类型。
 * 约定：所有状态对象均为只读（readonly），reducer 只返回新对象，不修改入参。
 */
import type { CardId, Level, NaturalRank, Suit } from './cards.ts';
import type { RulesConfig } from './config.ts';
import type { RngState } from './rng.ts';

/* ───────────────────────── 座位与队伍 ───────────────────────── */

/** 座位 0..3，出牌顺序为 0→1→2→3→0（「下家」= seat+1） */
export type Seat = 0 | 1 | 2 | 3;
/** 0 号队 = 座位 0、2；1 号队 = 座位 1、3（对家为队友） */
export type Team = 0 | 1;
export const SEATS: readonly Seat[] = [0, 1, 2, 3];

/* ───────────────────────── 牌型 ───────────────────────── */

export type ComboType =
  | 'single' //   单张
  | 'pair' //     对子
  | 'triple' //   三同张
  | 'fullHouse' // 三带二（以三张比较）
  | 'straight' // 顺子（恰好 5 张，A 可作 1 或 14，级牌按自然点数）
  | 'tube' //     连对/三连对（恰好 3 对）
  | 'plate' //    钢板（恰好 2 个连续三张）
  | 'bomb' //     4–8 张同点炸弹
  | 'straightFlush' // 同花顺
  | 'jokerBomb'; //   天王炸（4 王）

export interface Combo {
  readonly type: ComboType;
  /**
   * 比较键：
   *  - 同点类（single/pair/triple/bomb/fullHouse 的三张）：rankPower（级牌=15，小王16，大王17）
   *  - 序列类（straight/tube/plate/straightFlush）：最高张的自然点数，A 作 1 时最高张为 5/3/2
   */
  readonly key: number;
  /** 牌张数 */
  readonly size: number;
  /** 仅同花顺 */
  readonly suit?: Suit;
}

/** 用于客户端声明「我要按哪种牌型出」 */
export interface ComboSignature {
  readonly type: ComboType;
  readonly key: number;
  readonly suit?: Suit;
}

/** 逢人配替换：某张红桃级牌在本手中代表哪张牌 */
export interface WildAssignment {
  readonly cardId: CardId;
  readonly rank: NaturalRank;
  readonly suit: Suit;
}

/**
 * 一手具体出牌。合法动作生成（generatePlays / interpret）返回的 Play
 * 显式携带 wildAssignments：每张逢人配都有一条记录（代表自身时 rank=级牌, suit='H'）。
 */
export interface Play {
  readonly cards: readonly CardId[];
  readonly combo: Combo;
  readonly wildAssignments: readonly WildAssignment[];
}

/* ───────────────────────── 动作 ───────────────────────── */

export type GameAction =
  | { readonly type: 'startHand' }
  | { readonly type: 'tribute'; readonly seat: Seat; readonly card: CardId }
  | { readonly type: 'returnTribute'; readonly seat: Seat; readonly card: CardId }
  | {
      readonly type: 'play';
      readonly seat: Seat;
      readonly cards: readonly CardId[];
      /** 选牌有多种解释（逢人配 / 同花顺可当顺子）时必须声明 */
      readonly combo?: ComboSignature;
      /** 可选：客户端自行给出的替换方案，服务端会独立校验 */
      readonly wildAssignments?: readonly WildAssignment[];
    }
  | { readonly type: 'pass'; readonly seat: Seat };

/* ───────────────────────── 状态 ───────────────────────── */

export type Phase =
  | 'waiting' //  尚未开始第一局
  | 'tribute' //  进贡
  | 'return' //   还贡
  | 'playing' //  出牌
  | 'handOver' // 一局结束，等待下一局
  | 'matchOver'; // 过 A，整场结束

export interface TrickEntry {
  readonly seat: Seat;
  readonly play: Play | null; // null = 不要
}

export interface TrickState {
  /** 本轮首出者 */
  readonly leader: Seat;
  /** 本轮当前最大的一手；null 表示轮到 leader 首出 */
  readonly lastPlay: { readonly seat: Seat; readonly play: Play } | null;
  /** 自 lastPlay 之后已「不要」的座位 */
  readonly passed: readonly Seat[];
  /** 本轮出牌记录（公开） */
  readonly history: readonly TrickEntry[];
}

export interface TributeLink {
  readonly from: Seat;
  readonly to: Seat;
  readonly card: CardId;
  readonly returnCard: CardId | null;
}

export interface TributeState {
  readonly kind: 'single' | 'double';
  readonly payers: readonly Seat[];
  /** single: [头游]；double: [头游, 二游] */
  readonly receivers: readonly Seat[];
  /** 已交出的贡牌（交出即公开） */
  readonly paid: readonly { readonly from: Seat; readonly card: CardId }[];
  /** 全部交齐后生成的进贡→还贡对应关系 */
  readonly links: readonly TributeLink[];
}

export interface HandResult {
  readonly handNo: number;
  readonly level: Level;
  readonly levelTeam: Team | null;
  /** 头游、二游、三游、末游 */
  readonly finishOrder: readonly Seat[];
  readonly winTeam: Team;
  /** +3 双下 / +2 / +1 */
  readonly upgrade: 1 | 2 | 3;
  readonly levelsBefore: readonly [Level, Level];
  readonly levelsAfter: readonly [Level, Level];
  readonly aFailsAfter: readonly [number, number];
  /** 打 A 失败达到上限被打回 2 的队伍 */
  readonly aResetTeam: Team | null;
  readonly matchWinner: Team | null;
}

export interface GameState {
  readonly config: RulesConfig;
  /** 隐藏信息：绝不进入 PlayerView */
  readonly rng: RngState;
  readonly phase: Phase;
  readonly handNo: number;
  readonly teamLevels: readonly [Level, Level];
  readonly aFails: readonly [number, number];
  /** 本局级牌 */
  readonly level: Level;
  /** 本局打的是哪一队的级（首局为 null，双方都打 2） */
  readonly levelTeam: Team | null;
  readonly hands: readonly [readonly CardId[], readonly CardId[], readonly CardId[], readonly CardId[]];
  readonly turn: Seat | null;
  readonly trick: TrickState | null;
  /** 上一轮的公开出牌和不要记录。 */
  readonly previousTrick?: TrickState | null;
  /** 本局全部公开出牌和不要，用于战术推断。 */
  readonly publicHistory?: readonly TrickEntry[];
  readonly finishOrder: readonly Seat[];
  /** 本局已打出的牌（公开） */
  readonly playedCards: readonly CardId[];
  readonly tribute: TributeState | null;
  /** 本局是否抗贡 */
  readonly antiTribute: readonly Seat[] | null;
  readonly lastResult: HandResult | null;
  readonly matchWinner: Team | null;
}

/* ───────────────────────── 事件 ───────────────────────── */

export type GameEvent =
  | { readonly type: 'handStarted'; readonly handNo: number; readonly level: Level; readonly levelTeam: Team | null }
  | { readonly type: 'antiTribute'; readonly seats: readonly Seat[] }
  | { readonly type: 'tributeRequired'; readonly kind: 'single' | 'double'; readonly payers: readonly Seat[] }
  | { readonly type: 'tributePaid'; readonly from: Seat; readonly card: CardId }
  | { readonly type: 'tributeAssigned'; readonly links: readonly { from: Seat; to: Seat; card: CardId }[] }
  | { readonly type: 'tributeReturned'; readonly from: Seat; readonly to: Seat; readonly card: CardId | null }
  | { readonly type: 'played'; readonly seat: Seat; readonly play: Play }
  | { readonly type: 'passed'; readonly seat: Seat }
  | { readonly type: 'trickWon'; readonly seat: Seat; readonly leader: Seat; readonly jiefeng: boolean }
  | { readonly type: 'playerFinished'; readonly seat: Seat; readonly place: number }
  | { readonly type: 'handOver'; readonly result: HandResult }
  | { readonly type: 'matchOver'; readonly winner: Team };

/**
 * 带可见性的事件。visibleTo='all' 为公开事件；否则只发给列出的座位，
 * 其他座位收到 redacted 版本（若有）。
 */
export interface ScopedEvent {
  readonly event: GameEvent;
  readonly visibleTo: 'all' | readonly Seat[];
  readonly redacted?: GameEvent;
}

export type RuleErrorCode =
  | 'WRONG_PHASE'
  | 'NOT_YOUR_TURN'
  | 'CARD_NOT_IN_HAND'
  | 'DUPLICATE_CARD'
  | 'INVALID_COMBO'
  | 'AMBIGUOUS_COMBO'
  | 'BAD_WILD_ASSIGNMENT'
  | 'CANNOT_BEAT'
  | 'CANNOT_PASS_ON_LEAD'
  | 'NOT_A_PAYER'
  | 'ALREADY_DONE'
  | 'INVALID_TRIBUTE_CARD'
  | 'INVALID_RETURN_CARD'
  | 'BAD_ACTION';

export interface RuleError {
  readonly code: RuleErrorCode;
  readonly message: string;
}

export type ReduceResult =
  | { readonly ok: true; readonly state: GameState; readonly events: readonly ScopedEvent[] }
  | { readonly ok: false; readonly error: RuleError };

/* ───────────────────────── 玩家视图 ───────────────────────── */

export interface TributeView {
  readonly kind: 'single' | 'double';
  readonly payers: readonly Seat[];
  readonly receivers: readonly Seat[];
  readonly paid: readonly { readonly from: Seat; readonly card: CardId }[];
  /** 私密还贡时，returnCard 仅对进贡/还贡双方可见，其他人只看到 returned=true */
  readonly links: readonly { from: Seat; to: Seat; card: CardId; returned: boolean; returnCard: CardId | null }[];
}

export type PendingDuty = 'play' | 'tribute' | 'return' | null;

/** 服务端发给每位玩家的唯一游戏数据：自己手牌 + 对手张数 + 公开信息 */
export interface PlayerView {
  readonly seat: Seat;
  readonly config: RulesConfig;
  readonly phase: Phase;
  readonly handNo: number;
  readonly teamLevels: readonly [Level, Level];
  readonly aFails: readonly [number, number];
  readonly level: Level;
  readonly levelTeam: Team | null;
  readonly myHand: readonly CardId[];
  readonly handCounts: readonly [number, number, number, number];
  readonly turn: Seat | null;
  readonly trick: TrickState | null;
  readonly previousTrick?: TrickState | null;
  readonly publicHistory?: readonly TrickEntry[];
  readonly finishOrder: readonly Seat[];
  readonly playedCards: readonly CardId[];
  readonly tribute: TributeView | null;
  readonly antiTribute: readonly Seat[] | null;
  readonly myDuty: PendingDuty;
  readonly lastResult: HandResult | null;
  readonly matchWinner: Team | null;
}
