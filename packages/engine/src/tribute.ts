/**
 * 进贡 / 还贡 / 抗贡规则（纯函数）。
 */
import { BIG_JOKER, cardOf, cardPower, isJokerRank, isWild, type CardId, type Level } from './cards.ts';
import type { RulesConfig } from './config.ts';
import { isDoubleDown, nextSeat, teamOf } from './levels.ts';
import type { Seat, TributeLink } from './types.ts';

export type TributePlan =
  | { readonly kind: 'none' }
  | { readonly kind: 'anti'; readonly payers: readonly Seat[]; readonly receivers: readonly Seat[] }
  | { readonly kind: 'single' | 'double'; readonly payers: readonly Seat[]; readonly receivers: readonly Seat[] };

/**
 * 根据上一局名次与新发的手牌决定本局进贡方式。
 * - 单下：末游 → 头游；双下：三游、末游 → 头游、二游。
 * - 抗贡：进贡方（双下时两人合计）持有两张大王。【待确认 R12：双下时一人一张大王是否也算抗贡，默认算】
 */
export function planTribute(
  prevFinishOrder: readonly Seat[] | null,
  hands: readonly (readonly CardId[])[],
  cfg: RulesConfig,
): TributePlan {
  if (!prevFinishOrder || prevFinishOrder.length < 4) return { kind: 'none' };
  const fo = prevFinishOrder;
  const double = isDoubleDown(fo);
  const payers: Seat[] = double ? [fo[2]!, fo[3]!] : [fo[3]!];
  const receivers: Seat[] = double ? [fo[0]!, fo[1]!] : [fo[0]!];
  if (!double && !cfg.sameTeamTribute && teamOf(fo[3]!) === teamOf(fo[0]!)) return { kind: 'none' };
  const bigJokers = payers.flatMap((s) => hands[s]!).filter((id) => cardOf(id).rank === BIG_JOKER).length;
  if (bigJokers >= 2) return { kind: 'anti', payers, receivers };
  return { kind: double ? 'double' : 'single', payers, receivers };
}

/** 可进贡的牌：除红桃级牌外最大的单张（同点不同花色均可） */
export function validTributeCards(hand: readonly CardId[], level: Level): CardId[] {
  const candidates = hand.filter((id) => !isWild(id, level));
  if (candidates.length === 0) return [];
  const max = Math.max(...candidates.map((id) => cardPower(id, level)));
  return candidates.filter((id) => cardPower(id, level) === max);
}

/** 可还贡的牌：点数 ≤ returnMaxRank 的非王牌（无则退化为最小的牌） */
export function validReturnCards(hand: readonly CardId[], level: Level, cfg: RulesConfig): CardId[] {
  const ok = hand.filter((id) => {
    const c = cardOf(id);
    if (isJokerRank(c.rank)) return false;
    if (c.rank > cfg.returnMaxRank) return false;
    if (c.rank === level && !cfg.returnAllowLevelCard) return false;
    return true;
  });
  if (ok.length > 0) return ok;
  const min = Math.min(...hand.map((id) => cardPower(id, level)));
  return hand.filter((id) => cardPower(id, level) === min);
}

/** 贡牌全部交齐后，确定谁给谁 */
export function assignTribute(
  kind: 'single' | 'double',
  paid: readonly { from: Seat; card: CardId }[],
  receivers: readonly Seat[],
  payersInOrder: readonly Seat[],
  level: Level,
  cfg: RulesConfig,
): TributeLink[] {
  if (kind === 'single') {
    const p = paid[0]!;
    return [{ from: p.from, to: receivers[0]!, card: p.card, returnCard: null }];
  }
  // 按 payersInOrder（三游、末游）排序，保证结果与提交顺序无关
  const [a, b] = [...paid].sort((x, y) => payersInOrder.indexOf(x.from) - payersInOrder.indexOf(y.from)) as [
    { from: Seat; card: CardId },
    { from: Seat; card: CardId },
  ];
  const pa = cardPower(a.card, level);
  const pb = cardPower(b.card, level);
  let pairs: [typeof a, Seat][];
  if (pa > pb) pairs = [[a, receivers[0]!], [b, receivers[1]!]];
  else if (pb > pa) pairs = [[b, receivers[0]!], [a, receivers[1]!]];
  else if (cfg.doubleTributeTie === 'clockwise') pairs = [[a, nextSeat(a.from)], [b, nextSeat(b.from)]];
  else pairs = [[a, receivers[0]!], [b, receivers[1]!]];
  return pairs.map(([p, to]) => ({ from: p.from, to, card: p.card, returnCard: null }));
}

/** 还贡结束后谁先出 */
export function leaderAfterTribute(
  kind: 'single' | 'double',
  links: readonly TributeLink[],
  prevFinishOrder: readonly Seat[],
  level: Level,
  cfg: RulesConfig,
): Seat {
  if (kind === 'single') return links[0]!.from;
  const [x, y] = links as [TributeLink, TributeLink];
  const px = cardPower(x.card, level);
  const py = cardPower(y.card, level);
  if (px !== py) return px > py ? x.from : y.from;
  return cfg.doubleTributeTieLeader === 'headNext' ? nextSeat(prevFinishOrder[0]!) : prevFinishOrder[2]!;
}
