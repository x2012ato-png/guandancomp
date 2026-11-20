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
  BIG_JOKER,
  DECK_SIZE,
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
import { fullHousePairCost } from './fullHouseCost.ts';
import { earlyWildCost } from './wildCost.ts';
import { tacticalAdjustments, tacticalContext, type TacticalContext } from './tactics.ts';
import type { AIDecision, AIPolicy, DecisionContext } from './types.ts';

export interface HeuristicOptions {
  /** 对手剩余张数 ≤ 该值视为残局，开始拦截 */
  readonly dangerCount: number;
  /** 正常跟牌可接受的最大代价 */
  readonly followCostLimit: number;
  /** 高级策略额外保护同花顺并衡量抢到出牌权的收益。 */
  readonly advanced?: boolean;
  /** 评测时可关闭口诀偏好，保留原高级策略作对照。 */
  readonly tactical?: boolean;
}

export const DEFAULT_HEURISTIC: HeuristicOptions = { dangerCount: 6, followCostLimit: 14 };

const COMPOSITE = new Set<Combo['type']>(['straight', 'tube', 'plate', 'fullHouse']);

interface Scored {
  readonly play: Play;
  readonly cost: number;
  readonly details?: readonly string[];
  readonly overbid?: boolean;
  readonly protectedLoss?: boolean;
}

export interface HeuristicTrace {
  readonly mode: 'lead' | 'follow';
  readonly scores: readonly Scored[];
  readonly limit?: number;
  readonly danger?: boolean;
  readonly nearlyDone?: boolean;
  readonly partnerCaution?: boolean;
}

function strength(c: Combo): number {
  if (c.type === 'straight' || c.type === 'tube' || c.type === 'plate' || c.type === 'straightFlush') return c.key / 14;
  return (c.key - 2) / 15;
}

function without(hand: readonly CardId[], cards: readonly CardId[]): CardId[] {
  const s = new Set(cards);
  return hand.filter((c) => !s.has(c));
}

