import { describe, expect, it } from 'vitest';
import { makeRandom, reduce, toPlayerView } from '@guandan/engine';
import { analyzeAdvancedPlay } from '../src/advanced.ts';
import { cards, playingState } from '../../engine/test/helpers.ts';

describe('教练策略解释', () => {
  it('解释残局候选牌的拆分、逢人配代价和对手余牌的影响', () => {
    const state = playingState([cards('S3 D4 C5 S6 H2 BJ'), cards('S9'), cards('S8 C8 D8'), cards('D9 D10 DJ')]);
    const result = analyzeAdvancedPlay(toPlayerView(state, 0), { search: false })!;
    const explanation = result.reasons.join('\n');
    expect(explanation).toContain('余牌估计');
    expect(explanation).toContain('对比');
    expect(explanation).toContain('使用逢人配');
    expect(explanation).toContain('对手仅剩 1 张');
    expect(explanation).toContain('未知单牌也可能在队友手中');
    expect(explanation).not.toMatch(/本次出 \d+ 张/);
    expect(explanation).not.toContain('对手当前分别剩');
  });

  it('首出和跟牌分别展示真实代价及拦截条件', () => {
    const lead = playingState([cards('S3 D4 C5 S6 D7 S9 D9 SQ DK'), cards('SA S8'), cards('S8 C8 D8'), cards('D9 D10 DJ')]);
    const leadText = analyzeAdvancedPlay(toPlayerView(lead, 0), { search: false })!.reasons.join('\n');
    expect(leadText).toContain('首出比较代价');
    expect(leadText).toContain('余牌结构变化');
    expect(leadText).toContain('拆炸');
    const state = playingState([cards('SA S3 S4'), cards('S9 D9 C9 H9 S3 D4 S6 SQ'), cards('C6 DK D2 C2 S8 D8 C8'), cards('S7 SJ')]);
    const played = reduce(state, { type: 'play', seat: 0, cards: cards('SA') });
    if (!played.ok) throw new Error('Setup play rejected');
    const followText = analyzeAdvancedPlay(toPlayerView(played.state, 1), { search: false })!.reasons.join('\n');
    expect(followText).toContain('触发拦截');
    expect(followText).toContain('最便宜炸弹');
    expect(followText).toContain('炸弹等级');
    expect(followText).toContain('符合用炸条件');
  });

  it('模拟展示每个候选行动的平均分和评分方法', () => {
    const hands: [number[], number[], number[], number[]] = [cards('S3 D3 SA'), cards('S5'), cards('S6'), cards('S7')];
    const remaining = new Set(hands.flat());
    const state = playingState(hands, { playedCards: Array.from({ length: 108 }, (_, id) => id).filter(id => !remaining.has(id)) });
    const text = analyzeAdvancedPlay(toPlayerView(state, 0), {}, { rng: makeRandom('coach-simulation') })!.reasons.join('\n');
    expect(text).toContain('残局模拟比较了');
    expect(text).toContain('样本：');
    expect(text).toContain('分数越高越优');
    expect(text).toContain('出牌权');
  });
});
