import { describe, expect, it } from 'vitest';
import { cardOf, interpret, makeDeck, makeRules } from '@guandan/engine';
import { cards } from '../../engine/test/helpers.ts';
import { canArrangeHand, groupHand, layoutHand, layoutSixRowHand, orderedHand, straightFlushCards } from '../src/handLayout.ts';

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

  it('理牌支持四张及以上炸弹、王炸、顺子和逢人配组成的牌型', () => {
    for (const text of ['S9 D9 C9 H9', 'S9 D9 C9 H9 S9', 'SJ SJ BJ BJ', 'S3 D4 C5 S6 D7', 'S3 S4 S5 S6 S7', 'S9 D9 C9 H2', 'S3 D4 C5 S6 H2']) {
      expect(canArrangeHand(cards(text), 2, makeRules()), text).toBe(true);
    }
    for (const text of ['', 'S3 D4', 'S3 D4 C5 S6', 'S3 D4 C5 S6 D8']) {
      expect(canArrangeHand(cards(text), 2, makeRules()), text).toBe(false);
    }
  });

  it('理牌支持三不带和三带二，包括逢人配组成的牌型', () => {
    for (const text of ['S9 D9 C9', 'S9 D9 H2', 'S3 D3 C3 S4 D4', 'S3 D3 H2 S4 D4', 'S3 D3 C3 S4 H2']) {
      expect(canArrangeHand(cards(text), 2, makeRules()), text).toBe(true);
    }
    for (const text of ['S3 D3 S4', 'S3 D3 C3 S4 D5', 'S3 D3 S4 D4 S5']) {
      expect(canArrangeHand(cards(text), 2, makeRules()), text).toBe(false);
    }
  });

  it('理牌支持三连对和钢板，包括逢人配和 A 的高低用法', () => {
    for (const text of [
      'S3 D3 S4 D4 S5 D5', 'S3 D3 S4 D4 S5 H2',
      'SA DA S2 D2 S3 D3', 'SQ DQ SK DK SA DA',
      'S3 D3 C3 S4 D4 C4', 'S3 D3 C3 S4 D4 H2',
      'SA DA CA S2 D2 C2', 'SK DK CK SA DA CA',
    ]) {
      // 打 6，避免低 A 组合中的红桃 2 被当作逢人配。
      const level = text.includes('H2') ? 2 : 6;
      expect(canArrangeHand(cards(text), level, makeRules()), text).toBe(true);
    }
    for (const text of ['S3 D3 S4 D4 S6 D6', 'S3 D3 C3 S5 D5 C5', 'SK DK SA DA S2 D2']) {
      expect(canArrangeHand(cards(text), 6, makeRules()), text).toBe(false);
    }
  });

  it('手动牌序在出牌后保留，移除已出牌并保持其他牌的相对顺序', () => {
    const hand = cards('S3 D4 C5 S6 D7 S9 D9 C9 H9');
    const before = orderedHand(hand, 2).flatMap(group => group.cards);
    const selected = hand.slice(5);
    const front = before.filter(card => selected.includes(card));
    const rest = before.filter(card => !selected.includes(card));
    const order = [...front, ...rest];
    expect(orderedHand(hand, 2, order).flatMap(group => group.cards)).toEqual(order);
    const remaining = hand.filter(card => card !== front[0] && card !== rest[0]);
    const after = orderedHand(remaining, 2, order);
    expect(after.flatMap(group => group.cards)).toEqual(order.filter(card => remaining.includes(card)));
    expect(after.filter(group => group.label === '同花顺').flatMap(group => group.cards)).toEqual([]);
  });

  it('整理的长炸弹完整放在第一排左侧，不从中间拆开', () => {
    const bomb = cards('S9 D9 C9 H9 S9 D9 C9 H9');
    const hand = [...bomb, ...cards('S3 D4 C5')];
    const layout = layoutHand(orderedHand(hand, 2, hand), bomb.length);
    expect(layout.cards.slice(0, bomb.length).map(item => [item.card, item.row, item.column])).toEqual(bomb.map((card, index) => [card, 1, index + 1]));
    expect(layout.cards.slice(bomb.length).every(item => item.row === 2)).toBe(true);
  });

  it('六行布局换行时将相同点数、级牌和大小王分别留在同一行', () => {
    const hand = cards('S3 D3 C3 S4 D4 S5 D5 S6 D6 S7 D7 S2 H2 SJ SJ BJ BJ');
    const layout = layoutSixRowHand(orderedHand(hand, 2));
    expect(new Set(layout.cards.map(item => item.row))).toEqual(new Set([1, 2]));
    expect(layout.cards).toHaveLength(hand.length);
    for (const rank of new Set(hand.map(card => cardOf(card).rank))) {
      expect(new Set(layout.cards.filter(item => cardOf(item.card).rank === rank).map(item => item.row)).size).toBe(1);
    }
    expect(layout.columns).toBe(Math.max(...layout.cards.map(item => item.column)));
  });

  it('理顺子后即使同点数的牌分散，也保持整理的牌在第一行前方', () => {
    const selected = cards('S3 S4 S5 S6 S7');
    const other = cards('D3 D4 D5 D6 D7 S8 D8 S9 D9 S10 D10');
    const hand = [...selected, ...other];
    for (const current of [hand, hand.filter(card => card !== selected[1] && card !== other[2])]) {
      const remainingFront = selected.filter(card => current.includes(card));
      const layout = layoutSixRowHand(orderedHand(current, 2, hand), remainingFront.length);
      expect(layout.cards.slice(0, remainingFront.length).map(item => item.card)).toEqual(remainingFront);
      expect(layout.cards.slice(0, remainingFront.length).every(item => item.row === 1)).toBe(true);
      for (const rank of new Set(current.map(card => cardOf(card).rank))) {
        expect(new Set(layout.cards.filter(item => cardOf(item.card).rank === rank).map(item => item.row)).size).toBe(1);
      }
    }
  });

  it('少于 14 张时全部放在一行，包括手动整理后及出牌后的手牌', () => {
    const hand = cards('S3 S4 S5 S6 S7 D9 D10 SJ BJ S8 D8 S9 D9');
    for (const current of [hand, hand.slice(0, 7)]) {
      const layout = layoutSixRowHand(orderedHand(current, 2, hand), 5, [hand.slice(0, 5)]);
      expect(layout.cards.map(item => item.card)).toEqual(current);
      expect(layout.cards.every(item => item.row === 1)).toBe(true);
      expect(layout.columns).toBe(current.length);
    }
  });

  it('14 张起可分两行，无法同时保留整理牌和同点数时保留一行', () => {
    const bomb = cards('S9 D9 C9 H9 S9 D9 C9 H9');
    expect(layoutSixRowHand(orderedHand(bomb, 2)).cards.every(item => item.row === 1)).toBe(true);
    const hand = cards('S3 S4 S5 S6 S7 D3 D4 D5 D6 D7 C3 C4 C5 C6 C7');
    const layout = layoutSixRowHand(orderedHand(hand, 2, hand), 5, [hand.slice(0, 5)]);
    expect(layout.cards.every(item => item.row === 1)).toBe(true);
    const fourteen = cards('S3 D3 S4 D4 S5 D5 S6 D6 S7 D7 S8 D8 S9 D9');
    expect(new Set(layoutSixRowHand(orderedHand(fourteen, 2)).cards.map(item => item.row))).toEqual(new Set([1, 2]));
    expect(layoutSixRowHand([])).toEqual({ cards: [], columns: 0 });
  });

  it('再次理牌后，之前整理的同花顺也不会被换行拆开', () => {
    const front = cards('S3 D3 C3');
    const flush = cards('S4 S5 S6 S7 S8');
    const hand = [...front, ...flush, ...cards('S9 D9 S10 D10 SJ DJ SQ DQ')];
    const layout = layoutSixRowHand(orderedHand(hand, 2, hand), front.length, [front, flush]);
    expect(new Set(layout.cards.map(item => item.row))).toEqual(new Set([1, 2]));
    expect(new Set(layout.cards.filter(item => flush.includes(item.card)).map(item => item.row)).size).toBe(1);
    expect(layout.cards.slice(0, front.length).map(item => item.card)).toEqual(front);
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
