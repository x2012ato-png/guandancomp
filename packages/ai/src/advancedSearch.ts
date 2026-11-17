/** 有界信息集模拟，只使用玩家视图；模拟中的玩家使用口诀启发式。 */
import {
  BIG_JOKER, DECK_SIZE, generatePlays, isBomb, makeRandom, partnerOf, pendingActors, reduce, teamOf, toPlayerView,
  type CardId, type GameState, type PlayerView, type Seat,
} from '@guandan/engine';
import { randomDeterminizer } from './determinize.ts';
import { choosePlay, createHeuristicPolicy, DEFAULT_HEURISTIC, generateTacticalPlays, type HeuristicTrace } from './heuristic.ts';
import { planHand } from './handPlan.ts';
import { fullHousePairCost } from './fullHouseCost.ts';
import { earlyWildCost } from './wildCost.ts';
import { tacticalAdjustments, tacticalContext } from './tactics.ts';
import { decisionToAction, type AIDecision, type DecisionContext } from './types.ts';

const SAMPLES = 12;
const MAX_CANDIDATES = 6;
const MAX_STEPS = 48;
const MAX_REMAINING_CARDS = 18;
const rolloutPolicy = createHeuristicPolicy({ advanced: true });

/** 未公开的还贡牌可能就是贡牌：只固定有足够信息确认归属的牌。 */
function drawAdvancedWorld(view: PlayerView, rng: () => number): GameState {
  const state = randomDeterminizer.sample({ ...view, tribute: null }, rng);
  const hands = state.hands.map(hand => [...hand]);
  const fixed = new Set<CardId>();
  const visible = new Set([...view.myHand, ...view.playedCards]);
  const assign = (card: CardId, target: Seat) => {
    if (visible.has(card) || fixed.has(card) || target === view.seat) return;
    const from = hands.findIndex(hand => hand.includes(card));
    if (from < 0) return;
    if (from !== target) {
      const swap = hands[target]!.findIndex(id => !fixed.has(id));
      if (swap < 0) return;
      const index = hands[from]!.indexOf(card);
      hands[from]![index] = hands[target]![swap]!;
      hands[target]![swap] = card;
    }
    fixed.add(card);
  };
  for (const link of view.tribute?.links ?? []) {
    if (!link.returned || (link.returnCard !== null && link.returnCard !== link.card)) assign(link.card, link.to);
    if (link.returnCard !== null) assign(link.returnCard, link.from);
  }
  for (const link of view.tribute?.links ?? []) {
    if (!link.returned || link.returnCard !== null || visible.has(link.card)) continue;
    const possible = [link.from, link.to].filter(seat => seat !== view.seat)
      .map(seat => ({ seat, slots: hands[seat]!.filter(id => !fixed.has(id)).length }))
      .filter(item => item.slots > 0);
    const total = possible.reduce((sum, item) => sum + item.slots, 0);
    if (!total) continue;
    let pick = rng() * total;
    for (const item of possible) {
      pick -= item.slots;
      if (pick < 0) { assign(link.card, item.seat); break; }
    }
  }
  return { ...state, hands: hands as unknown as GameState['hands'] };
}

/** 上轮队友让过同类牌是弱证据：降低能普通跟牌的样本权重，但不排除战术性不要。 */
export function sampleAdvancedWorld(view: PlayerView, rng: () => number): GameState {
  const previous = view.previousTrick;
  const last = previous?.lastPlay;
  const current = view.trick?.lastPlay;
  const partner = partnerOf(view.seat);
  const infer = last && current && last.play.combo.type === current.play.combo.type &&
    teamOf(last.seat) !== teamOf(view.seat) && previous.passed.includes(partner) && view.handCounts[partner] > 0;
  let world = drawAdvancedWorld(view, rng);
  if (!infer) return world;
  const since = view.trick?.history.filter(entry => entry.seat === partner && entry.play).flatMap(entry => entry.play!.cards) ?? [];
  for (let attempt = 0; attempt < 2; attempt++) {
    const priorHand = [...world.hands[partner], ...since];
    const couldFollow = generatePlays(priorHand, view.level, view.config, last.play.combo).some(play => !isBomb(play.combo));
    if (!couldFollow || rng() >= 0.65) break;
    world = drawAdvancedWorld(view, rng);
  }
  return world;
}

