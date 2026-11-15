import { createAdvancedPolicy, createBeginnerPolicy, type AIPolicy } from '@guandan/ai';
import type { BotKind } from '@guandan/protocol';

const beginner = createBeginnerPolicy();
const advanced = createAdvancedPolicy({ search: false });

/** 只有 AI 教练使用高级策略，普通 AI 和真人托管使用初级策略。 */
export function automatedPolicy(slot: { readonly bot: boolean; readonly botKind: BotKind | null }): AIPolicy {
  return slot.bot && slot.botKind === 'coach' ? advanced : beginner;
}
