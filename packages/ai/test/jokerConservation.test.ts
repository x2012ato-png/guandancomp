import { describe, expect, it } from 'vitest';
import { interpret, isBomb, makeRules, toPlayerView } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { hasStrongFinishEvidence, searchAdvancedWithInfo, selectStableCandidate } from '../src/advancedSearch.ts';
import { choosePlay, DEFAULT_HEURISTIC } from '../src/heuristic.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

function followView(handSpec: string, opponentCount = 10, lastCard = 'H2') {
  const hand = cards(handSpec);
  const last = cards(lastCard).map(card => hand.includes(card) ? card + 54 : card);
  const previous = interpret(last, 2, makeRules())[0]!;
  const reserved = new Set([...hand, ...previous.cards]);
  const available = Array.from({ length: 108 }, (_, id) => id).filter(id => !reserved.has(id));
  const hands: [number[], number[], number[], number[]] = [hand, available.slice(0, 10), available.slice(10, 20), available.slice(20, 20 + opponentCount)];
  const inHands = new Set(hands.flat());
  return toPlayerView(playingState(hands, {
    playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !inHands.has(id)),
    trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
  }), 0);
}

describe('跟单时保留大王', () => {
  it('真实开局张数下，持有大小王时不会用大王越级管级牌', () => {
    const hand = cards('SJ BJ S2 S3 D4 C5 S6 D7 S8 D9 C10 C8 SQ SK SA D3 D5 D6 D8 D10 DJ DQ DK DA C3 C4 C6');
    const previous = interpret(cards('H2'), 2, makeRules())[0]!;
    const reserved = new Set([...hand, ...previous.cards]);
    const available = Array.from({ length: 108 }, (_, id) => id).filter(id => !reserved.has(id));
    const hands: [number[], number[], number[], number[]] = [hand, available.slice(0, 27), available.slice(27, 54), available.slice(54)];
    const view = toPlayerView(playingState(hands, {
      playedCards: previous.cards,
      trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
    }), 0);
    const decision = analyzeAdvancedPlay(view, { search: false })!.decision;
    expect(decision.type).toBe('play');
    if (decision.type === 'play') expect(decision.play.cards).toEqual(cards('SJ'));
  });

  it('大小王都能管级牌时，优先使用小王', () => {
    const view = followView('SJ BJ S3 D4 C5 S6 D7 S8 D9 C10');
    const result = analyzeAdvancedPlay(view, { search: false })!;
    expect(result.decision.type).toBe('play');
    if (result.decision.type === 'play') expect(result.decision.play.cards).toEqual(cards('SJ'));
    expect(result.reasons.join(' ')).toContain('最小同型牌');
  });

  it('对手出普通单张时，不因为大王奖励而跳过小王', () => {
    const view = followView('SJ BJ S3 D4 C5 S6 D7 S8 D9 C10', 10, 'HQ');
    const decision = analyzeAdvancedPlay(view, { search: false })!.decision;
    expect(decision.type).toBe('play');
    if (decision.type === 'play') expect(decision.play.cards).toEqual(cards('SJ'));
  });

  it('即使小王成对且对手紧急，也不因为拆对代价改用大王越级管牌', () => {
    const view = followView('SJ SJ BJ S3 D4 C5 S6 D7 S8 D9 C10', 2);
    const decision = analyzeAdvancedPlay(view, { search: false })!.decision;
    expect(decision.type).toBe('play');
    if (decision.type === 'play') expect(decision.play.combo.key).toBe(16);
  });

  it('只有大王能管时，按正常跟牌代价判断，不因持有大王而一律让牌', () => {
    const hand = 'BJ S3 D4 C5 S6 D7 S8 D9 C10 SQ';
    const ordinary = analyzeAdvancedPlay(followView(hand), { search: false })!.decision;
    expect(ordinary.type).toBe('play');
    if (ordinary.type === 'play') expect(ordinary.play.cards).toEqual(cards('BJ'));
    const urgent = analyzeAdvancedPlay(followView(hand, 2), { search: false })!.decision;
    expect(urgent.type).toBe('play');
    if (urgent.type === 'play') expect(urgent.play.cards).toEqual(cards('BJ'));
  });

  it('后台模拟比较小王、让牌和大王，并约束越级选择', () => {
    const view = followView('SJ BJ S3 D4 C5 S6 D7 S8 D9 C10');
    const fallback = choosePlay(view, { ...DEFAULT_HEURISTIC, advanced: true });
    const search = searchAdvancedWithInfo(view, fallback, { deadline: Date.now() + 5000 }, true);
    expect(search.samples).toBeGreaterThan(0);
    const big = search.scores.find(item => item.decision.type === 'play' && item.decision.play.combo.key === 17);
    expect(big?.overbid).toBe(true);
    expect(hasStrongFinishEvidence(search.samples, big!.uninterruptedFinishes)).toBe(false);
    expect(search.scores.some(item => item.decision.type === 'pass')).toBe(true);
    expect(search.scores.some(item => item.decision.type === 'play' && item.decision.play.combo.key === 16)).toBe(true);
    expect(search.decision.type === 'play' && search.decision.play.combo.key === 17).toBe(false);
  }, 10000);

  it('越级的强牌例外要求足够样本，且至少九成连续出完', () => {
    expect(hasStrongFinishEvidence(7, 7)).toBe(false);
    expect(hasStrongFinishEvidence(10, 8)).toBe(false);
    expect(hasStrongFinishEvidence(10, 9)).toBe(true);
    expect(hasStrongFinishEvidence(12, 10)).toBe(false);
    expect(hasStrongFinishEvidence(12, 11)).toBe(true);
    expect(selectStableCandidate([0, 2], [0, 10], 10, true, [false, true], [0, 8])).toBe(0);
    expect(selectStableCandidate([0, 2], [0, 10], 10, true, [false, true], [0, 9])).toBe(1);
  });
  it.each([2, 10])('初级和教练持大王与炸弹跟小王时优先大王（对手剩 %s 张）', opponentCount => {
    const view = followView('BJ BJ S7 D7 C7 H7', opponentCount, 'SJ');
    for (const decision of [choosePlay(view), analyzeAdvancedPlay(view, { search: false })!.decision]) {
      expect(decision.type === 'play' && decision.play.combo.type === 'single' && decision.play.combo.key === 17).toBe(true);
    }
  });

  it('有更小的合法单张时，仍可保留大王和炸弹', () => {
    const view = followView('SJ BJ S7 D7 C7 H7 S3 D5 C6', 2, 'H2');
    for (const decision of [choosePlay(view), analyzeAdvancedPlay(view, { search: false })!.decision]) {
      expect(decision.type === 'play' && decision.play.combo.key).toBe(16);
    }
  });

  it('大王压不住对方大王时，仍可以用炸弹', () => {
    const view = followView('BJ S7 D7 C7 H7 S3 D5 C6', 2, 'BJ');
    for (const decision of [choosePlay(view), analyzeAdvancedPlay(view, { search: false })!.decision]) {
      expect(decision.type === 'play' && isBomb(decision.play.combo)).toBe(true);
    }
  });

  it('后台模拟不会用炸弹代替能压对手单张的大王', () => {
    const view = followView('BJ BJ S7 D7 C7 H7 S3 D5 C6', 2, 'SJ');
    const fallback = choosePlay(view, { ...DEFAULT_HEURISTIC, advanced: true });
    const result = searchAdvancedWithInfo(view, fallback, { deadline: Date.now() + 5000 }, true);
    expect(result.samples).toBeGreaterThan(0);
    expect(result.scores.some(item => item.decision.type === 'play' && item.decision.play.combo.key === 17)).toBe(true);
    expect(result.scores.some(item => item.decision.type === 'play' && isBomb(item.decision.play.combo))).toBe(false);
    expect(result.decision.type === 'play' && isBomb(result.decision.play.combo)).toBe(false);
  }, 10000);

  it('不为了使用大王而压队友的单张', () => {
    const view = followView('BJ S7 D7 C7 H7 S3 D5 C6', 10, 'SJ');
    const partnerLead = { ...view, trick: { ...view.trick!, lastPlay: { ...view.trick!.lastPlay!, seat: 2 as const } } };
    expect(choosePlay(partnerLead)).toEqual({ type: 'pass' });
    expect(analyzeAdvancedPlay(partnerLead, { search: false })!.decision).toEqual({ type: 'pass' });
  });

  it('对方出对子时不套用单张规则，仍可使用炸弹', () => {
    const pair = interpret(cards('S5 D5'), 2, makeRules())[0]!;
    const state = playingState([cards('BJ S7 D7 C7 H7 S3 D6'), cards('S8 D8'), cards('S9 D9'), cards('S4 D4')], {
      trick: { leader: 3, lastPlay: { seat: 3, play: pair }, passed: [], history: [{ seat: 3, play: pair }] },
    });
    const view = toPlayerView(state, 0);
    const decision = analyzeAdvancedPlay(view, { search: false })!.decision;
    expect(decision.type === 'play' && isBomb(decision.play.combo)).toBe(true);
  });

  it('王炸能一手出完时，跟对手单张仍按要求先出大王', () => {
    const view = followView('BJ BJ SJ SJ', 2, 'H2');
    for (const decision of [choosePlay(view), analyzeAdvancedPlay(view, { search: false })!.decision]) {
      expect(decision.type === 'play' && decision.play.combo.type === 'single' && decision.play.combo.key === 17).toBe(true);
    }
  });

});
