import { describe, expect, it } from 'vitest';
import { createGame, interpret, makeRules, reduce, toPlayerView } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { searchAdvancedWithInfo } from '../src/advancedSearch.ts';
import { choosePlay, DEFAULT_HEURISTIC } from '../src/heuristic.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

describe('高级策略的开局与跟牌', () => {
  it('跟三带二时比较同点数的不同花色，保留同花顺', () => {
    const hand = cards('S5 S6 S7 S8 S9 H10 D10 C10 D5 C5 SQ DK');
    const previous = interpret(cards('S3 D3 C3 S4 D4'), 2, makeRules()).find(p => p.combo.type === 'fullHouse')!;
    const state = playingState([hand, cards('SA DA CA HJ'), cards('SK DK'), cards('H7 H8 H9 H10 HJ HQ')], {
      trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
    });
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type).toBe('play');
    if (result.decision.type === 'play') expect(result.decision.play.cards.some(id => cards('S5 S6 S7 S8 S9').includes(id))).toBe(false);
  });

  it('跟牌时也保护逢人配可组成的同花顺', () => {
    const hand = cards('S5 S6 S7 S8 H2 D5 C5 SQ DK');
    const previous = interpret(cards('S3 D3 C3 S4 D4'), 2, makeRules()).find(p => p.combo.type === 'fullHouse')!;
    const state = playingState([hand, cards('SA DA CA HJ H8 H9 HK'), cards('SK DK'), cards('H7 H8 H9 H10 HJ HQ HK')], {
      trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
    });
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type).toBe('pass');
    expect(result.reasons.join(' ')).toContain('拆掉同花顺');
  });

  it('残局首出估算也保护逢人配同花顺', () => {
    const hand = cards('S5 S6 S7 S8 H2 D5');
    const state = playingState([hand, cards('SA DA CA HJ H8 H9 HK'), cards('SK DK'), cards('H7 H8 H9 H10 HJ HQ HK')]);
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type).toBe('play');
    if (result.decision.type === 'play') expect(result.decision.play.cards).toEqual(cards('D5'));
  });

  it('手牌较多且上家出小王时考虑大王夺取出牌权', () => {
    const hand = cards('BJ BJ S3 D4 C5 S6 D7 S8 D9 C10 C8 SQ SK SA D3 D5 D6 D8 D10 DJ DQ DK DA C3 C4 C6 C7');
    const previous = interpret(cards('SJ'), 2, makeRules())[0]!;
    const state = playingState([hand, cards('H3 H4 H5 H6 H7 H8 H9 H10'), cards('C8 C9 C10 CJ CQ CK CA'), cards('H3 H4 H5 H6 H7 H8 H9 H10 HQ')], {
      trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] }, playedCards: cards('SJ'),
    });
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type).toBe('play');
    if (result.decision.type === 'play') expect(result.decision.play.combo.key).toBe(17);
    expect(result.reasons.join(' ')).toContain('大王取得单张控制机会');
  });

  it('完整发牌后可对相同样本比较候选出法，过期预算回退', () => {
    const start = reduce(createGame(makeRules({ firstLeader: 0 }), 'opening-test'), { type: 'startHand' });
    if (!start.ok) throw new Error('Setup failed');
    const view = toPlayerView(start.state, 0);
    const fallback = choosePlay(view, { ...DEFAULT_HEURISTIC, advanced: true });
    const search = searchAdvancedWithInfo(view, fallback, { deadline: Date.now() + 5000 }, true);
    expect(search.samples).toBeGreaterThan(0);
    expect(search.scores.length).toBeGreaterThan(1);
    expect(searchAdvancedWithInfo(view, fallback, { deadline: 0 }, true)).toMatchObject({ decision: fallback, samples: 0 });
  }, 10000);

  it('上轮队友对同类牌不要会作为弱信息参与本轮模拟', () => {
    let state = playingState([
      cards('S3 D3 C3 S4 D4 S5 D5 S6 D6 S7 D7'),
      cards('SA DA CA SK DK CK'),
      cards('S9 D9 C9 H9 S10 D10 C10'),
      cards('S8 D8 C8 H5 C5 H7 C7 D7 H4 C4 H6'),
    ], { turn: 3 });
    const act = (action: Parameters<typeof reduce>[1]) => {
      const result = reduce(state, action);
      if (!result.ok) throw new Error(result.error.message);
      state = result.state;
    };
    act({ type: 'play', seat: 3, cards: cards('S8 D8 C8 H5 C5') });
    act({ type: 'pass', seat: 0 });
    act({ type: 'pass', seat: 1 });
    act({ type: 'pass', seat: 2 });
    act({ type: 'play', seat: 3, cards: cards('H7 C7 D7 H4 C4') });
    const remaining = new Set(state.hands.flat());
    state = { ...state, playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !remaining.has(id)) };
    const view = toPlayerView(state, 0);
    expect(view.previousTrick?.passed).toContain(2);
    const analysis = analyzeAdvancedPlay(view, { allPhases: true }, { deadline: Date.now() + 5000 })!;
    expect(analysis.reasons.join(' ')).toContain('上轮对同类牌选择不要');
    expect(analysis.reasons.join(' ')).toContain('不能断定队友没有牌');
  }, 10000);
});
