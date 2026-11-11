import { describe, expect, it } from 'vitest';
import { reduce, type GameAction, type GameState } from '@guandan/engine';
import { card, cards, playingState } from '../../engine/test/helpers.ts';
import { trickPlaysBySeat } from '../src/trickPlays.ts';

function act(state: GameState, action: GameAction): GameState {
  const result = reduce(state, action);
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

describe('seat plays', () => {
  it('keeps each seat’s latest cards through passes and clears them at the end of the trick', () => {
    let state = playingState([cards('S3 S7 D8'), cards('S4 D9'), cards('S5 D10'), cards('S6 DJ')]);
    state = act(state, { type: 'play', seat: 0, cards: [card('S3')] });
    state = act(state, { type: 'play', seat: 1, cards: [card('S4')] });
    state = act(state, { type: 'pass', seat: 2 });
    state = act(state, { type: 'pass', seat: 3 });
    expect(trickPlaysBySeat(state.trick, true)[0]?.cards).toEqual([card('S3')]);
    expect(trickPlaysBySeat(state.trick, true)[1]?.cards).toEqual([card('S4')]);
    state = act(state, { type: 'play', seat: 0, cards: [card('S7')] });
    expect(trickPlaysBySeat(state.trick, true)[0]?.cards).toEqual([card('S7')]);
    state = act(state, { type: 'pass', seat: 1 });
    state = act(state, { type: 'pass', seat: 2 });
    state = act(state, { type: 'pass', seat: 3 });
    expect(trickPlaysBySeat(state.trick, true)).toEqual({});
  });

  it('hides retained trick history when the hand is over', () => {
    let state = playingState([cards('S3'), cards('S5 D5'), cards('S4'), cards('S7 D7')]);
    state = act(state, { type: 'play', seat: 0, cards: [card('S3')] });
    state = act(state, { type: 'pass', seat: 1 });
    state = act(state, { type: 'play', seat: 2, cards: [card('S4')] });
    expect(state.phase).toBe('handOver');
    expect(trickPlaysBySeat(state.trick, false)).toEqual({});
  });
});
