import { describe, expect, it } from 'vitest';
import { reduce, type GameAction, type GameState, type Play } from '@guandan/engine';
import { card, cards, playingState } from '../../engine/test/helpers.ts';
import { displayPlayCards, trickPassesBySeat, trickPlaysBySeat } from '../src/trickPlays.ts';

function act(state: GameState, action: GameAction): GameState {
  const result = reduce(state, action);
  if (!result.ok) throw new Error(result.error.message);
  return result.state;
}

describe('played card display order', () => {
  it('places two wild cards into their sequence positions without changing the play', () => {
    const original = cards('S3 S5 S7 H9 H9');
    const play: Play = { cards: original, combo: { type: 'straight', key: 7, size: 5 }, wildAssignments: [
      { cardId: original[3]!, rank: 4, suit: 'H' }, { cardId: original[4]!, rank: 6, suit: 'H' },
    ] };
    expect(displayPlayCards(play, 9)).toEqual([original[0], original[3], original[1], original[4], original[2]]);
    expect(play.cards).toEqual(original);
  });

  it('places an ace at the low end of an A-2-3-4-5 straight', () => {
    const original = cards('S2 S3 S4 S5 H9');
    const play: Play = { cards: original, combo: { type: 'straight', key: 5, size: 5 }, wildAssignments: [{ cardId: original[4]!, rank: 14, suit: 'H' }] };
    expect(displayPlayCards(play, 9)).toEqual([original[4], ...original.slice(0, 4)]);
  });

  it('groups a wild card with the triple in a full house, even when the pair is higher', () => {
    const original = cards('S3 D3 S8 D8 H9');
    const play: Play = { cards: original, combo: { type: 'fullHouse', key: 3, size: 5 }, wildAssignments: [{ cardId: original[4]!, rank: 3, suit: 'H' }] };
    expect(displayPlayCards(play, 9)).toEqual([original[0], original[1], original[4], original[2], original[3]]);
  });
});

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
    expect(trickPlaysBySeat(state.trick, false, true)).toEqual({ 2: state.trick?.lastPlay?.play });
    expect(trickPassesBySeat(state.trick, false)).toEqual({});
  });

  it('shows a pass until that seat plays again or the trick ends', () => {
    let state = playingState([cards('S3 S7 D8'), cards('S4 S9 D9'), cards('S5 D10'), cards('S6 S8 DJ')]);
    state = act(state, { type: 'play', seat: 0, cards: [card('S3')] });
    state = act(state, { type: 'play', seat: 1, cards: [card('S4')] });
    state = act(state, { type: 'pass', seat: 2 });
    state = act(state, { type: 'play', seat: 3, cards: [card('S6')] });
    expect(trickPassesBySeat(state.trick, true)[2]).toBe(true);
    state = act(state, { type: 'play', seat: 0, cards: [card('S7')] });
    state = act(state, { type: 'pass', seat: 1 });
    expect(trickPassesBySeat(state.trick, true)[1]).toBe(true);
    state = act(state, { type: 'pass', seat: 2 });
    state = act(state, { type: 'play', seat: 3, cards: [card('S8')] });
    state = act(state, { type: 'pass', seat: 0 });
    state = act(state, { type: 'play', seat: 1, cards: [card('S9')] });
    expect(trickPassesBySeat(state.trick, true)[1]).toBe(false);
    state = act(state, { type: 'pass', seat: 2 });
    state = act(state, { type: 'pass', seat: 3 });
    state = act(state, { type: 'pass', seat: 0 });
    expect(trickPassesBySeat(state.trick, true)).toEqual({});
  });
});
