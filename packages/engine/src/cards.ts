/**
 * 牌与点数的基础定义。
 *
 * 两副牌共 108 张，CardId 为 0..107 的整数：
 *   deck = floor(id / 54)，i = id % 54
 *   i ∈ [0, 51]: suit = SUITS[floor(i / 13)], rank = 2 + i % 13   (A = 14)
 *   i = 52: 小王 (rank 16)；i = 53: 大王 (rank 17)
 *
 * CardId → Card 是确定性的纯映射，因此状态中只存 CardId（不可变、可序列化）。
 */

export const SUITS = ['S', 'H', 'C', 'D'] as const;
export type Suit = (typeof SUITS)[number];
export type CardSuit = Suit | 'J';

/** 自然点数 2..14（11=J, 12=Q, 13=K, 14=A） */
export type NaturalRank = 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
export const SMALL_JOKER = 16 as const;
export const BIG_JOKER = 17 as const;
export type JokerRank = typeof SMALL_JOKER | typeof BIG_JOKER;
export type Rank = NaturalRank | JokerRank;

/** 级牌（本局打几），取值 2..14 */
export type Level = NaturalRank;

export type CardId = number;

export interface Card {
  readonly id: CardId;
  readonly suit: CardSuit;
  readonly rank: Rank;
  readonly deck: 0 | 1;
}

export const NATURAL_RANKS: readonly NaturalRank[] = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
export const DECK_SIZE = 108;

/** 级牌在单张/同点比较中的位置：高于 A(14)、低于小王(16) */
export const LEVEL_POWER = 15;

const CARD_TABLE: readonly Card[] = Object.freeze(
  Array.from({ length: DECK_SIZE }, (_, id) => {
    const deck = (id >= 54 ? 1 : 0) as 0 | 1;
    const i = id % 54;
    let card: Card;
    if (i === 52) card = { id, suit: 'J', rank: SMALL_JOKER, deck };
    else if (i === 53) card = { id, suit: 'J', rank: BIG_JOKER, deck };
    else card = { id, suit: SUITS[Math.floor(i / 13)]!, rank: (2 + (i % 13)) as NaturalRank, deck };
    return Object.freeze(card);
  }),
);

export function isCardId(x: unknown): x is CardId {
  return typeof x === 'number' && Number.isInteger(x) && x >= 0 && x < DECK_SIZE;
}

export function cardOf(id: CardId): Card {
  const c = CARD_TABLE[id];
  if (!c) throw new RangeError(`invalid card id ${id}`);
  return c;
}

export function makeDeck(): CardId[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => i);
}

export function isJokerRank(r: Rank): r is JokerRank {
  return r === SMALL_JOKER || r === BIG_JOKER;
}

/** 逢人配：红桃级牌 */
export function isWild(id: CardId, level: Level): boolean {
  const c = cardOf(id);
  return c.suit === 'H' && c.rank === level;
}

/** 单张/对子/三张/炸弹等「同点牌」的大小值 */
export function rankPower(rank: Rank, level: Level): number {
  if (rank === level) return LEVEL_POWER;
  return rank;
}

export function cardPower(id: CardId, level: Level): number {
  return rankPower(cardOf(id).rank, level);
}

const RANK_LABEL: Record<number, string> = {
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 16: '小王', 17: '大王',
};
const SUIT_LABEL: Record<CardSuit, string> = { S: '♠', H: '♥', C: '♣', D: '♦', J: '' };

export function rankLabel(r: number): string {
  return RANK_LABEL[r] ?? String(r);
}
export function suitLabel(s: CardSuit): string {
  return SUIT_LABEL[s];
}
export function cardLabel(id: CardId): string {
  const c = cardOf(id);
  return c.suit === 'J' ? rankLabel(c.rank) : `${SUIT_LABEL[c.suit]}${rankLabel(c.rank)}`;
}

/** 手牌展示排序：按单张大小降序，同点按花色 */
export function sortHand(ids: readonly CardId[], level: Level): CardId[] {
  const suitOrder: Record<CardSuit, number> = { J: 0, H: 1, S: 2, C: 3, D: 4 };
  return [...ids].sort((a, b) => {
    const ca = cardOf(a), cb = cardOf(b);
    const pa = rankPower(ca.rank, level), pb = rankPower(cb.rank, level);
    if (pa !== pb) return pb - pa;
    if (ca.suit !== cb.suit) return suitOrder[ca.suit] - suitOrder[cb.suit];
    return a - b;
  });
}
