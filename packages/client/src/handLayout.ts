import { planHand, type GroupKind } from '@guandan/ai';
import { cardOf, generatePlays, isWild, makeRules, sortHand, SUITS, type CardId, type Level, type RulesConfig } from '@guandan/engine';

export interface HandGroup {
  readonly label: string;
  readonly cards: readonly CardId[];
}

export interface HandLayoutCard {
  readonly card: CardId;
  readonly group: number;
  readonly label: string;
  readonly row: number;
  readonly column: number;
}

const labels: Record<GroupKind, string> = {
  single: '单张', pair: '对子', triple: '三张', straight: '顺子', tube: '连对',
  plate: '钢板', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '王炸',
};

/** Plan using only the player's own cards. Wild cards remain available separately. */
export function groupHand(hand: readonly CardId[], level: Level, config: RulesConfig = makeRules(), highlightStraightFlush = false): HandGroup[] {
  let remaining = [...hand];
  const straightFlushes: HandGroup[] = [];
  if (highlightStraightFlush) {
    while (true) {
      const candidates = generatePlays(remaining, level, config).filter(play => play.combo.type === 'straightFlush');
      candidates.sort((a, b) => a.wildAssignments.length - b.wildAssignments.length || b.combo.key - a.combo.key);
      const play = candidates[0];
      if (!play) break;
      straightFlushes.push({ label: '同花顺', cards: play.cards });
      remaining = remaining.filter(card => !play.cards.includes(card));
    }
  }
  const plan = planHand(sortHand(remaining, level), level);
  const pairs = plan.groups.filter(group => group.kind === 'pair');
  const pairForTriple = new Map(plan.groups.filter(group => group.kind === 'triple').slice(0, pairs.length).map((group, index) => [group, pairs[index]!]));
  const usedPairs = new Set(pairForTriple.values());
  const result: HandGroup[] = [...straightFlushes, ...plan.bombs.map(group => ({ label: labels[group.kind], cards: group.cards }))];
  for (const group of plan.groups) {
    if (usedPairs.has(group)) continue;
    const pair = pairForTriple.get(group);
    if (pair) result.push({ label: '三带二', cards: [...group.cards, ...pair.cards] });
    else result.push({ label: labels[group.kind], cards: group.cards });
  }
  result.push(...plan.wilds.map(card => ({ label: '逢人配', cards: [card] })));
  return result;
}

/** All cards that can participate in at least one straight flush, including duplicates and wilds. */
export function straightFlushCards(hand: readonly CardId[], level: Level): Set<CardId> {
  const wilds = hand.filter(card => isWild(card, level));
  const natural = hand.filter(card => !isWild(card, level));
  const windows = [[14, 2, 3, 4, 5], ...Array.from({length: 9}, (_, i) => Array.from({length: 5}, (_, j) => i + j + 2))];
  const result = new Set<CardId>();
  for (const suit of SUITS) for (const ranks of windows) {
    const matching = natural.filter(card => { const c = cardOf(card); return c.suit === suit && ranks.includes(c.rank); });
    const present = new Set(matching.map(card => cardOf(card).rank));
    if (5 - present.size > wilds.length) continue;
    for (const card of matching) result.add(card);
    // A wild can also replace a present rank when no rank is missing.
    for (const card of wilds) result.add(card);
  }
  return result;
}

/** Sort by increasing card strength without grouping, highlighting all possible straight flush cards. */
export function orderedHand(hand: readonly CardId[], level: Level): HandGroup[] {
  const highlighted = straightFlushCards(hand, level);
  return sortHand(hand, level).reverse().map(card => ({ label: highlighted.has(card) ? '同花顺' : '', cards: [card] }));
}

/** Break between groups near the midpoint so portrait displays at most two rows. */
export function layoutHand(groups: readonly HandGroup[]): { cards: HandLayoutCard[]; columns: number } {
  const total = groups.reduce((sum, group) => sum + group.cards.length, 0);
  let firstRow = total;
  if (groups.length > 1) {
    let count = 0;
    let best = Infinity;
    for (let i = 0; i < groups.length - 1; i++) {
      count += groups[i]!.cards.length;
      const difference = Math.abs(total - 2 * count);
      if (difference < best) { best = difference; firstRow = count; }
    }
  }
  const cards: HandLayoutCard[] = [];
  let index = 0;
  groups.forEach((group, groupIndex) => {
    for (const card of group.cards) {
      const secondRow = index >= firstRow;
      cards.push({ card, group: groupIndex, label: group.label, row: secondRow ? 2 : 1, column: secondRow ? index - firstRow + 1 : index + 1 });
      index++;
    }
  });
  return { cards, columns: Math.max(firstRow, total - firstRow) };
}
