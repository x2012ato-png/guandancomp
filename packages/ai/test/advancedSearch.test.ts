import { describe, expect, it } from 'vitest';
import { checkInvariants, generatePlays, makeRandom, reduce, toPlayerView, type GameState } from '@guandan/engine';
import { decisionToAction } from '../src/types.ts';
import { analyzeAdvancedPlay, createAdvancedPolicy } from '../src/advanced.ts';
import { sampleAdvancedWorld, searchAdvanced, searchAdvancedWithInfo, selectStableCandidate } from '../src/advancedSearch.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

function endgame(): GameState {
  const hands: [number[], number[], number[], number[]] = [
    cards('S3 SK H2'), cards('D5 DJ'), cards('C6 D6'), cards('S7 C7'),
  ];
  const remaining = new Set(hands.flat());
  return playingState(hands, { playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !remaining.has(id)) });
}

describe('高级策略的残局采样', () => {
  it('模拟有不同倾向时，默认策略和参考模式仍保留基础决策', () => {
    const rng = makeRandom('reference-fixture-48');
    const deck = Array.from({ length: 108 }, (_, id) => id);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    const state = playingState([deck.slice(0, 4), deck.slice(4, 6), deck.slice(6, 8), deck.slice(8, 10)], { playedCards: deck.slice(10) });
    const view = toPlayerView(state, 0);
    const base = analyzeAdvancedPlay(view, { search: false })!;
    const searched = analyzeAdvancedPlay(view, { search: true })!;
    const reference = analyzeAdvancedPlay(view, { search: true, adoptSearch: false })!;
    expect(searched.decision).not.toEqual(base.decision);
    expect(reference.decision).toEqual(base.decision);
    expect(createAdvancedPolicy().decide(view)).toEqual(base.decision);
    expect(createAdvancedPolicy({ search: true }).decide(view)).toEqual(searched.decision);
    expect(reference.reasons.join(' ')).toContain('仅供参考，仍保留基础建议');
    expect(reference.reasons.join(' ')).not.toContain('因此调整了原建议');
  });
  it('开局样本不足或意见不一致时保留基准行动，仅在优势稳定时调整', () => {
    expect(selectStableCandidate([0, 3], [0, 3], 3, true)).toBe(0);
    expect(selectStableCandidate([0, 4], [0, 3], 4, true)).toBe(0);
    expect(selectStableCandidate([0, 0.2], [0, 4], 4, true)).toBe(0);
    expect(selectStableCandidate([0, 0.4], [0, 4], 4, true)).toBe(1);
    expect(selectStableCandidate([0, 1.2], [0, 10], 12, true)).toBe(1);
    expect(selectStableCandidate([0, 1.2], [0, 9], 12, true)).toBe(0);
    expect(selectStableCandidate([0, 0.2], [0, 3], 3, false)).toBe(1);
  });
  it('有充足预算时，所有候选比较相同的 12 组样本', () => {
    const view = toPlayerView(endgame(), 0);
    const fallback = { type: 'play' as const, play: generatePlays(view.myHand, view.level, view.config)[0]! };
    const info = searchAdvancedWithInfo(view, fallback, { rng: makeRandom('twelve-samples') });
    expect(info.samples).toBe(12);
    expect(info.candidates).toBeGreaterThan(1);
    expect(info.scores).toHaveLength(info.candidates);
    expect(info.scores.every(item => Number.isFinite(item.average))).toBe(true);
  });
  it('保持手牌数量和牌守恒，并遵循已知的贡牌和还贡归属', () => {
    const view = toPlayerView(endgame(), 0);
    const card = cards('D5')[0]!;
    const returned = cards('S7')[0]!;
    const withTribute = { ...view, tribute: { kind: 'single' as const, payers: [3 as const], receivers: [1 as const], paid: [{ from: 3 as const, card }],
      links: [{ from: 3 as const, to: 1 as const, card, returned: true, returnCard: returned }] } };
    const rng = makeRandom('known-tribute');
    for (let i = 0; i < 20; i++) {
      const world = sampleAdvancedWorld(withTribute, rng);
      expect(world.hands[0]).toEqual(view.myHand);
      expect(world.hands.map(hand => hand.length)).toEqual(view.handCounts);
      expect(world.hands[1]).toContain(card);
      expect(world.hands[3]).toContain(returned);
      expect(checkInvariants(world)).toBeNull();
    }
  });

  it('未公开的还贡可能是原贡牌，不将贡牌错误地固定给收贡者', () => {
    const view = toPlayerView(endgame(), 0);
    const card = cards('D5')[0]!;
    const hidden = { ...view, tribute: { kind: 'single' as const, payers: [3 as const], receivers: [1 as const], paid: [{ from: 3 as const, card }],
      links: [{ from: 3 as const, to: 1 as const, card, returned: true, returnCard: null }] } };
    const rng = makeRandom('hidden-return');
    const worlds = Array.from({ length: 30 }, () => sampleAdvancedWorld(hidden, rng));
    expect(worlds.some(world => !world.hands[1].includes(card))).toBe(true);
    expect(worlds.every(world => world.hands[1].includes(card) || world.hands[3].includes(card))).toBe(true);
    expect(worlds.every(world => checkInvariants(world) === null)).toBe(true);
  });

  it('使用采样并返回合法动作；没有时间时回退到原动作', () => {
    const state = endgame();
    const view = toPlayerView(state, 0);
    const fallback = { type: 'play' as const, play: generatePlays(view.myHand, view.level, view.config)[0]! };
    let draws = 0;
    const seeded = makeRandom('search');
    const decision = searchAdvanced(view, fallback, { rng: () => { draws++; return seeded(); } });
    expect(draws).toBeGreaterThan(0);
    expect(reduce(state, decisionToAction(0, decision)).ok).toBe(true);
    expect(searchAdvanced(view, fallback, { deadline: 0, rng: () => { throw new Error('No sampling after deadline'); } })).toEqual(fallback);
  });

  it('相同公开信息下，对手真实手牌改变不会改变决策', () => {
    const state = endgame();
    const swapped: GameState = { ...state, hands: [state.hands[0], state.hands[3], state.hands[2], state.hands[1]] };
    const first = toPlayerView(state, 0);
    const second = toPlayerView(swapped, 0);
    expect(first).toEqual(second);
    const policy = createAdvancedPolicy();
    expect(policy.decide(first)).toEqual(policy.decide(second));
  });

  it('模拟能避开让下一家立刻走完的单张，并选择可保住牌权的对子', () => {
    const hands: [number[], number[], number[], number[]] = [cards('S3 D3 SA'), cards('S5'), cards('S6'), cards('S7')];
    const remaining = new Set(hands.flat());
    const state = playingState(hands, { playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !remaining.has(id)) });
    const view = toPlayerView(state, 0);
    const single = generatePlays(view.myHand, view.level, view.config).find(play => play.combo.type === 'single' && play.combo.key === 3)!;
    const decision = searchAdvanced(view, { type: 'play', play: single }, { rng: makeRandom('avoid-giving-away-first') });
    expect(decision.type === 'play' && decision.play.combo.type).toBe('pair');
  });
});
