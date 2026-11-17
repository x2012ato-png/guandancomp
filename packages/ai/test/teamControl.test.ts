import { describe, expect, it } from 'vitest';
import { interpret, isBomb, makeRandom, makeRules, reduce, toPlayerView, type GameState } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { searchAdvancedWithInfo } from '../src/advancedSearch.ts';
import { decisionToAction } from '../src/types.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

function withPublicCards(state: GameState): GameState {
  const hidden = new Set(state.hands.flat());
  return { ...state, playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !hidden.has(id)) };
}

describe('队友牌权与残局控牌顺序', () => {
  it.each(['SJ SJ S3 D5 C9', 'BJ BJ S3 D5 C9', 'S2 D2 C2 H2 S3 D5'])('队友出对七时，全阶段模拟不使用王对或炸弹无故接管（%s）', hand => {
    const last = interpret(cards('S7 D7'), 2, makeRules())[0]!;
    const state = withPublicCards(playingState([
      cards(hand), cards('SA DA S8'), cards('C4 D4 C6 D6'), cards('SK DK S10'),
    ], { trick: { leader: 2, lastPlay: { seat: 2, play: last }, passed: [3], history: [] } }));
    const view = toPlayerView(state, 0);
    const info = searchAdvancedWithInfo(view, { type: 'pass' }, { rng: makeRandom('partner-sevens') }, true);
    expect(info.decision).toEqual({ type: 'pass' });
    expect(info.scores.every(item => item.decision.type === 'pass' ||
      (item.decision.type === 'play' && item.decision.play.cards.length === view.myHand.length))).toBe(true);
    expect(analyzeAdvancedPlay(view, { allPhases: true })!.decision).toEqual({ type: 'pass' });
  });

  it('先出散单，再用保留的炸弹收回牌权，最后一手走完', () => {
    let state = withPublicCards(playingState([
      cards('S2 D2 C2 H2 S4 D6 C6'), cards('SA DA'), cards('SQ DQ CQ'), cards('SK DK'),
    ], { level: 3 }));
    const act = (action: Parameters<typeof reduce>[1]) => {
      const result = reduce(state, action);
      if (!result.ok) throw new Error(result.error.message);
      state = result.state;
    };
    const decide = () => analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!.decision;
    const opening = decide();
    expect(opening.type === 'play' && opening.play.cards).toEqual(cards('S4'));
    act(decisionToAction(0, opening));
    act({ type: 'play', seat: 1, cards: cards('SA') });
    act({ type: 'pass', seat: 2 });
    act({ type: 'pass', seat: 3 });
    const reclaim = decide();
    expect(reclaim.type === 'play' && isBomb(reclaim.play.combo)).toBe(true);
    act(decisionToAction(0, reclaim));
    for (const seat of [1, 2, 3] as const) act({ type: 'pass', seat });
    const finish = decide();
    expect(finish.type === 'play' && new Set(finish.play.cards)).toEqual(new Set(cards('D6 C6')));
    act(decisionToAction(0, finish));
    expect(state.finishOrder[0]).toBe(0);
  });

  it.each([false, true])('四个2加多张散单先处理散单，保留炸弹收回牌权（模拟=%s）', search => {
    const state = withPublicCards(playingState([
      cards('S2 D2 C2 H2 S4 D6 C9'), cards('SA DA'), cards('SK DK CK'), cards('S10 D10'),
    ], { level: 3 }));
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search, allPhases: true })!;
    expect(result.decision.type).toBe('play');
    if (result.decision.type !== 'play') throw new Error('Expected lead');
    expect(isBomb(result.decision.play.combo)).toBe(false);
    expect(result.decision.play.combo.type).toBe('single');
    expect(reduce(state, decisionToAction(0, result.decision)).ok).toBe(true);
  });

  it('对手报单时不先空炸再送小单，先用对子阻止对手直接走完', () => {
    const state = withPublicCards(playingState([
      cards('S2 D2 C2 H2 S4 D6'), cards('SA'), cards('SK DK CK'), cards('S10'),
    ], { level: 3 }));
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type === 'play' && result.decision.play.combo.type).toBe('pair');
  });

  it('残局仍允许炸弹一手走完', () => {
    const state = playingState([cards('S2 D2 C2 H2'), cards('SA DA'), cards('SK DK'), cards('S10 D10')], { level: 3 });
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type === 'play' && result.decision.play.cards.length).toBe(4);
  });

  it('队友领先时仍允许用王对一手走完', () => {
    const last = interpret(cards('S7 D7'), 2, makeRules())[0]!;
    const state = withPublicCards(playingState([cards('SJ SJ'), cards('SA DA'), cards('C4 D4'), cards('SK DK')], {
      trick: { leader: 2, lastPlay: { seat: 2, play: last }, passed: [3], history: [] },
    }));
    const decision = analyzeAdvancedPlay(toPlayerView(state, 0), { allPhases: true })!.decision;
    expect(decision.type === 'play' && decision.play.cards).toEqual(cards('SJ SJ'));
  });
});
