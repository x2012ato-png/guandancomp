/** 配对种子、交换队伍座位的离线评测。 */
import { performance } from 'node:perf_hooks';
import { createGame, makeRules, pendingActors, reduce, toPlayerView, type Team } from '@guandan/engine';
import { analyzeAdvancedPlay, createAdvancedPolicy, createBeginnerPolicy, decisionToAction, type AIPolicy } from '../src/index.ts';

function argument(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`Missing --${name} value`);
  return value;
}
const seeds = Number(argument('seeds', '20'));
const maxHands = Number(argument('hands', '4'));
const opponentName = argument('opponent', 'beginner');
const allPhases = argument('all-phases', 'false') === 'true';
const budgetMs = Number(argument('budget-ms', '0'));
const progressEvery = Number(argument('progress-every', '0'));
if (!Number.isInteger(seeds) || seeds < 1 || !Number.isInteger(maxHands) || maxHands < 1 ||
    !Number.isInteger(budgetMs) || budgetMs < 0 || !Number.isInteger(progressEvery) || progressEvery < 0 ||
    !['beginner', 'advanced-no-search', 'advanced-no-tactics'].includes(opponentName)) throw new Error('Invalid arguments');
const advanced = createAdvancedPolicy({ search: true, allPhases });
const opponent = opponentName === 'beginner' ? createBeginnerPolicy()
  : createAdvancedPolicy({ search: false, tactics: opponentName !== 'advanced-no-tactics' });
const timings: Record<string, number[]> = { advanced: [], opponent: [] };
const searchStats = { eligibleTurns: 0, completedSearches: 0, changedRecommendations: 0 };
const results = { hands: 0, advancedWins: 0, opponentWins: 0, advancedDouble: 0, opponentDouble: 0,
  advancedUpgrade: 0, opponentUpgrade: 0, advancedMatchWins: 0, opponentMatchWins: 0, completedMatches: 0 };
const pairedResults = { bothWon: 0, split: 0, bothLost: 0 };
let firstSeatWon = false;
const evaluationStart = performance.now();

for (let seed = 0; seed < seeds; seed++) for (const advancedTeam of [0, 1] as const) {
  let state = createGame(makeRules({ firstLeader: 0 }), `ai-eval-${seed}`);
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
      const isAdvanced = actor % 2 === advancedTeam;
      const policy: AIPolicy = isAdvanced ? advanced : opponent;
      const view = toPlayerView(state, actor);
      const start = performance.now();
      const context = isAdvanced && budgetMs ? { deadline: Date.now() + budgetMs } : undefined;
      const analysis = isAdvanced && view.myDuty === 'play' ? analyzeAdvancedPlay(view, { allPhases }, context) : null;
      if (isAdvanced && view.myDuty === 'play') {
        searchStats.eligibleTurns++;
        if (analysis?.reasons.some(reason => reason.includes('模拟比较了'))) searchStats.completedSearches++;
        if (analysis?.reasons.some(reason => reason.includes('因此调整了原建议'))) searchStats.changedRecommendations++;
      }
      const decision = analysis?.decision ?? policy.decide(view, context);
      timings[isAdvanced ? 'advanced' : 'opponent']!.push(performance.now() - start);
      if (!decision) throw new Error('Missing decision');
      const next = reduce(state, decisionToAction(actor, decision));
      if (!next.ok) throw new Error(`Illegal action: ${next.error.message}`);
      state = next.state;
    }
    const result = state.lastResult;
    if (!result) throw new Error('Missing hand result');
    const won = result.winTeam === advancedTeam;
    results.hands++;
    if (won) {
      results.advancedWins++;
      results.advancedUpgrade += result.upgrade;
      if (result.upgrade === 3) results.advancedDouble++;
    } else {
      results.opponentWins++;
      results.opponentUpgrade += result.upgrade;
      if (result.upgrade === 3) results.opponentDouble++;
    }
    hands++;
  }
  if (state.phase === 'matchOver') {
    results.completedMatches++;
    if (state.matchWinner === advancedTeam as Team) results.advancedMatchWins++;
    else results.opponentMatchWins++;
  }
  if (maxHands === 1) {
    const advancedWon = state.lastResult?.winTeam === advancedTeam;
    if (advancedTeam === 0) firstSeatWon = advancedWon;
    else {
      if (firstSeatWon && advancedWon) pairedResults.bothWon++;
      else if (firstSeatWon || advancedWon) pairedResults.split++;
      else pairedResults.bothLost++;
    }
  }
  if (progressEvery && advancedTeam === 1 && (seed + 1) % progressEvery === 0) {
    process.stderr.write(`已完成 ${seed + 1}/${seeds} 个种子、${results.hands} 局；全阶段搜索 ${results.advancedWins} 胜，对照 ${results.opponentWins} 胜；耗时 ${Math.round((performance.now() - evaluationStart) / 1000)} 秒。\n`);
  }
}

function latency(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
  return { decisions: values.length, meanMs: values.reduce((a, b) => a + b, 0) / values.length,
    p95Ms: percentile(0.95), p99Ms: percentile(0.99), maxMs: percentile(1) };
}
process.stdout.write(JSON.stringify({ seeds, seatAssignmentsPerSeed: 2, maxHands, opponent: opponentName, allPhases, budgetMs,
  ...results, advancedWinRate: results.advancedWins / results.hands, ...(maxHands === 1 ? { pairedResults } : {}), searchStats,
  latency: { advanced: latency(timings.advanced!), opponent: latency(timings.opponent!) } }, null, 2) + '\n');
