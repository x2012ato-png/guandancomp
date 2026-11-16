import { describe, expect, it } from 'vitest';
import { generatePlays, interpret, makeRandom, makeRules, toPlayerView, type GameState } from '@guandan/engine';
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

  it('依据公开牌和同轮的出牌、压牌与不要解释各家可能持有的牌', () => {
    const state = playingState([cards('S3 D3 SA'), cards('S5'), cards('S6'), cards('S7')]);
    const view = toPlayerView(state, 0);
    const low = interpret(cards('C9'), view.level, makeRules())[0]!;
    const high = interpret(cards('CK'), view.level, makeRules())[0]!;
    const history = [{ seat: 3 as const, play: low }, { seat: 1 as const, play: high }, { seat: 2 as const, play: null }];
    const decision = { type: 'pass' as const };
    const insights = buildCoachInsights({ ...view, playedCards: [...low.cards, ...high.cards], publicHistory: history,
      trick: { leader: 3, lastPlay: { seat: 1, play: high }, passed: [2], history } }, decision);
    expect(insights.known.join(' ')).not.toMatch(/剩\s*\d+\s*张/);
    expect(insights.possibilities[0]).toContain('下家（对手）：可能持有');
    expect(insights.possibilities[0]).toContain('♣K压过上家（对手）的单张 ♣9');
    expect(insights.possibilities[1]).toContain('面对下家（对手）的单张 ♣K时不要');
    expect(insights.possibilities[1]).toContain('也可能是战术让牌');
    expect(insights.possibilities[2]).toContain('曾出单张 ♣9');
    expect(insights.possibilities.join(' ')).not.toMatch(/\d+\/\d+|组假设/);
  });

  it('根据可见贡牌排除其他玩家持有该牌，且不依赖模拟样本', () => {
    const state = endgame();
    const view = toPlayerView(state, 0);
    const card = cards('S5')[0]!;
    const tribute = { kind: 'single' as const, payers: [3 as const], receivers: [1 as const], paid: [{ from: 3 as const, card }], links: [{ from: 3 as const, to: 1 as const, card, returned: false, returnCard: null }] };
    const insights = buildCoachInsights({ ...view, tribute }, { type: 'pass' });
    expect(insights.possibilities[0]).toContain('可能持有 5');
    expect(insights.possibilities[1]).not.toContain('可能持有 5');
    expect(insights.possibilities[2]).not.toContain('可能持有 5');
  });
});
