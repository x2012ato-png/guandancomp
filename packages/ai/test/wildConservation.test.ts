import { describe, expect, it } from 'vitest';
import { generatePlays, interpret, makeRandom, makeRules, toPlayerView, type Play } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { searchAdvancedWithInfo } from '../src/advancedSearch.ts';
import { choosePlay, DEFAULT_HEURISTIC, type HeuristicTrace } from '../src/heuristic.ts';
import { earlyWildCost } from '../src/wildCost.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

const pairHand = [13, 43, 104, 74, 102, 25, 16, 84, 52, 85, 42, 70, 24, 0, 37, 3, 22, 4, 96, 107];
const tubeHand = [13, 47, 76, 72, 97, 27, 50, 43, 69, 17, 89, 104, 86, 80, 56, 73, 10, 12, 100, 46];

function followView(hand: number[], previous: Play, opponentCount = 20) {
  const reserved = new Set([...hand, ...previous.cards]);
  const available = Array.from({ length: 108 }, (_, id) => id).filter(id => !reserved.has(id));
  const hands: [number[], number[], number[], number[]] = [hand, available.slice(0, 20), available.slice(20, 40), available.slice(40, 40 + opponentCount)];
  const held = new Set(hands.flat());
  return toPlayerView(playingState(hands, {
    playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !held.has(id)),
    trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
  }), 0);
}

const pair = interpret(cards('S3 D3'), 2, makeRules()).find(p => p.combo.type === 'pair')!;
const tube = interpret(cards('S3 D3 S4 D4 S5 D5'), 2, makeRules()).find(p => p.combo.type === 'tube')!;

describe('早期保留逢人配', () => {
  it.each([['对子', pairHand, pair], ['三连对', tubeHand, tube]] as const)(
    '手牌和对手余牌较多时，避免用逢人配跟小%s', (_name, hand, previous) => {
      const view = followView([...hand], previous);
      const result = analyzeAdvancedPlay(view, { search: false })!;
      expect(result.decision.type === 'pass' || result.decision.type === 'play' && result.decision.play.wildAssignments.length === 0).toBe(true);
      let trace: HeuristicTrace | undefined;
      choosePlay(view, { ...DEFAULT_HEURISTIC, advanced: true }, value => { trace = value; });
      expect(trace!.scores.some(item => item.play.combo.type === previous.combo.type && item.play.wildAssignments.length > 0 &&
        item.details?.some(detail => detail.includes('保留逢人配')))).toBe(true);
    },
  );

  it('普通局面只有拼对子可跟时让牌，对手将走完时可以拦截', () => {
    const hand = cards('H2 S4 S6 D8 C10 SQ DK SA S3 D5 C7 S9');
    expect(choosePlay(followView(hand, pair))).toEqual({ type: 'pass' });
    const decision = choosePlay(followView(hand, pair, 2));
    expect(decision.type).toBe('play');
    if (decision.type === 'play') expect(decision.play.wildAssignments).toHaveLength(1);
  });

  it('普通局面避免用逢人配拼小三张跟牌', () => {
    const previous = interpret(cards('S3 D3 C3'), 2, makeRules()).find(p => p.combo.type === 'triple')!;
    const hand = cards('H2 S4 D4 S6 D8 C10 SQ DK SA S5 D5 C7 S9');
    expect(analyzeAdvancedPlay(followView(hand, previous), { search: false })!.decision).toEqual({ type: 'pass' });
  });

  it('首出也计入保留逢人配的代价', () => {
    const following = followView(pairHand, pair);
    const view = { ...following, trick: { ...following.trick!, lastPlay: null } };
    let trace: HeuristicTrace | undefined;
    choosePlay(view, DEFAULT_HEURISTIC, value => { trace = value; });
    expect(trace!.mode).toBe('lead');
    expect(trace!.scores.some(item => item.play.wildAssignments.length > 0 && item.details?.some(detail => detail.includes('保留逢人配')))).toBe(true);
  });

  it('后台模拟比较小对子时也计入同一代价', () => {
    const view = followView(pairHand, pair);
    const play = generatePlays(view.myHand, view.level, view.config, pair.combo)
      .find(p => p.combo.type === 'pair' && p.combo.key === 7 && p.wildAssignments.length)!;
    const search = searchAdvancedWithInfo(view, { type: 'play', play }, { rng: makeRandom('wild-follow'), deadline: Date.now() + 5000 }, true);
    expect(search.samples).toBeGreaterThan(0);
    expect(search.scores[0]!.adjustmentDetails).toContainEqual({ text: '余牌较多且对手不紧急，保留逢人配', value: -0.12 });
  }, 10000);

  it('一手走完、剩牌不多或用逢人配组成炸弹时不增加早期代价', () => {
    const hand = cards('H2 S4 S6 D8 C10 SQ DK SA S3 D5 C7 S9');
    const view = followView(hand, pair);
    const play = generatePlays(hand, 2, view.config, pair.combo).find(p => p.combo.type === 'pair' && p.combo.key === 4)!;
    expect(earlyWildCost(view, play)).toBe(24);
    expect(earlyWildCost({ ...view, myHand: play.cards }, play)).toBe(0);
    expect(earlyWildCost({ ...view, myHand: hand.slice(0, 9) }, play)).toBe(0);
    const finish = choosePlay({ ...view, myHand: play.cards, handCounts: [2, 20, 20, 20] });
    expect(finish.type === 'play' && finish.play.cards).toHaveLength(2);
    const bomb = interpret(cards('S4 D4 C4 H2'), 2, makeRules()).find(p => p.combo.type === 'bomb')!;
    expect(earlyWildCost(view, bomb)).toBe(0);
  });
});
