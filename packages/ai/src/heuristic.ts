/**
 * 启发式 AI：
 *  - 首攻：优先复合牌型（顺子/连对/钢板/三带二），选拆牌代价最小、点数最小的一手；
 *  - 跟牌：用最小的、不破坏牌型的一手压过对手；
 *  - 不压队友（除非能一手走完）；
 *  - 对手残局（张数少）时提高出牌意愿、允许拆牌和用炸弹拦截；
 *  - 不拆炸弹（拆炸弹有高额惩罚，残局才可能突破）。
 */
import {
  cardPower,
  generatePlays,
  isBomb,
  bombTier,
  nextSeat,
  partnerOf,
  teamOf,
  validReturnCards,
  validTributeCards,
  type CardId,
  type Combo,
  type Play,
  type PlayerView,
  type Seat,
} from '@guandan/engine';
import { planHand, type HandPlan } from './handPlan.ts';
import type { AIDecision, AIPolicy, DecisionContext } from './types.ts';

export interface HeuristicOptions {
  /** 对手剩余张数 ≤ 该值视为残局，开始拦截 */
  readonly dangerCount: number;
  /** 正常跟牌可接受的最大代价 */
  readonly followCostLimit: number;
}

export const DEFAULT_HEURISTIC: HeuristicOptions = { dangerCount: 6, followCostLimit: 14 };

const COMPOSITE = new Set<Combo['type']>(['straight', 'tube', 'plate', 'fullHouse']);

interface Scored {
  readonly play: Play;
  readonly cost: number;
}

function strength(c: Combo): number {
  if (c.type === 'straight' || c.type === 'tube' || c.type === 'plate' || c.type === 'straightFlush') return c.key / 14;
  return (c.key - 2) / 15;
}

function without(hand: readonly CardId[], cards: readonly CardId[]): CardId[] {
  const s = new Set(cards);
  return hand.filter((c) => !s.has(c));
}

/** 出这手牌对剩余手牌结构的破坏程度 */
function structuralCost(hand: readonly CardId[], play: Play, before: HandPlan, view: PlayerView) {
  const after = planHand(without(hand, play.cards), view.level);
  const frag = after.turns - (before.turns - (isBomb(play.combo) ? 0 : 1));
  const bombLoss = isBomb(play.combo)
    ? Math.max(0, before.bombs.length - after.bombs.length - 1)
    : Math.max(0, before.bombs.length - after.bombs.length);
  const wildsUsed = play.wildAssignments.length;
  return { frag, bombLoss, wildsUsed, after };
}

export function createHeuristicPolicy(options: Partial<HeuristicOptions> = {}): AIPolicy {
  const opts = { ...DEFAULT_HEURISTIC, ...options };
  return {
    id: 'heuristic-v1',
    decide(view: PlayerView, _ctx?: DecisionContext): AIDecision | null {
      switch (view.myDuty) {
        case 'tribute':
          return { type: 'tribute', card: chooseTribute(view) };
        case 'return':
          return { type: 'returnTribute', card: chooseReturn(view) };
        case 'play':
          return choosePlay(view, opts);
        default:
          return null;
      }
    },
  };
}

export function chooseTribute(view: PlayerView): CardId {
  const options = validTributeCards(view.myHand, view.level);
  return minBy(options, (id) => planHand(without(view.myHand, [id]), view.level).turns);
}

export function chooseReturn(view: PlayerView): CardId {
  const options = validReturnCards(view.myHand, view.level, view.config);
  return minBy(options, (id) => {
    const turns = planHand(without(view.myHand, [id]), view.level).turns;
    return turns * 10 + cardPower(id, view.level) * 0.5;
  });
}

function minBy<T>(items: readonly T[], f: (x: T) => number): T {
  let best = items[0] as T;
  let bv = Infinity;
  for (const x of items) {
    const v = f(x);
    if (v < bv) {
      bv = v;
      best = x;
    }
  }
  return best;
}

