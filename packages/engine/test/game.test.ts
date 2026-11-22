import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  checkInvariants,
  computeHandResult,
  createGame,
  eventsForSeat,
  legalActions,
  makeRules,
  pendingActors,
  reduce,
  toPlayerView,
  validReturnCards,
  validTributeCards,
  makeRandom,
  type GameAction,
  type GameState,
  type HandResult,
  type Level,
  type Seat,
} from '../src/index.ts';
import { card, cards, playingState } from './helpers.ts';

function ok(state: GameState, action: GameAction): GameState {
  const r = reduce(state, action);
  if (!r.ok) throw new Error(`${action.type}: ${r.error.code} ${r.error.message}`);
  return r.state;
}
function fail(state: GameState, action: GameAction): string {
  const r = reduce(state, action);
  expect(r.ok).toBe(false);
  return r.ok ? '' : r.error.code;
}

describe('开局与发牌', () => {
  it('发 4×27 张，牌守恒，首局无进贡', () => {
    const s = ok(createGame(DEFAULT_RULES, 'seed-1'), { type: 'startHand' });
    expect(s.hands.map((h) => h.length)).toEqual([27, 27, 27, 27]);
    expect(s.phase).toBe('playing');
    expect(checkInvariants(s)).toBeNull();
    expect(s.level).toBe(2);
  });
  it('reducer 不修改入参（不可变）', () => {
    const s0 = Object.freeze(createGame(DEFAULT_RULES, 3));
    const s1 = ok(s0, { type: 'startHand' });
    const snapshot = JSON.stringify(s1);
    const actions = legalActions(s1, s1.turn!);
    ok(s1, actions[0]!);
    expect(JSON.stringify(s1)).toBe(snapshot);
  });
});

describe('出牌回合、不要与接风', () => {
  it('首出不能不要；不是你的回合；压不过', () => {
    const s = playingState([cards('S3 S4'), cards('S5'), cards('S6'), cards('S7')]);
    expect(fail(s, { type: 'pass', seat: 0 })).toBe('CANNOT_PASS_ON_LEAD');
    expect(fail(s, { type: 'play', seat: 1, cards: cards('S5') })).toBe('NOT_YOUR_TURN');
    const s1 = ok(s, { type: 'play', seat: 0, cards: [card('S4')] });
    expect(fail(s1, { type: 'play', seat: 1, cards: [card('S5'), card('S4')] })).toBe('CARD_NOT_IN_HAND');
    const s2 = ok(ok(s1, { type: 'pass', seat: 1 }), { type: 'pass', seat: 2 });
    expect(s2.turn).toBe(3);
  });

  it('三家都不要，出牌人重新首出', () => {
    let s = playingState([cards('S3 S4'), cards('S5 D5'), cards('S6 D6'), cards('S7 D7')]);
    s = ok(s, { type: 'play', seat: 0, cards: [card('S4')] });
    for (const seat of [1, 2, 3] as Seat[]) s = ok(s, { type: 'pass', seat });
    expect(s.turn).toBe(0);
    expect(s.trick!.lastPlay).toBeNull();
  });

  it('接风：出完最后一手后其余三家都不要，由对家出牌', () => {
    let s = playingState([cards('SA'), cards('S5 D5'), cards('S6 D6'), cards('S7 D7')]);
    const r = reduce(s, { type: 'play', seat: 0, cards: [card('SA')] });
    expect(r.ok).toBe(true);
    s = (r as { state: GameState }).state;
    expect(s.finishOrder).toEqual([0]);
    expect(s.turn).toBe(1);
    s = ok(s, { type: 'pass', seat: 1 });
    s = ok(s, { type: 'pass', seat: 2 });
    const last = reduce(s, { type: 'pass', seat: 3 });
    expect(last.ok && last.events.some((e) => e.event.type === 'trickWon' && e.event.jiefeng && e.event.leader === 2)).toBe(true);
    expect(last.ok && last.state.turn).toBe(2);
  });

  it('接风前若有人压牌，则不接风', () => {
    let s = playingState([cards('SK'), cards('SA D5'), cards('S6 D6'), cards('S7 D7')]);
    s = ok(s, { type: 'play', seat: 0, cards: [card('SK')] });
    s = ok(s, { type: 'play', seat: 1, cards: [card('SA')] });
    s = ok(s, { type: 'pass', seat: 2 });
    s = ok(s, { type: 'pass', seat: 3 });
    expect(s.turn).toBe(1);
  });

  it('双下：同队两人先出完，本局立即结束，+3', () => {
    let s = playingState([cards('S3'), cards('S5 D5'), cards('S4'), cards('S7 D7')]);
    s = ok(s, { type: 'play', seat: 0, cards: [card('S3')] });
    s = ok(s, { type: 'pass', seat: 1 });
    s = ok(s, { type: 'play', seat: 2, cards: [card('S4')] });
    expect(s.phase).toBe('handOver');
    expect(s.lastResult!.finishOrder.slice(0, 2)).toEqual([0, 2]);
    expect(s.lastResult!.upgrade).toBe(3);
    expect(s.teamLevels).toEqual([5, 2]);
    expect(s.level).toBe(5);
    expect(s.levelTeam).toBe(0);
  });

  it('三人出完后补齐末游', () => {
    let s = playingState([cards('S3'), cards('S5'), cards('S4 D4'), cards('S7 D7')]);
    s = ok(s, { type: 'play', seat: 0, cards: [card('S3')] }); // 头游 0
    s = ok(s, { type: 'play', seat: 1, cards: [card('S5')] }); // 二游 1
    s = ok(s, { type: 'pass', seat: 2 });
    s = ok(s, { type: 'pass', seat: 3 }); // 1 已出完 → 对家 3 接风
    expect(s.turn).toBe(3);
    s = ok(s, { type: 'play', seat: 3, cards: cards('S7 D7') });
    expect(s.phase).toBe('handOver');
    expect(s.lastResult!.finishOrder).toEqual([0, 1, 3, 2]);
    expect(s.lastResult!.upgrade).toBe(1);
  });

  it('逢人配歧义需要声明牌型', () => {
    const s = playingState([cards('S3 D4 C5 S6 H7 SK'), cards('S8'), cards('S9'), cards('S10')], { level: 7 });
    expect(fail(s, { type: 'play', seat: 0, cards: cards('S3 D4 C5 S6 H7') })).toBe('AMBIGUOUS_COMBO');
    const s1 = ok(s, { type: 'play', seat: 0, cards: cards('S3 D4 C5 S6 H7'), combo: { type: 'straight', key: 7 } });
    expect(s1.trick!.lastPlay!.play.wildAssignments[0]).toMatchObject({ rank: 7 });
  });
});

