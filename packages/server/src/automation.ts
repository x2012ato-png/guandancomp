import { createAdvancedPolicy, createBeginnerPolicy, createDanZeroPolicy, type AIPolicy } from '@guandan/ai';
import type { BotKind } from '@guandan/protocol';

const beginner = createBeginnerPolicy();
const advanced = createAdvancedPolicy({ search: false });
const danzero = createDanZeroPolicy({ deep: false });
const danzeroDeep = createDanZeroPolicy({ deep: true, samples: 6, topK: 4 });

/**
 * - `danzero`: DanZero 快速版（0 层直觉网络）
 * - `danzero-deep`: DanZero 深度搜索版（神经网络 Top-K 初筛 + 多世界深度推演）
 * - `coach`: AI 教练（口诀高级策略）
 * - `beginner` / 真人托管: 初级策略
 */
export function automatedPolicy(slot: { readonly bot: boolean; readonly botKind: BotKind | null }): AIPolicy {
  if (slot.bot && slot.botKind === 'danzero-deep') return danzeroDeep;
  if (slot.bot && slot.botKind === 'danzero') return danzero;
  return slot.bot && slot.botKind === 'coach' ? advanced : beginner;
}
