/**
 * AI 接口。所有策略只能读取 PlayerView（与人类玩家相同的信息），保证 AI 不作弊。
 */
import type { CardId, GameAction, GameState, Play, PlayerView, Seat } from '@guandan/engine';

export type AIDecision =
  | { readonly type: 'tribute'; readonly card: CardId }
  | { readonly type: 'returnTribute'; readonly card: CardId }
  | { readonly type: 'play'; readonly play: Play }
  | { readonly type: 'pass' };

export interface DecisionContext {
  /** 随机源（MCTS 采样 / 打破平局） */
  readonly rng?: () => number;
  /** 截止时间（ms 时间戳），供搜索类策略使用 */
  readonly deadline?: number;
}

/** 策略统一接口：返回 null 表示当前无需行动 */
export interface AIPolicy {
  readonly id: string;
  decide(view: PlayerView, ctx?: DecisionContext): AIDecision | null;
}

/* ───────── 预留给 MCTS / ISMCTS 的扩展点 ───────── */

/** 信息集采样：根据玩家视图生成一个与之相容的完整状态（对手手牌随机分配） */
export interface Determinizer {
  sample(view: PlayerView, rng: () => number): GameState;
}

/** 局面评估：返回 seat 所在队伍的价值（-1..1），供截断搜索使用 */
export interface Evaluator {
  evaluate(state: GameState, seat: Seat): number;
}

export interface SearchPolicyOptions {
  readonly iterations: number;
  readonly timeBudgetMs: number;
  readonly exploration: number;
  readonly determinizer: Determinizer;
  /** 模拟（rollout）策略，通常为启发式 */
  readonly rolloutPolicy: AIPolicy;
  readonly evaluator?: Evaluator;
  /** 根节点候选动作剪枝：仅搜索启发式排名前 K 的动作 */
  readonly topK?: number;
}

export function decisionToAction(seat: Seat, d: AIDecision): GameAction {
  switch (d.type) {
    case 'tribute':
      return { type: 'tribute', seat, card: d.card };
    case 'returnTribute':
      return { type: 'returnTribute', seat, card: d.card };
    case 'pass':
      return { type: 'pass', seat };
    case 'play':
      return {
        type: 'play',
        seat,
        cards: d.play.cards,
        combo: { type: d.play.combo.type, key: d.play.combo.key, ...(d.play.combo.suit ? { suit: d.play.combo.suit } : {}) },
        wildAssignments: d.play.wildAssignments,
      };
  }
}
