import type { Play, Seat, TrickState } from '@guandan/engine';

/** The most recent cards each seat played in the current trick. */
export function trickPlaysBySeat(trick: TrickState | null, playing: boolean): Partial<Record<Seat, Play>> {
  const plays: Partial<Record<Seat, Play>> = {};
  if (playing) {
    for (const entry of trick?.history ?? []) {
      if (entry.play) plays[entry.seat] = entry.play;
    }
  }
  return plays;
}
