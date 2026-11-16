import { isBomb, nextSeat, partnerOf, type Play, type PlayerView } from '@guandan/engine';

/** 手牌还多、对手不紧急时保留逢人配；拼低强度普通牌的代价更高。 */
export function earlyWildCost(view: PlayerView, play: Play): number {
  if (!play.wildAssignments.length || isBomb(play.combo) || play.combo.type === 'single' ||
      view.myHand.length - play.cards.length < 8) return 0;
  const opponents = [nextSeat(view.seat), nextSeat(partnerOf(view.seat))]
    .map(seat => view.handCounts[seat]).filter(count => count > 0);
  if (!opponents.length || Math.min(...opponents) <= 6) return 0;
  return play.wildAssignments.length * (play.combo.key <= 10 ? 24 : 14);
}
