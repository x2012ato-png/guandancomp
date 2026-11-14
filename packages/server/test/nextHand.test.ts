import { describe, expect, it } from 'vitest';
import { nextHandDeadline, toggleReady } from '../src/nextHand.ts';

describe('next hand readiness', () => {
  it('toggles readiness even when every player has become ready', () => {
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

  it('preserves the original deadline when readiness or scheduling changes', () => {
    const seats = [{ ready: false }, { ready: false }, { ready: true }, { ready: true }];
    const deadline = nextHandDeadline(null, 1000, 15000);
    toggleReady(seats, 0);
    expect(nextHandDeadline(deadline, 5000, 15000)).toBe(16000);
    toggleReady(seats, 0);
    expect(nextHandDeadline(deadline, 9000, 15000)).toBe(16000);
    expect(nextHandDeadline(null, 20000, 15000)).toBe(35000);
  });
});
