import { describe, expect, it } from 'vitest';
import { createGame, type GameState } from '@guandan/engine';
import { botDelay } from '../src/botDelay.ts';

const bot = { bot: true };
const human = { bot: false };
const playing = { ...createGame(), phase: 'playing' } as GameState;

describe('bot delay', () => {
  it('uses the normal pace before anyone finishes and outside the playing phase', () => {
    expect(botDelay(playing, [human, bot, bot, bot], 900)).toBe(900);
    expect(botDelay({ ...playing, phase: 'tribute', finishOrder: [0] }, [human, bot, bot, bot], 900)).toBe(900);
  });

  it('speeds up the last remaining bot and games with only bots still playing', () => {
    expect(botDelay({ ...playing, finishOrder: [1, 2] }, [human, bot, bot, bot], 900)).toBe(50);
    expect(botDelay({ ...playing, finishOrder: [0] }, [human, bot, bot, bot], 900)).toBe(50);
  });

  it('keeps the usual pace when multiple bots and a human are still playing', () => {
    expect(botDelay({ ...playing, finishOrder: [3] }, [human, bot, bot, bot], 900)).toBe(900);
    expect(botDelay({ ...playing, finishOrder: [1] }, [human, bot, human, human], 900)).toBe(900);
  });
});
