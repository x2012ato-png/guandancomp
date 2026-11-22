import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RULES,
  beats,
  bombTier,
  generatePlays,
  interpret,
  makeRules,
  resolvePlay,
  signatureOf,
  validatePlay,
  makeRandom,
  shuffle,
  seedRng,
  makeDeck,
  isWild,
  type Combo,
  type Level,
  type Play,
} from '../src/index.ts';
import { cards } from './helpers.ts';

const cfg = DEFAULT_RULES;
const sigs = (plays: Play[]) => plays.map((p) => signatureOf(p.combo)).sort();
const one = (spec: string, level: Level = 2) => {
  const r = interpret(cards(spec), level, cfg);
  expect(r).toHaveLength(1);
  return r[0]!;
};

describe('基础牌型识别', () => {
  it('单张、对子、三张，级牌与王的大小', () => {
    expect(one('S3').combo).toEqual({ type: 'single', key: 3, size: 1 });
    expect(one('S7', 7).combo.key).toBe(15); // 级牌高于 A
    expect(one('SA', 7).combo.key).toBe(14);
    expect(one('SJ').combo.key).toBe(16);
    expect(one('BJ').combo.key).toBe(17);
    expect(one('S9 D9').combo).toEqual({ type: 'pair', key: 9, size: 2 });
    expect(one('SJ SJ').combo).toEqual({ type: 'pair', key: 16, size: 2 });
    expect(interpret(cards('SJ BJ'), 2, cfg)).toEqual([]); // 大小王不成对
    expect(one('SK HK CK').combo).toEqual({ type: 'triple', key: 13, size: 3 });
  });

  it('4–8 张炸弹与天王炸', () => {
    for (let n = 4; n <= 8; n++) {
      const spec = ['S8', 'H8', 'C8', 'D8', 'S8', 'H8', 'C8', 'D8'].slice(0, n).join(' ');
      expect(one(spec).combo).toEqual({ type: 'bomb', key: 8, size: n });
    }
    expect(one('SJ SJ BJ BJ').combo.type).toBe('jokerBomb');
    expect(interpret(cards('SJ SJ BJ'), 2, cfg)).toEqual([]);
  });

  it('顺子：恰好 5 张，A 可作 1 或 14，不能绕圈', () => {
    expect(one('SA D2 C3 H4 S5').combo).toEqual({ type: 'straight', key: 5, size: 5 });
    expect(one('S10 DJ CQ HK SA').combo).toEqual({ type: 'straight', key: 14, size: 5 });
    expect(interpret(cards('SQ DK CA H2 S3'), 2, cfg)).toEqual([]);
    expect(interpret(cards('S3 D4 C5 H6'), 2, cfg)).toEqual([]);
    expect(interpret(cards('S3 D4 C5 H6 S7 D8'), 2, cfg).some((p) => p.combo.type === 'straight')).toBe(false);
  });

  it('【R13 级牌在顺子中按自然点数】打 5 时 3-4-5-6-7 合法、key=7', () => {
    expect(one('S3 D4 C5 S6 S7', 5).combo).toEqual({ type: 'straight', key: 7, size: 5 });
  });

  it('三连对与钢板，A 可低可高', () => {
    expect(one('SA DA S2 D2 S3 D3').combo).toEqual({ type: 'tube', key: 3, size: 6 });
    expect(one('SQ DQ SK DK SA DA').combo).toEqual({ type: 'tube', key: 14, size: 6 });
    expect(interpret(cards('SK DK SA DA S2 D2'), 3, cfg)).toEqual([]);
    expect(one('SA DA CA S2 D2 C2', 5).combo).toEqual({ type: 'plate', key: 2, size: 6 });
    expect(one('SK DK CK SA DA CA', 5).combo).toEqual({ type: 'plate', key: 14, size: 6 });
  });

  it('三带二以三张比较；王对可作带牌（R1）；三张与对子不能同点（R2）', () => {
    expect(one('S9 D9 C9 S4 D4').combo).toEqual({ type: 'fullHouse', key: 9, size: 5 });
    expect(one('S9 D9 C9 BJ BJ').combo.type).toBe('fullHouse');
    expect(interpret(cards('S9 D9 C9 BJ BJ'), 2, makeRules({ jokerPairInFullHouse: false }))).toEqual([]);
    const five = interpret(cards('S9 D9 C9 H9 S9'), 2, cfg);
    expect(sigs(five)).toEqual(['bomb:9:5:']);
    const five2 = interpret(cards('S9 D9 C9 H9 S9'), 2, makeRules({ fullHouseSameRank: true }));
    expect(sigs(five2)).toEqual(['bomb:9:5:', 'fullHouse:9:5:']);
  });

  it('同花顺；默认不可当普通顺子（R3）', () => {
    const r = interpret(cards('S5 S6 S7 S8 S9'), 2, cfg);
    expect(sigs(r)).toEqual(['straightFlush:9:5:S']);
    const loose = interpret(cards('S5 S6 S7 S8 S9'), 2, makeRules({ straightFlushAsStraight: true }));
    expect(sigs(loose)).toEqual(['straight:9:5:', 'straightFlush:9:5:S']);
  });
});

