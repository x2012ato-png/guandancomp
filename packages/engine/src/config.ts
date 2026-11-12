import type { Seat } from './types.ts';

/**
 * 规则开关。所有标注 【待确认】 的项都是 2022 竞技规则文本存在歧义或各地执行不一的地方，
 * 默认值为当前实现采用的解释，可通过配置切换，无需改动引擎代码。
 * 详见 docs/RULES-CONFIRM.md。
 */
export interface RulesConfig {
  /** 【待确认 R1】三带二的「二」是否允许一对王（小王对/大王对）。默认允许。 */
  readonly jokerPairInFullHouse: boolean;
  /** 【待确认 R2】三带二的三张与对子能否同点（如 33333 当三带二出）。默认不允许（5 张同点只能是炸弹）。 */
  readonly fullHouseSameRank: boolean;
  /** 【待确认 R3】同花五连张能否由出牌人选择按普通顺子出。默认允许（出牌时需声明牌型）。 */
  readonly straightFlushAsStraight: boolean;
  /** 【待确认 R4】打 A 失败次数上限，达到后退回 2；null 表示不限。默认 3。 */
  readonly aFailLimit: number | null;
  /** 【待确认 R5】打 A 第 N 次失败但本局是头游（+1）时，重置为 2 后是否仍然叠加本局升级。默认不叠加。 */
  readonly upgradeAfterAReset: boolean;
  /** 还贡牌最大点数（含），默认 10。 */
  readonly returnMaxRank: number;
  /** 【待确认 R6】当级牌点数 ≤ returnMaxRank 时，级牌（非红桃）可否用于还贡。默认允许。 */
  readonly returnAllowLevelCard: boolean;
  /**
   * 【待确认 R7】双下且两张贡牌一样大时的分配：
   *  'clockwise' 每个进贡者交给自己的下家（座位 +1）；
   *  'headPicksFirstPayer' 头游拿 finishOrder 中名次靠前（三游）者的贡牌。
   */
  readonly doubleTributeTie: 'clockwise' | 'headPicksFirstPayer';
  /** 【待确认 R8】双下贡牌一样大时谁先出：'headNext' 头游的下家；'third' 三游。 */
  readonly doubleTributeTieLeader: 'headNext' | 'third';
  /** 【待确认 R9】头游与末游为同一方（升 1 级）时末游是否仍向头游进贡。默认照常进贡。 */
  readonly sameTeamTribute: boolean;
  /** 【待确认 R10】首局先出者：'random' 或固定座位。 */
  readonly firstLeader: 'random' | Seat;
  /** 【待确认 R11】还贡牌是否对其他两家公开。默认公开。 */
  readonly publicReturnCard: boolean;
}

export const DEFAULT_RULES: RulesConfig = Object.freeze({
  jokerPairInFullHouse: true,
  fullHouseSameRank: false,
  straightFlushAsStraight: true,
  aFailLimit: 3,
  upgradeAfterAReset: false,
  returnMaxRank: 10,
  returnAllowLevelCard: true,
  doubleTributeTie: 'clockwise',
  doubleTributeTieLeader: 'headNext',
  sameTeamTribute: true,
  firstLeader: 'random',
  publicReturnCard: true,
});

export function makeRules(overrides: Partial<RulesConfig> = {}): RulesConfig {
  return Object.freeze({ ...DEFAULT_RULES, ...overrides });
}
