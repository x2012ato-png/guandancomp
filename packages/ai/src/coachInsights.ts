import { cardLabel, cardOf, cardPower, partnerOf, rankLabel, sortHand, suitLabel, teamOf, type CardId, type PlayerView, type Seat } from '@guandan/engine';
import { planHand } from './handPlan.ts';
import { tacticalAdjustments, tacticalContext } from './tactics.ts';
import type { AIDecision } from './types.ts';
import type { searchAdvancedWithInfo } from './advancedSearch.ts';

type Search = ReturnType<typeof searchAdvancedWithInfo>;
type PlayDecision = Extract<AIDecision, { type: 'play' | 'pass' }>;
export interface CoachInsights {
  readonly assessment: readonly string[];
  readonly known: readonly string[];
  readonly possibilities: readonly string[];
  readonly grouping: string;
  readonly scenarios: readonly { readonly title: string; readonly hands: readonly string[]; readonly steps: readonly string[]; readonly stop: string }[];
}

function seatName(view: PlayerView, seat: Seat): string {
  if (seat === view.seat) return '你';
  if (seat === partnerOf(view.seat)) return '队友';
  return (seat + 4 - view.seat) % 4 === 1 ? '下家（对手）' : '上家（对手）';
}

function knownInformation(view: PlayerView): string[] {
  const visible = new Set([...view.myHand, ...view.playedCards]);
  const lines: string[] = [];
  for (const link of view.tribute?.links ?? []) {
    const card = cardLabel(link.card);
    if (visible.has(link.card)) {
      lines.push(`贡牌 ${card} 已在你的手中或已打出，不再推测其余家的持有位置。`);
    } else if (link.returned && link.returnCard === null) {
      lines.push(`${seatName(view, link.from)}向${seatName(view, link.to)}进贡 ${card}；还贡牌不可见，贡牌可能已被原样还回。`);
    } else {
      const holder = link.returned && link.returnCard === link.card ? link.from : link.to;
      lines.push(`根据进还贡记录，${seatName(view, holder)}持有贡牌 ${card}。`);
    }
    if (link.returnCard !== null && link.returnCard !== link.card && !visible.has(link.returnCard)) {
      lines.push(`根据还贡记录，${seatName(view, link.from)}持有还贡牌 ${cardLabel(link.returnCard)}。`);
    }
  }
  for (const offset of [1, 2, 3]) {
    const seat = ((view.seat + offset) % 4) as Seat;
    const history = (view.publicHistory ?? []).filter(entry => entry.seat === seat && entry.play).slice(-2);
    const recent = history.map(entry => entry.play!.cards.map(cardLabel).join('、')).join('；');
    lines.push(`${seatName(view, seat)}剩 ${view.handCounts[seat]} 张${recent ? `，最近出过 ${recent}` : ''}。`);
  }
  return lines;
}

function grouping(view: PlayerView, decision: PlayDecision): string {
  const used = new Set(decision.type === 'play' ? decision.play.cards : []);
  const rest = view.myHand.filter(card => !used.has(card));
  if (!rest.length) return '这手可以出完。';
  const plan = planHand(rest, view.level);
  const names: Record<string, string> = { single: '单张', pair: '对子', triple: '三张', straight: '顺子', tube: '连对', plate: '钢板', bomb: '炸弹', straightFlush: '同花顺', jokerBomb: '王炸' };
  const groups = [...plan.bombs, ...plan.groups].map(group => `${names[group.kind]} ${group.cards.map(cardLabel).join('、')}`);
  if (plan.wilds.length) groups.push(`逢人配 ${plan.wilds.map(cardLabel).join('、')}（留作灵活组牌）`);
  return `按当前建议${decision.type === 'play' ? '出牌后' : '保留手牌'}，可参考分组：${groups.join('；')}。三张和对子可考虑组成三带二；这是参考拆分，实际能否按顺序出完取决于后续牌权。`;
}

