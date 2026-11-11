/**
 * 手牌拆分（理牌）：把手牌分解为尽量少的出牌手数，作为启发式评估的基础。
 * 只使用自然牌做拆分；逢人配单独计数，作为灵活资源。
 */
import {
  BIG_JOKER,
  NATURAL_RANKS,
  SMALL_JOKER,
  SUITS,
  cardOf,
  isWild,
  rankPower,
  type CardId,
  type Level,
  type NaturalRank,
  type Rank,
  type Suit,
} from '@guandan/engine';

export type GroupKind = 'single' | 'pair' | 'triple' | 'straight' | 'tube' | 'plate' | 'bomb' | 'straightFlush' | 'jokerBomb';

export interface PlanGroup {
  readonly kind: GroupKind;
  readonly cards: readonly CardId[];
  /** 比较强度：同点类为 rankPower，序列类为最高张 */
  readonly key: number;
}

export interface HandPlan {
  readonly groups: readonly PlanGroup[];
  readonly bombs: readonly PlanGroup[];
  readonly wilds: readonly CardId[];
  /** 估计出完所需手数（三张与对子可合并为三带二） */
  readonly turns: number;
}

type Pools = Map<Rank, CardId[]>;

function poolsOf(cards: readonly CardId[]): Pools {
  const m: Pools = new Map();
  for (const id of cards) {
    const r = cardOf(id).rank;
    const a = m.get(r);
    if (a) a.push(id);
    else m.set(r, [id]);
  }
  return m;
}

const cnt = (p: Pools, r: Rank) => p.get(r)?.length ?? 0;
const take = (p: Pools, r: Rank, n: number): CardId[] => {
  const a = p.get(r)!;
  const out = a.splice(0, n);
  if (a.length === 0) p.delete(r);
  return out;
};

/** 序列窗口（A 用 14 表示，start=1 即 A 作 1） */
function windows(len: number): NaturalRank[][] {
  const out: NaturalRank[][] = [];
  for (let s = 1; s + len - 1 <= 14; s++) {
    const w: NaturalRank[] = [];
    for (let r = s; r < s + len; r++) w.push((r === 1 ? 14 : r) as NaturalRank);
    out.push(w);
  }
  return out;
}
const W5 = windows(5);
const W3 = windows(3);
const W2 = windows(2);
const seqKey = (w: NaturalRank[]) => (w[0] === 14 ? w.length : w[w.length - 1]!);

type Strategy = { straights: 'none' | 'clean' | 'greedy'; seqFirst: boolean };
const STRATEGIES: Strategy[] = [
  { straights: 'none', seqFirst: true },
  { straights: 'clean', seqFirst: true },
  { straights: 'greedy', seqFirst: true },
  { straights: 'clean', seqFirst: false },
];

function decompose(pools: Pools, level: Level, st: Strategy): PlanGroup[] {
  const p: Pools = new Map([...pools].map(([k, v]) => [k, [...v]]));
  const groups: PlanGroup[] = [];
  const power = (r: Rank) => rankPower(r, level);

  const extractStraights = () => {
    if (st.straights === 'none') return;
    let found = true;
    while (found) {
      found = false;
      for (const w of W5) {
        if (!w.every((r) => cnt(p, r) >= 1)) continue;
        // clean：最多拆一个对子/三张，避免把成型的牌拆散
        const ok = st.straights === 'greedy' || w.filter((r) => cnt(p, r) >= 2).length <= 1;
        if (ok) {
          groups.push({ kind: 'straight', cards: w.flatMap((r) => take(p, r, 1)), key: seqKey(w) });
          found = true;
          break;
        }
      }
    }
  };
  const extractSeq = () => {
    for (const w of W2) {
      if (w.every((r) => cnt(p, r) === 3)) groups.push({ kind: 'plate', cards: w.flatMap((r) => take(p, r, 3)), key: seqKey(w) });
    }
    for (const w of W3) {
      if (w.every((r) => cnt(p, r) === 2)) groups.push({ kind: 'tube', cards: w.flatMap((r) => take(p, r, 2)), key: seqKey(w) });
    }
  };

  if (st.seqFirst) {
    extractSeq();
    extractStraights();
  } else {
    extractStraights();
    extractSeq();
  }
  for (const [r, ids] of [...p].sort((a, b) => power(a[0]) - power(b[0]))) {
    const n = ids.length;
    const kind: GroupKind = n >= 3 ? 'triple' : n === 2 ? 'pair' : 'single';
    if (n > 3) {
      // 已在外层抽走炸弹，这里不会出现
      groups.push({ kind: 'triple', cards: ids.slice(0, 3), key: power(r) });
      groups.push({ kind: 'single', cards: ids.slice(3), key: power(r) });
    } else groups.push({ kind, cards: [...ids], key: power(r) });
  }
  return groups;
}

