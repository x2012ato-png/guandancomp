/**
 * 牌型识别、逢人配替换、比较与合法出牌生成（全部为纯函数）。
 *
 * 核心思想：每一种「目标牌型」都表达为一个模板 Template = 若干 Group（点数, 张数, 可选花色）。
 *  - interpret(cards)：把选中的牌（自然牌 + 逢人配）匹配到所有模板，得到全部合法解释，
 *    每个解释都显式给出 wildAssignments。
 *  - validatePlay(play)：把 wildAssignments 代入后，用「0 张逢人配」再次匹配模板做独立校验。
 *  - generatePlays(hand)：反向使用同一组模板，从手牌中挑出最少逢人配的具体牌。
 * 三者共享模板，保证识别、校验与生成的一致性（测试中交叉验证）。
 */
import {
  BIG_JOKER,
  NATURAL_RANKS,
  SMALL_JOKER,
  SUITS,
  cardOf,
  isJokerRank,
  isWild,
  rankPower,
  type CardId,
  type Level,
  type NaturalRank,
  type Rank,
  type Suit,
  type CardSuit,
} from './cards.ts';
import type { RulesConfig } from './config.ts';
import type { Combo, ComboSignature, ComboType, Play, RuleError, WildAssignment } from './types.ts';

/* ───────────────────────── 比较 ───────────────────────── */

/** 炸弹等级：4炸 < 5炸 < 同花顺 < 6炸 < 7炸 < 8炸 < 9炸 < 10炸 < 天王炸；非炸弹为 0 */
export function bombTier(c: Combo): number {
  switch (c.type) {
    case 'bomb':
      // 4→1, 5→2, (同花顺=3), 6→4, 7→5, 8→6, 9→7, 10→8
      return c.size <= 5 ? c.size - 3 : c.size - 2;
    case 'straightFlush':
      return 3;
    case 'jokerBomb':
      return 9;
    default:
      return 0;
  }
}

export function isBomb(c: Combo): boolean {
  return bombTier(c) > 0;
}

/** a 能否压过 b */
export function beats(a: Combo, b: Combo): boolean {
  const ta = bombTier(a);
  const tb = bombTier(b);
  if (ta > 0 || tb > 0) {
    if (ta !== tb) return ta > tb;
    return a.key > b.key;
  }
  if (a.type !== b.type || a.size !== b.size) return false;
  return a.key > b.key;
}

export function signatureOf(c: Combo): string {
  return `${c.type}:${c.key}:${c.size}:${c.suit ?? ''}`;
}

export function sameCombo(a: ComboSignature & { size?: number }, b: Combo): boolean {
  return a.type === b.type && a.key === b.key && (a.suit ?? undefined) === (b.suit ?? undefined) && (a.size === undefined || a.size === b.size);
}

/* ───────────────────────── 模板 ───────────────────────── */

interface Group {
  readonly rank: Rank;
  readonly count: number;
  readonly suit?: Suit;
  /** 该组全部由逢人配组成是否允许（同点组仅当点数=级牌时允许，即两张逢人配就是一对级牌） */
  readonly wildOnlyOk: boolean;
}

interface Template {
  readonly combo: Combo;
  readonly groups: readonly Group[];
}

const SEQ_TYPES: Record<'straight' | 'tube' | 'plate', { len: number; width: number }> = {
  straight: { len: 5, width: 1 },
  tube: { len: 3, width: 2 },
  plate: { len: 2, width: 3 },
};

/** 连续窗口：start=1 表示 A 作 1；返回窗口中各点数（A 统一用 14 表示）与最高张键值 */
function seqWindows(len: number): { ranks: NaturalRank[]; key: number }[] {
  const out: { ranks: NaturalRank[]; key: number }[] = [];
  for (let start = 1; start + len - 1 <= 14; start++) {
    const ranks: NaturalRank[] = [];
    for (let r = start; r < start + len; r++) ranks.push((r === 1 ? 14 : r) as NaturalRank);
    out.push({ ranks, key: start + len - 1 });
  }
  return out;
}