function key(decision: AIDecision): string {
  if (decision.type !== 'play') return decision.type;
  const p = decision.play;
  return `${p.combo.type}:${p.combo.key}:${p.combo.suit ?? ''}:${[...p.cards].sort((a, b) => a - b).join(',')}`;
}

function candidates(view: PlayerView, fallback: AIDecision, useTactics: boolean): AIDecision[] {
  const generated = generateTacticalPlays(view, view.trick?.lastPlay?.play.combo).candidates;
  const last = view.trick?.lastPlay;
  const partnerLeads = !!last && teamOf(last.seat) === teamOf(view.seat);
  // 接管队友必须由基础策略确认救急或控牌条件，不能由随机分牌的收益绕过。
  // fallback 已保留该类接管；额外候选仅允许一手走完。
  const plays = partnerLeads ? generated.filter(play => play.cards.length === view.myHand.length) : generated;
  const choices: AIDecision[] = [fallback];
  const add = (d: AIDecision | undefined) => {
    if (partnerLeads && d?.type === 'play' && d.play.cards.length !== view.myHand.length) return;
    if (d && choices.length < MAX_CANDIDATES && !choices.some(c => key(c) === key(d))) choices.push(d);
  };
  if (view.trick?.lastPlay) add({ type: 'pass' });
  const normal = plays.filter(p => !isBomb(p.combo));
  const asDecision = (p: typeof plays[number] | undefined): AIDecision | undefined => p && { type: 'play', play: p };
  let trace: HeuristicTrace | undefined;
  choosePlay(view, { ...DEFAULT_HEURISTIC, advanced: true, tactical: useTactics }, info => { trace = info; });
  const ranked = trace?.scores.filter(item => !isBomb(item.play.combo)).sort((a, b) => a.cost - b.cost) ?? [];
  add(asDecision(ranked[0]?.play));
  add(asDecision(ranked.find(item => item.play.combo.type !== (fallback.type === 'play' ? fallback.play.combo.type : ranked[0]?.play.combo.type))?.play));
  // 保证炸弹有机会参与比较，避免候选位被普通牌耗尽。
  add(asDecision(plays.find(p => isBomb(p.combo))));
  add(asDecision(normal[0]));
  // Include a different shape (or a higher response), then a bomb if space remains.
  add(asDecision(normal.find(p => p.combo.type !== (fallback.type === 'play' ? fallback.play.combo.type : normal[0]?.combo.type)) ?? normal.at(-1)));
  return choices;
}

interface ValueDetail { score: number; explanation: string }
export interface SimulationExample { actions: { seat: Seat; decision: AIDecision }[]; stop: string; value: ValueDetail }
interface Adjustment { text: string; value: number }

function value(state: GameState, seat: Seat): ValueDetail {
  const team = teamOf(seat);
  if ((state.phase === 'handOver' || state.phase === 'matchOver') && state.lastResult) {
    const won = state.lastResult.winTeam === team;
    return { score: (won ? 1 : -1) * (1 + state.lastResult.upgrade * 0.15),
      explanation: `${won ? '我方获胜' : '对方获胜'}，升 ${state.lastResult.upgrade} 级：${won ? '+' : '−'}(1 + ${state.lastResult.upgrade} × 0.15)` };
  }
  const ours = state.hands[team]!.length + state.hands[team + 2]!.length;
  const theirs = state.hands[1 - team]!.length + state.hands[3 - team]!.length;
  const plans = state.hands.map(hand => planHand(hand, state.level));
  const resources = plans.map(plan => plan.bombs.length + plan.wilds.length * 0.5);
  const resourcesDiff = resources[team]! + resources[team + 2]! - resources[1 - team]! - resources[3 - team]!;
  const owner = state.trick?.lastPlay?.seat ?? state.turn;
  const control = owner == null ? 0 : teamOf(owner) === team ? 0.025 : -0.025;
  const first = state.finishOrder[0];
  const finish = first == null ? 0 : teamOf(first) === team ? 0.2 : -0.2;
  return { score: (theirs - ours) / DECK_SIZE + resourcesDiff * 0.015 + control + finish,
    explanation: `余牌（对方 ${theirs} − 我方 ${ours}）÷ ${DECK_SIZE}；资源差 ${resourcesDiff} × 0.015（炸弹每个算 1，逢人配每张算 0.5）；牌权 ${control >= 0 ? '+' : ''}${control}；头游 ${finish >= 0 ? '+' : ''}${finish}` };
}

