import { describe, expect, it } from 'vitest';
import { interpret, makeDeck, makeRules } from '@guandan/engine';
import { cards } from '../../engine/test/helpers.ts';
import { groupHand, layoutHand, orderedHand, straightFlushCards } from '../src/handLayout.ts';

describe('手牌规划与布局', () => {
  it('保留每张手牌并将规划出的牌型分组', () => {
    const hand = cards('S3 D4 C5 S6 D7 SK DK CK HK H2 SJ');
    const groups = groupHand(hand, 2);
    expect(groups.map(group => group.label)).toEqual(expect.arrayContaining(['炸弹', '顺子', '逢人配']));
    expect(groups.flatMap(group => group.cards).sort((a, b) => a - b)).toEqual([...hand].sort((a, b) => a - b));
  });

  it('将三张和对子合成可出的三带二，逢人配单独保留', () => {
    const hand = cards('S3 D3 C3 S4 D4 H2');
    const groups = groupHand(hand, 2);
    const fullHouse = groups.find(group => group.label === '三带二');
    expect(fullHouse).toBeDefined();
    expect(interpret(fullHouse!.cards, 2, makeRules()).some(play => play.combo.type === 'fullHouse')).toBe(true);
    expect(groups.find(group => group.label === '逢人配')!.cards).toEqual([hand[5]]);
  });

  it('优先分组同花顺，包括逢人配补牌，并保留全部手牌', () => {
    for (const hand of [cards('S3 S4 S5 S6 S7 D9'), cards('S3 S4 S5 S7 H2 D9')]) {
      const groups = groupHand(hand, 2, makeRules(), true);
      expect(groups[0]!.label).toBe('同花顺');
      expect(interpret(groups[0]!.cards, 2, makeRules()).some(play => play.combo.type === 'straightFlush')).toBe(true);
      expect(groups.flatMap(group => group.cards).sort((a, b) => a - b)).toEqual([...hand].sort((a, b) => a - b));
    }
  });

  it('可优先保留多组互不重叠的同花顺', () => {
    const hand = cards('S3 S4 S5 S6 S7 D3 D4 D5 D6 D7');
    expect(groupHand(hand, 2, makeRules(), true).filter(group => group.label === '同花顺')).toHaveLength(2);
  });

  it('六行手牌按牌力从小到大排列，级牌和大小王在末尾', () => {
    const hand = cards('BJ S2 D3 SJ SA H2 S3');
    const ordered = orderedHand(hand, 2);
    expect(ordered.map(group => group.cards[0])).toEqual(cards('D3 S3 SA S2 H2 SJ BJ'));
    const layout = layoutHand(ordered);
    expect(layout.cards.map(card => card.card)).toEqual(ordered.flatMap(group => group.cards));
    expect(layout.cards.map(card => card.row)).toEqual([1, 1, 1, 2, 2, 2, 2]);
  });

  it('高亮所有重叠同花顺中的牌及双副同牌，而不移动它们', () => {
    const hand = cards('S3 S4 S4 S5 S6 S7 S8 D9');
    const highlighted = straightFlushCards(hand, 2);
    expect([...highlighted].sort((a, b) => a - b)).toEqual(hand.slice(0, 7).sort((a, b) => a - b));
    expect(orderedHand(hand, 2).filter(group => group.label === '同花顺').flatMap(group => group.cards)).toHaveLength(7);
  });

  it('高亮可以补全或替代同花顺牌的逢人配，排除无关牌', () => {
    const hand = cards('S3 S4 S5 S7 H2 H2 D9');
    const highlighted = straightFlushCards(hand, 2);
    expect([...highlighted].sort((a, b) => a - b)).toEqual(hand.slice(0, 6).sort((a, b) => a - b));
    expect(straightFlushCards(cards('S3 S4 D5 C6 H2'), 2).size).toBe(0);
    const complete = cards('S3 S4 S5 S6 S7 H2');
    expect(straightFlushCards(complete, 2).has(complete[5]!)).toBe(true);
  });

  it('两排之间只在组间换行，并保留所有牌', () => {
    const groups = groupHand(makeDeck().slice(0, 27), 2);
    const layout = layoutHand(groups);
    expect(layout.cards).toHaveLength(27);
    expect(new Set(layout.cards.map(card => card.card)).size).toBe(27);
    expect(new Set(layout.cards.map(card => card.row))).toEqual(new Set([1, 2]));
    for (const group of new Set(layout.cards.map(card => card.group))) {
      expect(new Set(layout.cards.filter(card => card.group === group).map(card => card.row)).size).toBe(1);
    }
    expect(layout.columns).toBe(Math.max(...layout.cards.map(card => card.column)));
  });

  it('少量牌和空手牌可以布局', () => {
    expect(layoutHand([])).toEqual({ cards: [], columns: 0 });
    const group = { label: '对子', cards: cards('S3 D3') };
    expect(layoutHand([group]).cards.map(card => card.row)).toEqual([1, 1]);
  });
});