describe('升级 / 过 A / 打 A 失败', () => {
  const base = { handNo: 1, level: 2 as Level, levelTeam: null, teamLevels: [2, 2] as [Level, Level], aFails: [0, 0] as [number, number] };
  it('+3 / +2 / +1', () => {
    expect(computeHandResult({ ...base, finishOrder: [0, 2, 1, 3] }, DEFAULT_RULES).levelsAfter).toEqual([5, 2]);
    expect(computeHandResult({ ...base, finishOrder: [1, 0, 3, 2] }, DEFAULT_RULES).levelsAfter).toEqual([2, 4]);
    expect(computeHandResult({ ...base, finishOrder: [1, 0, 2, 3] }, DEFAULT_RULES).levelsAfter).toEqual([2, 3]);
  });
  it('升级封顶 A', () => {
    const r = computeHandResult({ ...base, level: 13, levelTeam: 0, teamLevels: [13, 5], finishOrder: [0, 2, 1, 3] }, DEFAULT_RULES);
    expect(r.levelsAfter).toEqual([14, 5]);
    expect(r.matchWinner).toBeNull();
  });
  it('过 A：打本方 A、头游且升级 ≥2', () => {
    const atA = { ...base, level: 14 as Level, levelTeam: 0 as const, teamLevels: [14, 9] as [Level, Level] };
    expect(computeHandResult({ ...atA, finishOrder: [0, 1, 2, 3] }, DEFAULT_RULES).matchWinner).toBe(0);
    expect(computeHandResult({ ...atA, finishOrder: [2, 0, 1, 3] }, DEFAULT_RULES).matchWinner).toBe(0);
    const plus1 = computeHandResult({ ...atA, finishOrder: [0, 1, 3, 2] }, DEFAULT_RULES);
    expect(plus1.matchWinner).toBeNull();
    expect(plus1.aFailsAfter).toEqual([1, 0]);
  });
  it('不是在打本方 A 时，即使本方在 A 也不能过 A', () => {
    const r = computeHandResult({ ...base, level: 9, levelTeam: 1, teamLevels: [14, 9], finishOrder: [0, 2, 1, 3] }, DEFAULT_RULES);
    expect(r.matchWinner).toBeNull();
    expect(r.levelsAfter).toEqual([14, 9]);
  });
  it('打 A 三次失败退回 2（R4），且不叠加本局升级（R5）', () => {
    const atA = { ...base, level: 14 as Level, levelTeam: 0 as const, teamLevels: [14, 9] as [Level, Level], aFails: [2, 0] as [number, number] };
    const lost = computeHandResult({ ...atA, finishOrder: [1, 3, 0, 2] }, DEFAULT_RULES);
    expect(lost.levelsAfter).toEqual([2, 12]);
    expect(lost.aResetTeam).toBe(0);
    const won1 = computeHandResult({ ...atA, finishOrder: [0, 1, 3, 2] }, DEFAULT_RULES);
    expect(won1.levelsAfter).toEqual([2, 9]);
    const won1b = computeHandResult({ ...atA, finishOrder: [0, 1, 3, 2] }, makeRules({ upgradeAfterAReset: true }));
    expect(won1b.levelsAfter).toEqual([3, 9]);
    const noLimit = computeHandResult({ ...atA, finishOrder: [1, 3, 0, 2] }, makeRules({ aFailLimit: null }));
    expect(noLimit.levelsAfter).toEqual([14, 12]);
  });
});