function simulate(state: GameState, decision: AIDecision, seat: Seat, deadline?: number, capture = false): { score: number; example?: SimulationExample } | null {
  const initial = reduce(state, decisionToAction(seat, decision));
  if (!initial.ok) return { score: -2, example: capture ? { actions: [{ seat, decision }], stop: '候选行动无法执行', value: { score: -2, explanation: '无效行动固定记 −2 分' } } : undefined };
  let current = initial.state;
  const steps = state.hands.flat().length > MAX_REMAINING_CARDS ? 12 : MAX_STEPS;
  const actions: SimulationExample['actions'] = capture ? [{ seat, decision }] : [];
  let stop = `达到后续 ${steps} 步上限`;
  for (let i = 0; i < steps && current.phase === 'playing'; i++) {
    if (deadline !== undefined && Date.now() >= deadline) return null;
    const actor = pendingActors(current)[0];
    if (actor === undefined) { stop = '没有待行动玩家'; break; }
    const action = rolloutPolicy.decide(toPlayerView(current, actor));
    if (!action) { stop = '模拟策略没有返回行动'; break; }
    const result = reduce(current, decisionToAction(actor, action));
    if (!result.ok) { stop = '模拟行动无法执行'; break; }
    if (capture) actions.push({ seat: actor, decision: action });
    current = result.state;
  }
  if (current.phase === 'handOver' || current.phase === 'matchOver') stop = '本局结束';
  const evaluated = value(current, seat);
  return { score: evaluated.score, example: capture ? { actions, stop, value: evaluated } : undefined };
}

/** 当样本数或一致性不足时，继续采用基准行动。 */
export function selectStableCandidate(totals: readonly number[], winsAgainstFallback: readonly number[], completed: number, earlyGame: boolean): number {
  let best = 0;
  if (!completed) return best;
  for (let i = 1; i < totals.length; i++) {
    const enoughEvidence = earlyGame ? completed >= 4 && winsAgainstFallback[i]! >= Math.ceil(completed * 0.8)
      : completed >= 3 && winsAgainstFallback[i]! >= Math.ceil(completed * 0.75);
    if (enoughEvidence && (totals[i]! - totals[0]!) / completed >= (earlyGame ? 0.08 : 0.04) && totals[i]! > totals[best]!) best = i;
  }
  return best;
}

