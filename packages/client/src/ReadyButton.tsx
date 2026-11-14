import { useEffect, useState } from 'react';

interface ReadyButtonProps {
  ready: boolean;
  deadline: number;
  serverNow: number;
  onToggle: () => void;
}

export function ReadyButton({ ready, deadline, serverNow, onToggle }: ReadyButtonProps) {
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil((deadline - serverNow) / 1000)));

  useEffect(() => {
    const receivedAt = performance.now();
    const tick = () => setSeconds(Math.max(0, Math.ceil((deadline - serverNow - (performance.now() - receivedAt)) / 1000)));
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [deadline, serverNow]);

  return <button type="button" className="primary ready-button" aria-pressed={ready} onClick={onToggle}>
    {ready ? '已准备' : '准备'} <span className="ready-countdown">({seconds}秒)</span>
  </button>;
}
