import { describe, expect, it } from 'vitest';
import { interpret, makeRules, type GameState } from '@guandan/engine';
import { cards, playingState } from '../../engine/test/helpers.ts';
import { shouldAutoPass } from '../src/autoPass.ts';

function following(hand: number[], previous: string): GameState {
  const play = interpret(cards(previous), 2, makeRules())[0]!;
  return playingState([hand, [], [], []], {
    trick: { leader: 3, lastPlay: { seat: 3, play }, passed: [], history: [] },
  });
}

const human = { bot: false };
const bot = { bot: true };
const multiplayer = [human, human, bot, bot];

describe('forced human pass', () => {
  it('passes only on a turn with no legal response', () => {
    const state = following(cards('S3 D4'), 'BJ');
    expect(shouldAutoPass(state, 0, multiplayer)).toBe(true);
    expect(shouldAutoPass(state, 1, multiplayer)).toBe(false);
    expect(shouldAutoPass({ ...state, trick: { leader: 0, lastPlay: null, passed: [], history: [] } }, 0, multiplayer)).toBe(false);
    expect(shouldAutoPass({ ...state, phase: 'return' }, 0, multiplayer)).toBe(false);
  });

  it('does not force a pass with only one human, but counts finished human players', () => {
    const state = following(cards('S3 D4'), 'BJ');
    expect(shouldAutoPass(state, 0, [human, bot, bot, bot])).toBe(false);
    expect(shouldAutoPass(state, 0, [bot, human, human, bot])).toBe(false);
    expect(shouldAutoPass({ ...state, finishOrder: [1] }, 0, multiplayer)).toBe(true);
  });

  it('keeps the turn when a higher play, bomb or wild-card play can respond', () => {
    expect(shouldAutoPass(following(cards('BJ S3'), 'SJ'), 0, multiplayer)).toBe(false);
    expect(shouldAutoPass(following(cards('S3 H3 C3 D3'), 'BJ'), 0, multiplayer)).toBe(false);
    expect(shouldAutoPass(following(cards('S5 H2'), 'S4 D4'), 0, multiplayer)).toBe(false);
    expect(shouldAutoPass(following(cards('S3 S4 S5 S7 H2'), 'BJ'), 0, multiplayer)).toBe(false);
  });
});
