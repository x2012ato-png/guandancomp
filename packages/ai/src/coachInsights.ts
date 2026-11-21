import { BIG_JOKER, LEVEL_POWER, SMALL_JOKER, cardLabel, cardOf, cardPower, comboLabel, makeDeck, partnerOf, rankLabel, sortHand, suitLabel, teamOf, type CardId, type PlayerView, type Seat, type TrickEntry, type TrickState } from '@guandan/engine';
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

interface HighSingleEvidence { acePass: boolean; levelPass: boolean; jokerPlayedAfterLevelPass: boolean }

/** 每次不要归因于之前最近的一手牌；新一轮总以出牌开始。 */
function highSingleEvidence(view: PlayerView): Map<Seat, HighSingleEvidence> {
  const evidence = new Map<Seat, HighSingleEvidence>();
  const histories: readonly (readonly TrickEntry[])[] = view.publicHistory?.length
    ? [view.publicHistory] : [view.previousTrick?.history ?? [], view.trick?.history ?? []];
  for (const history of histories) {
    let last: TrickEntry | null = null;
    for (const entry of history) {
      if (entry.play) {
        const prior = evidence.get(entry.seat);
        if (prior?.levelPass && entry.play.cards.some(card => cardOf(card).rank >= SMALL_JOKER)) prior.jokerPlayedAfterLevelPass = true;
        last = entry;
        continue;
      }
      if (!last?.play || last.seat !== view.seat || teamOf(entry.seat) === teamOf(view.seat) || last.play.combo.type !== 'single') continue;
      const isLevel = last.play.combo.key === LEVEL_POWER;
      const isAce = cardOf(last.play.cards[0]!).rank === 14 && !isLevel;
      if (!isLevel && !isAce) continue;
      const prior = evidence.get(entry.seat) ?? { acePass: false, levelPass: false, jokerPlayedAfterLevelPass: false };
      if (isAce) prior.acePass = true;
      if (isLevel) { prior.levelPass = true; prior.jokerPlayedAfterLevelPass = false; }
      evidence.set(entry.seat, prior);
    }
  }
  return evidence;
}

function possibilities(view: PlayerView): string[] {
  const visible = new Set([...view.myHand, ...view.playedCards]);
  // 贡牌的归属有时无法确认；未知还贡可能把贡牌原样还回。
  const owners = new Map<CardId, readonly Seat[]>();
  for (const link of view.tribute?.links ?? []) {
    if (!visible.has(link.card)) owners.set(link.card, link.returned && link.returnCard === null
      ? [link.from, link.to] : [link.returned && link.returnCard === link.card ? link.from : link.to]);
    if (link.returnCard !== null && !visible.has(link.returnCard)) owners.set(link.returnCard, [link.from]);
  }
  const unseen = makeDeck().filter(card => !visible.has(card));
  const tricks = [view.previousTrick, view.trick].filter((trick): trick is TrickState => !!trick);
  const highSingles = highSingleEvidence(view);
  return [1, 2, 3].map(offset => {
    const seat = ((view.seat + offset) % 4) as Seat;
    if (!view.handCounts[seat]) return `${seatName(view, seat)}已经出完。`;
    const fixed = unseen.filter(card => owners.get(card)?.length === 1 && owners.get(card)![0] === seat);
    const canHold = unseen.filter(card => {
      const allowed = owners.get(card);
      return allowed?.length === 1 ? allowed[0] === seat : fixed.length < view.handCounts[seat] && (!allowed || allowed.includes(seat));
    });
    const ranks = new Map<number, number>();
    for (const card of canHold) ranks.set(cardOf(card).rank, cardPower(card, view.level));
    const top = [...ranks].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([rank]) => rankLabel(rank));
    const details = [top.length
      ? `可能持有 ${top.join('、')} 等牌：这些点数仍有牌未在你的手牌或已出牌中出现，且公开进还贡记录未排除其归属`
      : '根据目前公开信息，没有可列出的未见牌'];

    // 只在完整的轮次记录中关联上手牌，避免跨轮错误地解释“不要”或“压牌”。
    const observations: string[] = [];
    for (const trick of tricks) {
      let last: typeof trick.lastPlay = null;
      for (const entry of trick.history) {
        if (entry.seat === seat) {
          if (!entry.play && last) {
            observations.push(`面对${seatName(view, last.seat)}的${comboLabel(last.play.combo)} ${last.play.cards.map(cardLabel).join('、')}时不要，可能当时缺少能压过的牌，也可能是战术让牌`);
          } else if (entry.play && last) {
            observations.push(`曾用${comboLabel(entry.play.combo)} ${entry.play.cards.map(cardLabel).join('、')}压过${seatName(view, last.seat)}的${comboLabel(last.play.combo)} ${last.play.cards.map(cardLabel).join('、')}，说明当时有这样的牌力`);
          } else if (entry.play) {
            observations.push(`曾出${comboLabel(entry.play.combo)} ${entry.play.cards.map(cardLabel).join('、')}，说明当时有这种牌型`);
          }
        }
        if (entry.play) last = { seat: entry.seat, play: entry.play };
      }
    }
    if (!observations.length) {
      const recent = (view.publicHistory ?? []).filter(entry => entry.seat === seat && entry.play).at(-1)?.play;
      if (recent) observations.push(`曾出${comboLabel(recent.combo)} ${recent.cards.map(cardLabel).join('、')}，说明当时有这种牌型`);
    }
    const evidence = highSingles.get(seat);
    if (evidence?.levelPass) {
      const source = evidence.acePass ? `曾对你的单 A 和级牌单 ${rankLabel(view.level)} 都不要` : `曾对你的级牌单 ${rankLabel(view.level)} 不要`;
      const fixedJokers = fixed.filter(card => cardOf(card).rank === SMALL_JOKER || cardOf(card).rank === BIG_JOKER);
      if (fixedJokers.length) details.unshift(`${source}；但进还贡记录表明其现在持有 ${fixedJokers.map(cardLabel).join('、')}，不能判断其没有王`);
      else if (evidence.jokerPlayedAfterLevelPass) details.unshift(`${source}；但之后曾出过王，不能据此断定其当时没有王`);
      else details.unshift(`${source}，可能没有王，单张控牌能力可能较弱；也可能有王但选择保留或战术让牌，不能确定`);
    } else if (evidence?.acePass) {
      details.unshift('曾对你的单 A 不要，可能缺少更大的单牌，但也可能保留级牌或王，不能断定没有王');
    }
    if (observations.length) details.push(...observations.slice(-2), '这些出牌线索只能反映当时的手牌，不能确定现在仍持有什么');
    else if (!evidence) details.push('暂无可用于判断其牌力的出牌记录');
    return `${seatName(view, seat)}：${details.join('；')}。`;
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
  return { assessment, known: knownInformation(view), possibilities: possibilities(view), grouping: grouping(view, decision), scenarios };
}
