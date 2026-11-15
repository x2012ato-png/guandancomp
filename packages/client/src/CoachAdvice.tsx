import { cardLabel, comboLabel, rankLabel, suitLabel } from '@guandan/engine';
import type { CoachAdvice as Advice } from '@guandan/protocol';

export function CoachAdvice({ advice, dealing, myTurn }: { advice: Advice | null; dealing: boolean; myTurn: boolean }) {
  const decision = advice?.decision;
  return <section className="coach-advice" aria-label="指导出牌区" aria-live="polite">
    <h3>指导出牌区 <span>AI教练</span></h3>
    {decision ? <>
      <p className="coach-recommendation">建议：{decision.type === 'pass' ? '不要' : `${decision.play.cards.map(cardLabel).join('、')}（${comboLabel(decision.play.combo)}）`}</p>
      {decision.type === 'play' && decision.play.wildAssignments.length > 0 && <p>逢人配：{decision.play.wildAssignments.map(w => `${cardLabel(w.cardId)} → ${suitLabel(w.suit)}${rankLabel(w.rank)}`).join('、')}</p>}
      <ul>{advice!.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>
      {advice!.pending && <p>正在进一步比较其他出法…</p>}
    </> : <p>{dealing ? '发牌结束后，轮到你出牌时显示建议。' : myTurn ? '正在准备建议。' : '轮到你出牌时显示建议。'}</p>}
  </section>;
}