/** 构造「上一局已结束」的状态，然后 startHand 进入进贡 */
function afterHand(finishOrder: Seat[], seed: number, config = DEFAULT_RULES): GameState {
  const result: HandResult = computeHandResult(
    { handNo: 1, level: 2, levelTeam: null, teamLevels: [2, 2], aFails: [0, 0], finishOrder },
    config,
  );
  return {
    ...createGame(config, seed),
    phase: 'handOver',
    handNo: 1,
    lastResult: result,
    teamLevels: result.levelsAfter,
    level: result.levelsAfter[result.winTeam],
    levelTeam: result.winTeam,
  };
}

function startWithTribute(finishOrder: Seat[], wantAnti: boolean, config = DEFAULT_RULES) {
  for (let seed = 1; seed < 500; seed++) {
    const s = ok(afterHand(finishOrder, seed, config), { type: 'startHand' });
    if (wantAnti === (s.antiTribute !== null)) return s;
  }
  throw new Error('no seed');
}

describe('进贡 / 还贡 / 抗贡', () => {
  it('单下：末游进贡最大牌（不含逢人配）给头游，头游还 ≤10 的牌，末游先出', () => {
    let s = startWithTribute([0, 1, 2, 3], false);
    expect(s.phase).toBe('tribute');
    expect(s.tribute).toMatchObject({ kind: 'single', payers: [3], receivers: [0] });
    expect(pendingActors(s)).toEqual([3]);
    const valid = validTributeCards(s.hands[3], s.level);
    const invalid = s.hands[3].find((id) => !valid.includes(id))!;
    expect(fail(s, { type: 'tribute', seat: 3, card: invalid })).toBe('INVALID_TRIBUTE_CARD');
    expect(fail(s, { type: 'tribute', seat: 1, card: s.hands[1][0]! })).toBe('NOT_A_PAYER');
    s = ok(s, { type: 'tribute', seat: 3, card: valid[0]! });
    expect(s.phase).toBe('return');
    expect(s.hands[0]).toHaveLength(28);
    const okReturn = validReturnCards(s.hands[0], s.level, s.config);
    const bad = s.hands[0].find((id) => !okReturn.includes(id))!;
    expect(fail(s, { type: 'returnTribute', seat: 0, card: bad })).toBe('INVALID_RETURN_CARD');
    s = ok(s, { type: 'returnTribute', seat: 0, card: okReturn[0]! });
    expect(s.phase).toBe('playing');
    expect(s.turn).toBe(3);
    expect(s.hands.map((h) => h.length)).toEqual([27, 27, 27, 27]);
    expect(checkInvariants(s)).toBeNull();
  });

  it('双下：两人进贡，大牌归头游；默认还贡牌只对双方可见', () => {
    let s = startWithTribute([0, 2, 1, 3], false);
    expect(s.config.publicReturnCard).toBe(false);
    expect(s.tribute).toMatchObject({ kind: 'double', payers: [1, 3], receivers: [0, 2] });
    const t1 = validTributeCards(s.hands[1], s.level)[0]!;
    const t3 = validTributeCards(s.hands[3], s.level)[0]!;
    s = ok(s, { type: 'tribute', seat: 3, card: t3 });
    expect(s.phase).toBe('tribute');
    s = ok(s, { type: 'tribute', seat: 1, card: t1 });
    expect(s.phase).toBe('return');
    const links = s.tribute!.links;
    expect(links.map((l) => l.to).sort()).toEqual([0, 2]);
    for (const l of links) {
      const r = reduce(s, { type: 'returnTribute', seat: l.to, card: validReturnCards(s.hands[l.to], s.level, s.config)[0]! });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const outsider = ([0, 1, 2, 3] as Seat[]).find((x) => x !== l.to && x !== l.from)!;
      const ev = eventsForSeat(r.events, outsider)[0]!;
      expect(ev).toMatchObject({ type: 'tributeReturned', card: null });
      const seen = toPlayerView(r.state, outsider).tribute!.links.find((x) => x.from === l.from)!;
      expect(seen).toMatchObject({ returned: true, returnCard: null });
      expect(toPlayerView(r.state, l.from).tribute!.links.find((x) => x.from === l.from)!.returnCard).not.toBeNull();
      s = r.state;
    }
    expect(s.phase).toBe('playing');
    expect([1, 3]).toContain(s.turn);
    expect(checkInvariants(s)).toBeNull();
  });

  it('配置公开时向所有玩家公开还贡牌和对应的进贡关系', () => {
    let s = startWithTribute([0, 1, 2, 3], false, makeRules({ publicReturnCard: true }));
    const tributeCard = validTributeCards(s.hands[3], s.level)[0]!;
    s = ok(s, { type: 'tribute', seat: 3, card: tributeCard });
    const returnCard = validReturnCards(s.hands[0], s.level, s.config)[0]!;
    const result = reduce(s, { type: 'returnTribute', seat: 0, card: returnCard });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      expect(toPlayerView(result.state, seat).tribute!.links).toMatchObject([
        { from: 3, to: 0, card: tributeCard, returned: true, returnCard },
      ]);
      expect(eventsForSeat(result.events, seat)).toContainEqual({ type: 'tributeReturned', from: 0, to: 3, card: returnCard });
    }
  });

  it('抗贡：进贡方持有两张大王，头游先出', () => {
    const s = startWithTribute([0, 1, 2, 3], true);
    expect(s.phase).toBe('playing');
    expect(s.turn).toBe(0);
    expect(s.antiTribute).toEqual([3]);
  });

  it('双下贡牌相同：按顺时针各给下家（R7），头游下家先出（R8）', () => {
    // 直接构造：两家进贡同点牌（本局升到打 5，还贡牌使用非级牌 S6）
    const base = afterHand([0, 2, 1, 3], 1);
    let s: GameState = {
      ...base,
      phase: 'tribute',
      handNo: 2,
      hands: [cards('S3'), cards('SA S4'), cards('S6'), cards('DA D4')],
      tribute: { kind: 'double', payers: [1, 3], receivers: [0, 2], paid: [], links: [] },
    };
    s = ok(s, { type: 'tribute', seat: 1, card: card('SA') });
    s = ok(s, { type: 'tribute', seat: 3, card: card('DA') });
    expect(s.tribute!.links.map((l) => [l.from, l.to])).toEqual([[1, 2], [3, 0]]);
    s = ok(s, { type: 'returnTribute', seat: 2, card: card('S6') });
    s = ok(s, { type: 'returnTribute', seat: 0, card: card('S3') });
    expect(s.turn).toBe(1);
  });
});

