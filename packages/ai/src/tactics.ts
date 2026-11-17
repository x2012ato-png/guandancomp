/** 口诀对应的战术倾向。只使用自己的手牌和公开信息，分值是可被局面推翻的偏好。 */
import {
  BIG_JOKER, SMALL_JOKER, cardOf, cardPower, generatePlays, isBomb, nextSeat, partnerOf, teamOf,
  type Combo, type Play, type PlayerView, type TrickEntry,
} from '@guandan/engine';
import { planHand } from './handPlan.ts';

export type TacticalMode = 'race' | 'support' | 'balanced';
export interface TacticalContext {
  readonly mode: TacticalMode;
  readonly strength: number;
  readonly jokers: number;
  readonly lowSingles: number;
  readonly opponents: readonly number[];
  readonly partnerCount: number;
  readonly partnerNeed: Combo['type'] | null;
  readonly opening: boolean;
  readonly firstOpponentStraight: boolean;
  readonly controlCards: number;
}
export interface TacticalAdjustment { readonly code: string; readonly text: string; readonly cost: number }

function historyOf(view: PlayerView): readonly TrickEntry[] {
  if (view.publicHistory?.length) return view.publicHistory;
  return [...(view.previousTrick?.history ?? []), ...(view.trick?.history ?? [])];
}

/** 粗略手牌强度只作为战术分支，不代表真实头游概率。 */
export function tacticalContext(view: PlayerView): TacticalContext {
  const partner = partnerOf(view.seat);
  const opponents = [nextSeat(view.seat), nextSeat(partner)].map(seat => view.handCounts[seat]).filter(n => n > 0);
  const plan = planHand(view.myHand, view.level);
  const jokers = view.myHand.filter(id => cardOf(id).rank === SMALL_JOKER || cardOf(id).rank === BIG_JOKER).length;
  const controls = view.myHand.filter(id => cardPower(id, view.level) >= 15).length;
  const lowSingles = plan.groups.filter(group => group.kind === 'single' && group.key <= 10).length;
  const strength = (controls + jokers + plan.bombs.length * 2 + plan.wilds.length) / Math.max(view.myHand.length, 1);
  const minOpp = opponents.length ? Math.min(...opponents) : Infinity;
  const mode: TacticalMode = strength >= 0.35 || (view.myHand.length <= minOpp && controls >= 2) ? 'race'
    : strength < 0.22 && view.myHand.length > minOpp ? 'support' : 'balanced';
  const history = historyOf(view);
  const partnerPlays = history.filter(entry => entry.seat === partner && entry.play && !isBomb(entry.play.combo)).slice(-5);
  const counts = new Map<Combo['type'], number>();
  for (const entry of partnerPlays) {
    const type = entry.play!.combo.type;
    counts.set(type, (counts.get(type) ?? 0) + 1);
  }
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const partnerNeed = ranked[0] && ranked[0][1] >= 2 && (!ranked[1] || ranked[0][1] > ranked[1][1]) ? ranked[0][0] : null;
  const last = view.trick?.lastPlay;
  const straights = history.filter(entry => entry.play?.combo.type === 'straight' && teamOf(entry.seat) !== teamOf(view.seat));
  const currentRecorded = !!last && straights.some(entry => entry.seat === last.seat && entry.play === last.play);
  // 反序列化后引用可能不同；若当前牌已在历史末尾，以牌 id 和出牌者识别。
  const lastRecorded = !!last && straights.some(entry => entry.seat === last.seat && entry.play!.cards.length === last.play.cards.length &&
    entry.play!.cards.every(id => last.play.cards.includes(id)));
  const firstOpponentStraight = !!last && last.play.combo.type === 'straight' && teamOf(last.seat) !== teamOf(view.seat) &&
    straights.length <= (currentRecorded || lastRecorded ? 1 : 0);
  return { mode, strength, jokers, lowSingles, opponents, partnerCount: view.handCounts[partner], partnerNeed,
    opening: view.playedCards.length < 10, firstOpponentStraight, controlCards: controls + plan.bombs.length };
}

