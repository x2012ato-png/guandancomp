import { isDoubleDown, type GameState, type Seat } from '@guandan/engine';

export function lastPlaceReveal(state: GameState, until: number | null, now: number, after: number | null = null) {
  if ((state.phase !== 'handOver' && state.phase !== 'matchOver') || (state.phase === 'handOver' && until === null) || (after !== null && now < after) || (until !== null && now >= until)) return null;
  const order = state.lastResult?.finishOrder;
  if (!order || order.length !== 4) return null;
  const places = isDoubleDown(order) ? [2, 3] : [3];
  return { until, hands: places.map(place => {
    const seat = order[place]!;
    return { seat, cards: [...state.hands[seat]], place: place + 1 };
  }) };
}

export function toggleReady(seats: readonly ({ ready: boolean } | null)[], seat: Seat): void {
  const player = seats[seat];
  if (!player) return;
  player.ready = !player.ready;
}

export function allHumansReady(seats: readonly ({ readonly bot: boolean; readonly ready: boolean } | null)[]): boolean {
  let humanCount = 0;
  for (const seat of seats) {
    if (!seat || seat.bot) continue;
    humanCount++;
    if (!seat.ready) return false;
  }
  return humanCount >= 2;
}

export function nextHandDeadline(deadline: number | null, now: number, delay: number): number {
  return deadline ?? now + delay;
}
