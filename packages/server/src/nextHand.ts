import type { Seat } from '@guandan/engine';

export function toggleReady(seats: readonly ({ ready: boolean } | null)[], seat: Seat): void {
  const player = seats[seat];
  if (!player) return;
  player.ready = !player.ready;
}

export function nextHandDeadline(deadline: number | null, now: number, delay: number): number {
  return deadline ?? now + delay;
}
