/** 三种高级策略两两对照：每个种子交换座位，每场连续进行多局。 */
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createGame, makeRules, pendingActors, reduce, toPlayerView, type Team } from '@guandan/engine';
import { analyzeAdvancedPlay, createBeginnerPolicy, decisionToAction, type AdvancedOptions } from '../src/index.ts';

function arg(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name}`);
  return value;
}

const seeds = Number(arg('seeds', '2'));
const handsPerMatch = Number(arg('hands', '4'));
const budgetMs = Number(arg('budget-ms', '3000'));
const output = arg('output', '');
if (!Number.isInteger(seeds) || seeds < 1 || !Number.isInteger(handsPerMatch) || handsPerMatch < 1 ||
    !Number.isInteger(budgetMs) || budgetMs < 1) throw new Error('Invalid benchmark arguments');

type Strategy = 'base' | 'endgame' | 'all';
const options: Record<Strategy, AdvancedOptions> = {
  base: { search: false },
  endgame: { search: true, allPhases: false },
  all: { search: true, allPhases: true },
};
const matchups: readonly (readonly [Strategy, Strategy])[] = [['base', 'endgame'], ['base', 'all'], ['endgame', 'all']];
const baseline = createBeginnerPolicy();
const stats = Object.fromEntries((['base', 'endgame', 'all'] as const).map(name => [name, {
  hands: 0, wins: 0, double: 0, upgrade: 0, decisions: 0, searched: 0, changed: 0, ms: [] as number[],
}])) as Record<Strategy, { hands: number; wins: number; double: number; upgrade: number; decisions: number; searched: number; changed: number; ms: number[] }>;
const startedAt = performance.now();
const rows: { a: Strategy; b: Strategy; hands: number; wins: Record<Strategy, number>; double: Record<Strategy, number>; upgrade: Record<Strategy, number>; matches: number }[] = [];

for (const [a, b] of matchups) {
  const row = { a, b, hands: 0, wins: { base: 0, endgame: 0, all: 0 }, double: { base: 0, endgame: 0, all: 0 }, upgrade: { base: 0, endgame: 0, all: 0 }, matches: 0 };
  rows.push(row);
  for (let seed = 0; seed < seeds; seed++) for (const teamA of [0, 1] as const) {
    let state = createGame(makeRules({ firstLeader: 0 }), `strategy-compare-${seed}`);
    let hand = 0;
    while (hand < handsPerMatch && state.phase !== 'matchOver') {
      const started = reduce(state, { type: 'startHand' });
      if (!started.ok) throw new Error(started.error.message);
      state = started.state;
      let actions = 0;
      while (state.phase !== 'handOver' && state.phase !== 'matchOver') {
        if (++actions > 2000) throw new Error(`Action limit exceeded: ${a}/${b}, seed ${seed}`);
        const seat = pendingActors(state)[0];
        if (seat === undefined) throw new Error('No pending actor');
        const strategy = seat % 2 === teamA ? a : b;
        const view = toPlayerView(state, seat);
        const start = performance.now();
        const analysis = view.myDuty === 'play'
          ? analyzeAdvancedPlay(view, options[strategy], { deadline: Date.now() + budgetMs }) : null;
        const decision = analysis?.decision ?? baseline.decide(view);
        stats[strategy].ms.push(performance.now() - start);
        stats[strategy].decisions++;
        if (analysis?.reasons.some(reason => reason.includes('模拟比较了'))) stats[strategy].searched++;
        if (analysis?.reasons.some(reason => reason.includes('因此调整了原建议'))) stats[strategy].changed++;
        if (!decision) throw new Error('Missing decision');
        const next = reduce(state, decisionToAction(seat, decision));
        if (!next.ok) throw new Error(`Illegal action: ${next.error.message}`);
        state = next.state;
      }
      const result = state.lastResult;
      if (!result) throw new Error('Missing hand result');
      const winner = result.winTeam === teamA as Team ? a : b;
      for (const strategy of [a, b]) stats[strategy].hands++;
      stats[winner].wins++; stats[winner].upgrade += result.upgrade;
      row.wins[winner]++; row.upgrade[winner] += result.upgrade;
      if (result.upgrade === 3) { stats[winner].double++; row.double[winner]++; }
      row.hands++; hand++;
      process.stderr.write(`${a} 对 ${b}：第 ${seed + 1}/${seeds} 个种子、${teamA === 0 ? '首座' : '换座'}，完成 ${row.hands}/${seeds * 2 * handsPerMatch} 局；耗时 ${Math.round((performance.now() - startedAt) / 1000)} 秒。\n`);
    }
    row.matches++;
  }
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { meanMs: values.reduce((a, b) => a + b, 0) / values.length, p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: percentile(1) };
}
const result = {
  finishedAt: new Date().toISOString(), seeds, handsPerMatch, budgetMs, elapsedSeconds: (performance.now() - startedAt) / 1000,
  matchups: rows,
  strategies: Object.fromEntries((['base', 'endgame', 'all'] as const).map(name => {
    const { ms, ...summary } = stats[name];
    return [name, { ...summary, latency: latency(ms) }];
  })),
};
const json = JSON.stringify(result, null, 2) + '\n';
if (output) writeFileSync(output, json);
process.stdout.write(json);
