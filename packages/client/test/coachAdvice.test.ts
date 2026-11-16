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

  it('优先展示持牌推测、分组和假设推演，不展示内部评分', () => {
    const html = renderToStaticMarkup(createElement(CoachAdvice, { advice: {
      decision: { type: 'pass' }, reasons: ['模拟平均分 1.2'],
      insights: { assessment: ['保留牌权'], known: [], possibilities: ['下家可能有大王：大王仍未见'], grouping: '对子 ♠3、♦3',
        scenarios: [{ title: '假设 1', hands: ['下家假设持有大王'], steps: ['你不要', '下家出大王'], stop: '本局结束' }] },
    }, dealing: false, myTurn: true }));
    expect(html).toContain('已知信息');
    expect(html).toContain('其他人可能持有');
    expect(html).toContain('下家可能有大王：大王仍未见');
    expect(html).not.toContain('随机抽样');
    expect(html).not.toContain('下家剩 2 张');
    expect(html).toContain('后续组牌');
    expect(html).toContain('下家假设持有大王');
    expect(html).toContain('下家出大王');
    expect(html).not.toContain('模拟平均分');
  });

  it('将模拟过程作为可展开的出牌步骤展示', () => {
    const html = renderToStaticMarkup(createElement(CoachAdvice, { advice: { decision: { type: 'pass' }, reasons: ['模拟过程示例（不要）：第 1 组假设分牌下，你不要。'] }, dealing: false, myTurn: true }));
    expect(html).toContain('<details>');
    expect(html).toContain('点击查看出牌步骤');
    expect(html).toContain('第 1 组假设分牌');
  });

  it('只接受当前牌局版本的后台建议', () => {
    const current = { roomId: '666888', version: 4, coachAdvice: null } as GameUpdate;
    const advice = { decision: { type: 'pass' as const }, reasons: ['模拟比较'] };
    expect(applyCoachAdvice(current, { roomId: '666888', version: 4, advice })?.coachAdvice).toEqual(advice);
    expect(applyCoachAdvice(current, { roomId: '666888', version: 3, advice })).toBe(current);
    expect(applyCoachAdvice(current, { roomId: 'other', version: 4, advice })).toBe(current);
  });
});
