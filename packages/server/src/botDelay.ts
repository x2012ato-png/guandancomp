import { SEATS, type GameState } from '@guandan/engine';

const ENDGAME_BOT_DELAY_MS = 50;
export const BOT_PLAY_DISPLAY_MS = 5_000;

/** Both human players have finished, leaving the two bots at the table. */
export function isTwoHumanBotEndgame(state: GameState, seats: readonly ({ readonly bot: boolean } | null)[]): boolean {
  const humans = SEATS.filter(seat => seats[seat]?.bot === false);
  const bots = SEATS.filter(seat => seats[seat]?.bot === true);
  return state.phase === 'playing' && humans.length === 2 && bots.length === 2 &&
    humans.every(seat => state.finishOrder.includes(seat)) && bots.every(seat => !state.finishOrder.includes(seat));
}

/** Speed up the remaining bots once players have started finishing. */
export function botDelay(state: GameState, seats: readonly ({ readonly bot: boolean } | null)[], normalDelay: number): number {
  if (isTwoHumanBotEndgame(state, seats)) return BOT_PLAY_DISPLAY_MS;
  if (state.phase !== 'playing' || state.finishOrder.length === 0) return normalDelay;
  const active = SEATS.filter(seat => !state.finishOrder.includes(seat));
  const bots = active.filter(seat => seats[seat]?.bot);
  return bots.length > 0 && (bots.length === 1 || bots.length === active.length)
    ? Math.min(normalDelay, ENDGAME_BOT_DELAY_MS)
    : normalDelay;
}