function opponentsOf(seat: Seat): Seat[] {
  return [nextSeat(seat), nextSeat(partnerOf(seat))];
}

export function choosePlay(view: PlayerView, opts: HeuristicOptions = DEFAULT_HEURISTIC): AIDecision {
  const hand = view.myHand;
  const me = view.seat;
  const lp = view.trick?.lastPlay ?? null;
  const toBeat = lp?.play.combo ?? null;
  const candidates = generatePlays(hand, view.level, view.config, toBeat);

  // 能一手出完就直接出
  const finishing = candidates.find((p) => p.cards.length === hand.length);
  if (finishing) return { type: 'play', play: finishing };

  const opp = opponentsOf(me).filter((s) => view.handCounts[s]! > 0);
  const minOpp = opp.length ? Math.min(...opp.map((s) => view.handCounts[s]!)) : Infinity;
  const partner = partnerOf(me);
  const partnerCount = view.handCounts[partner]!;
  const before = planHand(hand, view.level);

  if (!lp) return { type: 'play', play: chooseLead(view, candidates, before, minOpp, partnerCount) };

  // 不压队友
  if (teamOf(lp.seat) === teamOf(me)) return { type: 'pass' };

  const playerCount = view.handCounts[lp.seat]!;
  const danger = playerCount <= opts.dangerCount || minOpp <= Math.ceil(opts.dangerCount / 2);

  const nonBomb: Scored[] = [];
  const bombs: Scored[] = [];
  for (const play of candidates) {
    const s = structuralCost(hand, play, before, view);
    if (isBomb(play.combo)) {
      bombs.push({ play, cost: bombTier(play.combo) * 10 + strength(play.combo) * 5 + s.bombLoss * 40 + s.wildsUsed * 6 });
    } else {
      nonBomb.push({ play, cost: s.frag * 10 + strength(play.combo) * 6 + s.wildsUsed * 8 + s.bombLoss * 40 });
    }
  }
  nonBomb.sort((a, b) => a.cost - b.cost);
  const best = nonBomb[0];
  const limit = danger ? 80 : opts.followCostLimit;
  if (best && best.cost <= limit) return { type: 'play', play: best.play };

  if (bombs.length > 0) {
    // 下家就是队友且对手不危险时，留给队友处理
    const partnerNext = nextSeat(me) === partner && partnerCount > 0;
    const nearlyDone = before.turns <= 2;
    const wantBomb = danger || (nearlyDone && !partnerNext);
    if (wantBomb) {
      bombs.sort((a, b) => a.cost - b.cost);
      return { type: 'play', play: bombs[0]!.play };
    }
  }
  return { type: 'pass' };
}

function chooseLead(view: PlayerView, candidates: Play[], before: HandPlan, minOpp: number, partnerCount: number): Play {
  const hand = view.myHand;
  const scored: Scored[] = [];
  for (const play of candidates) {
    const c = play.combo;
    const s = structuralCost(hand, play, before, view);
    let cost = s.frag * 10 + strength(c) * 4 + s.wildsUsed * 8 + s.bombLoss * 30;
    if (isBomb(c)) cost += 50;
    if (COMPOSITE.has(c.type)) cost -= 3;
    cost -= play.cards.length * 0.3;
    // 对手残局：避免送出对手能接的张数
    if (minOpp === 1 && c.type === 'single') cost += c.key >= 16 ? 0 : 25;
    if (minOpp === 2 && c.type === 'pair') cost += 12;
    // 队友只剩 1–2 张且对手不危险：递小牌
    if (partnerCount > 0 && partnerCount <= 2 && minOpp > 3) {
      if (partnerCount === 1 && c.type === 'single') cost -= 8 * (1 - strength(c));
      if (partnerCount === 2 && c.type === 'pair') cost -= 8 * (1 - strength(c));
    }
    scored.push({ play, cost });
  }
  scored.sort((a, b) => a.cost - b.cost);
  return scored[0]!.play;
}
