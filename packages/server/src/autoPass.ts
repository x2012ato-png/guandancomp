import { generatePlays, type GameState, type Seat } from '@guandan/engine';

/** Force a human pass only in multiplayer games when no legal response exists. */
export function shouldAutoPass(state: GameState, seat: Seat, seats: readonly ({ readonly bot: boolean } | null)[]): boolean {
  const last = state.trick?.lastPlay;
  return seats[seat]?.bot === false && seats.filter(slot => slot && !slot.bot).length > 1 &&
    state.phase === 'playing' && state.turn === seat && !!last &&
    generatePlays(state.hands[seat], state.level, state.config, last.play.combo).length === 0;
}