describe('信息隔离（PlayerView）', () => {
  it('视图只包含自己的手牌，不含 rng 与他人手牌', () => {
    const s = ok(createGame(DEFAULT_RULES, 'view'), { type: 'startHand' });
    for (const seat of [0, 1, 2, 3] as Seat[]) {
      const v = toPlayerView(s, seat);
      const json = JSON.stringify(v);
      expect(json).not.toContain('"rng"');
      expect(json).not.toContain('"hands"');
      expect(v.myHand).toEqual(s.hands[seat]);
      expect(v.handCounts).toEqual([27, 27, 27, 27]);
    }
  });
});

describe('随机对局模拟（不变量）', () => {
  it('随机合法动作打完多局，牌守恒且状态机不卡死', () => {
    const rand = makeRandom('sim');
    let s = createGame(makeRules({ firstLeader: 0 }), 'sim');
    let hands = 0;
    let steps = 0;
    while (hands < 12 && s.phase !== 'matchOver' && steps < 20000) {
      steps++;
      if (s.phase === 'waiting' || s.phase === 'handOver') {
        s = ok(s, { type: 'startHand' });
        hands++;
        continue;
      }
      const actors = pendingActors(s);
      expect(actors.length).toBeGreaterThan(0);
      const seat = actors[0]!;
      const actions = legalActions(s, seat);
      expect(actions.length).toBeGreaterThan(0);
      // 偏向不要以加快结束；首出时随机
      const pick = actions.find((a) => a.type === 'pass') && rand() < 0.5 ? actions.find((a) => a.type === 'pass')! : actions[Math.floor(rand() * actions.length)]!;
      s = ok(s, pick);
      expect(checkInvariants(s)).toBeNull();
    }
    expect(hands).toBeGreaterThanOrEqual(2);
  });
});
