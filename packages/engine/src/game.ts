/**
 * 掼蛋状态机（纯 reducer）。
 *
 *   waiting ──startHand──▶ playing（首局）
 *   handOver ─startHand─▶ tribute ──全部进贡──▶ return ──全部还贡──▶ playing
 *                       └─(抗贡/无需进贡)──────────────────────────▶ playing
 *   playing ──一方两人出完 / 三人出完──▶ handOver | matchOver（过 A）
 *
 * reduce(state, action) 不修改入参，返回新状态 + 带可见性范围的事件。
 */
import { DECK_SIZE, isCardId, makeDeck, type CardId, type Level } from './cards.ts';
import { DEFAULT_RULES, type RulesConfig } from './config.ts';
import { beats, generatePlays, resolvePlay } from './combos.ts';
import { computeHandResult, nextSeat, partnerOf, teamOf } from './levels.ts';
import { nextInt, seedRng, shuffle } from './rng.ts';
import {
  assignTribute,
  leaderAfterTribute,
  planTribute,
  validReturnCards,
  validTributeCards,
} from './tribute.ts';
import type {
  GameAction,
  GameEvent,
  GameState,
  ReduceResult,
  RuleError,
  RuleErrorCode,
  ScopedEvent,
  Seat,
} from './types.ts';
import { SEATS } from './types.ts';

type Hands = GameState['hands'];

const err = (code: RuleErrorCode, message: string): ReduceResult => ({ ok: false, error: { code, message } });
const pub = (event: GameEvent): ScopedEvent => ({ event, visibleTo: 'all' });

export function createGame(config: RulesConfig = DEFAULT_RULES, seed: number | string = Date.now()): GameState {
  return {
    config,
    rng: seedRng(seed),
    phase: 'waiting',
    handNo: 0,
    teamLevels: [2, 2],
    aFails: [0, 0],
    level: 2,
    levelTeam: null,
    hands: [[], [], [], []],
    turn: null,
    trick: null,
    previousTrick: null,
    publicHistory: [],
    finishOrder: [],
    playedCards: [],
    tribute: null,
    antiTribute: null,
    lastResult: null,
    matchWinner: null,
  };
}

export function isActive(state: GameState, seat: Seat): boolean {
  return !state.finishOrder.includes(seat);
}

export function nextActive(state: GameState, seat: Seat): Seat {
  let s = seat;
  for (let i = 0; i < 4; i++) {
    s = nextSeat(s);
    if (isActive(state, s)) return s;
  }
  return seat;
}

function setHand(hands: Hands, seat: Seat, cards: readonly CardId[]): Hands {
  const h = [...hands] as CardId[][];
  h[seat] = [...cards];
  return h as unknown as Hands;
}

function removeCards(hand: readonly CardId[], cards: readonly CardId[]): CardId[] {
  const rm = new Set(cards);
  return hand.filter((c) => !rm.has(c));
}

function startPlaying(state: GameState, leader: Seat): GameState {
  return {
    ...state,
    phase: 'playing',
    turn: leader,
    trick: { leader, lastPlay: null, passed: [], history: [] },
  };
}

/** 当前需要行动的座位（进贡阶段可能有两人同时行动） */
export function pendingActors(state: GameState): Seat[] {
  switch (state.phase) {
    case 'tribute': {
      const t = state.tribute!;
      return t.payers.filter((s) => !t.paid.some((p) => p.from === s));
    }
    case 'return':
      return state.tribute!.links.filter((l) => l.returnCard === null).map((l) => l.to);
    case 'playing':
      return state.turn === null ? [] : [state.turn];
    default:
      return [];
  }
}

