import { describe, expect, it } from 'vitest';
import { interpret, makeRules, reduce, toPlayerView, type Combo, type Play, type PlayerView } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { choosePlay, DEFAULT_HEURISTIC, type HeuristicTrace } from '../src/heuristic.ts';
import { searchAdvancedWithInfo } from '../src/advancedSearch.ts';
import { tacticalAdjustments, tacticalContext, type TacticalContext } from '../src/tactics.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

function play(spec: string, type: Combo['type']): Play {
  const result = interpret(cards(spec), 2, makeRules()).find(item => item.combo.type === type);
  if (!result) throw new Error(`Missing ${type}: ${spec}`);
  return result;
}
function view(): PlayerView {
  return toPlayerView(playingState([
    cards('S3 D3 C3 S4 D4 S5 D5 S6 S7 S8 S9 S10 SK BJ'),
    cards('SA DA CA HA SK DK CK HK S2 D2'),
    cards('C4 C5 C6 C7 C8 C9 C10 CJ CQ CK'),
    cards('H3 H4 H5 H6 H7 H8 H9 H10 HJ HQ'),
  ]), 0);
}
function cost(v: PlayerView, p: Play, context = tacticalContext(v)): number {
  return tacticalAdjustments(v, p, context).reduce((total, item) => total + item.cost, 0);
}

