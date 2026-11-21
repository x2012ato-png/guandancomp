import { describe, expect, it } from 'vitest';
import { generatePlays, interpret, makeRandom, makeRules, rankLabel, reduce, toPlayerView, type GameState, type Level } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { buildCoachInsights } from '../src/coachInsights.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

function endgame(): GameState {
  const hands: [number[], number[], number[], number[]] = [cards('S3 D3 SA'), cards('S5'), cards('S6'), cards('S7')];
  const remaining = new Set(hands.flat());
  return playingState(hands, { playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !remaining.has(id)) });
}

describe('教练持牌推测和推演说明', () => {
  it('整局历史中对手对我的单 A 和级牌单 2 都不要时，分别推测其可能没有王', () => {
    let state = playingState([
      cards('SA S2 S3 D3'), cards('BJ S8 D8'), cards('S6 D6 C6'), cards('SJ S7 D7'),
    ]);
    for (const action of [
      { type: 'play' as const, seat: 0 as const, cards: cards('SA') },
      ...([1, 2, 3] as const).map(seat => ({ type: 'pass' as const, seat })),
      { type: 'play' as const, seat: 0 as const, cards: cards('S2') },
      ...([1, 2, 3] as const).map(seat => ({ type: 'pass' as const, seat })),
    ]) {
      const result = reduce(state, action);
      if (!result.ok) throw new Error(result.error.message);
      state = result.state;
    }
    const view = toPlayerView(state, 0);
    const analysis = analyzeAdvancedPlay(view, { search: false })!;
    for (const line of [analysis.insights.possibilities[0]!, analysis.insights.possibilities[2]!]) {
      expect(line).toContain('单 A 和级牌单 2 都不要');
      expect(line).toContain('可能没有王');
      expect(line).toContain('也可能有王');
    }
    expect(analysis.insights.possibilities[1]).not.toContain('可能没有王');
    // 未知真实手牌不同，但公开信息相同时指导内容必须相同。
    const changed: GameState = { ...state, hands: [state.hands[0], state.hands[3], state.hands[2], state.hands[1]] };
    expect(analyzeAdvancedPlay(toPlayerView(changed, 0), { search: false })!.insights).toEqual(analysis.insights);
  });

  it('只把面对本人级牌单张的不要作为线索，不误判其他人的牌或对子', () => {
    const view = toPlayerView(playingState([cards('S3 D3'), cards('S5 D5'), cards('S6 D6'), cards('S7 D7')]), 0);
    const level = interpret(cards('S2'), 2, makeRules())[0]!;
    const ace = interpret(cards('SA'), 2, makeRules())[0]!;
    const pair = interpret(cards('C2 D2'), 2, makeRules())[0]!;
    const decision = { type: 'pass' as const };
    const otherLead = buildCoachInsights({ ...view, publicHistory: [
      { seat: 2, play: level }, { seat: 1, play: null }, { seat: 0, play: pair }, { seat: 3, play: null },
    ] }, decision);
    expect(otherLead.possibilities.join(' ')).not.toContain('可能没有王');
    const aceOnly = buildCoachInsights({ ...view, publicHistory: [{ seat: 0, play: ace }, { seat: 1, play: null }] }, decision);
    expect(aceOnly.possibilities[0]).toContain('不能断定没有王');
    expect(aceOnly.possibilities[0]).not.toContain('可能没有王');
  });

  it('按实际级牌判断，并在只有近期牌墩记录时继续提供线索', () => {
    const state = playingState([cards('S3 D3'), cards('S5 D5'), cards('S6 D6'), cards('S8 D8')], { level: 7 });
    const view = toPlayerView(state, 0);
    const level = interpret(cards('S7'), 7, makeRules())[0]!;
    const previous = { leader: 0 as const, lastPlay: { seat: 0 as const, play: level }, passed: [1, 2, 3] as const,
      history: [{ seat: 0 as const, play: level }, { seat: 1 as const, play: null }] };
    const insights = buildCoachInsights({ ...view, previousTrick: previous, publicHistory: [] }, { type: 'pass' });
    expect(insights.possibilities[0]).toContain('级牌单 7 不要');
    expect(insights.possibilities[0]).toContain('可能没有王');
    expect(insights.possibilities[2]).not.toContain('可能没有王');
  });

  it.each([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14] as Level[])(
    '打 %s 时，对手不要级牌单张都可作为缺王线索', level => {
      // 黑桃 J 的文本缩写与测试辅助函数中的小王缩写相同，直接使用其牌 ID。
      const levelCard = interpret([level - 2], level, makeRules())[0]!;
      const ace = interpret(cards('DA'), level, makeRules())[0]!;
      const remaining = Array.from({ length: 108 }, (_, id) => id).filter(id => !levelCard.cards.includes(id) && !ace.cards.includes(id));
      const hands: [number[], number[], number[], number[]] = [remaining.slice(0, 2), remaining.slice(2, 4), remaining.slice(4, 6), remaining.slice(6, 8)];
      const view = toPlayerView(playingState(hands, { level }), 0);
      const history = level === 14
        ? [{ seat: 0 as const, play: levelCard }, { seat: 1 as const, play: null }]
        : [{ seat: 0 as const, play: ace }, { seat: 1 as const, play: null },
          { seat: 0 as const, play: levelCard }, { seat: 1 as const, play: null }];
      const insights = buildCoachInsights({ ...view, publicHistory: history }, { type: 'pass' });
      expect(insights.possibilities[0]).toContain(`级牌单 ${rankLabel(level)}`);
      expect(insights.possibilities[0]).toContain('不要');
      expect(insights.possibilities[0]).toContain('可能没有王');
      if (level === 14) expect(insights.possibilities[0]).not.toContain('单 A 和级牌单 A');
      else expect(insights.possibilities[0]).toContain('单 A 和级牌单');
      expect(insights.possibilities[2]).not.toContain('可能没有王');
    },
  );

  it('对手不要级牌后出过王，或公开记录确认其持王时，不推断其没王', () => {
    const view = toPlayerView(playingState([cards('S3 D3'), cards('SJ D5'), cards('S6 D6'), cards('S7 D7')]), 0);
    const level = interpret(cards('S2'), 2, makeRules())[0]!;
    const joker = interpret(cards('SJ'), 2, makeRules())[0]!;
    const history = [{ seat: 0 as const, play: level }, { seat: 1 as const, play: null }];
    const decision = { type: 'pass' as const };
    const later = buildCoachInsights({ ...view, publicHistory: [...history, { seat: 1, play: joker }] }, decision);
    expect(later.possibilities[0]).toContain('之后曾出过王');
    expect(later.possibilities[0]).not.toContain('可能没有王');
    const tribute = { kind: 'single' as const, payers: [3 as const], receivers: [1 as const], paid: [{ from: 3 as const, card: joker.cards[0]! }], links: [{ from: 3 as const, to: 1 as const, card: joker.cards[0]!, returned: false, returnCard: null }] };
    const known = buildCoachInsights({ ...view, publicHistory: history, tribute }, decision);
    expect(known.possibilities[0]).toContain('进还贡记录表明其现在持有');
    expect(known.possibilities[0]).not.toContain('可能没有王');
  });

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