const templateCache = new Map<string, readonly Template[]>();

function cfgKey(cfg: RulesConfig): string {
  return `${cfg.jokerPairInFullHouse ? 1 : 0}${cfg.fullHouseSameRank ? 1 : 0}`;
}

function sameRankTemplate(rank: Rank, count: number, level: Level): Template {
  const type: ComboType = count === 1 ? 'single' : count === 2 ? 'pair' : count === 3 ? 'triple' : 'bomb';
  return {
    combo: { type, key: rankPower(rank, level), size: count },
    groups: [{ rank, count, wildOnlyOk: rank === level }],
  };
}

function buildTemplates(size: number, level: Level, cfg: RulesConfig): readonly Template[] {
  const t: Template[] = [];
  if (size >= 1 && size <= 10) {
    for (const r of NATURAL_RANKS) t.push(sameRankTemplate(r, size, level));
    if (size <= 2) {
      t.push(sameRankTemplate(SMALL_JOKER, size, level));
      t.push(sameRankTemplate(BIG_JOKER, size, level));
    }
  }
  if (size === 4) {
    t.push({
      combo: { type: 'jokerBomb', key: BIG_JOKER, size: 4 },
      groups: [
        { rank: SMALL_JOKER, count: 2, wildOnlyOk: false },
        { rank: BIG_JOKER, count: 2, wildOnlyOk: false },
      ],
    });
  }
  if (size === 5) {
    const pairRanks: Rank[] = [...NATURAL_RANKS];
    if (cfg.jokerPairInFullHouse) pairRanks.push(SMALL_JOKER, BIG_JOKER);
    for (const tr of NATURAL_RANKS) {
      for (const pr of pairRanks) {
        if (pr === tr && !cfg.fullHouseSameRank) continue;
        t.push({
          combo: { type: 'fullHouse', key: rankPower(tr, level), size: 5 },
          groups: [
            { rank: tr, count: 3, wildOnlyOk: tr === level },
            { rank: pr, count: 2, wildOnlyOk: pr === level },
          ],
        });
      }
    }
    for (const w of seqWindows(5)) {
      t.push({
        combo: { type: 'straight', key: w.key, size: 5 },
        groups: w.ranks.map((rank) => ({ rank, count: 1, wildOnlyOk: true })),
      });
      for (const suit of SUITS) {
        t.push({
          combo: { type: 'straightFlush', key: w.key, size: 5, suit },
          groups: w.ranks.map((rank) => ({ rank, count: 1, suit, wildOnlyOk: true })),
        });
      }
    }
  }
  if (size === 6) {
    for (const type of ['tube', 'plate'] as const) {
      const { len, width } = SEQ_TYPES[type];
      for (const w of seqWindows(len)) {
        t.push({
          combo: { type, key: w.key, size: 6 },
          groups: w.ranks.map((rank) => ({ rank, count: width, wildOnlyOk: true })),
        });
      }
    }
  }
  return Object.freeze(t);
}

function templatesFor(size: number, level: Level, cfg: RulesConfig): readonly Template[] {
  const k = `${size}|${level}|${cfgKey(cfg)}`;
  let t = templateCache.get(k);
  if (!t) {
    t = buildTemplates(size, level, cfg);
    templateCache.set(k, t);
  }
  return t;
}

/* ───────────────────────── 识别（interpret） ───────────────────────── */

interface ConcreteCard {
  readonly rank: Rank;
  readonly suit: CardSuit;
}

/**
 * 把自然牌匹配进模板，返回每组剩余缺口（需要逢人配填补的数量）；不匹配返回 null。
 */
function fitNaturals(tpl: Template, naturals: readonly ConcreteCard[], wildCount: number): number[] | null {
  const need = tpl.groups.map((g) => g.count);
  for (const c of naturals) {
    let placed = false;
    for (let i = 0; i < tpl.groups.length; i++) {
      const g = tpl.groups[i]!;
      if (need[i]! > 0 && g.rank === c.rank && (g.suit === undefined || g.suit === c.suit)) {
        need[i]!--;
        placed = true;
        break;
      }
    }
    if (!placed) return null;
  }
  let deficit = 0;
  for (let i = 0; i < tpl.groups.length; i++) {
    const g = tpl.groups[i]!;
    const d = need[i]!;
    if (d === 0) continue;
    if (isJokerRank(g.rank)) return null; // 逢人配不能代替王
    if (d === g.count && !g.wildOnlyOk) return null;
    deficit += d;
  }
  return deficit === wildCount ? need : null;
}

