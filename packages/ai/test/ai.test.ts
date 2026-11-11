import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  checkInvariants,
  createGame,
  legalActions,
  makeRandom,
  makeRules,
  pendingActors,
  reduce,
  toPlayerView,
  teamOf,
  type GameAction,
  type GameState,
  type Seat,
} from '@guandan/engine';
import { choosePlay, createHeuristicPolicy, decisionToAction, planHand, randomDeterminizer, type AIPolicy } from '../src/index.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

const ai = createHeuristicPolicy();

describe('手牌拆分', () => {
  it('识别顺子、炸弹，逢人配单列', () => {
    const p = planHand(cards('S3 D4 C5 S6 D7 SK DK CK HK H2 SJ'), 2);
    expect(p.bombs.map((b) => b.kind)).toEqual(['bomb']);
    expect(p.groups.some((g) => g.kind === 'straight')).toBe(true);
    expect(p.wilds).toHaveLength(1);
  });
});

describe('启发式决策', () => {
  it('首攻优先复合牌型', () => {
    const s = playingState([cards('S3 D4 C5 S6 D7 S9 DQ'), cards('SA'), cards('SA'), cards('SA')]);
    const d = choosePlay(toPlayerView(s, 0));
    expect(d.type === 'play' && d.play.combo.type).toBe('straight');
  });

  it('跟牌最小压、不拆对子', () => {
    let s = playingState([cards('S3 S4 S5'), cards('S8 D8 S9 SQ SK'), cards('S6 SJ'), cards('S7 SJ')], { turn: 0 });
    s = (reduce(s, { type: 'play', seat: 0, cards: cards('S5') }) as { state: GameState }).state;
    const d = choosePlay(toPlayerView(s, 1));
    expect(d.type === 'play' && d.play.combo.key).toBe(9);
  });

  it('不压队友', () => {
    let s = playingState([cards('S3 S4 S5 D9 D10'), cards('S8 D8'), cards('S6 SA SK'), cards('S7 SJ')], { turn: 0 });
    s = (reduce(s, { type: 'play', seat: 0, cards: cards('S5') }) as { state: GameState }).state;
    s = (reduce(s, { type: 'pass', seat: 1 }) as { state: GameState }).state;
    expect(choosePlay(toPlayerView(s, 2))).toEqual({ type: 'pass' });
  });

  it('不拆炸弹；对手残局时用炸弹拦截', () => {
    const mk = (oppCards: string) => {
      let s = playingState([cards(oppCards), cards('S9 D9 C9 H9 S3 D4 S6 SQ'), cards('C6 DK D2 C2 S8 D8 C8'), cards('S7 SJ')], { turn: 0 });
      s = (reduce(s, { type: 'play', seat: 0, cards: cards('SA') }) as { state: GameState }).state;
      return choosePlay(toPlayerView(s, 1));
    };
    expect(mk('SA S3 S4 S5 S6 S7 S8 S9 S10 SJ SQ DK DA')).toEqual({ type: 'pass' });
    const d = mk('SA S3 S4');
    expect(d.type === 'play' && d.play.combo.type).toBe('bomb');
  });

  it('进贡/还贡选择合法', () => {
    const s0 = createGame(DEFAULT_RULES, 9);
    const fakeView = { ...toPlayerView({ ...playingState([cards('S3 S4 SA D10 H2'), [], [], []]) }, 0), myDuty: 'tribute' as const };
    const d = ai.decide(fakeView);
    expect(d).toEqual({ type: 'tribute', card: cards('SA')[0] });
    const rv = { ...fakeView, myDuty: 'return' as const };
    const r = ai.decide(rv);
    expect(r?.type).toBe('returnTribute');
    void s0;
  });
});

function playMatch(policies: AIPolicy[], seed: string, maxHands: number) {
  let s = createGame(makeRules({ firstLeader: 0 }), seed);
  const wins = [0, 0];
  let hands = 0;
  let decisions = 0;
  const t0 = Date.now();
  while (hands < maxHands && s.phase !== 'matchOver') {
    if (s.phase === 'waiting' || s.phase === 'handOver') {
      if (s.lastResult) wins[s.lastResult.winTeam] = (wins[s.lastResult.winTeam] ?? 0) + 1;
      s = (reduce(s, { type: 'startHand' }) as { state: GameState }).state;
      hands++;
      continue;
    }
    for (const seat of pendingActors(s)) {
      const d = policies[seat]!.decide(toPlayerView(s, seat));
      expect(d).not.toBeNull();
      const r = reduce(s, decisionToAction(seat, d!));
      if (!r.ok) throw new Error(`illegal AI action: ${r.error.code} ${r.error.message}`);
      s = r.state;
      decisions++;
      expect(checkInvariants(s)).toBeNull();
      break;
    }
  }
  if (s.lastResult && (s.phase === 'handOver' || s.phase === 'matchOver')) wins[s.lastResult.winTeam] = (wins[s.lastResult.winTeam] ?? 0) + 1;
  return { wins, hands, decisions, ms: Date.now() - t0, state: s };
}

const randomPolicy = (seed: string): AIPolicy => {
  const rand = makeRandom(seed);
  return {
    id: 'random',
    decide(view) {
      if (!view.myDuty) return null;
      const fake: GameState = randomDeterminizer.sample(view, rand);
      const acts: GameAction[] = legalActions(fake, view.seat);
      const pick = acts[Math.floor(rand() * acts.length)]!;
      if (pick.type === 'tribute') return { type: 'tribute', card: pick.card };
      if (pick.type === 'returnTribute') return { type: 'returnTribute', card: pick.card };
      if (pick.type === 'pass') return { type: 'pass' };
      if (pick.type === 'play') {
        return { type: 'play', play: { cards: pick.cards, combo: { ...pick.combo!, size: pick.cards.length }, wildAssignments: pick.wildAssignments ?? [] } };
      }
      return null;
    },
  };
};

describe('整场模拟', () => {
  it('4 个启发式 AI 打多局，全部动作合法', () => {
    const r = playMatch([ai, ai, ai, ai], 'h4', 6);
    expect(r.hands).toBeGreaterThanOrEqual(3);
    // 单步决策耗时应可接受（手机上也能跑）
    expect(r.ms / r.decisions).toBeLessThan(80);
  }, 60000);

  it('启发式队伍明显强于随机队伍', () => {
    let heuristicWins = 0;
    let total = 0;
    for (const seed of ['a', 'b']) {
      const r = playMatch([ai, randomPolicy(seed + 1), ai, randomPolicy(seed + 3)], seed, 5);
      heuristicWins += r.wins[0]!;
      total += r.wins[0]! + r.wins[1]!;
    }
    expect(heuristicWins / total).toBeGreaterThanOrEqual(0.7);
  }, 60000);
});

describe('确定化采样（MCTS 预留）', () => {
  it('采样结果与视图相容且牌守恒', () => {
    const s = (reduce(createGame(DEFAULT_RULES, 5), { type: 'startHand' }) as { state: GameState }).state;
    const v = toPlayerView(s, 2);
    const w = randomDeterminizer.sample(v, makeRandom(1));
    expect(w.hands[2]).toEqual(s.hands[2]);
    expect(w.hands.map((h) => h.length)).toEqual(v.handCounts);
    expect(checkInvariants(w)).toBeNull();
    expect(teamOf(2 as Seat)).toBe(0);
  });
});