/** 对候选行动增减代价（越低越有利）；不会把未知手牌当作事实。 */
export function tacticalAdjustments(view: PlayerView, play: Play, context: TacticalContext): TacticalAdjustment[] {
  const result: TacticalAdjustment[] = [];
  const add = (code: string, text: string, cost: number) => result.push({ code, text, cost });
  const c = play.combo;
  const last = view.trick?.lastPlay;
  if (!last) {
    const immediateSingleThreat = context.opponents.includes(1);
    if (context.opening && c.type === 'pair') add('probe_pair', '开局信息少，用对子试探', -3);
    if (context.opening && context.jokers > 0 && c.type === 'single' && c.key <= 10) add('joker_single', '持王时可先试单张，保留王争牌权', -2);
    if (context.opening && context.jokers === 0 && c.type === 'fullHouse') add('no_joker_fullhouse', '没有王时优先考虑三带二整理牌型', -3);
    if (c.type === 'single' && c.key <= 10 && context.mode === 'support' && !immediateSingleThreat) add('weak_single', '牌力偏弱，避免过早送小单张', 4);
    if (c.type === 'single' && c.key <= 10 && context.mode === 'race' && context.lowSingles >= 2) add('race_singles', '有争先条件且小单张较多，及早处理', -4);
    if (c.type === 'straight') {
      const before = planHand(view.myHand, view.level);
      const used = new Set(play.cards);
      const after = planHand(view.myHand.filter(id => !used.has(id)), view.level);
      if (after.turns > before.turns - 1) add('split_straight', '组顺使余牌更零散，谨慎拆组', 4);
    }
    if (c.type === 'triple' && context.mode === 'support' && context.opponents.some(n => n >= 5)) add('bare_triple', '牌力偏弱，三张可试探对手结构', -3);
    if (context.mode === 'race' && c.key <= 10 && !isBomb(c)) add('strong_low', '牌力偏强，保留部分大牌', -1.5);
    if (context.mode === 'support' && c.key >= 13 && !isBomb(c) && !immediateSingleThreat) add('weak_high', '牌力偏弱，可用较大牌争取节奏', -1.5);
    const used = new Set(play.cards);
    const remaining = view.myHand.filter(id => !used.has(id));
    if (isBomb(c) && remaining.length > 1 && remaining.length <= 8 &&
        remaining.some(id => cardPower(id, view.level) < 15)) {
      const continuations = generatePlays(remaining, view.level, view.config);
      if (!continuations.some(next => next.cards.length === remaining.length || isBomb(next.combo))) {
        add('retain_bomb_control', '先出炸弹后余牌仍需多手且有弱牌，保留炸弹用于收回牌权', 24);
      }
    }
    const remainingControls = remaining.filter(id => cardPower(id, view.level) >= 15).length;
    const retainedBomb = !isBomb(c) && remainingControls === 0 && remaining.length >= 4 && planHand(remaining, view.level).bombs.length > 0;
    if (c.type === 'single' && c.key <= 10 && (remainingControls > 0 || retainedBomb)) add('retain_control', '出小单后仍保留大牌或炸弹，可尝试收回牌权', -2);
    if (c.type !== 'single' && !isBomb(c) && (remainingControls > 0 || retainedBomb)) add('retain_control', '出牌后保留大牌或炸弹，可尝试重新争取牌权', -1.5);
    if (c.type === 'single' && c.key <= 10 && context.controlCards === 0 && context.mode !== 'race' && !immediateSingleThreat) add('no_control', '缺少明显控牌，小单失去牌权的风险较高', 2);
    if (c.type !== 'single' && !isBomb(c) && remainingControls === 0 && !retainedBomb && context.mode === 'support') add('no_control', '余牌缺少明显控牌，主动出牌后可能难以收回', 1.5);
    if (context.opponents.includes(5) && c.type === 'pair') add('opp5_pair', '对手剩 5 张，考虑用对子试探或拆牌', -5);
    if (context.opponents.includes(6) && c.type === 'triple') add('opp6_triple', '对手剩 6 张，考虑用三张试探或拆牌', -5);
    if (context.opponents.some(n => n === 7 || n === 8) && (c.type === 'fullHouse' || c.type === 'straight')) add('opp78_composite', '对手剩 7–8 张，考虑五张牌型', -4);
    if (context.opponents.includes(9) && (c.type === 'single' || c.type === 'pair')) add('opp9_single_pair', '对手剩 9 张，考虑单张或对子试探', -3);
    if (context.opponents.includes(10) && c.type === 'pair') add('opp10_pair', '对手剩 10 张，考虑对子试探', -3);
    if (context.partnerCount > 0 && context.partnerNeed === c.type && !isBomb(c) && c.key <= 12 && context.opponents.every(n => n > 3)) {
      add('feed_partner', `队友近期多次出${c.type === 'single' ? '单张' : c.type === 'pair' ? '对子' : c.type === 'triple' ? '三张' : '此牌型'}，可尝试递牌`, -3);
    }
  } else if (teamOf(last.seat) === teamOf(view.seat)) {
    const goodSingle = context.mode === 'race' && c.type === 'single' && c.key === BIG_JOKER;
    if (play.cards.length !== view.myHand.length) add('respect_partner', goodSingle ? '牌力较强，用大王接队友仍需谨慎' : '队友领先，谨慎接牌', goodSingle ? 2 : 12);
  } else if (isBomb(c)) {
    if (context.firstOpponentStraight) add('first_straight_bomb', '对手首次出顺子，考虑用炸弹阻断连续出牌', -14);
    const count = view.handCounts[last.seat];
    if (count === 5) add('bomb_five', '上家剩 5 张，考虑用炸弹拦截', -10);
    if (count === 4) add('save_bomb_four', '上家剩 4 张，谨慎开炸并比较其他方案', 16);
  }
  return result;
}