function allSameSuit(cards: readonly ConcreteCard[]): boolean {
  return cards.length > 0 && cards.every((c) => c.suit === cards[0]!.suit);
}

function identityCount(play: Play, level: Level): number {
  return play.wildAssignments.filter((a) => a.rank === level && a.suit === 'H').length;
}

/**
 * 列出一组牌的全部合法解释（按牌型签名去重，每种签名优先保留「逢人配代表自身」最多的方案）。
 * 例如 [3,3,7,逢人配,逢人配] → 三带二(333+77) 与 三带二(777+33) 两种解释。
 */
export function interpret(cardIds: readonly CardId[], level: Level, cfg: RulesConfig): Play[] {
  const n = cardIds.length;
  if (n === 0 || n > 10 || new Set(cardIds).size !== n) return [];
  const wilds = cardIds.filter((id) => isWild(id, level)).sort((a, b) => a - b);
  const naturalIds = cardIds.filter((id) => !isWild(id, level));
  const naturals = naturalIds.map(cardOf);
  const bySig = new Map<string, Play>();

  for (const tpl of templatesFor(n, level, cfg)) {
    const need = fitNaturals(tpl, naturals, wilds.length);
    if (!need) continue;
    const assignments: WildAssignment[] = [];
    let wi = 0;
    tpl.groups.forEach((g, i) => {
      for (let k = 0; k < need[i]!; k++) {
        assignments.push({ cardId: wilds[wi++]!, rank: g.rank as NaturalRank, suit: g.suit ?? 'H' });
      }
    });
    if (tpl.combo.type === 'straight' && !cfg.straightFlushAsStraight) {
      const concrete: ConcreteCard[] = [...naturals, ...assignments.map((a) => ({ rank: a.rank, suit: a.suit }))];
      if (allSameSuit(concrete)) continue;
    }
    const play: Play = { cards: [...cardIds], combo: tpl.combo, wildAssignments: assignments };
    const sig = signatureOf(tpl.combo);
    const prev = bySig.get(sig);
    if (!prev || identityCount(play, level) > identityCount(prev, level)) bySig.set(sig, play);
  }
  return sortPlays([...bySig.values()]);
}

/** 独立校验一手出牌（含客户端自带的 wildAssignments） */
export function validatePlay(play: Play, level: Level, cfg: RulesConfig): RuleError | null {
  const ids = play.cards;
  if (ids.length === 0 || ids.length > 10) return { code: 'INVALID_COMBO', message: '牌数不合法' };
  if (new Set(ids).size !== ids.length) return { code: 'DUPLICATE_CARD', message: '重复的牌' };
  if (play.combo.size !== ids.length) return { code: 'INVALID_COMBO', message: '牌型张数不符' };
  const wilds = new Set(ids.filter((id) => isWild(id, level)));
  const assigned = new Map<CardId, WildAssignment>();
  for (const a of play.wildAssignments) {
    if (!wilds.has(a.cardId) || assigned.has(a.cardId)) {
      return { code: 'BAD_WILD_ASSIGNMENT', message: `逢人配替换指向了非逢人配牌 ${a.cardId}` };
    }
    if (!NATURAL_RANKS.includes(a.rank) || !SUITS.includes(a.suit)) {
      return { code: 'BAD_WILD_ASSIGNMENT', message: '逢人配只能代替非王的牌' };
    }
    assigned.set(a.cardId, a);
  }
  if (assigned.size !== wilds.size) return { code: 'BAD_WILD_ASSIGNMENT', message: '每张逢人配都必须给出替换' };
  const concrete: ConcreteCard[] = ids.map((id) => {
    const a = assigned.get(id);
    return a ? { rank: a.rank, suit: a.suit } : cardOf(id);
  });
  const ok = templatesFor(ids.length, level, cfg).some(
    (tpl) =>
      signatureOf(tpl.combo) === signatureOf(play.combo) &&
      fitNaturals(tpl, concrete, 0) !== null &&
      !(tpl.combo.type === 'straight' && !cfg.straightFlushAsStraight && allSameSuit(concrete)),
  );
  return ok ? null : { code: 'INVALID_COMBO', message: '替换后不构成所声明的牌型' };
}

