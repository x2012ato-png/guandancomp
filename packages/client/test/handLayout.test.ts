import { describe, expect, it } from 'vitest';
import { interpret, makeDeck, makeRules } from '@guandan/engine';
import { cards } from '../../engine/test/helpers.ts';
import { groupHand, layoutHand } from '../src/handLayout.ts';

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
