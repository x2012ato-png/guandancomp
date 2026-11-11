/**
 * 座位/队伍工具 + 升级（含过 A、打 A 失败）计算。纯函数。
 */
import type { Level } from './cards.ts';
import type { RulesConfig } from './config.ts';
import type { HandResult, Seat, Team } from './types.ts';

export const teamOf = (s: Seat): Team => (s % 2) as Team;
export const partnerOf = (s: Seat): Seat => ((s + 2) % 4) as Seat;
export const nextSeat = (s: Seat): Seat => ((s + 1) % 4) as Seat;

export const ACE: Level = 14;

/** 头游方升级数：对家二游 +3（双下）、三游 +2、末游 +1 */
export function upgradeAmount(finishOrder: readonly Seat[]): 1 | 2 | 3 {
  const head = finishOrder[0]!;
  const pos = finishOrder.indexOf(partnerOf(head));
  return pos === 1 ? 3 : pos === 2 ? 2 : 1;
}

export function isDoubleDown(finishOrder: readonly Seat[]): boolean {
  return teamOf(finishOrder[0]!) === teamOf(finishOrder[1]!);
}

export interface LevelInput {
  readonly handNo: number;
  readonly level: Level;
  readonly levelTeam: Team | null;
  readonly teamLevels: readonly [Level, Level];
  readonly aFails: readonly [number, number];
  readonly finishOrder: readonly Seat[];
}

/**
 * 根据一局的名次计算升级结果。
 *
 * - 过 A：本局打的是本队的 A（levelTeam === 本队 且 level === A），本队头游且升级 ≥ 2 → 整场获胜。
 * - 打 A 失败：levelTeam 正在打 A 但未过（无论输赢），失败次数 +1；达到 aFailLimit 退回 2。【待确认 R4/R5】
 * - 其他：头游方升级，封顶 A（必须实际打 A 才能过）。
 * - 下一局打头游方的级。
 */
export function computeHandResult(input: LevelInput, cfg: RulesConfig): HandResult {
  const fo = input.finishOrder;
  const winTeam = teamOf(fo[0]!);
  const upgrade = upgradeAmount(fo);
  const lt = input.levelTeam;
  const playingA = (t: Team) => lt === t && input.level === ACE;

  const levels: [Level, Level] = [input.teamLevels[0], input.teamLevels[1]];
  const aFails: [number, number] = [input.aFails[0], input.aFails[1]];
  let aResetTeam: Team | null = null;
  let matchWinner: Team | null = null;

  if (playingA(winTeam) && upgrade >= 2) {
    matchWinner = winTeam;
  } else {
    if (lt !== null && playingA(lt)) {
      aFails[lt] += 1;
      if (cfg.aFailLimit !== null && aFails[lt] >= cfg.aFailLimit) {
        levels[lt] = 2;
        aFails[lt] = 0;
        aResetTeam = lt;
      }
    }
    if (!(aResetTeam === winTeam && !cfg.upgradeAfterAReset)) {
      levels[winTeam] = Math.min(ACE, levels[winTeam] + upgrade) as Level;
    }
  }

  return {
    handNo: input.handNo,
    level: input.level,
    levelTeam: lt,
    finishOrder: [...fo],
    winTeam,
    upgrade,
    levelsBefore: [input.teamLevels[0], input.teamLevels[1]],
    levelsAfter: levels,
    aFailsAfter: aFails,
    aResetTeam,
    matchWinner,
  };
}
