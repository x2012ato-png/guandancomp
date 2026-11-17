/** 高级策略：沿用初级策略，只在有把握评估的局面增加残局判断。 */
import {
  cardLabel, cardPower, comboLabel, DECK_SIZE, generatePlays, isBomb, nextSeat, partnerOf, rankLabel, suitLabel, teamOf,
  type CardId, type Play, type PlayerView,
} from '@guandan/engine';
import { choosePlay, createBeginnerPolicy, DEFAULT_HEURISTIC, generateTacticalPlays, type HeuristicTrace } from './heuristic.ts';
import { searchAdvancedWithInfo } from './advancedSearch.ts';
import { tacticalAdjustments, tacticalContext } from './tactics.ts';
import { buildCoachInsights, type CoachInsights } from './coachInsights.ts';
import { fullHousePairCost } from './fullHouseCost.ts';
import type { AIDecision, AIPolicy, DecisionContext } from './types.ts';

const ENDGAME_HAND_LIMIT = 8;

function without(hand: readonly CardId[], played: readonly CardId[]): CardId[] {
  const used = new Set(played);
  return hand.filter(card => !used.has(card));
}

/** 尚未见到的大单张数量；可能在队友手中，不代表对手确定持有。 */
function unseenHigherSingles(view: PlayerView, power: number): number {
  const visible = new Set([...view.myHand, ...view.playedCards]);
  let count = 0;
  for (let card = 0; card < DECK_SIZE; card++) {
    if (!visible.has(card) && cardPower(card, view.level) > power) count++;
  }
  return count;
}

/** 按合法牌型搜索小手牌的拆分；代表性出法使其是估计而非最优保证。 */
function createTurnsEstimator(view: PlayerView): (hand: readonly CardId[]) => number {
  const cache = new Map<string, number>();
  const estimate = (hand: readonly CardId[]): number => {
    if (hand.length === 0) return 0;
    const key = [...hand].sort((a, b) => a - b).join(',');
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const plays = generatePlays(hand, view.level, view.config);
    if (plays.some(play => play.cards.length === hand.length)) {
      cache.set(key, 1);
      return 1;
    }
    let best = hand.length;
    for (const play of plays) {
      if (play.cards.length === 1 && best <= 2) continue;
      best = Math.min(best, 1 + estimate(without(hand, play.cards)));
      if (best === 2) break;
    }
    cache.set(key, best);
    return best;
  };
  return estimate;
}

function protectPartner(view: PlayerView): Play | null {
  const last = view.trick?.lastPlay;
  const partner = partnerOf(view.seat);
  const next = nextSeat(view.seat);
  if (!last || last.seat !== partner || view.handCounts[partner] === 0 ||
      last.play.combo.type !== 'single' || view.handCounts[next] !== 1 ||
      view.trick?.passed.includes(next) || unseenHigherSingles(view, last.play.combo.key) === 0) return null;
  // 下一家只有一张牌时，保留一张没有更大未知单牌的牌可阻止其立即走完。
  return generatePlays(view.myHand, view.level, view.config, last.play.combo)
    .filter(play => play.combo.type === 'single' && unseenHigherSingles(view, play.combo.key) === 0)
    .sort((a, b) => a.combo.key - b.combo.key)[0] ?? null;
}

interface EndgameScore { play: Play; turns: number; score: number; adjustments: string[] }

