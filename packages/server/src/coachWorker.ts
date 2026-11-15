import { parentPort, workerData } from 'node:worker_threads';
import { analyzeAdvancedPlay } from '@guandan/ai';
import type { PlayerView } from '@guandan/engine';

const { view, budgetMs } = workerData as { view: PlayerView; budgetMs: number };
try {
  const advice = analyzeAdvancedPlay(view, { allPhases: true }, { deadline: Date.now() + budgetMs });
  parentPort!.postMessage(advice);
} catch (error) {
  parentPort!.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
