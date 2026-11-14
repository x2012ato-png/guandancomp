import { generatePlays, type GameState, type Seat } from '@guandan/engine';

/** A forced pass is safe only when following a play and no legal response exists. */
export function shouldAutoPass(state: GameState, seat: Seat): boolean {
  const last = state.trick?.lastPlay;
  return state.phase === 'playing' && state.turn === seat && !!last &&
    generatePlays(state.hands[seat], state.level, state.config, last.play.combo).length === 0;
}
