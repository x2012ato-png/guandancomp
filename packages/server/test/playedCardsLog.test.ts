import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type GameEvent, type ScopedEvent } from '@guandan/engine';
import { PlayedCardsLog } from '../src/playedCardsLog.ts';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const pub = (event: GameEvent): ScopedEvent => ({ event, visibleTo: 'all' });
const seats = [{ nickname: '甲' }, { nickname: '乙' }, { nickname: '丙' }, { nickname: '丁' }];

describe('played cards log', () => {
  it('records public actions in order, including wild assignments, and resets for a new hand', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guandan-log-test-')); directories.push(dir);
    const path = join(dir, 'played_cards_log.md');
    const log = new PlayedCardsLog(path);
    log.record('666888', seats, [pub({ type: 'handStarted', handNo: 1, level: 2, levelTeam: null })]);
    log.record('666888', seats, [pub({ type: 'played', seat: 0, play: {
      cards: [13, 1], combo: { type: 'pair', key: 3, size: 2 },
      wildAssignments: [{ cardId: 13, rank: 3, suit: 'S' }],
    } })]);
    log.record('666888', seats, [pub({ type: 'passed', seat: 1 })]);
    const first = readFileSync(path, 'utf8');
    expect(first).toContain('1. 甲（座位 0） 出牌：♥2（ID 13）、♠3（ID 1）；牌型：对子');
    expect(first).toContain('逢人配：♥2（ID 13）→♠3');
    expect(first).toContain('2. 乙（座位 1） 不要');
    log.record('666888', seats, [pub({ type: 'handStarted', handNo: 2, level: 3, levelTeam: 0 })]);
    log.record('666888', seats, [pub({ type: 'passed', seat: 2 })]);
    const second = readFileSync(path, 'utf8');
    expect(second).toContain('# 出牌记录：第 2 局');
    expect(second).toContain('1. 丙（座位 2） 不要');
    expect(second).not.toContain('逢人配：');
    expect(second).not.toContain('第 1 局');
  });

  it('uses redacted events for private return cards', () => {
    const dir = mkdtempSync(join(tmpdir(), 'guandan-log-test-')); directories.push(dir);
    const path = join(dir, 'played_cards_log.md');
    const log = new PlayedCardsLog(path);
    log.record('666888', seats, [pub({ type: 'handStarted', handNo: 2, level: 3, levelTeam: 0 })]);
    log.record('666888', seats, [{
      visibleTo: [0, 1],
      event: { type: 'tributeReturned', from: 0, to: 1, card: 1 },
      redacted: { type: 'tributeReturned', from: 0, to: 1, card: null },
    }]);
    const result = readFileSync(path, 'utf8');
    expect(result).toContain('还贡（牌面未公开）');
    expect(result).not.toContain('♠3');
  });
});
