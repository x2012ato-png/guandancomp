import { describe, expect, it } from 'vitest';
import { createGame, makeRules, pendingActors, reduce, toPlayerView } from '@guandan/engine';
import { cards, playingState } from '../../engine/test/helpers.ts';
import { chooseDanZeroReturn, chooseDanZeroTribute, createDanZeroPolicy, decisionToAction } from '../src/index.ts';

describe('DanZero 内置深度蒙特卡洛策略', () => {
  it('进贡时若有多张同点最大牌，自动避开会拆掉同花顺的花色', () => {
    // 打 7：手牌有 S7（与 S5 S6 S8 S9 组成黑桃同花顺）和 C7（单张级牌）
    const hand = cards('S5 S6 S7 S8 S9 C7 D3 H4');
    const state = {
      ...playingState([hand, cards('S2'), cards('S3'), cards('S4')], { level: 7 }),
      phase: 'tribute' as const,
      tribute: { kind: 'single' as const, payers: [0 as const], receivers: [1 as const], paid: [], links: [] },
    };
    const view = toPlayerView(state, 0);
    const chosen = chooseDanZeroTribute(view);
    expect(chosen).toBe(cards('C7')[0]);
  });

  it('还贡时保护同花顺、顺子与对子，优先还孤张小牌並结合神经网络评分', () => {
    // 打 2：手牌有黑桃同花顺 S3-S4-S5-S6-S7、对子 D4-C4，以及孤张 H8
    // 虽然 3、4 点数比 8 小，但拆 3 会破同花顺，拆 4 会破对子，应当还 H8
    const hand = cards('S3 S4 S5 S6 S7 D4 C4 H8 SA');
    const state = {
      ...playingState([hand, cards('S2'), cards('D2'), cards('C2')], { level: 2 }),
      phase: 'return' as const,
      tribute: {
        kind: 'single' as const,
        payers: [1 as const],
        receivers: [0 as const],
        paid: [{ from: 1 as const, card: cards('SA')[0]! }],
        links: [{ from: 1 as const, to: 0 as const, card: cards('SA')[0]!, returnCard: null }],
      },
    };
    const view = toPlayerView(state, 0);
    const chosen = chooseDanZeroReturn(view);
    expect(chosen).toBe(cards('H8')[0]);
  });

  it('快速版（0层直觉网络）与深度版（DanZero 蒙特卡洛推演）均可本地推理并生成合法动作', () => {
    const fastPolicy = createDanZeroPolicy({ deep: false });
    const deepPolicy = createDanZeroPolicy({ deep: true, samples: 2, topK: 3, rolloutDepth: 4 });
    let state = createGame(makeRules({ firstLeader: 0 }), 'danzero-unit-test');

    for (let hand = 0; hand < 2; hand++) {
      const started = reduce(state, { type: 'startHand' });
      expect(started.ok).toBe(true);
      if (!started.ok) return;
      state = started.state;

      let steps = 0;
      while (state.phase !== 'handOver' && state.phase !== 'matchOver') {
        expect(++steps).toBeLessThan(1000);
        const actor = pendingActors(state)[0]!;
        const view = toPlayerView(state, actor);
        const policy = actor % 2 === 0 ? deepPolicy : fastPolicy;
        const decision = policy.decide(view, { deadline: Date.now() + 200 });
        expect(decision).not.toBeNull();
        const next = reduce(state, decisionToAction(actor, decision!));
        expect(next.ok).toBe(true);
        if (!next.ok) return;
        state = next.state;
      }
    }
  });
});