/**
 * 将客户端的选牌解析为唯一的一手牌：
 *  - 给了 wildAssignments：按声明独立校验；
 *  - 给了 combo：在 interpret 结果中按签名匹配；
 *  - 都没给：若只有一种（能压过 toBeat 的）解释则采用，否则报 AMBIGUOUS_COMBO。
 */
export function resolvePlay(
  cardIds: readonly CardId[],
  level: Level,
  cfg: RulesConfig,
  opts: { combo?: ComboSignature; wildAssignments?: readonly WildAssignment[]; toBeat?: Combo | null } = {},
): { ok: true; play: Play } | { ok: false; error: RuleError } {
  if (opts.wildAssignments && opts.combo) {
    const play: Play = {
      cards: [...cardIds],
      combo: { type: opts.combo.type, key: opts.combo.key, size: cardIds.length, ...(opts.combo.suit ? { suit: opts.combo.suit } : {}) },
      wildAssignments: [...opts.wildAssignments],
    };
    const err = validatePlay(play, level, cfg);
    return err ? { ok: false, error: err } : { ok: true, play };
  }
  const plays = interpret(cardIds, level, cfg);
  if (plays.length === 0) return { ok: false, error: { code: 'INVALID_COMBO', message: '不是合法牌型' } };
  if (opts.combo) {
    const sig = opts.combo;
    const p = plays.find((x) => sameCombo(sig, x.combo));
    return p ? { ok: true, play: p } : { ok: false, error: { code: 'INVALID_COMBO', message: '所选牌不能组成声明的牌型' } };
  }
  const toBeat = opts.toBeat;
  const candidates = toBeat ? plays.filter((p) => beats(p.combo, toBeat)) : plays;
  if (candidates.length === 1) return { ok: true, play: candidates[0]! };
  if (candidates.length === 0) return { ok: false, error: { code: 'CANNOT_BEAT', message: '压不过上家' } };
  return { ok: false, error: { code: 'AMBIGUOUS_COMBO', message: `有 ${candidates.length} 种组牌方式，请选择` } };
}

/* ───────────────────────── 合法出牌生成 ───────────────────────── */

const TYPE_ORDER: Record<ComboType, number> = {
  single: 0, pair: 1, triple: 2, fullHouse: 3, straight: 4, tube: 5, plate: 6,
  bomb: 7, straightFlush: 7, jokerBomb: 7,
};

export function sortPlays(plays: Play[]): Play[] {
  return plays.sort(
    (a, b) =>
      bombTier(a.combo) - bombTier(b.combo) ||
      TYPE_ORDER[a.combo.type] - TYPE_ORDER[b.combo.type] ||
      a.combo.key - b.combo.key ||
      a.wildAssignments.length - b.wildAssignments.length,
  );
}

interface HandIndex {
  readonly wilds: readonly CardId[];
  /** key = rank 或 `${rank}${suit}` */
  readonly pools: ReadonlyMap<string, readonly CardId[]>;
}

function indexHand(hand: readonly CardId[], level: Level): HandIndex {
  const wilds: CardId[] = [];
  const pools = new Map<string, CardId[]>();
  const push = (k: string, id: CardId) => {
    const arr = pools.get(k);
    if (arr) arr.push(id);
    else pools.set(k, [id]);
  };
  for (const id of [...hand].sort((a, b) => a - b)) {
    if (isWild(id, level)) {
      wilds.push(id);
      continue;
    }
    const c = cardOf(id);
    push(String(c.rank), id);
    push(`${c.rank}${c.suit}`, id);
  }
  return { wilds, pools };
}