/** 列举某座位当前全部合法动作（供 AI / MCTS 使用） */
export function legalActions(state: GameState, seat: Seat): GameAction[] {
  if (!pendingActors(state).includes(seat)) return [];
  const hand = state.hands[seat];
  if (state.phase === 'tribute') {
    return validTributeCards(hand, state.level).map((card) => ({ type: 'tribute', seat, card }));
  }
  if (state.phase === 'return') {
    return validReturnCards(hand, state.level, state.config).map((card) => ({ type: 'returnTribute', seat, card }));
  }
  const toBeat = state.trick?.lastPlay?.play.combo ?? null;
  const plays = generatePlays(hand, state.level, state.config, toBeat);
  const actions: GameAction[] = plays.map((p) => ({
    type: 'play',
    seat,
    cards: p.cards,
    combo: { type: p.combo.type, key: p.combo.key, ...(p.combo.suit ? { suit: p.combo.suit } : {}) },
    wildAssignments: p.wildAssignments,
  }));
  if (toBeat) actions.push({ type: 'pass', seat });
  return actions;
}

export function reduce(state: GameState, action: GameAction): ReduceResult {
  switch (action.type) {
    case 'startHand':
      return startHand(state);
    case 'tribute':
      return payTribute(state, action.seat, action.card);
    case 'returnTribute':
      return returnTribute(state, action.seat, action.card);
    case 'play':
      return play(state, action);
    case 'pass':
      return pass(state, action.seat);
    default:
      return err('BAD_ACTION', '未知动作');
  }
}

/* ───────────────────────── 开局 / 发牌 ───────────────────────── */

function startHand(state: GameState): ReduceResult {
  if (state.phase !== 'waiting' && state.phase !== 'handOver') return err('WRONG_PHASE', '当前不能开始新的一局');
  let [deck, rng] = shuffle(makeDeck(), state.rng);
  const hands = SEATS.map((s) => deck.slice(s * 27, s * 27 + 27)) as unknown as Hands;
  const handNo = state.handNo + 1;
  const events: ScopedEvent[] = [pub({ type: 'handStarted', handNo, level: state.level, levelTeam: state.levelTeam })];
  let base: GameState = {
    ...state,
    rng,
    handNo,
    hands,
    phase: 'playing',
    turn: null,
    trick: null,
    previousTrick: null,
    publicHistory: [],
    finishOrder: [],
    playedCards: [],
    tribute: null,
    antiTribute: null,
  };

  const prev = state.lastResult;
  if (!prev) {
    let leader: Seat;
    if (state.config.firstLeader === 'random') {
      let r: number;
      [r, rng] = nextInt(rng, 4);
      leader = r as Seat;
      base = { ...base, rng };
    } else leader = state.config.firstLeader;
    return { ok: true, state: startPlaying(base, leader), events };
  }

  const plan = planTribute(prev.finishOrder, hands, state.config);
  const head = prev.finishOrder[0]!;
  if (plan.kind === 'none') return { ok: true, state: startPlaying(base, head), events };
  if (plan.kind === 'anti') {
    events.push(pub({ type: 'antiTribute', seats: plan.payers }));
    return { ok: true, state: startPlaying({ ...base, antiTribute: plan.payers }, head), events };
  }
  events.push(pub({ type: 'tributeRequired', kind: plan.kind, payers: plan.payers }));
  return {
    ok: true,
    state: {
      ...base,
      phase: 'tribute',
      tribute: { kind: plan.kind, payers: plan.payers, receivers: plan.receivers, paid: [], links: [] },
    },
    events,
  };
}

/* ───────────────────────── 进贡 / 还贡 ───────────────────────── */

function payTribute(state: GameState, seat: Seat, card: CardId): ReduceResult {
  const t = state.tribute;
  if (state.phase !== 'tribute' || !t) return err('WRONG_PHASE', '当前不是进贡阶段');
  if (!t.payers.includes(seat)) return err('NOT_A_PAYER', '你不需要进贡');
  if (t.paid.some((p) => p.from === seat)) return err('ALREADY_DONE', '已经进贡');
  const hand = state.hands[seat];
  if (!isCardId(card) || !hand.includes(card)) return err('CARD_NOT_IN_HAND', '手中没有这张牌');
  if (!validTributeCards(hand, state.level).includes(card)) {
    return err('INVALID_TRIBUTE_CARD', '必须进贡除红桃级牌外最大的单张');
  }
  let hands = setHand(state.hands, seat, removeCards(hand, [card]));
  const paid = [...t.paid, { from: seat, card }];
  const events: ScopedEvent[] = [pub({ type: 'tributePaid', from: seat, card })];
  if (paid.length < t.payers.length) {
    return { ok: true, state: { ...state, hands, tribute: { ...t, paid } }, events };
  }
  const links = assignTribute(t.kind, paid, t.receivers, t.payers, state.level, state.config);
  for (const l of links) hands = setHand(hands, l.to, [...hands[l.to], l.card]);
  events.push(pub({ type: 'tributeAssigned', links: links.map(({ from, to, card: c }) => ({ from, to, card: c })) }));
  return { ok: true, state: { ...state, hands, phase: 'return', tribute: { ...t, paid, links } }, events };
}

