import { describe, expect, it } from 'vitest';
import { createGame, makeRandom, makeRules, reduce, toPlayerView } from '@guandan/engine';
import { analyzeAdvancedPlay } from '@guandan/ai';
import { runBackgroundCoach } from '../src/backgroundCoach.ts';
import { playingState } from '../../engine/test/helpers.ts';

describe('后台教练分析', () => {
  it('开局产生有效建议并在预算内返回，不阻塞事件循环', async () => {
    const started = reduce(createGame(makeRules({ firstLeader: 0 }), 'worker-opening'), { type: 'startHand' });
    if (!started.ok) throw new Error('Setup failed');
    const view = toPlayerView(started.state, 0);
    let eventLoopRan = false;
    const advice = await new Promise<Parameters<Parameters<typeof runBackgroundCoach>[1]>[0]>(resolve => {
      runBackgroundCoach(view, resolve);
      setTimeout(() => { eventLoopRan = true; }, 0);
    });
    expect(eventLoopRan).toBe(true);
    expect(advice?.decision.type).toBe('play');
    if (advice?.decision.type === 'play') expect(advice.decision.play.cards.every(card => view.myHand.includes(card))).toBe(true);
    expect(advice?.reasons.some(reason => reason.includes('模拟比较了'))).toBe(true);
  }, 5000);

  it('取消后不会回传旧建议', async () => {
    const started = reduce(createGame(makeRules({ firstLeader: 0 }), 'cancel-worker'), { type: 'startHand' });
    if (!started.ok) throw new Error('Setup failed');
    let called = false;
    const cancel = runBackgroundCoach(toPlayerView(started.state, 0), () => { called = true; });
    cancel();
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(called).toBe(false);
  });

  it('模拟证据充分时返回搜索决策，允许更新教练建议', async () => {
    const rng = makeRandom('reference-fixture-48');
    const deck = Array.from({ length: 108 }, (_, id) => id);
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [deck[i], deck[j]] = [deck[j]!, deck[i]!];
    }
    const view = toPlayerView(playingState([deck.slice(0, 4), deck.slice(4, 6), deck.slice(6, 8), deck.slice(8, 10)], { playedCards: deck.slice(10) }), 0);
    const base = analyzeAdvancedPlay(view, { search: false })!;
    const advice = await new Promise<Parameters<Parameters<typeof runBackgroundCoach>[1]>[0]>(resolve => runBackgroundCoach(view, resolve));
    expect(advice?.decision).not.toEqual(base.decision);
    expect(advice?.reasons.some(reason => reason.includes('因此调整了原建议'))).toBe(true);
  }, 5000);
});
