/**
 * 不信任客户端：所有入参先做结构校验，再交给规则引擎。
 */
import { SUITS, isCardId, makeRules, type ComboType, type RulesConfig, type Seat, type WildAssignment } from '@guandan/engine';
import type { ClientGameAction } from '@guandan/protocol';

const COMBO_TYPES: readonly ComboType[] = [
  'single', 'pair', 'triple', 'fullHouse', 'straight', 'tube', 'plate', 'bomb', 'straightFlush', 'jokerBomb',
];

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export function parseSeat(x: unknown): Seat | null {
  return x === 0 || x === 1 || x === 2 || x === 3 ? x : null;
}

export function sanitizeNickname(x: unknown): string {
  const s = typeof x === 'string' ? x.replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 16) : '';
  return s || `玩家${Math.floor(Math.random() * 9000 + 1000)}`;
}

export function parseRoomId(x: unknown): string | null {
  return typeof x === 'string' && /^[A-Z0-9]{4,8}$/.test(x.trim().toUpperCase()) ? x.trim().toUpperCase() : null;
}

export function parseAction(raw: unknown): ClientGameAction | null {
  if (!isObj(raw)) return null;
  switch (raw.type) {
    case 'pass':
      return { type: 'pass' };
    case 'tribute':
    case 'returnTribute':
      return isCardId(raw.card) ? { type: raw.type, card: raw.card } : null;
    case 'play': {
      const cards = raw.cards;
      if (!Array.isArray(cards) || cards.length === 0 || cards.length > 27 || !cards.every(isCardId)) return null;
      let combo: { type: ComboType; key: number; suit?: (typeof SUITS)[number] } | undefined;
      if (raw.combo !== undefined) {
        const c = raw.combo;
        if (!isObj(c) || !COMBO_TYPES.includes(c.type as ComboType) || typeof c.key !== 'number' || !Number.isInteger(c.key)) return null;
        if (c.suit !== undefined && !SUITS.includes(c.suit as never)) return null;
        combo = { type: c.type as ComboType, key: c.key, ...(c.suit ? { suit: c.suit as (typeof SUITS)[number] } : {}) };
      }
      let wildAssignments: WildAssignment[] | undefined;
      if (raw.wildAssignments !== undefined) {
        const w = raw.wildAssignments;
        if (!Array.isArray(w) || w.length > 2) return null;
        wildAssignments = [];
        for (const a of w) {
          if (!isObj(a) || !isCardId(a.cardId) || typeof a.rank !== 'number' || !SUITS.includes(a.suit as never)) return null;
          wildAssignments.push({ cardId: a.cardId, rank: a.rank as WildAssignment['rank'], suit: a.suit as WildAssignment['suit'] });
        }
      }
      return {
        type: 'play',
        cards: [...cards],
        ...(combo ? { combo } : {}),
        ...(wildAssignments ? { wildAssignments } : {}),
      };
    }
    default:
      return null;
  }
}

/** 房主可调整的规则开关白名单 */
export function parseConfig(raw: unknown): RulesConfig {
  if (!isObj(raw)) return makeRules();
  const o: Record<string, unknown> = {};
  const bools = ['jokerPairInFullHouse', 'fullHouseSameRank', 'straightFlushAsStraight', 'upgradeAfterAReset', 'returnAllowLevelCard', 'sameTeamTribute', 'publicReturnCard'];
  for (const k of bools) if (typeof raw[k] === 'boolean') o[k] = raw[k];
  if (raw.aFailLimit === null || (typeof raw.aFailLimit === 'number' && [1, 2, 3, 4, 5].includes(raw.aFailLimit))) o.aFailLimit = raw.aFailLimit;
  if (raw.doubleTributeTie === 'clockwise' || raw.doubleTributeTie === 'headPicksFirstPayer') o.doubleTributeTie = raw.doubleTributeTie;
  if (raw.doubleTributeTieLeader === 'headNext' || raw.doubleTributeTieLeader === 'third') o.doubleTributeTieLeader = raw.doubleTributeTieLeader;
  if (raw.firstLeader === 'random' || parseSeat(raw.firstLeader) !== null) o.firstLeader = raw.firstLeader;
  return makeRules(o as Partial<RulesConfig>);
}
