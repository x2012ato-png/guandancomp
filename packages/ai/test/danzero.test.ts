import { describe, expect, it } from 'vitest';
import { createGame, makeRules, pendingActors, reduce, toPlayerView } from '@guandan/engine';
import { createDanZeroPolicy, decisionToAction } from '../src/index.ts';

describe('DanZero 内置深度蒙特卡洛策略', () => {
  it('在完整牌局（含出牌、进贡、还贡）中直接本地推理并生成合法动作', () => {
    const policy = createDanZeroPolicy();
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
        const decision = policy.decide(view);
        expect(decision).not.toBeNull();
        const next = reduce(state, decisionToAction(actor, decision!));
        expect(next.ok).toBe(true);
        if (!next.ok) return;
        state = next.state;
      }
    }
  });
});