/** 队友仍在牌局中，且对手无法用更大的单张压住其当前单张。炸弹仍可能改变牌权。 */
export function partnerSingleHasNoUnknownHigher(view: PlayerView): boolean {
  const last = view.trick?.lastPlay;
  if (!last || last.seat !== partnerOf(view.seat) || view.handCounts[last.seat] === 0 || last.play.combo.type !== 'single') return false;
  const visible = new Set([...view.myHand, ...view.playedCards, ...last.play.cards]);
  for (let card = 0; card < DECK_SIZE; card++) {
    if (!visible.has(card) && cardPower(card, view.level) > last.play.combo.key) return false;
  }
  return true;
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

/** 初级策略：保留原有启发式行为和兼容接口。 */
export function createBeginnerPolicy(options: Partial<HeuristicOptions> = {}): AIPolicy {
  return { ...createHeuristicPolicy(options), id: 'beginner' };
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

/** 添加保留整副同花顺的同牌型替代方案，不改变引擎的代表牌生成契约。 */
export function generateTacticalPlays(view: PlayerView, toBeat?: Combo | null): { candidates: Play[]; flushes: Play[] } {
  const hand = view.myHand;
  let candidates = generatePlays(hand, view.level, view.config, toBeat);
  const flushes = (toBeat ? generatePlays(hand, view.level, view.config) : candidates).filter(play => play.combo.type === 'straightFlush');
  if (flushes.length) {
    // 为同一牌型补充不使用同花顺牌的代表方案，避免固定花色选牌拆炸。
    const signatures = new Set(candidates.map(p => `${p.combo.type}:${p.combo.key}:${p.combo.suit ?? ''}:${[...p.cards].sort((a, b) => a - b)}`));
    for (const flush of flushes) {
      for (const play of generatePlays(without(hand, flush.cards), view.level, view.config, toBeat)) {
        const key = `${play.combo.type}:${play.combo.key}:${play.combo.suit ?? ''}:${[...play.cards].sort((a, b) => a - b)}`;
        if (!signatures.has(key)) { signatures.add(key); candidates.push(play); }
      }
    }
  }
  return { candidates, flushes };
}

export function choosePlay(view: PlayerView, opts: HeuristicOptions = DEFAULT_HEURISTIC, report?: (trace: HeuristicTrace) => void): AIDecision {
  const hand = view.myHand;
  const me = view.seat;
  const lp = view.trick?.lastPlay ?? null;
  const toBeat = lp?.play.combo ?? null;
  const { candidates, flushes } = opts.advanced ? generateTacticalPlays(view, toBeat)
    : { candidates: generatePlays(hand, view.level, view.config, toBeat), flushes: [] };

  // 能一手出完就直接出
  const finishing = candidates.find((p) => p.cards.length === hand.length);
  if (finishing) return { type: 'play', play: finishing };

  const opp = opponentsOf(me).filter((s) => view.handCounts[s]! > 0);
  const minOpp = opp.length ? Math.min(...opp.map((s) => view.handCounts[s]!)) : Infinity;
  const partner = partnerOf(me);
  const partnerCount = view.handCounts[partner]!;
  const before = planHand(hand, view.level);
  const tactics = opts.advanced && opts.tactical !== false ? tacticalContext(view) : undefined;

  if (!lp) return { type: 'play', play: chooseLead(view, candidates, before, minOpp, partnerCount, report, flushes, tactics) };

  // 不压队友
  if (teamOf(lp.seat) === teamOf(me)) {
    if (partnerSingleHasNoUnknownHigher(view)) return { type: 'pass' };
    // 己方牌力强、队友手牌尚多且对手接近走完时，考虑用可控单张接管。
    if (tactics?.mode === 'race' && lp.play.combo.type === 'single' && partnerCount >= 4 && minOpp <= 6) {
      const singles = candidates.filter(play => play.combo.type === 'single');
      const minSingle = Math.min(...singles.map(play => play.combo.key));
      const cover = singles.filter(play => play.combo.key === BIG_JOKER && play.combo.key === minSingle)
        .find(play => structuralCost(hand, play, before, view).frag <= 1);
      if (cover) return { type: 'play', play: cover };
    }
    return { type: 'pass' };
  }

  const playerCount = view.handCounts[lp.seat]! || view.handCounts[partnerOf(lp.seat)]!;
  const danger = playerCount <= opts.dangerCount || minOpp <= Math.ceil(opts.dangerCount / 2);

  const nonBomb: Scored[] = [];
  const bombs: Scored[] = [];
  for (const play of candidates) {
    const s = structuralCost(hand, play, before, view);
    const tactical = tactics ? tacticalAdjustments(view, play, tactics) : [];
    const tacticalCost = tactical.reduce((sum, item) => sum + item.cost, 0);
    const tacticalDetails = report ? tactical.map(item => `${item.text} ${item.cost > 0 ? '+' : ''}${item.cost}`) : [];
    const remaining = flushes.length ? new Set(without(hand, play.cards)) : null;
    const losesFlush = !!remaining && play.combo.type !== 'straightFlush' && !flushes.some(flush => flush.cards.every(card => remaining.has(card)));
    // 同花顺未被普通理牌识别时仍保护；已计入拆炸损失时不重复惩罚。
    const flushCost = losesFlush && s.bombLoss === 0 ? 40 : 0;
    const pairCost = fullHousePairCost(play, view.level);
    const wildCost = earlyWildCost(view, play);
    if (isBomb(play.combo)) {
      bombs.push({ play, cost: bombTier(play.combo) * 10 + strength(play.combo) * 5 + s.bombLoss * 40 + s.wildsUsed * 6 + flushCost + tacticalCost,
        details: report ? [`炸弹等级 ${bombTier(play.combo)} × 10`, `牌力 ${strength(play.combo).toFixed(3)} × 5`, `额外拆炸 ${s.bombLoss} × 40`, `逢人配 ${s.wildsUsed} × 6`, ...(flushCost ? [`拆掉同花顺 +${flushCost}`] : []), ...tacticalDetails] : undefined });
    } else {
      nonBomb.push({ play, cost: s.frag * 10 + strength(play.combo) * 6 + s.wildsUsed * 8 + s.bombLoss * 40 + flushCost + pairCost + wildCost + tacticalCost,
        protectedLoss: s.bombLoss > 0 || losesFlush,
        details: report ? [`余牌结构变化 ${s.frag} × 10`, `牌力 ${strength(play.combo).toFixed(3)} × 6`, `逢人配 ${s.wildsUsed} × 8`, `拆炸 ${s.bombLoss} × 40`, ...(wildCost ? [`余牌较多且对手不紧急，保留逢人配 +${wildCost}`] : []), ...(pairCost ? [`三带二消耗控牌对子 +${pairCost}`] : []), ...(flushCost ? [`拆掉同花顺 +${flushCost}`] : []), ...tacticalDetails] : undefined });
    }
  }
  nonBomb.sort((a, b) => a.cost - b.cost);
  // 高级策略跟牌先考虑能管住的最小同型牌；代价过高时仍可让牌。
  // 一手走完已在上方优先处理；越级抢出牌权由后台模拟验证强牌连走机会。
  const minKey = opts.advanced && nonBomb.length ? Math.min(...nonBomb.map(item => item.play.combo.key)) : null;
  const eligible = minKey === null ? nonBomb : nonBomb.filter(item => item.play.combo.key === minKey);
  const best = eligible[0];
  const partnerCanAct = partnerCount > 0 && !view.trick?.passed.includes(partner);
  const lowSingleForPartner = lp.play.combo.type === 'single' && lp.play.combo.key <= 10 &&
    partnerCanAct && playerCount >= 4 && minOpp >= 3;
  const yieldLowSingleToPartner = !!tactics && lowSingleForPartner &&
    partnerCount <= opts.dangerCount && view.myHand.length >= partnerCount + 6 && tactics.mode !== 'race';
  const partnerCaution = !!tactics && partnerCanAct &&
    ((tactics.mode === 'support' && (!danger || lowSingleForPartner) && !(lp.play.combo.size >= 5 && partnerCount <= opts.dangerCount)) || yieldLowSingleToPartner);
  const limit = partnerCaution ? Math.min(opts.followCostLimit, 6) : danger ? 80 : opts.followCostLimit;
  report?.({ mode: 'follow', scores: [...nonBomb.map(item => ({ ...item, overbid: minKey !== null && item.play.combo.key > minKey })), ...bombs], limit, danger, nearlyDone: before.turns <= 2, partnerCaution });
  if (yieldLowSingleToPartner && before.turns > 2) return { type: 'pass' };
  const normalCanBeat = !!best && best.cost <= limit && !(opts.advanced && best.protectedLoss && best.cost > opts.followCostLimit);
  const bestBomb = bombs.reduce<Scored | undefined>((selected, item) => !selected || item.cost < selected.cost ? item : selected, undefined);
  const contest = !!tactics && (tactics.firstOpponentStraight || (tactics.suppressOpponentComposite && !normalCanBeat) || (playerCount === 5 && !normalCanBeat && !lowSingleForPartner));
  if (contest && bestBomb && playerCount !== 4 && bestBomb.cost <= (best?.cost ?? limit) + 6) return { type: 'play', play: bestBomb.play };
  if (normalCanBeat) return { type: 'play', play: best.play };

  if (bombs.length > 0) {
    const nearlyDone = before.turns <= 2;
    const conserveFour = !!tactics && playerCount === 4 && !nearlyDone && minOpp > 2;
    const wantBomb = ((danger && !lowSingleForPartner) || nearlyDone || (!!tactics?.suppressOpponentComposite && !normalCanBeat)) && !conserveFour;
    if (wantBomb) {
      bombs.sort((a, b) => a.cost - b.cost);
      return { type: 'play', play: bombs[0]!.play };
    }
  }
  return { type: 'pass' };
}

function chooseLead(view: PlayerView, candidates: Play[], before: HandPlan, minOpp: number, partnerCount: number, report?: (trace: HeuristicTrace) => void, flushes: readonly Play[] = [], tactics?: TacticalContext): Play {
  const hand = view.myHand;
  const scored: Scored[] = [];
  for (const play of candidates) {
    const c = play.combo;
    const s = structuralCost(hand, play, before, view);
    let cost = s.frag * 10 + strength(c) * 4 + s.wildsUsed * 8 + s.bombLoss * 30;
    const details = report ? [`余牌结构变化 ${s.frag} × 10`, `牌力 ${strength(c).toFixed(3)} × 4`, `逢人配 ${s.wildsUsed} × 8`, `拆炸 ${s.bombLoss} × 30`, `出牌 ${play.cards.length} 张 × −0.3`] : undefined;
    const pairCost = fullHousePairCost(play, view.level);
    if (pairCost) { cost += pairCost; details?.push(`三带二消耗控牌对子 +${pairCost}`); }
    const wildCost = earlyWildCost(view, play);
    if (wildCost) { cost += wildCost; details?.push(`余牌较多且对手不紧急，保留逢人配 +${wildCost}`); }
    for (const item of tactics ? tacticalAdjustments(view, play, tactics) : []) { cost += item.cost; details?.push(`${item.text} ${item.cost > 0 ? '+' : ''}${item.cost}`); }
    if (flushes.length && c.type !== 'straightFlush' && s.bombLoss === 0) {
      const remaining = new Set(without(hand, play.cards));
      if (!flushes.some(flush => flush.cards.every(card => remaining.has(card)))) { cost += 30; details?.push('拆掉同花顺 +30'); }
    }
    if (isBomb(c)) { cost += 50; details?.push('出炸弹 +50'); }
    if (COMPOSITE.has(c.type)) { cost -= 3; details?.push('复合牌型 −3'); }
    cost -= play.cards.length * 0.3;
    // 对手残局：避免送出对手能接的张数
    if (minOpp === 1 && c.type === 'single' && c.key < 16) { cost += 25; details?.push('对手剩 1 张，出非王单张 +25'); }
    if (minOpp === 2 && c.type === 'pair') { cost += 12; details?.push('对手剩 2 张，出对子 +12'); }
    // 队友只剩 1–2 张且对手不危险：递小牌
    if (partnerCount > 0 && partnerCount <= 2 && minOpp > 3) {
      if ((partnerCount === 1 && c.type === 'single') || (partnerCount === 2 && c.type === 'pair')) {
        const discount = 8 * (1 - strength(c));
        cost -= discount;
        details?.push(`队友剩 ${partnerCount} 张，递牌优惠 −${discount.toFixed(3)}`);
      }
    }
    scored.push({ play, cost, details });
  }
  scored.sort((a, b) => a.cost - b.cost);
  report?.({ mode: 'lead', scores: scored });
  return scored[0]!.play;
}
