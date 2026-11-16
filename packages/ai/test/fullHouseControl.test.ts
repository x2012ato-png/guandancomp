import { describe, expect, it } from 'vitest';
import { cardOf, generatePlays, interpret, makeRules, toPlayerView } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { searchAdvancedWithInfo } from '../src/advancedSearch.ts';
import { fullHousePairCost } from '../src/fullHouseCost.ts';
import { choosePlay } from '../src/heuristic.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

const previous = interpret(cards('S4 D4 C4 S6 D6'), 2, makeRules()).find(p => p.combo.type === 'fullHouse')!;
const opponents = cards('S7 D7 C7 H7 S8 D8 C8 H8 S9 D9');

function followView(hand: string, danger = false) {
  const state = playingState([cards(hand), opponents, cards('S10 D10 C10 H10 S11 D11'), danger ? cards('SA DA') : opponents], {
    trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
  });
  return toPlayerView(state, 0);
}

describe('三带二的控牌对子', () => {
  it('打二时同样三张优先带 K 而保留级牌，初级和高级策略一致', () => {
    const view = followView('S5 D5 C5 SK DK S2 D2 S8 D9 C10');
    for (const decision of [choosePlay(view), analyzeAdvancedPlay(view, { search: false })!.decision]) {
      expect(decision.type).toBe('play');
      if (decision.type === 'play') expect(decision.play.cards.filter(id => cardOf(id).rank === 13)).toHaveLength(2);
    }
  });

  it('只有带一对大王才能跟时，非紧急局面选择不要，紧急时仍能拦截', () => {
    const hand = 'S5 D5 C5 BJ BJ S8 D9 C10 SQ DK';
    for (const decision of [choosePlay(followView(hand)), analyzeAdvancedPlay(followView(hand), { search: false })!.decision]) {
      expect(decision).toEqual({ type: 'pass' });
    }
    const urgent = choosePlay(followView(hand, true));
    expect(urgent.type).toBe('play');
    if (urgent.type === 'play') expect(urgent.play.cards.filter(id => cardOf(id).rank === 17)).toHaveLength(2);
  });

  it('能一手走完时仍可带王', () => {
    const decision = choosePlay(followView('S5 D5 C5 BJ BJ'));
    expect(decision.type).toBe('play');
    if (decision.type === 'play') expect(decision.play.cards).toHaveLength(5);
  });

  it('残局首出考虑对子价值，保留级牌', () => {
    const other = cards('S7 D7 C7 H7 S8 D8 C8');
    const state = playingState([cards('S3 D3 C3 SK DK S2 D2 S8'), other, other, other]);
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    expect(result.decision.type).toBe('play');
    if (result.decision.type === 'play') {
      expect(result.decision.play.combo.type).toBe('fullHouse');
      expect(result.decision.play.cards.filter(id => cardOf(id).rank === 13)).toHaveLength(2);
    }
    expect(result.reasons.join(' ')).toContain('三带二消耗控牌对子 +1');
  });

  it('后台模拟也计入带出大王的代价', () => {
    const hand = cards('S5 D5 C5 BJ BJ S8 D9 C10 SQ DK');
    const reserved = new Set([...hand, ...previous.cards]);
    const available = Array.from({ length: 108 }, (_, id) => id).filter(id => !reserved.has(id));
    const hands: [number[], number[], number[], number[]] = [hand, available.slice(0, 10), available.slice(10, 20), available.slice(20, 30)];
    const inHands = new Set(hands.flat());
    const state = playingState(hands, {
      playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !inHands.has(id)),
      trick: { leader: 3, lastPlay: { seat: 3, play: previous }, passed: [], history: [] },
    });
    const view = toPlayerView(state, 0);
    const play = generatePlays(hand, 2, view.config, previous.combo).find(p => p.combo.type === 'fullHouse' && p.cards.filter(id => cardOf(id).rank === 17).length === 2)!;
    const search = searchAdvancedWithInfo(view, { type: 'play', play }, { deadline: Date.now() + 5000 }, true);
    expect(search.samples).toBeGreaterThan(0);
    expect(search.scores[0]!.adjustmentDetails).toContainEqual({ text: '三带二消耗控牌对子', value: -0.12 });
  }, 10000);

  it('按逢人配实际代表的点数识别带出的对子', () => {
    const play = interpret(cards('S3 D3 C3 SK H2'), 2, makeRules()).find(p => p.combo.type === 'fullHouse' && p.combo.key === 3)!;
    expect(fullHousePairCost(play, 2)).toBe(1);
    const levelPair = interpret(cards('S3 D3 C3 S2 H2'), 2, makeRules()).find(p => p.combo.type === 'fullHouse' && p.combo.key === 3)!;
    expect(fullHousePairCost(levelPair, 2)).toBe(8);
  });
});
