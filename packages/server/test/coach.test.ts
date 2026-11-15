import { describe, expect, it } from 'vitest';
import { interpret, makeRules, reduce, type GameState } from '@guandan/engine';
import { createAdvancedPolicy, decisionToAction } from '@guandan/ai';
import { cards, playingState } from '../../engine/test/helpers.ts';
import { coachAdvice, shouldForcePass } from '../src/coach.ts';
import { automatedPolicy } from '../src/automation.ts';
import { toPlayerView } from '@guandan/engine';

const human = { bot: false, botKind: null } as const;
const beginner = { bot: true, botKind: 'beginner' } as const;
const coach = { bot: true, botKind: 'coach' } as const;
const seats = [human, human, coach, beginner];

function position(): GameState {
  return playingState([cards('S3 D4 C5 S6 D7 S9 DQ'), cards('S8 D8'), cards('S6 SA SK'), cards('S7 SJ')]);
}

describe('AI 教练', () => {
  it('初级 AI、教练和真人托管选择各自的策略', () => {
    expect(automatedPolicy(beginner).id).toBe('beginner');
    expect(automatedPolicy(coach).id).toBe('advanced');
    expect(automatedPolicy(human).id).toBe('beginner');
  });

  it('只在教练对家的真人出牌回合给建议，建议与高级策略一致且合法', () => {
    const state = position();
    const advice = coachAdvice(state, seats, 0);
    expect(advice).not.toBeNull();
    expect(advice!.decision).toEqual(createAdvancedPolicy().decide(toPlayerView(state, 0)));
    expect(advice!.reasons.length).toBeGreaterThanOrEqual(2);
    expect(reduce(state, decisionToAction(0, advice!.decision)).ok).toBe(true);
    expect(coachAdvice(state, seats, 1)).toBeNull();
    expect(coachAdvice(state, [human, human, beginner, coach], 0)).toBeNull();
    expect(coachAdvice(state, [beginner, human, coach, beginner], 0)).toBeNull();
    expect(coachAdvice({ ...state, phase: 'return' }, seats, 0)).toBeNull();
    expect(coachAdvice({ ...state, turn: 1 }, seats, 0)).toBeNull();
  });

  it('不因教练和对手的真实手牌改变而泄露信息', () => {
    const state = position();
    const opponent = [...state.hands[1]], coachHand = [...state.hands[2]];
    [opponent[0], coachHand[0]] = [coachHand[0]!, opponent[0]!];
    const altered: GameState = { ...state, hands: [state.hands[0], opponent, coachHand, state.hands[3]] };
    expect(coachAdvice(altered, seats, 0)).toEqual(coachAdvice(state, seats, 0));
  });

  it('没有可跟牌时等教练对家的真人阅读建议并手动选择不要', () => {
    const last = interpret(cards('BJ'), 2, makeRules())[0]!;
    const state = playingState([cards('S3 D4'), cards('S8 D8'), cards('S6 SA SK'), cards('S7 SJ')], {
      trick: { leader: 3, lastPlay: { seat: 3, play: last }, passed: [], history: [] },
    });
    expect(shouldForcePass(state, seats, 0)).toBe(false);
    expect(coachAdvice(state, seats, 0)?.decision).toEqual({ type: 'pass' });
    expect(shouldForcePass(state, [human, human, beginner, coach], 0)).toBe(true);
  });
});
