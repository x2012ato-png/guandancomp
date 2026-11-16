import { cardLabel, comboLabel, rankLabel, suitLabel } from '@guandan/engine';
import type { CoachAdvice as Advice } from '@guandan/protocol';

export function CoachAdvice({ advice, dealing, myTurn }: { advice: Advice | null; dealing: boolean; myTurn: boolean }) {
  const decision = advice?.decision;
  return <section className="coach-advice" aria-label="指导出牌区" aria-live="polite">
    <h3>指导出牌区 <span>AI教练</span></h3>
    {decision ? <>
      <p className="coach-recommendation">建议：{decision.type === 'pass' ? '不要' : `${decision.play.cards.map(cardLabel).join('、')}（${comboLabel(decision.play.combo)}）`}</p>
      {decision.type === 'play' && decision.play.wildAssignments.length > 0 && <p>逢人配：{decision.play.wildAssignments.map(w => `${cardLabel(w.cardId)} → ${suitLabel(w.suit)}${rankLabel(w.rank)}`).join('、')}</p>}
      {advice!.insights ? <div className="coach-insights">
        <p>{advice!.insights.assessment.join('；')}。</p>
        <h4>已知信息</h4>
        {advice!.insights.known.length > 0 ? <ul>{advice!.insights.known.map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>暂无可确认归属的进还贡信息。</p>}
        {advice!.insights.possibilities.length > 0 && <>
          <h4>其他人可能持有</h4>
          <p>根据未见牌、进还贡和公开出牌记录分析。未见牌可能在不同玩家手中；出牌和不要也可能出于战术考虑，不能确定当前手牌。</p>
          <ul>{advice!.insights.possibilities.map((line, index) => <li key={index}>{line}</li>)}</ul>
        </>}
        <h4>后续组牌</h4>
        <p>{advice!.insights.grouping}</p>
        {advice!.insights.scenarios.length > 0 && <>
          <h4>后续可能怎么走</h4>
          <p>以下是不同假设手牌下的多步推演；实际持牌和出法可能不同。</p>
          {advice!.insights.scenarios.map((scenario, index) => <details key={index}>
            <summary>{scenario.title}（查看假设手牌和后续出牌）</summary>
            <ul>{scenario.hands.map((hand, i) => <li key={i}>{hand}</li>)}</ul>
            <ol>{scenario.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
            <p>推演停止：{scenario.stop}。</p>
          </details>)}
        </>}
      </div> : <ul>{advice!.reasons.map((reason, index) => {
        const separator = reason.indexOf('：');
        return <li key={index}>{reason.startsWith('模拟过程示例（') && separator >= 0
          ? <details><summary>{reason.slice(0, separator)}（点击查看出牌步骤）</summary><p>{reason.slice(separator + 1)}</p></details>
          : reason}</li>;
      })}</ul>}
      {advice!.pending && <p>正在进一步比较其他出法…</p>}
    </> : <p>{dealing ? '发牌结束后，轮到你出牌时显示建议。' : myTurn ? '正在准备建议。' : '轮到你出牌时显示建议。'}</p>}
  </section>;
}