function templateCandidates(tpl: Template, toBeat: Combo | null | undefined): boolean {
  if (!toBeat) return true;
  return beats(tpl.combo, toBeat);
}

/**
 * 生成手牌中所有（可选：能压过 toBeat 的）合法出牌。
 * 每种牌型签名只返回一个代表方案：尽量少用逢人配，具体牌取同点中 id 最小者。
 * 同一点数的炸弹会分别生成 4..N 张的版本。
 */
export function generatePlays(
  hand: readonly CardId[],
  level: Level,
  cfg: RulesConfig,
  toBeat?: Combo | null,
): Play[] {
  const idx = indexHand(hand, level);
  const out: Play[] = [];
  const maxSize = Math.min(10, hand.length);
  const sizes: number[] = [];
  if (toBeat && !isBomb(toBeat)) sizes.push(toBeat.size);
  for (let s = 4; s <= maxSize; s++) if (!sizes.includes(s)) sizes.push(s);
  if (!toBeat) for (let s = 1; s <= 3 && s <= maxSize; s++) if (!sizes.includes(s)) sizes.push(s);

  for (const size of sizes) {
    if (size > hand.length) continue;
    for (const tpl of templatesFor(size, level, cfg)) {
      if (toBeat && !isBomb(toBeat) && !isBomb(tpl.combo) && tpl.combo.size !== toBeat.size) continue;
      if (!templateCandidates(tpl, toBeat)) continue;
      const play = buildFromHand(tpl, idx, cfg);
      if (play) out.push(play);
    }
  }
  return sortPlays(out);
}

function buildFromHand(tpl: Template, idx: HandIndex, cfg: RulesConfig): Play | null {
  const cards: CardId[] = [];
  const assignments: WildAssignment[] = [];
  const deficits: { rank: Rank; suit?: Suit; n: number }[] = [];
  let deficit = 0;
  for (const g of tpl.groups) {
    const key = g.suit ? `${g.rank}${g.suit}` : String(g.rank);
    const pool = idx.pools.get(key) ?? [];
    // 允许多个组共用同一点数池（如三带二同点配置），已选过的牌不会被重复选取
    const taken = pickUnused(pool, g.count, cards);
    cards.push(...taken);
    const d = g.count - taken.length;
    if (d > 0) {
      if (isJokerRank(g.rank)) return null;
      if (d === g.count && !g.wildOnlyOk) return null;
      deficit += d;
      deficits.push({ rank: g.rank, ...(g.suit ? { suit: g.suit } : {}), n: d });
    }
  }
  if (deficit > idx.wilds.length) return null;
  let wi = 0;
  for (const d of deficits) {
    for (let k = 0; k < d.n; k++) {
      const id = idx.wilds[wi++]!;
      cards.push(id);
      assignments.push({ cardId: id, rank: d.rank as NaturalRank, suit: d.suit ?? 'H' });
    }
  }
  if (tpl.combo.type === 'straight' && !cfg.straightFlushAsStraight) {
    const concrete = cards.map((id) => {
      const a = assignments.find((x) => x.cardId === id);
      return a ? { rank: a.rank, suit: a.suit } : cardOf(id);
    });
    if (allSameSuit(concrete)) return null;
  }
  return { cards, combo: tpl.combo, wildAssignments: assignments };
}

function pickUnused(pool: readonly CardId[], n: number, already: readonly CardId[]): CardId[] {
  const out: CardId[] = [];
  for (const id of pool) {
    if (out.length >= n) break;
    if (!already.includes(id)) out.push(id);
  }
  return out;
}

/** 牌型中文名 */
export function comboLabel(c: Combo): string {
  const names: Record<ComboType, string> = {
    single: '单张', pair: '对子', triple: '三同张', fullHouse: '三带二', straight: '顺子',
    tube: '三连对', plate: '钢板', bomb: `${c.size}张炸弹`, straightFlush: '同花顺', jokerBomb: '天王炸',
  };
  return names[c.type];
}
