import { SEATS, type GameState } from '@guandan/engine';

const ENDGAME_BOT_DELAY_MS = 50;

/** Speed up the remaining bots once players have started finishing. */
export function botDelay(state: GameState, seats: readonly ({ readonly bot: boolean } | null)[], normalDelay: number): number {
  if (state.phase !== 'playing' || state.finishOrder.length === 0) return normalDelay;
  const active = SEATS.filter(seat => !state.finishOrder.includes(seat));
  const bots = active.filter(seat => seats[seat]?.bot);
  return bots.length > 0 && (bots.length === 1 || bots.length === active.length)
    ? Math.min(normalDelay, ENDGAME_BOT_DELAY_MS)
    : normalDelay;
}