function chooseEndgameLead(view: PlayerView, useTactics = true): { play: Play; scores: EndgameScore[] } {
  const { candidates, flushes } = generateTacticalPlays(view);
  const estimate = createTurnsEstimator(view);
  const opponents = [nextSeat(view.seat), nextSeat(partnerOf(view.seat))];
  const minOpp = Math.min(...opponents.map(seat => view.handCounts[seat] || Infinity));
  const partnerCount = view.handCounts[partnerOf(view.seat)];
  const tactics = useTactics ? tacticalContext(view) : undefined;
  const scores: EndgameScore[] = [];
  for (const play of candidates) {
    const turns = estimate(without(view.myHand, play.cards));
    let score = turns * 10;
    const adjustments: string[] = [];
    const pairCost = fullHousePairCost(play, view.level);
    if (pairCost) { score += pairCost; adjustments.push(`三带二消耗控牌对子 +${pairCost}`); }
    for (const item of tactics ? tacticalAdjustments(view, play, tactics) : []) { score += item.cost; adjustments.push(`${item.text} ${item.cost > 0 ? '+' : ''}${item.cost}`); }
    if (isBomb(play.combo)) { score += 4; adjustments.push('使用炸弹 +4'); }
    if (flushes.length && play.combo.type !== 'straightFlush') {
      const remaining = new Set(without(view.myHand, play.cards));
      if (!flushes.some(flush => flush.cards.every(card => remaining.has(card)))) { score += 12; adjustments.push('拆掉同花顺 +12'); }
    }
    if (play.wildAssignments.length) {
      const cost = play.wildAssignments.length * 1.5;
      score += cost; adjustments.push(`使用逢人配 +${cost}`);
    }
    if (play.combo.type === 'single') {
      const higher = unseenHigherSingles(view, play.combo.key);
      // 对手只剩一张时，优先避免给其接单张的机会。
      if (minOpp === 1 && higher > 0) { score += 40; adjustments.push(`对手仅剩 1 张，仍有 ${higher} 张更大的未知单牌 +40`); }
      // 未见到更大的单牌时，平时尽量留下控牌。
      if (minOpp > 2 && higher === 0) { score += 2; adjustments.push('无更大未知单牌，保留控牌 +2'); }
      score += play.combo.key / 50;
      adjustments.push(`单张牌力 +${formatScore(play.combo.key / 50)}`);
    }
    if (minOpp === 2 && play.combo.type === 'pair') { score += 5; adjustments.push('对手仅剩 2 张，出对子 +5'); }
    if (minOpp > 3 && partnerCount > 0 && partnerCount <= 2 &&
        ((partnerCount === 1 && play.combo.type === 'single') ||
         (partnerCount === 2 && play.combo.type === 'pair'))) { score -= 2; adjustments.push(`队友剩 ${partnerCount} 张且仍在牌局中的对手均超过 3 张，尝试递牌 −2`); }
    scores.push({ play, turns, score, adjustments });
  }
  scores.sort((a, b) => a.score - b.score);
  return { play: scores[0]!.play, scores };
}

function formatScore(score: number): string { return Number(score.toFixed(4)).toString(); }
function playName(play: Play): string { return `${play.cards.map(cardLabel).join('、')}（${comboLabel(play.combo)}）`; }
function decisionName(decision: AIDecision): string { return decision.type === 'play' ? playName(decision.play) : '不要'; }

function endgameExplanation(scores: readonly EndgameScore[]): string[] {
  const describe = (item: EndgameScore) => `${playName(item.play)}：余牌估计 ${item.turns} 手 × 10${item.adjustments.length ? `，${item.adjustments.join('，')}` : '，没有其他加减分'}，合计 ${formatScore(item.score)} 分`;
  const first = scores[0]!;
  const second = scores.find(item => item.play.combo.type !== first.play.combo.type) ?? scores[1];
  const danger = scores.find(item => item !== first && item !== second && item.adjustments.some(detail => detail.includes('对手仅剩')));
  return [
    `残局首出按较低分选择：${describe(first)}${second ? `；对比 ${describe(second)}` : ''}${danger ? `；另一种有风险的出法 ${describe(danger)}` : ''}。`,
    '余牌手数通过合法牌型递归拆分估计，逢人配可参与组牌；这是代表性出法的估计，不保证实际能按该手数走完。未知单牌也可能在队友手中。',
  ];
}

