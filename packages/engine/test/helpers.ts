import { BIG_JOKER, SMALL_JOKER, SUITS, type CardId, type Level, type Suit } from '../src/cards.ts';
import { DEFAULT_RULES, type RulesConfig } from '../src/config.ts';
import type { GameState, Seat } from '../src/types.ts';

const RANKS: Record<string, number> = { J: 11, Q: 12, K: 13, A: 14 };

/** 牌面字符串 → id；同一张牌出现第二次自动取第二副 */
export function cards(spec: string): CardId[] {
  const used = new Set<CardId>();
  return spec
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((tok) => {
      let base: number;
      if (tok === 'SJ') base = 52;
      else if (tok === 'BJ') base = 53;
      else {
        const suit = tok[0] as Suit;
        const r = tok.slice(1);
        const rank = RANKS[r] ?? Number(r);
        const si = SUITS.indexOf(suit);
        if (si < 0 || !(rank >= 2 && rank <= 14)) throw new Error(`bad card ${tok}`);
        base = si * 13 + (rank - 2);
      }
      const id = used.has(base) ? base + 54 : base;
      if (used.has(id)) throw new Error(`card ${tok} used 3 times`);
      used.add(id);
      return id;
    });
}

export const card = (tok: string): CardId => cards(tok)[0]!;
export { SMALL_JOKER, BIG_JOKER };

/** 构造一个处于出牌阶段的局面；未指定的牌不在任何人手中（测试局部规则时使用） */
export function playingState(
  hands: [CardId[], CardId[], CardId[], CardId[]],
  opts: Partial<GameState> & { turn?: Seat; level?: Level; config?: RulesConfig } = {},
): GameState {
  const turn = opts.turn ?? 0;
  return {
    config: DEFAULT_RULES,
    rng: 1,
    phase: 'playing',
    handNo: 1,
    teamLevels: [2, 2],
    aFails: [0, 0],
    level: 2,
    levelTeam: null,
    hands,
    turn,
    trick: { leader: turn, lastPlay: null, passed: [], history: [] },
    finishOrder: [],
    playedCards: [],
    tribute: null,
    antiTribute: null,
    lastResult: null,
    matchWinner: null,
    ...opts,
  };
}
