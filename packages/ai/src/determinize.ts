/**
 * MCTS 预留：信息集采样与对局模拟工具。
 * 当前只提供确定化（determinization）与 rollout，搜索本身由后续 ISMCTS 实现接入 SearchPolicyOptions。
 */
import {
  DECK_SIZE,
  pendingActors,
  reduce,
  shuffle,
  seedRng,
  toPlayerView,
  type CardId,
  type GameState,
  type PlayerView,
  type Seat,
} from '@guandan/engine';
import { decisionToAction, type AIPolicy, type Determinizer } from './types.ts';

/**
 * 随机确定化：把「不可见的牌」按各家剩余张数随机分给对手。
 * 已知约束：进贡后贡牌在收贡者手中（若未打出），自己还出去的牌在对方手中（若未打出）。
 */
export const randomDeterminizer: Determinizer = {
  sample(view: PlayerView, rng: () => number): GameState {
    const me = view.seat;
    const visible = new Set<CardId>([...view.myHand, ...view.playedCards]);
    const known: Map<Seat, CardId[]> = new Map([[0, []], [1, []], [2, []], [3, []]] as [Seat, CardId[]][]);
    if (view.tribute && view.phase !== 'tribute') {
      for (const l of view.tribute.links) {
        if (l.to !== me && !visible.has(l.card) && !(l.from === me && l.returnCard === l.card)) {
          known.get(l.to)!.push(l.card);
          visible.add(l.card);
        }
        if (l.returnCard !== null && l.from !== me && !visible.has(l.returnCard)) {
          known.get(l.from)!.push(l.returnCard);
          visible.add(l.returnCard);
        }
      }
    }
    if (view.tribute && view.phase === 'tribute') for (const p of view.tribute.paid) visible.add(p.card);
    const unknown = Array.from({ length: DECK_SIZE }, (_, i) => i).filter((id) => !visible.has(id));
    const [shuffled] = shuffle(unknown, seedRng(Math.floor(rng() * 2 ** 32)));
    const hands: CardId[][] = [[], [], [], []];
    let cursor = 0;
    for (const s of [0, 1, 2, 3] as Seat[]) {
      if (s === me) {
        hands[s] = [...view.myHand];
        continue;
      }
      const k = known.get(s)!.slice(0, view.handCounts[s]);
      const need = view.handCounts[s]! - k.length;
      hands[s] = [...k, ...shuffled.slice(cursor, cursor + need)];
      cursor += need;
    }
    return {
      config: view.config,
      rng: seedRng(Math.floor(rng() * 2 ** 32)),
      phase: view.phase,
      handNo: view.handNo,
      teamLevels: view.teamLevels,
      aFails: view.aFails,
      level: view.level,
      levelTeam: view.levelTeam,
      hands: hands as unknown as GameState['hands'],
      turn: view.turn,
      trick: view.trick,
      previousTrick: view.previousTrick ?? null,
      publicHistory: [...(view.publicHistory ?? [])],
      finishOrder: view.finishOrder,
      playedCards: view.playedCards,
      tribute: view.tribute
        ? {
            kind: view.tribute.kind,
            payers: view.tribute.payers,
            receivers: view.tribute.receivers,
            paid: view.tribute.paid,
            links: view.tribute.links.map((l) => ({ from: l.from, to: l.to, card: l.card, returnCard: l.returned ? (l.returnCard ?? -1) : null })),
          }
        : null,
      antiTribute: view.antiTribute,
      lastResult: view.lastResult,
      matchWinner: view.matchWinner,
    };
  },
};

/** 用给定策略把一局打到结束（或步数上限），返回最终状态。供 rollout 与离线评测使用。 */
export function rollout(state: GameState, policies: readonly AIPolicy[], maxSteps = 2000): GameState {
  let s = state;
  for (let i = 0; i < maxSteps; i++) {
    if (s.phase !== 'playing' && s.phase !== 'tribute' && s.phase !== 'return') return s;
    const actor = pendingActors(s)[0];
    if (actor === undefined) return s;
    const d = policies[actor]!.decide(toPlayerView(s, actor));
    if (!d) return s;
    const r = reduce(s, decisionToAction(actor, d));
    if (!r.ok) throw new Error(`rollout: policy produced illegal action: ${r.error.message}`);
    s = r.state;
  }
  return s;
}
