import type { GameUpdate, ServerToClientEvents } from '@guandan/protocol';

/** 后台建议只更新与当前牌局版本相同的视图，不重置选牌。 */
export function applyCoachAdvice(current: GameUpdate | null, update: Parameters<ServerToClientEvents['coach:advice']>[0]): GameUpdate | null {
  return current && current.roomId === update.roomId && current.version === update.version
    ? { ...current, coachAdvice: update.advice }
    : current;
}