/** 每个候选动作使用相同样本；截止时间中断时仅采用完整的一组样本。 */
export function searchAdvancedWithInfo(view: PlayerView, fallback: AIDecision, ctx?: DecisionContext, allPhases = false, useTactics = true): { decision: AIDecision; samples: number; candidates: number; changed: boolean; scores: readonly { decision: AIDecision; average: number; adjustment: number; adjustmentDetails: readonly Adjustment[]; winsAgainstFallback: number; example?: SimulationExample; examples: readonly SimulationExample[] }[]; worlds: readonly GameState[] } {
  const noSearch = { decision: fallback, samples: 0, candidates: 0, changed: false, scores: [], worlds: [] };
  if (view.phase !== 'playing' || (!allPhases && view.handCounts.reduce((a, b) => a + b, 0) > MAX_REMAINING_CARDS) ||
      view.playedCards.length + view.handCounts.reduce((a, b) => a + b, 0) !== DECK_SIZE ||
      view.myHand.length !== view.handCounts[view.seat]) return noSearch;
  const choices = candidates(view, fallback, useTactics);
  if (choices.length < 2) return noSearch;
  const flushes = generatePlays(view.myHand, view.level, view.config).filter(play => play.combo.type === 'straightFlush');
  const tactics = tacticalContext(view);
  const adjustments = choices.map(choice => {
    if (choice.type !== 'play') {
      const partner = partnerOf(view.seat);
      return useTactics && choice.type === 'pass' && view.trick?.lastPlay && teamOf(view.trick.lastPlay.seat) !== teamOf(view.seat) &&
        tactics.mode === 'support' && view.handCounts[partner] > 0 && !view.trick.passed.includes(partner) ? [{ text: '让队友接牌', value: 0.02 }] : [];
    }
    const remaining = new Set(view.myHand.filter(card => !choice.play.cards.includes(card)));
    const breaksFlush = choice.play.combo.type !== 'straightFlush' && flushes.length > 0 && !flushes.some(flush => flush.cards.every(card => remaining.has(card)));
    const controlsSingle = choice.play.combo.type === 'single' && choice.play.combo.key === BIG_JOKER && view.myHand.length >= 10;
    const details: Adjustment[] = [];
    const pairCost = fullHousePairCost(choice.play, view.level);
    if (pairCost) details.push({ text: '三带二消耗控牌对子', value: -pairCost * 0.005 });
    const wildCost = earlyWildCost(view, choice.play);
    if (wildCost) details.push({ text: '余牌较多且对手不紧急，保留逢人配', value: -wildCost * 0.005 });
    if (breaksFlush) details.push({ text: '拆掉同花顺', value: -0.12 });
    if (controlsSingle) details.push({ text: '大王控单', value: 0.025 });
    if (useTactics) for (const item of tacticalAdjustments(view, choice.play, tactics)) details.push({ text: item.text, value: -item.cost * 0.005 });
    return details;
  });
  const adjustmentTotals = adjustments.map(items => items.reduce((sum, item) => sum + item.value, 0));
  const seed = `${view.handNo}:${view.seat}:${[...view.myHand].sort((a, b) => a - b)}:${view.playedCards.join(',')}:${view.handCounts.join(',')}`;
  const rng = ctx?.rng ?? makeRandom(seed);
  const totals = choices.map(() => 0);
  const winsAgainstFallback = choices.map(() => 0);
  let completed = 0;
  let examples: (SimulationExample | undefined)[] = [];
  const scenarioExamples: SimulationExample[][] = choices.map(() => []);
  const worlds: GameState[] = [];
  for (let sample = 0; sample < SAMPLES; sample++) {
    if (ctx?.deadline !== undefined && Date.now() >= ctx.deadline) break;
    const world = sampleAdvancedWorld(view, rng);
    const results: number[] = [];
    const sampleExamples: (SimulationExample | undefined)[] = [];
    for (const choice of choices) {
      if (ctx?.deadline !== undefined && Date.now() >= ctx.deadline) break;
      const result = simulate(world, choice, view.seat, ctx?.deadline, completed < 2);
      if (result === null) break;
      results.push(result.score);
      sampleExamples.push(result.example);
    }
    if (results.length !== choices.length) break;
    if (!completed) examples = sampleExamples;
    if (completed < 2) sampleExamples.forEach((example, i) => { if (example) scenarioExamples[i]!.push(example); });
    worlds.push(world);
    const adjusted = results.map((value, i) => value + adjustmentTotals[i]!);
    adjusted.forEach((v, i) => {
      totals[i]! += v;
      if (i > 0 && v > adjusted[0]!) winsAgainstFallback[i]!++;
    });
    completed++;
  }
  if (!completed) return noSearch;
  // 开局推演较短、未知牌较多：至少四组且 80% 支持；残局至少三组且 75% 支持。
  const earlyGame = view.handCounts.reduce((a, b) => a + b, 0) > MAX_REMAINING_CARDS;
  const best = selectStableCandidate(totals, winsAgainstFallback, completed, earlyGame);
  return { decision: choices[best]!, samples: completed, candidates: choices.length, changed: best !== 0,
    scores: choices.map((decision, index) => ({ decision, average: totals[index]! / completed, adjustment: adjustmentTotals[index]!, adjustmentDetails: adjustments[index]!, winsAgainstFallback: winsAgainstFallback[index]!, example: examples[index], examples: scenarioExamples[index]! })), worlds };
}

export function searchAdvanced(view: PlayerView, fallback: AIDecision, ctx?: DecisionContext): AIDecision {
  return searchAdvancedWithInfo(view, fallback, ctx).decision;
}
