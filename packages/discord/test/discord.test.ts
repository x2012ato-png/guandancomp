import { describe, expect, it } from 'vitest';
import { cardOf, isWild, sortHand, type CardId, type Level } from '@guandan/engine';
import {
  DiscordRoomManager,
  buildPlayInputModal,
  formatCardCounter,
  formatHandGrouped,
  getFilteredLegalPlays,
   getUiState,
  parseHandInput,
  renderCardCounterEmbed,
  renderCoachHintEmbed,
  renderEphemeralHand,
  renderPublicTable,
} from '../src/index.ts';

describe('@guandan/discord', () => {
  describe('cardsText & parseHandInput', () => {
    // 构造固定手牌：level = 2
    // id=0: ♠2, id=13: ♥2 (逢人配), id=3: ♠5, id=16: ♥5, id=29: ♣5, id=6: ♠8, id=19: ♥8, id=52: 小王, id=53: 大王
    const level: Level = 2;
    const sampleHand: CardId[] = [0, 13, 3, 16, 29, 6, 19, 52, 53];

    it('parses #index and #start-end ranges from sorted hand', () => {
      const sorted = sortHand(sampleHand, level);
      const res1 = parseHandInput('#1 #2', sampleHand, level);
      expect(res1.ok).toBe(true);
      if (res1.ok) {
        expect(res1.cards).toEqual([sorted[0], sorted[1]]);
      }

      const resRange = parseHandInput('#1-3', sampleHand, level);
      expect(resRange.ok).toBe(true);
      if (resRange.ok) {
        expect(resRange.cards).toEqual([sorted[0], sorted[1], sorted[2]]);
      }

      const badRange = parseHandInput('#1 #1', sampleHand, level);
      expect(badRange.ok).toBe(false);
    });

    it('parses shorthand rank inputs and prefers natural cards before wild cards', () => {
      // '88' 应该选中 ♠8 和 ♥8，不消耗 ♥2 逢人配
      const res88 = parseHandInput('88', sampleHand, level);
      expect(res88.ok).toBe(true);
      if (res88.ok) {
        expect(res88.cards.length).toBe(2);
        expect(res88.cards.every((c) => cardOf(c).rank === 8)).toBe(true);
      }

      // '888' 手里只有两张 8，第三张应自动用逢人配 ♥2 (id=13) 补齐
      const res888 = parseHandInput('888', sampleHand, level);
      expect(res888.ok).toBe(true);
      if (res888.ok) {
        expect(res888.cards.length).toBe(3);
        expect(res888.cards.some((c) => isWild(c, level))).toBe(true);
      }

      // '55588' 三带二
      const resFH = parseHandInput('55588', sampleHand, level);
      expect(resFH.ok).toBe(true);
      if (resFH.ok) {
        expect(resFH.cards.length).toBe(5);
      }

      // 王牌与指定花色
      const resJokers = parseHandInput('小王 大王 ♥2', sampleHand, level);
      expect(resJokers.ok).toBe(true);
      if (resJokers.ok) {
        expect(resJokers.cards).toEqual([53, 52, 13]);
      }
    });

    it('formats grouped hand and card counter cleanly', () => {
      const grouped = formatHandGrouped(sampleHand, level);
      expect(grouped.groupedText).toContain('王牌');
      expect(grouped.groupedText).toContain('级牌(2)');
      expect(grouped.indexedText).toContain('#1');

      const counter = formatCardCounter([0, 3], sampleHand, level);
      expect(counter).toContain('外场剩余逢人配');
    });
  });

  describe('DiscordRoomManager & Views', () => {
    it('manages lobby, bots, turn progression, and enforces Discord component limits', () => {
      const manager = new DiscordRoomManager();
      const channelId = 'chan-flight-1';
      const userId = 'user-1';

      const room = manager.createOrGetRoom(channelId, userId, 'Alice');
      expect(room.seats[0]?.userId).toBe(userId);

      // 渲染大厅
      const lobbyMsg = renderPublicTable(room);
      expect(lobbyMsg.embeds.length).toBe(1);
      expect(lobbyMsg.components.length).toBe(2);

      // 开局（自动补齐 3 个 AI，其中对家 2号位即 Seat 2 为 AI 教练）
      const startRes = manager.startGame(channelId, 'flight-seed-42');
      expect(startRes.ok).toBe(true);
      expect(room.seats[2]?.bot).toBe(true);
      expect(room.seats[2]?.botKind).toBe('coach');
      expect(room.game).not.toBeNull();

      // 由于 AI 会自动行动，经过 drainBots 后应当停在真人玩家 (Seat 0) 回合
      expect(room.game!.turn).toBe(0);

      // 校验公共牌桌渲染
      const publicMsg = renderPublicTable(room);
      expect(publicMsg.embeds.length).toBe(1);
      expect(publicMsg.components.length).toBeLessThanOrEqual(5);

      // 校验私密手牌面板渲染及 Discord 组件限制 (<= 5 rows, <= 25 select options)
      const handMsg = renderEphemeralHand(room, manager, userId);
      expect(handMsg.embeds.length).toBe(1);
      expect(handMsg.components.length).toBeLessThanOrEqual(5);
      for (const row of handMsg.components) {
        const json = row.toJSON();
        expect(json.components.length).toBeGreaterThanOrEqual(1);
        expect(json.components.length).toBeLessThanOrEqual(5);
        for (const comp of json.components) {
          if ('options' in comp && Array.isArray(comp.options)) {
            expect(comp.options.length).toBeGreaterThanOrEqual(1);
            expect(comp.options.length).toBeLessThanOrEqual(25);
          }
        }
      }

      // 校验 AI 教练建议和记牌器渲染
      const adviceRes = manager.getAdviceForUser(channelId, userId);
      expect(adviceRes.ok).toBe(true);
      if (adviceRes.ok) {
        const hintEmbed = renderCoachHintEmbed(room, 0, adviceRes.advice);
        expect(hintEmbed.toJSON().title).toContain('AI 教练');
      }
      const counterEmbed = renderCardCounterEmbed(room, 0);
      expect(counterEmbed.toJSON().title).toContain('记牌器');

      // 校验 Modal 构建
      const modal = buildPlayInputModal(room.game!.level);
      expect(modal.toJSON().custom_id).toBe('gd:modal_play');
    });

    it('plays through a complete hand with 1 human using AI recommendations and 3 bots', () => {
      const manager = new DiscordRoomManager();
      const channelId = 'chan-flight-2';
      const userId = 'user-pilot';

      manager.createOrGetRoom(channelId, userId, 'Pilot');
      const started = manager.startGame(channelId, 'complete-hand-seed');
      expect(started.ok).toBe(true);
      const room = manager.getRoom(channelId)!;

      let safety = 0;
      while (room.game && room.game.phase === 'playing' && safety < 200) {
        expect(room.game.turn).toBe(0);
        const { filteredPlays } = getFilteredLegalPlays(room.game, 0, getUiState(room, userId).category);
        if (filteredPlays.length > 0) {
          const play = filteredPlays[0]!;
          const res = manager.applyPlayerAction(channelId, userId, {
            type: 'play',
            seat: 0,
            cards: play.cards,
            combo: {
              type: play.combo.type,
              key: play.combo.key,
              ...(play.combo.suit ? { suit: play.combo.suit } : {}),
            },
            wildAssignments: play.wildAssignments,
          });
          expect(res.ok).toBe(true);
        } else {
          const res = manager.applyPlayerAction(channelId, userId, { type: 'pass', seat: 0 });
          expect(res.ok).toBe(true);
        }
        safety++;
      }

      expect(room.game!.phase).toBe('handOver');
      expect(room.game!.lastResult).not.toBeNull();

      // 进入下一局（可能触发进贡/还贡阶段，且 AI 若需进贡/还贡也会自动处理）
      const nextRes = manager.nextHand(channelId);
      expect(nextRes.ok).toBe(true);
      expect(['tribute', 'return', 'playing']).toContain(room.game!.phase);
    });

    it('handles text input plays and disambiguates multi-interpretation wild card combos', () => {
      const manager = new DiscordRoomManager();
      const channelId = 'chan-flight-ambig';
      const userId = 'user-ambig';

      manager.createOrGetRoom(channelId, userId, 'Tester');
      manager.startGame(channelId, 'ambig-seed');
      const room = manager.getRoom(channelId)!;

      // 构造含两张红桃2(逢人配: 13, 67) + 两张3(1, 55) + 一张7(5) 的手牌
      // [3, 3, 7, ♥2, ♥2] 可解释为 三带二(333+77) 或 三带二(777+33)
      room.game = {
        ...room.game!,
        level: 2,
        turn: 0,
        trick: { leader: 0, lastPlay: null, passed: [], history: [] },
        hands: [[1, 55, 5, 13, 67], room.game!.hands[1], room.game!.hands[2], room.game!.hands[3]],
      };

      const res = manager.playFromTextInput(channelId, userId, '337配配');
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.status).toBe('ambiguous');
        if (res.status === 'ambiguous') {
          expect(res.options.length).toBeGreaterThan(1);
        }
      }

      // 渲染私密手牌时应出现 gd:pick_ambig 消歧下拉菜单
      const ephem = renderEphemeralHand(room, manager, userId);
      const firstComp = ephem.components[0]?.toJSON().components[0];
      expect(firstComp && 'custom_id' in firstComp ? firstComp.custom_id : undefined).toBe('gd:pick_ambig');
    });
  });
});
