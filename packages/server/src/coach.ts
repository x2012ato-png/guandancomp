import { partnerOf, toPlayerView, type GameState, type Seat } from '@guandan/engine';
import { analyzeAdvancedPlay } from '@guandan/ai';
import type { BotKind, CoachAdvice } from '@guandan/protocol';
import { shouldAutoPass } from './autoPass.ts';

/** 教练只根据被指导玩家自己的视图分析，绝不使用教练座位的手牌。 */
type CoachSeat = { readonly bot: boolean; readonly botKind: BotKind | null } | null;

export function hasCoach(seats: readonly CoachSeat[], seat: Seat): boolean {
  return !!seats[seat] && !seats[seat]!.bot && !!seats[partnerOf(seat)]?.bot && seats[partnerOf(seat)]?.botKind === 'coach';
}

/** 留出时间阅读教练建议，即使玩家没有合法跟牌也等其手动选择。 */
export function shouldForcePass(state: GameState, seats: readonly CoachSeat[], seat: Seat): boolean {
  return !hasCoach(seats, seat) && shouldAutoPass(state, seat, seats);
}

export function coachAdvice(state: GameState, seats: readonly CoachSeat[], seat: Seat): CoachAdvice | null {
  if (state.phase !== 'playing' || !hasCoach(seats, seat)) return null;
  const view = toPlayerView(state, seat);
  if (view.myDuty !== 'play') return null;
  return analyzeAdvancedPlay(view, { search: false });
}
