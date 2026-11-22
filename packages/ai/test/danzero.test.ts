import { describe, expect, it } from 'vitest';
import { createGame, makeRules, pendingActors, reduce, toPlayerView } from '@guandan/engine';
import { createDanZeroPolicy, decisionToAction } from '../src/index.ts';

describe('DanZero 内置深度蒙特卡洛策略', () => {
  it('快速版（0层直觉网络）与深度版（DanZero+ 蒙特卡洛推演）均可本地推理并生成合法动作', () => {
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
