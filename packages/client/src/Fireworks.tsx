/** A short, non-interactive celebration for the winning team. */
export function Fireworks() {
  return <div className="fireworks" aria-label="恭喜过 A 获胜！" role="status">
    {[0, 1, 2, 3, 4, 5].map(burst => <div className={`firework firework-${burst}`} key={burst} aria-hidden="true">
      {Array.from({ length: 12 }, (_, ray) => <span key={ray} style={{ '--ray': ray } as React.CSSProperties} />)}
    </div>)}
  </div>;
}
