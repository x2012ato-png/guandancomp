import { describe, expect, it } from 'vitest';
import { generatePlays, makeRandom, toPlayerView, type GameState } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { buildCoachInsights } from '../src/coachInsights.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

function endgame(): GameState {
  const hands: [number[], number[], number[], number[]] = [cards('S3 D3 SA'), cards('S5'), cards('S6'), cards('S7')];
  const remaining = new Set(hands.flat());
  return playingState(hands, { playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !remaining.has(id)) });
}

describe('教练持牌推测和推演说明', () => {
  it('在公开信息相同时不泄露各家的真实手牌，并展示多个推演和余牌分组', () => {
    const state = endgame();
    const swapped: GameState = { ...state, hands: [state.hands[0], state.hands[3], state.hands[2], state.hands[1]] };
    const first = analyzeAdvancedPlay(toPlayerView(state, 0), { search: true }, { rng: makeRandom('insights') })!;
    const second = analyzeAdvancedPlay(toPlayerView(swapped, 0), { search: true }, { rng: makeRandom('insights') })!;
    expect(first.insights).toEqual(second.insights);
    expect(first.insights.possibilities).toHaveLength(3);
    expect(first.insights.scenarios.length).toBeGreaterThanOrEqual(2);
    expect(first.insights.scenarios[0]!.hands).toHaveLength(3);
    expect(first.insights.scenarios[0]!.steps.length).toBeGreaterThan(1);
    expect(first.insights.scenarios.some(scenario => scenario.title.includes('对照'))).toBe(true);
    expect(first.insights.grouping).toContain('参考分组');
  });

  it('仅在可见信息确定时指出贡牌和还贡牌的归属', () => {
    const state = playingState([cards('S3 D3 SA'), cards('D5'), cards('S6'), cards('S7')]);
    const view = toPlayerView(state, 0);
    const card = cards('D5')[0]!;
    const returned = cards('S7')[0]!;
    const tribute = { kind: 'single' as const, payers: [3 as const], receivers: [1 as const], paid: [{ from: 3 as const, card }], links: [{ from: 3 as const, to: 1 as const, card, returned: true, returnCard: null }] };
    const decision = { type: 'play' as const, play: generatePlays(view.myHand, view.level, view.config)[0]! };
    const hidden = buildCoachInsights({ ...view, tribute }, decision);
    expect(hidden.known.join(' ')).toContain('贡牌可能已被原样还回');
    expect(hidden.known.join(' ')).not.toContain('持有贡牌');
    const visible = buildCoachInsights({ ...view, tribute: { ...tribute, links: [{ ...tribute.links[0]!, returnCard: returned }] } }, decision);
    expect(visible.known.join(' ')).toContain('下家（对手）持有贡牌 ♦5');
    expect(visible.known.join(' ')).toContain('上家（对手）持有还贡牌 ♠7');
  });
});