describe('口诀战术覆盖', () => {
  it('开局同时比较对子试探、有王出单和无王三带二', () => {
    const v = view();
    const pair = play('S4 D4', 'pair');
    const single = play('S6', 'single');
    const full = play('S3 D3 C3 S4 D4', 'fullHouse');
    const withJoker = tacticalContext(v);
    expect(withJoker.jokers).toBe(1);
    expect(tacticalAdjustments(v, pair, withJoker).some(item => item.code === 'probe_pair')).toBe(true);
    expect(tacticalAdjustments(v, single, withJoker).some(item => item.code === 'joker_single')).toBe(true);
    const noJoker = { ...v, myHand: v.myHand.filter(id => !cards('BJ').includes(id)) };
    expect(tacticalAdjustments(noJoker, full, tacticalContext(noJoker)).some(item => item.code === 'no_joker_fullhouse')).toBe(true);
  });

  it('争头游时处理小单，牌弱时暂缓，并比较强弱打法及收牌能力', () => {
    const v = view();
    const small = play('S6', 'single');
    const high = play('SK', 'single');
    const common = tacticalContext(v);
    const race: TacticalContext = { ...common, mode: 'race', lowSingles: 2 };
    const support: TacticalContext = { ...common, mode: 'support', lowSingles: 2, controlCards: 0 };
    expect(tacticalAdjustments(v, small, race).some(item => item.code === 'race_singles')).toBe(true);
    expect(tacticalAdjustments(v, small, support).some(item => item.code === 'weak_single')).toBe(true);
    expect(cost(v, small, race)).toBeLessThan(cost(v, small, support));
    expect(tacticalAdjustments(v, small, race).some(item => item.code === 'strong_low')).toBe(true);
    expect(tacticalAdjustments(v, high, support).some(item => item.code === 'weak_high')).toBe(true);
    expect(tacticalAdjustments(v, small, race).some(item => item.code === 'retain_control')).toBe(true);
    const noControls = { ...v, myHand: v.myHand.filter(id => id !== cards('BJ')[0]) };
    expect(tacticalAdjustments(noControls, small, support).some(item => item.code === 'no_control')).toBe(true);
  });

  it('三不带、拆牌成顺和对手 5–10 张时逐一比较相应牌型', () => {
    const v = view();
    const base: TacticalContext = { ...tacticalContext(v), mode: 'support' };
    const triple = play('S3 D3 C3', 'triple');
    const pair = play('S4 D4', 'pair');
    const single = play('S6', 'single');
    const full = play('S3 D3 C3 S4 D4', 'fullHouse');
    const straight = play('S3 S4 S5 S6 S7', 'straight');
    expect(tacticalAdjustments(v, triple, { ...base, opponents: [10, 12] }).some(item => item.code === 'bare_triple')).toBe(true);
    for (const [count, candidate, code] of [
      [5, pair, 'opp5_pair'], [6, triple, 'opp6_triple'], [7, full, 'opp78_composite'],
      [8, straight, 'opp78_composite'], [9, pair, 'opp9_single_pair'], [9, single, 'opp9_single_pair'], [10, pair, 'opp10_pair'],
    ] as const) {
      expect(tacticalAdjustments(v, candidate, { ...base, opponents: [count, 12] }).some(item => item.code === code)).toBe(true);
      expect(tacticalAdjustments(v, candidate, { ...base, opponents: [11, 12] }).some(item => item.code === code)).toBe(false);
    }
    const fragile = { ...v, myHand: cards('S3 D3 S4 D4 S5 D5 S6 S7 SQ DK') };
    expect(tacticalAdjustments(fragile, straight, tacticalContext(fragile)).some(item => item.code === 'split_straight')).toBe(true);
  });

  it.each([
    [5, '对手剩 5 张'], [6, '对手剩 6 张'], [7, '对手剩 7–8 张'],
    [8, '对手剩 7–8 张'], [9, '对手剩 9 张'], [10, '对手剩 10 张'],
  ])('首出真实评分会考虑对手剩 %s 张', (count, text) => {
    const initial = view();
    const v = { ...initial, handCounts: [initial.myHand.length, count, 10, 12] as const };
    let trace: HeuristicTrace | undefined;
    choosePlay(v, { ...DEFAULT_HEURISTIC, advanced: true }, result => { trace = result; });
    expect(trace?.mode).toBe('lead');
    expect(trace?.scores.flatMap(item => item.details ?? []).some(detail => detail.includes(text))).toBe(true);
  });

  it('对手首次顺子可用炸弹拦截，第二次顺子不会重复触发', () => {
    const hand = cards('S9 D9 C9 H9 S2 D5 C7 HQ SK DA BJ');
    const first = play('S3 D4 C5 H6 S7', 'straight');
    const second = play('S8 D9 C10 HJ SQ', 'straight');
    const mk = (current: Play, history: PlayerView['publicHistory']) => ({
      ...toPlayerView(playingState([hand, cards('SA DA CA SK DK CK H3'), cards('S4 D4 C4 H4'), cards('H3 H4 H5 H6 H7 H8 H9')]), 0),
      trick: { leader: 3 as const, lastPlay: { seat: 3 as const, play: current }, passed: [], history: [{ seat: 3 as const, play: current }] },
      publicHistory: history,
    });
    const firstView = mk(first, [{ seat: 3, play: first }]);
    expect(tacticalContext(firstView).firstOpponentStraight).toBe(true);
    const decision = choosePlay(firstView, { ...DEFAULT_HEURISTIC, advanced: true });
    expect(decision.type === 'play' && decision.play.combo.type).toBe('bomb');
    const secondView = mk(second, [{ seat: 3, play: first }, { seat: 3, play: second }]);
    expect(tacticalContext(secondView).firstOpponentStraight).toBe(false);
    expect(choosePlay(secondView, { ...DEFAULT_HEURISTIC, advanced: true })).toEqual({ type: 'pass' });
  });

  it('对手剩五张倾向拦截，剩四张且不紧急时留炸弹', () => {
    const hand = cards('S9 D9 C9 H9 S2 D5 C7 HQ SK DA');
    const last = play('BJ', 'single');
    const make = (remaining: number) => ({
      ...toPlayerView(playingState([hand, cards('SA DA CA SK DK CK H3'), cards('S4 D4 C4 H4'), cards('H3 H4 H5 H6 H7')]), 0),
      handCounts: [hand.length, 7, 4, remaining] as const,
      trick: { leader: 3 as const, lastPlay: { seat: 3 as const, play: last }, passed: [], history: [] },
    });
    const five = choosePlay(make(5), { ...DEFAULT_HEURISTIC, advanced: true });
    expect(five.type === 'play' && five.play.combo.type).toBe('bomb');
    expect(choosePlay(make(4), { ...DEFAULT_HEURISTIC, advanced: true })).toEqual({ type: 'pass' });
  });

  it('根据队友公开出牌试探递牌，且没有历史时不编造需求', () => {
    const v = view();
    const pair = play('S4 D4', 'pair');
    expect(tacticalContext(v).partnerNeed).toBeNull();
    const informed = { ...v, publicHistory: [{ seat: 2 as const, play: play('C5 H5', 'pair') }, { seat: 2 as const, play: play('C6 H6', 'pair') }] };
    const context = tacticalContext(informed);
    expect(context.partnerNeed).toBe('pair');
    expect(tacticalAdjustments(informed, pair, context).some(item => item.code === 'feed_partner')).toBe(true);
  });

  it('弱牌时为还未行动的队友降低跟牌阈值；对家领先通常让牌', () => {
    const hand = cards('S3 D3 C3 S4 D4 C4 S5 D5 C5 S6 D6 C6 S7 D7 C7 S8 D8 C8 S9 D9 C9');
    const last = play('S10', 'single');
    const v = { ...toPlayerView(playingState([hand, cards('SA DA CA SK DK CK H3 H4 H5 H6'), cards('S4 D4 C4 H4 H7'), cards('H3 H4 H5 H6 H7 H8 H9 H10 HJ HQ')]), 0),
      trick: { leader: 3 as const, lastPlay: { seat: 3 as const, play: last }, passed: [], history: [] } };
    let trace: HeuristicTrace | undefined;
    choosePlay(v, { ...DEFAULT_HEURISTIC, advanced: true }, result => { trace = result; });
    expect(trace?.partnerCaution).toBe(true);
    expect(trace?.limit).toBe(6);
    const partnerView = { ...v, trick: { ...v.trick, lastPlay: { seat: 2 as const, play: last } } };
    expect(analyzeAdvancedPlay(partnerView, { search: false })?.decision).toEqual({ type: 'pass' });
  });

  it('牌力较强、队友牌多且对手将走完时，可以用大王接队友单张', () => {
    const hand = cards('BJ S2 D2 C2 S3 D3 C3 S5 D6');
    const last = play('S4', 'single');
    const state = playingState([hand, cards('SA DA CA SK DK'), cards('S6 S7 S8 S9 S10'), cards('H3 H4 H5 H6 H7')], {
      trick: { leader: 2, lastPlay: { seat: 2, play: last }, passed: [], history: [] },
    });
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type === 'play' && result.decision.play.combo.key).toBe(17);
    expect(result.reasons.join(' ')).toContain('队友仍有多张牌');
  });

  it('队友出小王且自己持有两张大王时，基础策略和全阶段搜索都保留队友牌权', () => {
    const hand = cards('BJ BJ SJ S3 D3 C3 S4 D4 C4 S5 D6 C7 S8 D9');
    const last = interpret([106], 2, makeRules())[0]!;
    const base = toPlayerView(playingState([hand, [], [], []]), 0);
    const playedCards = [106, ...Array.from({ length: 108 }, (_, id) => id)
      .filter(id => id !== 106 && !hand.includes(id)).slice(0, 55)];
    const v = { ...base, handCounts: [14, 6, 13, 19] as const, playedCards,
      trick: { leader: 2 as const, lastPlay: { seat: 2 as const, play: last }, passed: [1 as const], history: [] } };
    const decision = choosePlay(v, { ...DEFAULT_HEURISTIC, advanced: true });
    expect(decision).toEqual({ type: 'pass' });
    expect(searchAdvancedWithInfo(v, decision, { deadline: Date.now() + 5000 }, true).decision).toEqual({ type: 'pass' });
    expect(analyzeAdvancedPlay(v, { allPhases: true }, { deadline: Date.now() + 5000 })?.decision).toEqual({ type: 'pass' });
  });

  it('队友单张没有更大的未知牌时，自己仍可一手走完', () => {
    const hand = cards('BJ');
    const last = play('SJ', 'single');
    const base = toPlayerView(playingState([hand, cards('S3 S4'), cards('S5 S6'), cards('S7 S8')]), 0);
    const v = { ...base, playedCards: [52, 107],
      trick: { leader: 2 as const, lastPlay: { seat: 2 as const, play: last }, passed: [], history: [] } };
    const result = analyzeAdvancedPlay(v, { allPhases: true }, { deadline: Date.now() + 5000 })!;
    expect(result.decision.type === 'play' && result.decision.play.cards).toEqual(hand);
  });

  it('出牌与不要的公开历史跨轮保留，新局重置', () => {
    let state = playingState([cards('S3 S4'), cards('S5 S6'), cards('S7 S8'), cards('S9 S10')]);
    for (const action of [
      { type: 'play' as const, seat: 0 as const, cards: cards('S3') },
      { type: 'pass' as const, seat: 1 as const }, { type: 'pass' as const, seat: 2 as const }, { type: 'pass' as const, seat: 3 as const },
    ]) {
      const result = reduce(state, action);
      if (!result.ok) throw new Error(result.error.message);
      state = result.state;
    }
    expect(toPlayerView(state, 0).publicHistory).toHaveLength(4);
    const started = reduce({ ...state, phase: 'handOver' }, { type: 'startHand' });
    if (!started.ok) throw new Error(started.error.message);
    expect(toPlayerView(started.state, 0).publicHistory).toEqual([]);
  });
});
