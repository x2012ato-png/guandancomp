import { describe, expect, it } from 'vitest';
import { interpret, isBomb, makeRandom, makeRules, reduce, toPlayerView, type GameState } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { searchAdvancedWithInfo } from '../src/advancedSearch.ts';
import { partnerMayFinishPair } from '../src/tactics.ts';
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

  it('上家已出完且自己剩两副炸弹加一张大王时，出完大王后整出炸弹而不拆出单张', () => {
    const myNine = cards('S5 H5 C5 D5 BJ S2 H2 C2 D2');
    const partnerFour = cards('S7 D7 SK DK');
    const downSeventeen = cards('S3 D3 C3 H3 S4 D4 C4 S6 D6 C6 S8 D8 C8 S9 D9 S10 D10');
    let state = withPublicCards(playingState([partnerFour, [], myNine, downSeventeen], {
      level: 3,
      turn: 2,
      finishOrder: [1],
    }));
    const first = analyzeAdvancedPlay(toPlayerView(state, 2), { search: true, allPhases: true })!.decision;
    expect(first.type === 'play' && first.play.combo).toEqual({ type: 'single', key: 17, size: 1 });
    for (const action of [
      decisionToAction(2, first),
      { type: 'pass' as const, seat: 3 as const },
      { type: 'pass' as const, seat: 0 as const },
    ]) {
      const next = reduce(state, action);
      if (!next.ok) throw new Error(next.error.message);
      state = next.state;
    }
    const second = analyzeAdvancedPlay(toPlayerView(state, 2), { search: true, allPhases: true })!.decision;
    expect(second.type).toBe('play');
    if (second.type === 'play') expect(isBomb(second.play.combo)).toBe(true);
  });

  it('打九中期队友剩五张、自己剩二十一张时，用炸弹压制对手多张牌型，对手出单张八时让队友接牌而不开炸', () => {
    const level = 9;
    const coachHand = cards('S2 H2 C2 D2 S3 D4 C5 S6 H7 D8 S10 HJ CQ DK SA S4 D6 C7 H10 SQ CK');
    const partnerHand = cards('S9 D9 SJ SK DA');
    const upOpponent = cards('SK HK CK S4 D4 S5 D5 C6 H6 S7 D7');
    const downOpponent = cards('S3 H3 C3 S8 H8 C8 D10 C10 SJ DJ CQ DQ CA HA');
    const fullHouse = interpret(cards('SK HK CK S4 D4'), level, makeRules()).find(p => p.combo.type === 'fullHouse')!;
    const singleEight = interpret(cards('S8'), level, makeRules())[0]!;
    const vsComposite = withPublicCards(playingState([partnerHand, upOpponent, coachHand, downOpponent], {
      level,
      turn: 2,
      trick: { leader: 1, lastPlay: { seat: 1, play: fullHouse }, passed: [], history: [{ seat: 1, play: fullHouse }] },
    }));
    const compositeDecision = analyzeAdvancedPlay(toPlayerView(vsComposite, 2), { search: true, allPhases: true })!.decision;
    expect(compositeDecision.type).toBe('play');
    if (compositeDecision.type === 'play') expect(isBomb(compositeDecision.play.combo)).toBe(true);

    const vsSingleEight = withPublicCards(playingState([partnerHand, upOpponent.slice(0, 5), coachHand, downOpponent], {
      level,
      turn: 2,
      trick: { leader: 1, lastPlay: { seat: 1, play: singleEight }, passed: [], history: [{ seat: 1, play: singleEight }] },
    }));
    const singleDecision = analyzeAdvancedPlay(toPlayerView(vsSingleEight, 2), { search: true, allPhases: true })!.decision;
    expect(singleDecision).toEqual({ type: 'pass' });
  });
  it.each([false, true])('对手已头游、队友剩两张时，让其尝试接小对子（模拟=%s）', search => {
    const pair = interpret(cards('S5 D5'), 4, makeRules())[0]!;
    const state = withPublicCards(playingState([
      cards('S7 D7 C7 H7 S3 C8 C9 SK DA'), [], cards('S8 D8'),
      cards('S2 D2 C2 H2 S6 D6 C6 H6 S10 D10 C10 H10'),
    ], { level: 4, turn: 0, finishOrder: [1],
      trick: { leader: 3, lastPlay: { seat: 3, play: pair }, passed: [], history: [{ seat: 3, play: pair }] } }));
    const view = toPlayerView(state, 0);
    const result = analyzeAdvancedPlay(view, { search, allPhases: true })!;
    expect(result.decision).toEqual({ type: 'pass' });
    expect(result.reasons.join(' ')).toContain('可能用对子');
    const passed = reduce(state, decisionToAction(0, result.decision));
    if (!passed.ok) throw new Error(passed.error.message);
    const finish = reduce(passed.state, { type: 'play', seat: 2, cards: cards('S8 D8') });
    expect(finish.ok && finish.state.finishOrder.slice(0, 2)).toEqual([1, 2]);
  });

  it('队友已不要或对手接近走完时，不因队友剩两张而一律让牌', () => {
    const pair = interpret(cards('S5 D5'), 4, makeRules())[0]!;
    const base = playingState([
      cards('S7 D7 C7 H7 S3 C8 C9 SK DA'), [], cards('S8 D8'),
      cards('S2 D2 C2 H2 S6 D6 C6 H6 S10 D10 C10 H10'),
    ], { level: 4, turn: 0, finishOrder: [1],
      trick: { leader: 3, lastPlay: { seat: 3, play: pair }, passed: [2], history: [{ seat: 3, play: pair }] } });
    expect(partnerMayFinishPair(toPlayerView(base, 0))).toBe(false);
    const urgent = { ...base, hands: [base.hands[0], base.hands[1], base.hands[2], cards('S2 D2')] as const,
      trick: { ...base.trick!, passed: [] } };
    const defend = analyzeAdvancedPlay(toPlayerView(urgent, 0), { search: false })!;
    expect(defend.decision.type === 'play' && isBomb(defend.decision.play.combo)).toBe(true);
  });

  it('炸弹能直接走完时，不错过自己的二游', () => {
    const pair = interpret(cards('S5 D5'), 4, makeRules())[0]!;
    const state = playingState([cards('S7 D7 C7 H7'), [], cards('S8 D8'), cards('S2 D2 C2 H2 S6 D6')], {
      level: 4, turn: 0, finishOrder: [1],
      trick: { leader: 3, lastPlay: { seat: 3, play: pair }, passed: [], history: [{ seat: 3, play: pair }] },
    });
    const decision = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!.decision;
    expect(decision.type === 'play' && decision.play.cards.length).toBe(4);
  });

  it('对手头游的最后一手无法普通接住时，可用炸弹阻止其队友接风', () => {
    const triple = interpret(cards('S5 D5 C5'), 4, makeRules())[0]!;
    const state = playingState([cards('S8 D8'), [], cards('S7 D7 C7 H7 S3 C8 C9 SK DA'),
      cards('S2 D2 C2 H2 S6 D6 C6 H6 S10 D10 C10 H10')], {
      level: 4, turn: 2, finishOrder: [1],
      trick: { leader: 1, lastPlay: { seat: 1, play: triple }, passed: [], history: [{ seat: 1, play: triple }] },
    });
    const decision = analyzeAdvancedPlay(toPlayerView(state, 2), { search: false })!.decision;
    expect(decision.type === 'play' && isBomb(decision.play.combo)).toBe(true);
  });

});
