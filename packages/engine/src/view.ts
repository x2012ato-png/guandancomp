/**
 * 信息隔离：从权威状态投影出单个玩家可见的视图，并过滤事件。
 * 这是服务端向客户端发送游戏数据的唯一出口。
 */
import { pendingActors } from './game.ts';
import type { GameEvent, GameState, PendingDuty, PlayerView, ScopedEvent, Seat, TributeView } from './types.ts';

export function toPlayerView(state: GameState, seat: Seat): PlayerView {
  const t = state.tribute;
  const tribute: TributeView | null = t
    ? {
        kind: t.kind,
        payers: [...t.payers],
        receivers: [...t.receivers],
        paid: t.paid.map((p) => ({ ...p })),
        links: t.links.map((l) => {
          const involved = l.from === seat || l.to === seat || state.config.publicReturnCard;
          return {
            from: l.from,
            to: l.to,
            card: l.card,
            returned: l.returnCard !== null,
            returnCard: involved ? l.returnCard : null,
          };
        }),
      }
    : null;

  let myDuty: PendingDuty = null;
  if (pendingActors(state).includes(seat)) {
    myDuty = state.phase === 'tribute' ? 'tribute' : state.phase === 'return' ? 'return' : 'play';
  }

  return {
    seat,
    config: state.config,
    phase: state.phase,
    handNo: state.handNo,
    teamLevels: [...state.teamLevels] as [typeof state.level, typeof state.level],
    aFails: [...state.aFails] as [number, number],
    level: state.level,
    levelTeam: state.levelTeam,
    myHand: [...state.hands[seat]],
    handCounts: state.hands.map((h) => h.length) as unknown as [number, number, number, number],
    turn: state.turn,
    trick: state.trick,
    previousTrick: state.previousTrick ?? null,
    publicHistory: [...(state.publicHistory ?? [])],
    finishOrder: [...state.finishOrder],
    playedCards: [...state.playedCards],
    tribute,
    antiTribute: state.antiTribute,
    myDuty,
    lastResult: state.lastResult,
    matchWinner: state.matchWinner,
  };
}

export function eventsForSeat(events: readonly ScopedEvent[], seat: Seat): GameEvent[] {
  const out: GameEvent[] = [];
  for (const e of events) {
    if (e.visibleTo === 'all' || e.visibleTo.includes(seat)) out.push(e.event);
    else if (e.redacted) out.push(e.redacted);
  }
  return out;
}