function returnTribute(state: GameState, seat: Seat, card: CardId): ReduceResult {
  const t = state.tribute;
  if (state.phase !== 'return' || !t) return err('WRONG_PHASE', '当前不是还贡阶段');
  const li = t.links.findIndex((l) => l.to === seat && l.returnCard === null);
  if (li < 0) {
    return t.links.some((l) => l.to === seat) ? err('ALREADY_DONE', '已经还贡') : err('NOT_A_PAYER', '你不需要还贡');
  }
  const link = t.links[li]!;
  const hand = state.hands[seat];
  if (!isCardId(card) || !hand.includes(card)) return err('CARD_NOT_IN_HAND', '手中没有这张牌');
  if (!validReturnCards(hand, state.level, state.config).includes(card)) {
    return err('INVALID_RETURN_CARD', `还贡牌点数不能大于 ${state.config.returnMaxRank}`);
  }
  let hands = setHand(state.hands, seat, removeCards(hand, [card]));
  hands = setHand(hands, link.from, [...hands[link.from], card]);
  const links = t.links.map((l, i) => (i === li ? { ...l, returnCard: card } : l));
  const ev: GameEvent = { type: 'tributeReturned', from: seat, to: link.from, card };
  const events: ScopedEvent[] = [
    state.config.publicReturnCard
      ? pub(ev)
      : { event: ev, visibleTo: [seat, link.from], redacted: { ...ev, card: null } },
  ];
  const next: GameState = { ...state, hands, tribute: { ...t, links } };
  if (links.some((l) => l.returnCard === null)) return { ok: true, state: next, events };
  const leader = leaderAfterTribute(t.kind, links, state.lastResult!.finishOrder, state.level, state.config);
  return { ok: true, state: startPlaying(next, leader), events };
}

/* ───────────────────────── 出牌 / 不要 / 接风 ───────────────────────── */

function play(state: GameState, action: Extract<GameAction, { type: 'play' }>): ReduceResult {
  const { seat } = action;
  if (state.phase !== 'playing' || !state.trick) return err('WRONG_PHASE', '当前不是出牌阶段');
  if (state.turn !== seat) return err('NOT_YOUR_TURN', '还没轮到你');
  const cards = action.cards;
  if (!Array.isArray(cards) || cards.length === 0) return err('INVALID_COMBO', '请选择要出的牌');
  if (new Set(cards).size !== cards.length) return err('DUPLICATE_CARD', '重复的牌');
  const hand = state.hands[seat];
  if (!cards.every((c) => isCardId(c) && hand.includes(c))) return err('CARD_NOT_IN_HAND', '手中没有这些牌');

  const toBeat = state.trick.lastPlay?.play.combo ?? null;
  const res = resolvePlay(cards, state.level, state.config, {
    ...(action.combo ? { combo: action.combo } : {}),
    ...(action.wildAssignments ? { wildAssignments: action.wildAssignments } : {}),
    toBeat,
  });
  if (!res.ok) return { ok: false, error: res.error };
  const p = res.play;
  if (toBeat && !beats(p.combo, toBeat)) return err('CANNOT_BEAT', '压不过上家');

  const newHand = removeCards(hand, cards);
  const events: ScopedEvent[] = [pub({ type: 'played', seat, play: p })];
  let next: GameState = {
    ...state,
    hands: setHand(state.hands, seat, newHand),
    playedCards: [...state.playedCards, ...cards],
    publicHistory: [...(state.publicHistory ?? []), { seat, play: p }],
    trick: {
      ...state.trick,
      lastPlay: { seat, play: p },
      passed: [],
      history: [...state.trick.history, { seat, play: p }],
    },
  };

  if (newHand.length === 0) {
    const finishOrder = [...next.finishOrder, seat];
    next = { ...next, finishOrder };
    events.push(pub({ type: 'playerFinished', seat, place: finishOrder.length }));
    if (finishOrder.includes(partnerOf(seat)) || finishOrder.length >= 3) {
      // 剩余玩家按出牌顺序补齐名次
      const full = [...finishOrder];
      let s = seat;
      for (let i = 0; i < 4; i++) {
        s = nextSeat(s);
        if (!full.includes(s)) full.push(s);
      }
      return finishHand({ ...next, finishOrder: full }, events);
    }
  }
  return { ok: true, state: { ...next, turn: nextActive(next, seat) }, events };
}

