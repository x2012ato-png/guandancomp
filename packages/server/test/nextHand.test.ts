import { describe, expect, it } from 'vitest';
import { computeHandResult, createGame, DEFAULT_RULES, type Seat } from '@guandan/engine';
import { allHumansReady, LAST_PLACE_REVEAL_MS, lastPlaceReveal, nextHandDeadline, toggleReady } from '../src/nextHand.ts';

describe('next hand readiness', () => {
  it('toggles readiness before the next hand begins', () => {
    const seats = [{ ready: false }, { ready: false }, { ready: true }, { ready: true }];
    toggleReady(seats, 0);
    expect(seats[0]!.ready).toBe(true);
    toggleReady(seats, 0);
    expect(seats[0]!.ready).toBe(false);
    toggleReady(seats, 1);
    toggleReady(seats, 0);
    expect(seats.every(seat => seat.ready)).toBe(true);
    toggleReady(seats, 0);
    expect(seats[0]!.ready).toBe(false);
  });

  it('starts early only when at least two humans are all ready', () => {
    const bot = { bot: true, ready: true };
    const human = { bot: false, ready: true };
    expect(allHumansReady([bot, bot, bot, bot])).toBe(false);
    expect(allHumansReady([human, bot, bot, bot])).toBe(false);
    expect(allHumansReady([human, human, bot, bot])).toBe(true);
    expect(allHumansReady([human, { bot: false, ready: false }, bot, bot])).toBe(false);
    expect(allHumansReady([human, human, human, { bot: false, ready: false }])).toBe(false);
    expect(allHumansReady([human, human, human, human])).toBe(true);
    expect(allHumansReady([human, human, { bot: true, ready: false }, null])).toBe(true);
  });

  it('does not count autoplay humans as bots and respects readiness changes', () => {
    const seats = [
      { bot: false, auto: true, ready: false },
      { bot: false, auto: false, ready: true },
      { bot: true, auto: true, ready: true },
      { bot: true, auto: true, ready: true },
    ];
    expect(allHumansReady(seats)).toBe(false);
    toggleReady(seats, 0);
    expect(allHumansReady(seats)).toBe(true);
    toggleReady(seats, 1);
    expect(allHumansReady(seats)).toBe(false);
    seats[1]!.bot = true;
    expect(allHumansReady(seats)).toBe(false);
  });

  it('preserves the original deadline when readiness or scheduling changes', () => {
    const seats = [{ ready: false }, { ready: false }, { ready: true }, { ready: true }];
    const deadline = nextHandDeadline(null, 1000, 15000);
    toggleReady(seats, 0);
    expect(nextHandDeadline(deadline, 5000, 15000)).toBe(16000);
    toggleReady(seats, 0);
    expect(nextHandDeadline(deadline, 9000, 15000)).toBe(16000);
    expect(nextHandDeadline(null, 20000, 15000)).toBe(35000);
  });

  it('reveals only the last-place hand during the eight-second settlement window after any bot play display', () => {
    expect(LAST_PLACE_REVEAL_MS).toBe(8_000);
    const base = createGame(DEFAULT_RULES, 'reveal');
    const state = {
      ...base,
      phase: 'handOver' as const,
      hands: [[1], [2, 3], [4], [5, 6, 7]] as const,
      lastResult: computeHandResult({ ...base, finishOrder: [0, 1, 2, 3] as Seat[] }, base.config),
    };
    const botPlayUntil = 15_000;
    const until = botPlayUntil + LAST_PLACE_REVEAL_MS;
    expect(lastPlaceReveal(state, until, 10_000, botPlayUntil)).toBeNull();
    expect(lastPlaceReveal(state, until, botPlayUntil - 1, botPlayUntil)).toBeNull();
    expect(lastPlaceReveal(state, until, botPlayUntil, botPlayUntil)).toEqual({ hands: [{ seat: 3, cards: [5, 6, 7], place: 4 }], until });
    expect(lastPlaceReveal(state, until, until - 1, botPlayUntil)?.hands[0]?.cards).toEqual([5, 6, 7]);
    expect(lastPlaceReveal(state, until, until, botPlayUntil)).toBeNull();
    expect(lastPlaceReveal({ ...state, phase: 'matchOver' }, until, botPlayUntil, botPlayUntil)?.hands[0]?.seat).toBe(3);
    expect(lastPlaceReveal({ ...state, phase: 'playing' }, until, botPlayUntil, botPlayUntil)).toBeNull();
    expect(lastPlaceReveal(state, null, botPlayUntil, botPlayUntil)).toBeNull();
  });

  it.each([
    [0, 2, 1, 3],
    [1, 3, 2, 0],
  ] as Seat[][])('reveals both losing hands after a double down (%s, %s, %s, %s)', (...order) => {
    const base = createGame(DEFAULT_RULES, 'double-down-reveal');
    const hands = [[1], [2, 3], [4, 5, 6], [7, 8]] as const;
    const state = {
      ...base,
      phase: 'handOver' as const,
      hands,
      lastResult: computeHandResult({ ...base, finishOrder: order }, base.config),
    };
    const until = 13_000;
    const expected = { until, hands: order.slice(2).map((seat, index) => ({ seat, cards: hands[seat], place: index + 3 })) };
    expect(lastPlaceReveal(state, until, 10_000)).toEqual(expected);
    expect(lastPlaceReveal({ ...state, phase: 'matchOver' }, until, until - 1)).toEqual(expected);
    expect(lastPlaceReveal(state, until, until)).toBeNull();
    expect(lastPlaceReveal({ ...state, phase: 'playing' }, until, 10_000)).toBeNull();
  });
});