describe('逢人配（红桃级牌）', () => {
  const L: Level = 7; // H7 为逢人配
  it('单张逢人配就是级牌，两张逢人配为一对级牌', () => {
    expect(interpret(cards('H7'), L, cfg).map((p) => p.combo)).toEqual([{ type: 'single', key: 15, size: 1 }]);
    expect(interpret(cards('H7 H7'), L, cfg).map((p) => p.combo)).toEqual([{ type: 'pair', key: 15, size: 2 }]);
  });

  it('补对子 / 三张 / 炸弹，并显式给出 wildAssignments', () => {
    const p = one('S3 H7', L);
    expect(p.combo).toEqual({ type: 'pair', key: 3, size: 2 });
    expect(p.wildAssignments).toEqual([{ cardId: cards('H7')[0], rank: 3, suit: 'H' }]);
    expect(one('SK DK CK H7', L).combo).toEqual({ type: 'bomb', key: 13, size: 4 });
  });

  it('不能代替王', () => {
    expect(interpret(cards('BJ H7'), L, cfg)).toEqual([]);
    expect(interpret(cards('SJ SJ BJ H7'), L, cfg)).toEqual([]);
  });

  it('三带二的多种逢人配方案都会列出', () => {
    const r = interpret(cards('S3 D3 S9 H7 H7'), L, cfg);
    expect(sigs(r)).toEqual(['fullHouse:3:5:', 'fullHouse:9:5:']);
    const r2 = interpret(cards('S3 D3 C3 H7 H7'), L, cfg);
    expect(sigs(r2)).toEqual(['bomb:3:5:', 'fullHouse:3:5:']);
    // 333 + 两张逢人配作带牌时，优先解释为它们代表自身（一对级牌）
    const fh = r2.find((p) => p.combo.type === 'fullHouse')!;
    expect(fh.wildAssignments.every((a) => a.rank === 7)).toBe(true);
  });

  it('顺子缺口填补；同一组牌可能有多种顺子（逢人配 rank 选择）', () => {
    const r = interpret(cards('S3 D4 C5 S6 H7'), L, cfg);
    // 逢人配可作 2（23456）或 7（34567，代表自身）
    expect(sigs(r)).toEqual(['straight:6:5:', 'straight:7:5:']);
    const sf = interpret(cards('S9 S10 SQ SK H7'), L, cfg);
    expect(sigs(sf)).toEqual(['straight:13:5:', 'straightFlush:13:5:S']);
    const flush = sf.find((p) => p.combo.type === 'straightFlush')!;
    expect(flush.wildAssignments[0]).toMatchObject({ rank: 11, suit: 'S' });
  });

  it('连对/钢板中补缺', () => {
    expect(one('S3 D3 S4 S5 D5 H7', L).combo).toEqual({ type: 'tube', key: 5, size: 6 });
    expect(one('SQ DQ CQ SK DK H7', L).combo).toEqual({ type: 'plate', key: 13, size: 6 });
  });
});