function pass(state: GameState, seat: Seat): ReduceResult {
  const trick = state.trick;
  if (state.phase !== 'playing' || !trick) return err('WRONG_PHASE', '当前不是出牌阶段');
  if (state.turn !== seat) return err('NOT_YOUR_TURN', '还没轮到你');
  if (!trick.lastPlay) return err('CANNOT_PASS_ON_LEAD', '首出不能不要');
  const passed = [...trick.passed, seat];
  const history = [...trick.history, { seat, play: null }];
  const publicHistory = [...(state.publicHistory ?? []), { seat, play: null }];
  const events: ScopedEvent[] = [pub({ type: 'passed', seat })];
  const last = trick.lastPlay.seat;
  const others = SEATS.filter((s) => s !== last && isActive(state, s));
  if (others.every((s) => passed.includes(s))) {
    // 一轮结束：出牌者若已出完，则由其对家接风
    let leader: Seat;
    const jiefeng = !isActive(state, last);
    if (!jiefeng) leader = last;
    else if (isActive(state, partnerOf(last))) leader = partnerOf(last);
    else leader = nextActive(state, last);
    events.push(pub({ type: 'trickWon', seat: last, leader, jiefeng }));
    return {
      ok: true,
      state: { ...state, turn: leader, publicHistory, previousTrick: { ...trick, passed, history }, trick: { leader, lastPlay: null, passed: [], history: [] } },
      events,
    };
  }
  return {
    ok: true,
    state: { ...state, turn: nextActive(state, seat), publicHistory, trick: { ...trick, passed, history } },
    events,
  };
}

function finishHand(state: GameState, events: ScopedEvent[]): ReduceResult {
  const result = computeHandResult(
    {
      handNo: state.handNo,
      level: state.level,
      levelTeam: state.levelTeam,
      teamLevels: state.teamLevels,
      aFails: state.aFails,
      finishOrder: state.finishOrder,
    },
    state.config,
  );
  events.push(pub({ type: 'handOver', result }));
  const winTeam = result.winTeam;
  const nextLevel: Level = result.levelsAfter[winTeam];
  const over = result.matchWinner !== null;
  if (over) events.push(pub({ type: 'matchOver', winner: result.matchWinner! }));
  return {
    ok: true,
    state: {
      ...state,
      phase: over ? 'matchOver' : 'handOver',
      turn: null,
      teamLevels: result.levelsAfter,
      aFails: result.aFailsAfter,
      level: over ? state.level : nextLevel,
      levelTeam: over ? state.levelTeam : winTeam,
      lastResult: result,
      matchWinner: result.matchWinner,
    },
    events,
  };
}

/* ───────────────────────── 不变量（测试/调试） ───────────────────────── */

/** 牌守恒：手牌 + 已出 + 在途贡牌 恰好是 108 张各一次 */
export function checkInvariants(state: GameState): RuleError | null {
  if (state.phase === 'waiting') return null;
  const all: CardId[] = [...state.hands.flat(), ...state.playedCards];
  if (state.phase === 'tribute' && state.tribute) all.push(...state.tribute.paid.map((p) => p.card));
  if (all.length !== DECK_SIZE || new Set(all).size !== DECK_SIZE) {
    return { code: 'BAD_ACTION', message: `牌守恒被破坏：${all.length} 张 / ${new Set(all).size} 种` };
  }
  return null;
}

export { teamOf };
