import { Worker } from 'node:worker_threads';
import type { PlayerView } from '@guandan/engine';
import type { CoachAdvice } from '@guandan/protocol';

// A hard timeout also bounds startup and any individual, non-interruptible rule evaluation.
export const COACH_SEARCH_BUDGET_MS = 3000;
export const COACH_SEARCH_TIMEOUT_MS = 3800;

export function runBackgroundCoach(view: PlayerView, done: (advice: CoachAdvice | null) => void): () => void {
  let finished = false;
  let worker: Worker;
  try {
    worker = new Worker(new URL('./coachWorker.ts', import.meta.url), { workerData: { view, budgetMs: COACH_SEARCH_BUDGET_MS } });
  } catch {
    queueMicrotask(() => { if (!finished) { finished = true; done(null); } });
    return () => { finished = true; };
  }
  const finish = (advice: CoachAdvice | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    void worker.terminate();
    done(advice);
  };
  const timer = setTimeout(() => finish(null), COACH_SEARCH_TIMEOUT_MS);
  worker.once('message', (message: unknown) => {
    if (message && typeof message === 'object' && 'decision' in message && 'reasons' in message) finish(message as CoachAdvice);
    else finish(null);
  });
  worker.once('error', () => finish(null));
  worker.once('exit', () => finish(null));
  return () => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    void worker.terminate();
  };
}
