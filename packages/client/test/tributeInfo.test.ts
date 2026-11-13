import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { type Seat, type TributeView } from '@guandan/engine';
import { TributeInfo } from '../src/TributeInfo.tsx';

const seats = ['甲', '乙', '丙', '丁'].map(nickname => ({ nickname }));
const tribute: TributeView = {
  kind: 'double', payers: [1, 3], receivers: [0, 2], paid: [],
  links: [
    { from: 1, to: 0, card: 12, returned: true, returnCard: 1 },
    { from: 3, to: 2, card: 11, returned: true, returnCard: 2 },
  ],
};

function render(seat: Seat, publicReturnCard: boolean, value = tribute) {
  return renderToStaticMarkup(createElement(TributeInfo, { tribute: value, seat, publicReturnCard, seats }));
}

describe('tribute information', () => {
  it('shows each private return only to its recipient, while tribute stays visible', () => {
    for (const seat of [0, 1, 2, 3] as const) {
      const html = render(seat, false);
      expect(html).toContain('乙 向 甲 进贡 ♠A');
      expect(html).toContain('丁 向 丙 进贡 ♠K');
      expect(html.includes('甲 向 乙 还贡 ♠3')).toBe(seat === 1);
      expect(html.includes('丙 向 丁 还贡 ♠4')).toBe(seat === 3);
      expect(html).not.toContain('牌面未公开');
    }
  });

  it('shows public returns to every seat and hides returns that are not complete', () => {
    for (const seat of [0, 1, 2, 3] as const) {
      const html = render(seat, true);
      expect(html).toContain('甲 向 乙 还贡 ♠3');
      expect(html).toContain('丙 向 丁 还贡 ♠4');
    }
    const pending: TributeView = { ...tribute, links: [{ ...tribute.links[0]!, returned: false, returnCard: null }] };
    expect(render(1, false, pending)).not.toContain('还贡 ♠');
  });
});