function heuristicExplanation(trace: HeuristicTrace, view: PlayerView, decision: Extract<AIDecision, { type: 'play' | 'pass' }>): string[] {
  const scores = [...trace.scores].sort((a, b) => a.cost - b.cost);
  if (trace.mode === 'lead') {
    const first = scores[0];
    if (!first) return [];
    const second = scores.find(item => item.play.combo.type !== first.play.combo.type) ?? scores[1];
    return [
      `首出比较代价（越低越优）：${playName(first.play)} ${formatScore(first.cost)} 分（${first.details!.join('，')}）${second ? `；${playName(second.play)} ${formatScore(second.cost)} 分（${second.details!.join('，')}）` : ''}。`,
      `当前牌力粗估为${tacticalContext(view).mode === 'race' ? '有争先条件' : tacticalContext(view).mode === 'support' ? '偏弱，重视配合' : '中等'}；这是根据自己的控牌和余牌估算，不能确定名次。余牌结构变化包含小单张代价，炸弹和逢人配另算；各家剩牌和队友公开出牌会影响战术偏好。`,
    ];
  }
  const nonBomb = scores.filter(item => !isBomb(item.play.combo));
  const bombs = scores.filter(item => isBomb(item.play.combo));
  const best = nonBomb[0];
  const lastCount = view.handCounts[view.trick!.lastPlay!.seat];
  const oppCounts = [nextSeat(view.seat), nextSeat(partnerOf(view.seat))].map(seat => view.handCounts[seat]).filter(count => count > 0);
  const minOpp = oppCounts.length ? Math.min(...oppCounts) : Infinity;
  const context = `上家剩 ${lastCount} 张${Number.isFinite(minOpp) ? `，仍在牌局中的对手最少剩 ${minOpp} 张` : ''}，${trace.danger ? '触发拦截' : '未触发拦截'}${trace.partnerCaution ? '；自己牌力偏弱且队友仍有机会跟牌，倾向让队友接牌' : ''}，普通跟牌代价上限为 ${trace.limit} 分`;
  const comparison = best ? `最便宜的普通跟牌是 ${playName(best.play)}，代价 ${formatScore(best.cost)} 分（${best.details!.join('，')}）${nonBomb[1] ? `；另一种 ${playName(nonBomb[1].play)} 为 ${formatScore(nonBomb[1].cost)} 分（${nonBomb[1].details!.join('，')}）` : ''}` : '没有能压过当前牌的普通牌型';
  const tactics = tacticalContext(view);
  const bomb = bombs[0] ? `；最便宜炸弹为 ${playName(bombs[0].play)}，代价 ${formatScore(bombs[0].cost)} 分（${bombs[0].details!.join('，')}）${tactics.firstOpponentStraight ? '，对手首次出顺子可考虑拦截' : lastCount === 4 && !trace.nearlyDone && minOpp > 2 ? '，上家剩 4 张且局势未到紧急程度，优先保留炸弹' : trace.danger || trace.nearlyDone ? '，符合用炸条件' : '，但当前未满足用炸条件'}` : '；没有可用炸弹';
  return [
    `${context}。${comparison}${bomb}，因此${decision.type === 'pass' ? '选择不要' : `选择 ${playName(decision.play)}`}。`,
    '普通跟牌和炸弹分别比较拆牌、牌力和控牌代价；对手首次出顺子或剩 5 张时可优先考虑拦截，剩 4 张时通常更谨慎，仍会结合我方余牌和其他对手的威胁。',
  ];
}

export interface AdvancedOptions {
  /** 关闭搜索可用于对照评测原有高级启发式。 */
  readonly search?: boolean;
  /** 在有预算的后台任务中允许从开局开始搜索。 */
  readonly allPhases?: boolean;
  /** 只展示模拟比较，不用模拟结果替换基础决策。 */
  readonly adoptSearch?: boolean;
  /** 评测对照时关闭口诀战术。 */
  readonly tactics?: boolean;
}

export interface AdvancedPlayAnalysis {
  readonly decision: Extract<AIDecision, { type: 'play' | 'pass' }>;
  readonly reasons: readonly string[];
  readonly insights: CoachInsights;
}