describe('比较', () => {
  const c = (type: Combo['type'], key: number, size: number): Combo => ({ type, key, size });
  it('炸弹等级：4 < 5 < 同花顺 < 6 < 7 < 8 < 9 < 10 < 天王炸', () => {
    const order = [c('bomb', 14, 4), c('bomb', 3, 5), c('straightFlush', 6, 5), c('bomb', 3, 6), c('bomb', 3, 7), c('bomb', 3, 8), c('bomb', 3, 9), c('bomb', 3, 10), c('jokerBomb', 17, 4)];
    expect(order.map(bombTier)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (let i = 0; i < order.length; i++)
      for (let j = 0; j < order.length; j++) expect(beats(order[i]!, order[j]!)).toBe(i > j);
  });
  it('同级炸弹比点数，级牌炸弹大于 A 炸弹', () => {
    expect(beats(c('bomb', 15, 4), c('bomb', 14, 4))).toBe(true);
    expect(beats(c('straightFlush', 10, 5), c('straightFlush', 9, 5))).toBe(true);
    expect(beats(c('bomb', 9, 4), c('bomb', 9, 4))).toBe(false);
  });
  it('非炸弹只能同型同张数比较；炸弹压一切非炸弹', () => {
    expect(beats(c('pair', 5, 2), c('single', 3, 1))).toBe(false);
    expect(beats(c('straight', 7, 5), c('straight', 6, 5))).toBe(true);
    expect(beats(c('fullHouse', 3, 5), c('straight', 14, 5))).toBe(false);
    expect(beats(c('bomb', 2, 4), c('plate', 14, 6))).toBe(true);
    expect(beats(c('plate', 14, 6), c('bomb', 2, 4))).toBe(false);
  });
});

describe('校验与解析', () => {
  it('interpret 的每个结果都通过 validatePlay', () => {
    const specs = ['S3 D3 S9 H7 H7', 'S9 S10 SQ SK H7', 'S3 D3 S4 S5 D5 H7', 'H7 H7', 'SK DK CK H7'];
    for (const s of specs) for (const p of interpret(cards(s), 7, cfg)) expect(validatePlay(p, 7, cfg)).toBeNull();
  });
  it('拒绝非法替换', () => {
    const [w] = cards('H7');
    const base = cards('S3');
    const pair = { cards: [base[0]!, w!], combo: { type: 'pair' as const, key: 3, size: 2 } };
    expect(validatePlay({ ...pair, wildAssignments: [{ cardId: w!, rank: 4, suit: 'H' }] }, 7, cfg)?.code).toBe('INVALID_COMBO');
    expect(validatePlay({ ...pair, wildAssignments: [] }, 7, cfg)?.code).toBe('BAD_WILD_ASSIGNMENT');
    expect(validatePlay({ ...pair, wildAssignments: [{ cardId: base[0]!, rank: 3, suit: 'H' }] }, 7, cfg)?.code).toBe('BAD_WILD_ASSIGNMENT');
    expect(validatePlay({ ...pair, wildAssignments: [{ cardId: w!, rank: 16 as never, suit: 'H' }] }, 7, cfg)?.code).toBe('BAD_WILD_ASSIGNMENT');
  });
  it('resolvePlay：歧义需声明，或由 toBeat 消歧', () => {
    const ids = cards('S3 D4 C5 S6 H7');
    expect(resolvePlay(ids, 7, cfg)).toMatchObject({ ok: false, error: { code: 'AMBIGUOUS_COMBO' } });
    const r = resolvePlay(ids, 7, cfg, { toBeat: { type: 'straight', key: 6, size: 5 } });
    expect(r.ok && r.play.combo.key).toBe(7);
    const d = resolvePlay(ids, 7, cfg, { combo: { type: 'straight', key: 6 } });
    expect(d.ok && d.play.wildAssignments[0]!.rank).toBe(2);
  });
});

describe('合法出牌生成', () => {
  it('压牌时只返回能压过的牌（含炸弹）', () => {
    const hand = cards('S3 D3 S9 D9 SK DK CK HK SA');
    const plays = generatePlays(hand, 2, cfg, { type: 'pair', key: 9, size: 2 });
    expect(sigs(plays)).toEqual(['bomb:13:4:', 'pair:13:2:']);
  });

  it('与「枚举所有子集 + interpret」结果完全一致（交叉验证）', () => {
    const rand = makeRandom('gen-cross');
    for (let trial = 0; trial < 25; trial++) {
      const level = (2 + Math.floor(rand() * 13)) as Level;
      const [deck] = shuffle(makeDeck(), seedRng(trial * 7919 + 1));
      const wild = deck.filter((id) => isWild(id, level)).slice(0, 1 + (trial % 2));
      const hand = [...wild, ...deck.filter((id) => !isWild(id, level)).slice(0, 11 - wild.length)];
      const expected = new Set<string>();
      const n = hand.length;
      for (let mask = 1; mask < 1 << n; mask++) {
        const sub = hand.filter((_, i) => mask & (1 << i));
        if (sub.length > 8) continue;
        for (const p of interpret(sub, level, cfg)) expected.add(signatureOf(p.combo));
      }
      const generated = generatePlays(hand, level, cfg);
      for (const p of generated) {
        expect(validatePlay(p, level, cfg)).toBeNull();
        expect(p.cards.every((id) => hand.includes(id))).toBe(true);
      }
      expect(new Set(generated.map((p) => signatureOf(p.combo)))).toEqual(expected);
    }
  });
});
