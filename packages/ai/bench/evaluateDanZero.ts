/**
 * DanZero 深度蒙特卡洛（DMC）内置策略 vs 现有内置 AI 自动化对战与评测脚本。
 *
 * 直接调用 `@guandan/ai` 中的 `createDanZeroPolicy()` 本地推理，无需启动任何外部 Python 服务。
 */
import { performance } from 'node:perf_hooks';
import { createGame, makeRules, pendingActors, reduce, toPlayerView } from '@guandan/engine';
import { createAdvancedPolicy, createBeginnerPolicy, createDanZeroPolicy, decisionToAction } from '../src/index.ts';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name} value`);
  return value;
}

const seeds = Number(argument('seeds', '10'));
const maxHands = Number(argument('hands', '4'));
const opponentName = argument('opponent', 'advanced');

const danzero = createDanZeroPolicy();
const opponent =
  opponentName === 'beginner'
    ? createBeginnerPolicy()
    : createAdvancedPolicy({ search: opponentName === 'advanced-search' });

const timings = { danzero: [] as number[], opponent: [] as number[] };
const results = {
  hands: 0,
  danzeroWins: 0,
  opponentWins: 0,
  danzeroDouble: 0,
  opponentDouble: 0,
  danzeroUpgrade: 0,
  opponentUpgrade: 0,
};

for (let seed = 0; seed < seeds; seed++) {
  for (const danzeroTeam of [0, 1] as const) {
    let state = createGame(makeRules({ firstLeader: 0 }), `danzero-eval-${seed}`);
    let hands = 0;

    while (hands < maxHands && state.phase !== 'matchOver') {
      const started = reduce(state, { type: 'startHand' });
      if (!started.ok) throw new Error(started.error.message);
      state = started.state;
      let actions = 0;

      while (state.phase !== 'handOver' && state.phase !== 'matchOver') {
        if (++actions > 2000) throw new Error(`Action limit exceeded for seed ${seed}`);
        const actor = pendingActors(state)[0];
        if (actor === undefined) throw new Error('No pending actor');
        const isDanZero = actor % 2 === danzeroTeam;
        const view = toPlayerView(state, actor);
        const t0 = performance.now();
        const decision = (isDanZero ? danzero : opponent).decide(view);
        timings[isDanZero ? 'danzero' : 'opponent'].push(performance.now() - t0);
        if (!decision) throw new Error('Missing decision');
        const next = reduce(state, decisionToAction(actor, decision));
        if (!next.ok) throw new Error(`Illegal action: ${next.error.message}`);
        state = next.state;
      }

      const result = state.lastResult!;
      results.hands++;
      if (result.winTeam === danzeroTeam) {
        results.danzeroWins++;
        results.danzeroUpgrade += result.upgrade;
        if (result.upgrade === 3) results.danzeroDouble++;
      } else {
        results.opponentWins++;
        results.opponentUpgrade += result.upgrade;
        if (result.upgrade === 3) results.opponentDouble++;
      }
      hands++;
    }
  }
}

const stats = (arr: number[]) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const p = (q: number) => sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0;
  return {
    decisions: arr.length,
    meanMs: Number((arr.reduce((a, b) => a + b, 0) / (arr.length || 1)).toFixed(2)),
    p95Ms: Number(p(0.95).toFixed(2)),
    p99Ms: Number(p(0.99).toFixed(2)),
    maxMs: Number(p(1).toFixed(2)),
  };
};

console.log(
  JSON.stringify(
    {
      seeds,
      maxHands,
      opponent: opponentName,
      ...results,
      danzeroWinRate: Number((results.danzeroWins / results.hands).toFixed(4)),
      latency: {
        danzero: stats(timings.danzero),
        opponent: stats(timings.opponent),
      },
    },
    null,
    2,
  ),
);