/** 与高级策略使用同一次决策，解释其实际走过的分支。 */
export function analyzeAdvancedPlay(view: PlayerView, options: AdvancedOptions = {}, ctx?: DecisionContext): AdvancedPlayAnalysis | null {
  if (view.myDuty !== 'play') return null;
  let heuristicTrace: HeuristicTrace | undefined;
  const base = choosePlay(view, { ...DEFAULT_HEURISTIC, advanced: true, tactical: options.tactics }, trace => { heuristicTrace = trace; });
  if (!base || (base.type !== 'play' && base.type !== 'pass')) return null;
  const last = view.trick?.lastPlay;
  const reasons: string[] = [];
  let decision: typeof base = base;
  let searchInfo: ReturnType<typeof searchAdvancedWithInfo> | undefined;
  let method: 'finish' | 'partner' | 'partnerTake' | 'cover' | 'endgame' | 'basic' = 'basic';
  let endgameScores: EndgameScore[] | undefined;
  if (base.type === 'play' && base.play.cards.length === view.myHand.length) {
    method = 'finish';
  } else if (last && teamOf(last.seat) === teamOf(view.seat)) {
    const cover = protectPartner(view);
    if (cover) { decision = { type: 'play', play: cover }; method = 'cover'; }
    else method = base.type === 'play' ? 'partnerTake' : 'partner';
  } else {
    if (!last && view.myHand.length <= ENDGAME_HAND_LIMIT) {
      const endgame = chooseEndgameLead(view, options.tactics !== false);
      decision = { type: 'play', play: endgame.play };
      endgameScores = endgame.scores;
      method = 'endgame';
    }
  }
  if (options.search !== false && method !== 'finish' && (method !== 'partner' && method !== 'partnerTake' && method !== 'cover' || options.allPhases)) {
    const search = searchAdvancedWithInfo(view, decision, ctx, options.allPhases, options.tactics !== false);
    searchInfo = search;
    if (search.samples) {
      const bestAverage = Math.max(...search.scores.map(item => item.average));
      const conclusion = search.changed ? options.adoptSearch === false
        ? `模拟倾向 ${decisionName(search.decision)}，仅供参考，仍保留基础建议` : '因此调整了原建议' : bestAverage > search.scores[0]!.average
        ? '其他行动虽有更高平均分，但样本数量、一致性或优势不足，保留原建议' : '原建议的评分不低于其他候选行动';
      reasons.push(`${view.handCounts.reduce((a, b) => a + b, 0) <= 18 ? '残局' : '牌局'}模拟比较了 ${search.candidates} 个候选行动，每个行动使用相同的 ${search.samples} 组未知手牌样本：${search.scores.map(item => `${decisionName(item.decision)} ${formatScore(item.average)} 分${item.adjustment ? `（含本手调整 ${item.adjustment > 0 ? '+' : ''}${formatScore(item.adjustment)}）` : ''}`).join('；')}。分数越高越优，${conclusion}。`);
      reasons.push('每个候选分数 = 各组推演局面分的平均值 + 该出法的固定调整。局面分：结束时，胜方为 +(1 + 升级数 × 0.15)，负方为 −(1 + 升级数 × 0.15)；未结束时为（对方余牌 − 我方余牌）÷ 108 + 资源差 × 0.015 + 出牌权分 + 头游分。资源中炸弹算 1、逢人配算 0.5；出牌权在我方为 +0.025、对方为 −0.025、无人持有为 0；头游在我方为 +0.2、对方为 −0.2、尚无头游为 0。');
      reasons.push(`本手调整明细：${search.scores.map(item => `${decisionName(item.decision)}：${item.adjustmentDetails.length ? item.adjustmentDetails.map(detail => `${detail.text} ${detail.value >= 0 ? '+' : ''}${formatScore(detail.value)}`).join('，') : '无调整'}，合计 ${item.adjustment >= 0 ? '+' : ''}${formatScore(item.adjustment)}`).join('；')}。战术代价按 −0.005 倍换算为模拟分。`);
      const earlyGame = view.handCounts.reduce((a, b) => a + b, 0) > 18;
      reasons.push(`调整基础建议的条件：${earlyGame ? '至少 4 组样本，且至少 80% 的样本优于基础建议，平均优势至少 0.08 分' : '至少 3 组样本，且至少 75% 的样本优于基础建议，平均优势至少 0.04 分'}。${search.scores.slice(1).map(item => `${decisionName(item.decision)}：${item.winsAgainstFallback}/${search.samples} 组优于基础建议，平均差 ${formatScore(item.average - search.scores[0]!.average)} 分`).join('；')}。`);
      const exampleScores = search.changed ? [search.scores[0]!, search.scores.find(item => item.decision === search.decision)!] : [search.scores[0]!];
      for (const item of exampleScores) {
        const example = item.example;
        if (!example) continue;
        const name = (seat: number) => seat === view.seat ? '你' : seat === partnerOf(view.seat) ? '队友' : (seat + 4 - view.seat) % 4 === 1 ? '下家（对手）' : '上家（对手）';
        reasons.push(`模拟过程示例（${decisionName(item.decision)}）：第 1 组假设分牌下，${example.actions.map((action, index) => `${index + 1}. ${name(action.seat)} ${decisionName(action.decision)}${action.decision.type === 'play' && action.decision.play.wildAssignments.length ? `（逢人配 ${action.decision.play.wildAssignments.map(w => `${cardLabel(w.cardId)}→${suitLabel(w.suit)}${rankLabel(w.rank)}`).join('、')}）` : ''}`).join(' → ')}。停止原因：${example.stop}。该组局面分：${example.value.explanation} = ${formatScore(example.value.score)} 分；本手调整 ${item.adjustment >= 0 ? '+' : ''}${formatScore(item.adjustment)}，该组总分 ${formatScore(example.value.score + item.adjustment)} 分。`);
      }
      reasons.push('以上过程只是一组假设：未知手牌按公开信息采样，后续各家按启发式策略出牌；其他样本的过程可能不同，平均分也不是这一组的分数。模拟不能保证真实对手这样出牌。');
      const tacticalView = tacticalContext(view);
      const alternative = search.scores.filter(item => item.decision !== search.decision).sort((a, b) => b.average - a.average)[0];
      for (const candidate of [search.decision, alternative?.decision]) {
        if (candidate?.type === 'play') {
          const triggered = tacticalAdjustments(view, candidate.play, tacticalView);
          if (triggered.length) reasons.push(`${decisionName(candidate)}的战术考虑：${triggered.map(item => item.text).join('；')}。`);
        } else if (candidate?.type === 'pass' && tacticalView.mode === 'support' && view.trick?.lastPlay &&
            teamOf(view.trick.lastPlay.seat) !== teamOf(view.seat) && tacticalView.partnerCount > 0 && !view.trick.passed.includes(partnerOf(view.seat))) {
          reasons.push('不要的战术考虑：自己牌力估计偏弱，队友仍有机会接牌，但不能确定队友能否压住。');
        }
      }
      if (options.adoptSearch === false && !search.changed) reasons.push('模拟仅供参考，不会自动改变基础建议。');
      if (search.scores.some(item => item.adjustment !== 0)) reasons.push('模拟评分还计入保留同花顺、逢人配和控牌对子，以及大王控牌和当前局面的口诀战术偏好；这些只是加减分，并非必然结果。');
      if (view.previousTrick?.lastPlay && view.trick?.lastPlay && view.previousTrick.lastPlay.play.combo.type === view.trick.lastPlay.play.combo.type &&
          teamOf(view.previousTrick.lastPlay.seat) !== teamOf(view.seat) && view.previousTrick.passed.includes(partnerOf(view.seat)) && view.handCounts[partnerOf(view.seat)] > 0) {
        reasons.push('队友上轮对同类牌选择不要，采样时降低了其当时能用普通牌跟上的可能性；不要也可能是战术选择，不能断定队友没有牌。');
      }
    } else reasons.push('本次没有完成可比较的模拟样本（可能是候选行动不足、局面不符合采样条件或计算时间用完），以下采用基础建议。');
    if (options.adoptSearch !== false) {
      if (search.decision.type === 'play' || search.decision.type === 'pass') decision = search.decision;
      if (search.changed) method = 'basic';
    }
  }
  if (!reasons.length || method !== 'basic' || options.adoptSearch === false) {
    if (method === 'finish') reasons.push('这手牌符合当前出牌要求，并且能一次出完手牌，因此优先走完，无需模拟比较。');
    else if (method === 'cover') reasons.push('下一家只剩一张，队友的单张可能被压；建议用当前没有更大未知单张的牌接住，阻止下一家以单张立即走完。');
    else if (method === 'partner') reasons.push('当前最大牌来自队友，通常让队友保留出牌权，避免无必要地消耗自己的大牌。');
    else if (method === 'partnerTake') reasons.push('队友仍有多张牌，而对手接近走完；自己的控牌和余牌结构允许时，考虑用大王接管单张，之后再为队友创造机会。');
    else if (method === 'endgame' && endgameScores) reasons.push(...endgameExplanation(endgameScores));
    else if (heuristicTrace) reasons.push(...heuristicExplanation(heuristicTrace, view, decision));
    else if (!last) reasons.push('没有其他可比较的首出方案。');
    else if (decision.type === 'pass') {
      const legal = generatePlays(view.myHand, view.level, view.config, last.play.combo);
      reasons.push(legal.length === 0 ? '手中没有能压过当前牌的合法牌型，因此只能不要。' : '可以跟牌，但初级评分认为当前可跟牌的拆牌或用炸代价较高，选择保留手牌。');
    } else if (isBomb(decision.play.combo)) reasons.push('当前需要跟牌；策略结合对手剩余张数和自己的余牌结构，决定使用炸弹争取出牌权。');
    else reasons.push('当前需要跟牌；策略在能压过上家的牌中权衡牌力、拆牌、炸弹和逢人配的代价。');
  }
  return { decision, reasons, insights: buildCoachInsights(view, decision, searchInfo) };
}

export function createAdvancedPolicy(options: AdvancedOptions = {}): AIPolicy {
  const beginner = createBeginnerPolicy();
  const effective = { ...options, search: options.search ?? (options.allPhases === true) };
  return {
    id: 'advanced',
    decide(view, ctx): AIDecision | null {
      if (view.myDuty === 'play') return analyzeAdvancedPlay(view, effective, ctx)?.decision ?? null;
      const base = beginner.decide(view, ctx);
      return base;
    },
  };
}
