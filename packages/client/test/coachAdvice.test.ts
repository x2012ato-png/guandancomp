import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { interpret, makeRules } from '@guandan/engine';
import { cards } from '../../engine/test/helpers.ts';
import { CoachAdvice } from '../src/CoachAdvice.tsx';
import { applyCoachAdvice } from '../src/coachAdviceState.ts';
import type { GameUpdate } from '@guandan/protocol';

describe('指导出牌区', () => {
  it('shows the suggested cards, wild assignment and reasons', () => {
    const play = interpret(cards('S3 D4 C5 S6 H2'), 2, makeRules()).find(p => p.combo.type === 'straight')!;
    const html = renderToStaticMarkup(createElement(CoachAdvice, { advice: { decision: {type:'play', play}, reasons: ['保留余牌', '注意对手'] }, dealing:false, myTurn:true }));
    expect(html).toContain('指导出牌区');
    expect(html).toContain('♠3');
    expect(html).toContain('逢人配');
    expect(html).toContain('保留余牌');
    expect(html).toContain('注意对手');
  });

  it('shows pass advice and waiting state', () => {
    expect(renderToStaticMarkup(createElement(CoachAdvice, { advice: { decision: {type:'pass'}, reasons: ['队友正在领先'] }, dealing:false, myTurn:true }))).toContain('建议：不要');
    expect(renderToStaticMarkup(createElement(CoachAdvice, { advice:null, dealing:false, myTurn:false }))).toContain('轮到你出牌时显示建议');
  });

  it('只接受当前牌局版本的后台建议', () => {
    const current = { roomId: '666888', version: 4, coachAdvice: null } as GameUpdate;
    const advice = { decision: { type: 'pass' as const }, reasons: ['模拟比较'] };
    expect(applyCoachAdvice(current, { roomId: '666888', version: 4, advice })?.coachAdvice).toEqual(advice);
    expect(applyCoachAdvice(current, { roomId: '666888', version: 3, advice })).toBe(current);
    expect(applyCoachAdvice(current, { roomId: 'other', version: 4, advice })).toBe(current);
  });
});
