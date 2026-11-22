import { createAdvancedPolicy, createBeginnerPolicy, createDanZeroPolicy, type AIPolicy } from '@guandan/ai';
import type { BotKind } from '@guandan/protocol';

const beginner = createBeginnerPolicy();
const advanced = createAdvancedPolicy({ search: false });
const danzero = createDanZeroPolicy();

/** DanZero AI 使用内置预训练深度蒙特卡洛网络，AI 教练使用高级策略，普通 AI 和真人托管使用初级策略。 */
export function automatedPolicy(slot: { readonly bot: boolean; readonly botKind: BotKind | null }): AIPolicy {
  if (slot.bot && slot.botKind === 'danzero') return danzero;
  return slot.bot && slot.botKind === 'coach' ? advanced : beginner;
}
