import { cardOf, rankPower, type Level, type Play, type Rank } from '@guandan/engine';

/** 三带二只比较三张的点数，带出的对子需要另算其控牌价值。 */
export function fullHousePairCost(play: Play, level: Level): number {
  if (play.combo.type !== 'fullHouse') return 0;
  const assignments = new Map(play.wildAssignments.map(item => [item.cardId, item.rank]));
  const ranks = new Map<Rank, number>();
  for (const id of play.cards) {
    const rank = assignments.get(id) ?? cardOf(id).rank;
    ranks.set(rank, (ranks.get(rank) ?? 0) + 1);
  }
  // 允许同点三带二的规则下，五张同点既是三张也是对子。
  const pair = [...ranks].find(([, count]) => count === 2 || count === 5)?.[0];
  if (pair === undefined) return 0;
  const power = rankPower(pair, level);
  if (power === 17) return 24;
  if (power === 16) return 20;
  if (power === 15) return 8;
  return Math.max(0, power - 12);
}
