import {
  BIG_JOKER,
  NATURAL_RANKS,
  SMALL_JOKER,
  cardLabel,
  cardOf,
  comboLabel,
  isWild,
  rankLabel,
  rankPower,
  sortHand,
  suitLabel,
  type CardId,
  type CardSuit,
  type Level,
  type NaturalRank,
  type Play,
  type Rank,
} from '@guandan/engine';

export function formatCard(id: CardId, level: Level): string {
  const base = cardLabel(id);
  return isWild(id, level) ? `${base}✨` : base;
}

export function formatCards(ids: readonly CardId[], level: Level): string {
  if (ids.length === 0) return '（无）';
  return sortHand(ids, level)
    .map((id) => formatCard(id, level))
    .join(' ');
}

export function formatPlay(play: Play, level: Level): string {
  const label = comboLabel(play.combo);
  const cardsText = play.cards.map((id) => formatCard(id, level)).join(' ');
  const subNotes = play.wildAssignments
    .filter((a) => !(a.rank === level && a.suit === 'H'))
    .map((a) => `${cardLabel(a.cardId)}→${suitLabel(a.suit)}${rankLabel(a.rank)}`);
  const subText = subNotes.length > 0 ? ` (${subNotes.join(', ')})` : '';
  return `【${label}】 ${cardsText}${subText}`;
}

export function formatPlayCompact(play: Play, level: Level): string {
  const label = comboLabel(play.combo);
  const cardsText = play.cards.map((id) => formatCard(id, level)).join(' ');
  return `【${label}】 ${cardsText}`;
}

/**
 * 将玩家手牌格式化为：
 * 1. 按点数分组的清晰视图（便于在手机/网页端一眼看清炸弹、对子、三张）
 * 2. 带 #1..#N 编号的条带（支持用 #编号 快速选牌）
 */
export function formatHandGrouped(hand: readonly CardId[], level: Level): {
  groupedText: string;
  indexedText: string;
  sorted: CardId[];
} {
  const sorted = sortHand(hand, level);
  if (sorted.length === 0) {
    return { groupedText: '（手牌已出完）', indexedText: '（无）', sorted };
  }

  const groups = new Map<string, { title: string; cards: string[] }>();
  for (let i = 0; i < sorted.length; i++) {
    const id = sorted[i]!;
    const c = cardOf(id);
    let key: string;
    let title: string;
    if (c.rank === BIG_JOKER || c.rank === SMALL_JOKER) {
      key = 'joker';
      title = '🃏 王牌';
    } else if (c.rank === level) {
      key = 'level';
      title = `⭐ 级牌(${rankLabel(level)})`;
    } else {
      key = `r_${c.rank}`;
      title = `▫️ ${rankLabel(c.rank)}`;
    }
    let g = groups.get(key);
    if (!g) {
      g = { title, cards: [] };
      groups.set(key, g);
    }
    g.cards.push(formatCard(id, level));
  }

  const lines: string[] = [];
  for (const g of groups.values()) {
    const countBadge = g.cards.length >= 4 ? ` 🔥×${g.cards.length}` : g.cards.length > 1 ? ` (×${g.cards.length})` : '';
    lines.push(`**${g.title}**${countBadge}: ${g.cards.join('  ')}`);
  }

  const indexedTokens = sorted.map((id, idx) => `\`#${idx + 1}\`${formatCard(id, level)}`);
  const indexedRows: string[] = [];
  for (let i = 0; i < indexedTokens.length; i += 7) {
    indexedRows.push(indexedTokens.slice(i, i + 7).join(' '));
  }

  return {
    groupedText: lines.join('\n'),
    indexedText: indexedRows.join('\n'),
    sorted,
  };
}

/**
 * 记牌器：统计除已打出的公开牌（playedCards）和自己手牌（myHand）之外，
 * 场上其余玩家手中还剩多少张各点数牌。
 */
export function formatCardCounter(
  playedCards: readonly CardId[],
  myHand: readonly CardId[],
  level: Level,
): string {
  const known = new Set<CardId>([...playedCards, ...myHand]);
  const remainingByRank = new Map<Rank, number>();
  let remainingWilds = 0;

  for (let id = 0; id < 108; id++) {
    if (known.has(id)) continue;
    const c = cardOf(id);
    remainingByRank.set(c.rank, (remainingByRank.get(c.rank) ?? 0) + 1);
    if (isWild(id, level)) remainingWilds++;
  }

  const orderedRanks: Rank[] = [
    BIG_JOKER,
    SMALL_JOKER,
    level,
    ...([...NATURAL_RANKS].reverse().filter((r) => r !== level) as NaturalRank[]),
  ];

  const items = orderedRanks.map((r) => {
    const count = remainingByRank.get(r) ?? 0;
    const label = r === level ? `级${rankLabel(r)}` : rankLabel(r);
    return `**${label}**: ${count}张`;
  });

  const rows: string[] = [];
  for (let i = 0; i < items.length; i += 5) {
    rows.push(items.slice(i, i + 5).join(' ｜ '));
  }
  rows.unshift(`✨ **外场剩余逢人配 (♥${rankLabel(level)})**: **${remainingWilds}** / 2 张`);
  return rows.join('\n');
}