function turnsOf(groups: readonly PlanGroup[]): number {
  const triples = groups.filter((g) => g.kind === 'triple').length;
  const pairs = groups.filter((g) => g.kind === 'pair').length;
  // 小单张越多越难出，额外加一点权重
  const lowSingles = groups.filter((g) => g.kind === 'single' && g.key <= 10).length;
  return groups.length - Math.min(triples, pairs) + lowSingles * 0.25;
}

function findStraightFlush(pools: Pools, all: readonly CardId[], level: Level): PlanGroup | null {
  for (const suit of SUITS as readonly Suit[]) {
    for (const w of W5) {
      const ids: CardId[] = [];
      for (const r of w) {
        // 不从炸弹点数取牌
        if (cnt(pools, r) >= 4) break;
        const id = all.find((x) => {
          const c = cardOf(x);
          return c.rank === r && c.suit === suit && !isWild(x, level) && !ids.includes(x);
        });
        if (id === undefined) break;
        ids.push(id);
      }
      if (ids.length === 5) return { kind: 'straightFlush', cards: ids, key: seqKey(w) };
    }
  }
  return null;
}

export function planHand(hand: readonly CardId[], level: Level): HandPlan {
  const wilds = hand.filter((id) => isWild(id, level));
  const naturals = hand.filter((id) => !isWild(id, level));
  const pools = poolsOf(naturals);
  const bombs: PlanGroup[] = [];

  if (cnt(pools, SMALL_JOKER) === 2 && cnt(pools, BIG_JOKER) === 2) {
    bombs.push({ kind: 'jokerBomb', cards: [...take(pools, SMALL_JOKER, 2), ...take(pools, BIG_JOKER, 2)], key: BIG_JOKER });
  }
  for (const r of NATURAL_RANKS) {
    if (cnt(pools, r) >= 4) bombs.push({ kind: 'bomb', cards: take(pools, r, cnt(pools, r)), key: rankPower(r, level) });
  }

  let best = bestDecomposition(pools, level);
  const sf = findStraightFlush(pools, [...pools.values()].flat(), level);
  if (sf) {
    const p2: Pools = new Map();
    for (const [k, v] of pools) {
      const rest = v.filter((id) => !sf.cards.includes(id));
      if (rest.length > 0) p2.set(k, rest);
    }
    const alt = bestDecomposition(p2, level);
    // 抽出同花顺后普通手数增加不超过半手，则把同花顺当作额外炸弹保留
    if (alt.turns <= best.turns + 0.5) {
      best = alt;
      bombs.push(sf);
    }
  }
  return { groups: best.groups, bombs, wilds, turns: best.turns };
}

function bestDecomposition(pools: Pools, level: Level): { groups: PlanGroup[]; turns: number } {
  let groups: PlanGroup[] = [];
  let turns = Infinity;
  for (const st of STRATEGIES) {
    const g = decompose(pools, level, st);
    const t = turnsOf(g);
    if (t < turns) {
      turns = t;
      groups = g;
    }
  }
  return { groups, turns: turns === Infinity ? 0 : turns };
}