function possibilities(view: PlayerView, worlds: Search['worlds']): string[] {
  if (!worlds.length) return [];
  return [1, 2, 3].map(offset => {
    const seat = ((view.seat + offset) % 4) as Seat;
    if (!view.handCounts[seat]) return `${seatName(view, seat)}已经出完。`;
    const ranks = new Map<number, { samples: number; pairs: number; power: number }>();
    for (const world of worlds) {
      const counts = new Map<number, number>();
      for (const card of world.hands[seat]) {
        const rank = cardOf(card).rank;
        counts.set(rank, (counts.get(rank) ?? 0) + 1);
      }
      for (const [rank, count] of counts) {
        const entry = ranks.get(rank) ?? { samples: 0, pairs: 0, power: cardPower(world.hands[seat].find(card => cardOf(card).rank === rank)!, view.level) };
        entry.samples++;
        if (count >= 2) entry.pairs++;
        ranks.set(rank, entry);
      }
    }
    const top = [...ranks.entries()].sort((a, b) => b[1].power - a[1].power).slice(0, 3);
    return `${seatName(view, seat)}：${top.map(([rank, value]) => `${rankLabel(rank)}在 ${value.samples}/${worlds.length} 组假设中出现${value.pairs ? `（其中 ${value.pairs} 组至少两张）` : ''}`).join('；')}。`;
  });
}

function decisionText(decision: AIDecision): string {
  if (decision.type === 'pass') return '不要';
  if (decision.type !== 'play') return '选择进还贡';
  return `出 ${decision.play.cards.map(cardLabel).join('、')}${decision.play.wildAssignments.length ? `（${decision.play.wildAssignments.map(w => `${cardLabel(w.cardId)}代作${suitLabel(w.suit)}${rankLabel(w.rank)}`).join('、')}）` : ''}`;
}

export function buildCoachInsights(view: PlayerView, decision: PlayDecision, search?: Search): CoachInsights {
  const assessment: string[] = [];
  const last = view.trick?.lastPlay;
  if (decision.type === 'pass') assessment.push(last && teamOf(last.seat) === teamOf(view.seat) ? '队友目前领先，先让队友保留牌权。' : '目前选择不要，保留手牌等待更合适的机会。');
  else if (decision.play.cards.length === view.myHand.length) assessment.push('这手可以合法出完，优先走完。');
  else {
    const tactics = tacticalAdjustments(view, decision.play, tacticalContext(view));
    assessment.push(...tactics.map(item => item.text));
    if (!tactics.length) assessment.push('结合余牌结构、牌权和各家剩牌，优先考虑这手。');
  }
  const selected = search?.scores.find(item => item.decision === decision);
  if (search?.samples) assessment.push(`已用 ${search.samples} 组相同的假设手牌比较 ${search.candidates} 种行动${search.changed && selected ? '，推演支持调整基础建议' : '，当前保留基础建议'}。`);
  const scenarioFor = (example: NonNullable<Search['scores'][number]['example']>, index: number, title: string) => ({
    title,
    hands: [1, 2, 3].map(offset => {
      const seat = ((view.seat + offset) % 4) as Seat;
      const hand: readonly CardId[] = search!.worlds[index]!.hands[seat];
      return `${seatName(view, seat)}假设持有：${hand.length ? sortHand(hand, view.level).map(cardLabel).join('、') : '已出完'}`;
    }),
    steps: example.actions.map(action => `${seatName(view, action.seat)}${decisionText(action.decision)}`),
    stop: example.stop,
  });
  const scenarios = selected?.examples.map((example, index) => scenarioFor(example, index, `假设 ${index + 1}：${decisionText(decision)}`)) ?? [];
  const alternative = search?.scores.filter(item => item !== selected).sort((a, b) => b.average - a.average)[0];
  if (alternative?.examples[0]) scenarios.push(scenarioFor(alternative.examples[0], 0, `对照假设 1：${decisionText(alternative.decision)}`));
  return { assessment, known: knownInformation(view), possibilities: possibilities(view, search?.worlds ?? []), grouping: grouping(view, decision), scenarios };
}