type ParsedToken =
  | { kind: 'suitRank'; suit: CardSuit; rank: Rank }
  | { kind: 'wild' }
  | { kind: 'joker'; rank: typeof SMALL_JOKER | typeof BIG_JOKER | 'any' }
  | { kind: 'rank'; rank: NaturalRank };

const SUIT_CHAR_MAP: Record<string, CardSuit> = {
  '♠': 'S',
  S: 'S',
  '♥': 'H',
  H: 'H',
  '♣': 'C',
  C: 'C',
  '♦': 'D',
  D: 'D',
};

function parseRankToken(s: string): NaturalRank | null {
  const u = s.toUpperCase();
  if (u === '10' || u === 'T') return 10;
  if (u === 'J') return 11;
  if (u === 'Q') return 12;
  if (u === 'K') return 13;
  if (u === 'A' || u === '1') return 14;
  const n = Number(u);
  if (Number.isInteger(n) && n >= 2 && n <= 9) return n as NaturalRank;
  return null;
}

/**
 * 解析玩家在 Modal 或命令中输入的选牌表达式：
 * 1. `#` 开头按手牌编号解析：如 `#1 #2 #3`、`#1,2,3`、`#1-5`
 * 2. 花色+点数或简写点数：如 `♥2 ♠A`、`H2 SA`、`88`、`55522`、`34567`、`10 10 4 4`、`小王 大王`、`SJ BJ`、`配`
 */
export function parseHandInput(
  rawInput: string,
  hand: readonly CardId[],
  level: Level,
): { ok: true; cards: CardId[] } | { ok: false; message: string } {
  const sorted = sortHand(hand, level);
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { ok: false, message: '输入不能为空' };
  }

  // 模式 1：以 # 开头的编号模式（如 "#1 #2" 或 "#1,2,3" 或 "#1-5"）
  if (trimmed.startsWith('#')) {
    const indices: number[] = [];
    const cleaned = trimmed.replace(/#/g, ' ').trim();
    const parts = cleaned.split(/[\s,，、]+/).filter(Boolean);
    for (const part of parts) {
      const rangeMatch = /^(\d+)-(\d+)$/.exec(part);
      if (rangeMatch) {
        const start = Number(rangeMatch[1]);
        const end = Number(rangeMatch[2]);
        if (start < 1 || end < start || end > sorted.length) {
          return { ok: false, message: `编号范围 #${part} 超出手牌范围 (1..${sorted.length})` };
        }
        for (let i = start; i <= end; i++) indices.push(i);
      } else if (/^\d+$/.test(part)) {
        const idx = Number(part);
        if (idx < 1 || idx > sorted.length) {
          return { ok: false, message: `编号 #${idx} 超出手牌范围 (1..${sorted.length})` };
        }
        indices.push(idx);
      } else {
        return { ok: false, message: `无法识别的编号 "${part}"（编号模式示例：#1 #2 #3 或 #1-5）` };
      }
    }
    if (new Set(indices).size !== indices.length) {
      return { ok: false, message: '不能重复选择同一个手牌编号' };
    }
    return { ok: true, cards: indices.map((i) => sorted[i - 1]!) };
  }

  // 模式 2：牌面/点数简写模式
  const tokens: ParsedToken[] = [];
  const tokenRegex =
    /大王|小王|逢人配|配|BJ|RJ|SJ|WILD|W|([♠♥♣♦SHCD])(10|[2-9JQKAT])|10|[2-9JQKAT]|王/gi;

  let cursor = 0;
  const compact = trimmed.replace(/[\s,，、+]+/g, '');
  tokenRegex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = tokenRegex.exec(compact)) !== null) {
    if (match.index !== cursor) {
      const bad = compact.slice(cursor, match.index);
      return { ok: false, message: `无法识别的牌面字符 "${bad}"` };
    }
    cursor = tokenRegex.lastIndex;
    const full = match[0].toUpperCase();
    if (full === '大王' || full === 'BJ' || full === 'RJ') {
      tokens.push({ kind: 'joker', rank: BIG_JOKER });
    } else if (full === '小王' || full === 'SJ') {
      tokens.push({ kind: 'joker', rank: SMALL_JOKER });
    } else if (full === '王') {
      tokens.push({ kind: 'joker', rank: 'any' });
    } else if (full === '逢人配' || full === '配' || full === 'WILD' || full === 'W') {
      tokens.push({ kind: 'wild' });
    } else if (match[1] && match[2]) {
      const suit = SUIT_CHAR_MAP[match[1].toUpperCase()]!;
      const rank = parseRankToken(match[2])!;
      tokens.push({ kind: 'suitRank', suit, rank });
    } else {
      const rank = parseRankToken(full);
      if (!rank) {
        return { ok: false, message: `无法识别的牌面 "${match[0]}"` };
      }
      tokens.push({ kind: 'rank', rank });
    }
  }
  if (cursor !== compact.length) {
    return { ok: false, message: `无法识别的牌面字符 "${compact.slice(cursor)}"` };
  }
  if (tokens.length === 0) {
    return { ok: false, message: '未解析到任何牌面' };
  }

  const used = new Set<CardId>();
  const picked: (CardId | null)[] = new Array(tokens.length).fill(null);

  const pickCard = (pred: (id: CardId) => boolean): CardId | null => {
    // 顺序按从小牌到大牌或原手牌顺序均可；在同点数内优先挑最后面（不拆前面的红桃/高花色）
    for (let i = sorted.length - 1; i >= 0; i--) {
      const id = sorted[i]!;
      if (!used.has(id) && pred(id)) {
        used.add(id);
        return id;
      }
    }
    return null;
  };

  // 第一遍：先满足指定了花色、王牌或明确要求逢人配的 token
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind === 'suitRank') {
      const id = pickCard((c) => cardOf(c).suit === t.suit && cardOf(c).rank === t.rank);
      if (id === null) {
        return { ok: false, message: `手中没有足够的 ${suitLabel(t.suit)}${rankLabel(t.rank)}` };
      }
      picked[i] = id;
    } else if (t.kind === 'wild') {
      const id = pickCard((c) => isWild(c, level));
      if (id === null) {
        return { ok: false, message: `手中没有足够的逢人配 (♥${rankLabel(level)})` };
      }
      picked[i] = id;
    } else if (t.kind === 'joker') {
      const id =
        t.rank === 'any'
          ? pickCard((c) => cardOf(c).rank === SMALL_JOKER) ?? pickCard((c) => cardOf(c).rank === BIG_JOKER)
          : pickCard((c) => cardOf(c).rank === t.rank);
      if (id === null) {
        const name = t.rank === BIG_JOKER ? '大王' : t.rank === SMALL_JOKER ? '小王' : '王';
        return { ok: false, message: `手中没有足够的 ${name}` };
      }
      picked[i] = id;
    }
  }

  // 第二遍：满足纯点数 token（优先用非逢人配自然牌，不够时再用逢人配代替）
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t.kind !== 'rank') continue;
    // 1. 非逢人配的同点数牌
    let id = pickCard((c) => cardOf(c).rank === t.rank && !isWild(c, level));
    // 2. 如果点的就是级牌本身，允许使用逢人配
    if (id === null && t.rank === level) {
      id = pickCard((c) => isWild(c, level));
    }
    // 3. 如果普通自然牌缺张，自动用逢人配补齐
    if (id === null) {
      id = pickCard((c) => isWild(c, level));
    }
    if (id === null) {
      return { ok: false, message: `手中没有足够的 ${rankLabel(t.rank)}（也没有可用的逢人配）` };
    }
    picked[i] = id;
  }

  // 按照玩家手牌自然大小排序返回
  const result = picked.filter((x): x is CardId => x !== null);
  return {
    ok: true,
    cards: sortHand(result, level),
  };
}

/** 对合法出牌进行分类，便于在 Discord 25 项下拉菜单限制下快速筛选 */
export type PlayCategory =
  | 'all'
  | 'single'
  | 'pair'
  | 'triple'
  | 'fullHouse'
  | 'straight'
  | 'tube_plate'
  | 'bomb';

export const PLAY_CATEGORIES: readonly { id: PlayCategory; label: string; emoji: string }[] = [
  { id: 'all', label: '全部合法牌型', emoji: '🌟' },
  { id: 'single', label: '单张', emoji: '1️⃣' },
  { id: 'pair', label: '对子', emoji: '2️⃣' },
  { id: 'triple', label: '三同张', emoji: '3️⃣' },
  { id: 'fullHouse', label: '三带二', emoji: '🏠' },
  { id: 'straight', label: '顺子', emoji: '📏' },
  { id: 'tube_plate', label: '三连对 / 钢板', emoji: '⛓️' },
  { id: 'bomb', label: '炸弹 / 同花顺 / 天王炸', emoji: '💣' },
];

export function categoryOfPlay(play: Play): Exclude<PlayCategory, 'all'> {
  switch (play.combo.type) {
    case 'single':
      return 'single';
    case 'pair':
      return 'pair';
    case 'triple':
      return 'triple';
    case 'fullHouse':
      return 'fullHouse';
    case 'straight':
      return 'straight';
    case 'tube':
    case 'plate':
      return 'tube_plate';
    case 'bomb':
    case 'straightFlush':
    case 'jokerBomb':
      return 'bomb';
  }
}

export function sortRankOrderForDisplay(plays: readonly Play[], level: Level): Play[] {
  // 在同一类别中按由小到大排列，方便先出小牌
  return [...plays].sort((a, b) => a.combo.key - b.combo.key || a.cards.length - b.cards.length);
}
