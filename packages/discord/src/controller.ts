import {
  MessageFlags,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Interaction,
  type Message,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type TextBasedChannel,
} from 'discord.js';
import { cardLabel, type Seat } from '@guandan/engine';
import { decisionToAction } from '@guandan/ai';
import { formatPlay, type PlayCategory } from './cardsText.ts';
import { DiscordRoomManager, getUiState, type DiscordRoom } from './room.ts';
import {
  buildPlayInputModal,
  getFilteredLegalPlays,
  renderCardCounterEmbed,
  renderCoachHintEmbed,
  renderEphemeralHand,
  renderPublicTable,
} from './views.ts';

export class DiscordController {
  readonly manager: DiscordRoomManager;

  constructor(manager: DiscordRoomManager = new DiscordRoomManager()) {
    this.manager = manager;
  }

  /**
   * 统一处理所有 Discord Interaction（斜杠命令、按钮、下拉菜单、Modal 弹窗提交）
   */
  async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'guandan') {
          await this.handleSlashCommand(interaction);
        }
        return;
      }
      if (interaction.isButton()) {
        if (interaction.customId.startsWith('gd:')) {
          await this.handleButton(interaction);
        }
        return;
      }
      if (interaction.isStringSelectMenu()) {
        if (interaction.customId.startsWith('gd:')) {
          await this.handleSelectMenu(interaction);
        }
        return;
      }
      if (interaction.isModalSubmit()) {
        if (interaction.customId === 'gd:modal_play') {
          await this.handleModalSubmit(interaction);
        }
        return;
      }
    } catch (error) {
      console.error('Error handling Discord interaction:', error);
      if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
        await interaction
          .reply({
            content: `❌ 处理操作时出错：${error instanceof Error ? error.message : String(error)}`,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
    }
  }

  /**
   * 支持在聊天框直接输入 `!gd` 或 `!guandan` 快捷指令（无需等待斜杠命令同步即可开局）
   */
  async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const text = message.content.trim();
    if (!/^!(gd|guandan)(\s|$)/i.test(text)) return;

    const args = text.split(/\s+/).slice(1);
    const sub = (args[0] ?? 'create').toLowerCase();
    const channelId = message.channelId;
    const userId = message.author.id;
    const username = message.member?.displayName ?? message.author.displayName ?? message.author.username;

    if (sub === 'create' || sub === 'table') {
      const room = this.manager.createOrGetRoom(channelId, userId, username);
      const rendered = renderPublicTable(room);
      if ('send' in message.channel) {
        const sent = await message.channel.send(rendered);
        room.tableMessageId = sent.id;
      }
      return;
    }

    if (sub === 'start') {
      this.manager.createOrGetRoom(channelId, userId, username);
      const res = this.manager.startGame(channelId);
      if (!res.ok) {
        await message.reply(`⚠️ ${res.error}`);
        return;
      }
      await this.syncPublicTable(message.channel, res.room, true);
      return;
    }

    if (sub === 'reset') {
      this.manager.deleteRoom(channelId);
      await message.reply('🧹 已重置当前频道的掼蛋牌桌。输入 `!gd` 或 `/guandan create` 可重新创建。');
    }
  }

  private async handleSlashCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const sub = interaction.options.getSubcommand();
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const username =
      (interaction.member && 'displayName' in interaction.member
        ? interaction.member.displayName
        : null) ??
      interaction.user.displayName ??
      interaction.user.username;

    if (sub === 'create') {
      const room = this.manager.createOrGetRoom(channelId, userId, username);
      const rendered = renderPublicTable(room);
      const reply = await interaction.reply({ ...rendered, withResponse: true });
      if (reply.resource?.message?.id) {
        room.tableMessageId = reply.resource.message.id;
      }
      return;
    }

    if (sub === 'sit') {
      this.manager.createOrGetRoom(channelId, userId, username);
      const seatNum = interaction.options.getInteger('seat', true);
      const seat = (seatNum - 1) as Seat;
      const res = this.manager.sit(channelId, userId, username, seat);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: `✅ ${res.message}`, flags: MessageFlags.Ephemeral });
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }

    if (sub === 'start') {
      this.manager.createOrGetRoom(channelId, userId, username);
      const res = this.manager.startGame(channelId);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      const rendered = renderPublicTable(res.room);
      const reply = await interaction.reply({ ...rendered, withResponse: true });
      if (reply.resource?.message?.id) {
        res.room.tableMessageId = reply.resource.message.id;
      }
      return;
    }

    if (sub === 'hand') {
      const room = this.manager.getRoom(channelId);
      if (!room) {
        await interaction.reply({
          content: '⚠️ 当前频道还没有牌桌，请先使用 `/guandan create` 创建牌桌。',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }
      const rendered = renderEphemeralHand(room, this.manager, userId);
      await interaction.reply({ ...rendered, flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'play') {
      const cardsInput = interaction.options.getString('cards', true);
      const res = this.manager.playFromTextInput(channelId, userId, cardsInput);
      if (!res.ok) {
        const room = this.manager.getRoom(channelId);
        if (room?.game) {
          const rendered = renderEphemeralHand(room, this.manager, userId, `⚠️ 出牌失败：${res.error}`);
          await interaction.reply({ ...rendered, flags: MessageFlags.Ephemeral });
        } else {
          await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        }
        return;
      }
      if (res.status === 'ambiguous') {
        const rendered = renderEphemeralHand(
          res.room,
          this.manager,
          userId,
          '⚠️ 你输入的牌有多种组牌方式，请在下方下拉菜单中选择：',
        );
        await interaction.reply({ ...rendered, flags: MessageFlags.Ephemeral });
        return;
      }
      const rendered = renderEphemeralHand(res.room, this.manager, userId, `✅ 已出牌：**${res.playText}**`);
      await interaction.reply({ ...rendered, flags: MessageFlags.Ephemeral });
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }

    if (sub === 'pass') {
      const room = this.manager.getRoom(channelId);
      const seat = room ? this.manager.seatOfUser(room, userId) : null;
      if (!room || seat === null) {
        await interaction.reply({ content: '⚠️ 你不在当前牌桌座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const res = this.manager.applyPlayerAction(channelId, userId, { type: 'pass', seat });
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.reply({ content: '✅ 已选择 **不要 (Pass)**', flags: MessageFlags.Ephemeral });
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }

    if (sub === 'hint') {
      const room = this.manager.getRoom(channelId);
      const seat = room ? this.manager.seatOfUser(room, userId) : null;
      if (!room || !room.game || seat === null) {
        await interaction.reply({ content: '⚠️ 游戏尚未开始或你不在座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const adviceRes = this.manager.getAdviceForUser(channelId, userId);
      if (!adviceRes.ok) {
        await interaction.reply({ content: `⚠️ ${adviceRes.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      const embed = renderCoachHintEmbed(room, seat, adviceRes.advice);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'counter') {
      const room = this.manager.getRoom(channelId);
      const seat = room ? this.manager.seatOfUser(room, userId) : null;
      if (!room || !room.game || seat === null) {
        await interaction.reply({ content: '⚠️ 游戏尚未开始或你不在座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const embed = renderCardCounterEmbed(room, seat);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (sub === 'reset') {
      this.manager.deleteRoom(channelId);
      await interaction.reply({ content: '🧹 已重置当前频道的掼蛋牌桌。' });
      return;
    }
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const username =
      (interaction.member && 'displayName' in interaction.member
        ? interaction.member.displayName
        : null) ??
      interaction.user.displayName ??
      interaction.user.username;
    const id = interaction.customId;

    // 1. 大厅入座 / 离座 / AI 配置 / 开始游戏
    if (id.startsWith('gd:sit:')) {
      this.manager.createOrGetRoom(channelId, userId, username);
      const seat = Number(id.split(':')[2]) as Seat;
      const res = this.manager.sit(channelId, userId, username, seat);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    if (id === 'gd:stand') {
      const res = this.manager.stand(channelId, userId);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    if (id === 'gd:fill_bots') {
      const res = this.manager.fillBots(channelId, 'coach_partner');
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    if (id === 'gd:clear_bots') {
      const res = this.manager.clearBots(channelId);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    if (id === 'gd:start' || id === 'gd:rematch') {
      const res = this.manager.startGame(channelId);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    if (id === 'gd:nexthand') {
      const res = this.manager.nextHand(channelId);
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    if (id === 'gd:lobby') {
      const room = this.manager.getRoom(channelId);
      if (!room) {
        await interaction.reply({ content: '⚠️ 牌桌不存在', flags: MessageFlags.Ephemeral });
        return;
      }
      room.game = null;
      room.recentLog = [];
      room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(room));
      return;
    }

    const room = this.manager.getRoom(channelId);
    if (!room) {
      await interaction.reply({
        content: '⚠️ 当前频道还没有活跃牌桌，请先使用 `/guandan create` 创建。',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // 2. 公共牌桌上的按钮：查看私密手牌 / 不要 / 教练提示 / 记牌器
    if (id === 'gd:hand') {
      const rendered = renderEphemeralHand(room, this.manager, userId);
      await interaction.reply({ ...rendered, flags: MessageFlags.Ephemeral });
      return;
    }

    if (id === 'gd:refresh_hand') {
      const rendered = renderEphemeralHand(room, this.manager, userId);
      await interaction.update(rendered);
      return;
    }

    if (id === 'gd:cancel_ambig') {
      const ui = getUiState(room, userId);
      ui.pendingInterpretations = null;
      const rendered = renderEphemeralHand(room, this.manager, userId, '已取消选牌，请重新选择：');
      await interaction.update(rendered);
      return;
    }

    if (id === 'gd:page_prev' || id === 'gd:page_next') {
      const ui = getUiState(room, userId);
      ui.page = Math.max(0, ui.page + (id === 'gd:page_next' ? 1 : -1));
      const rendered = renderEphemeralHand(room, this.manager, userId);
      await interaction.update(rendered);
      return;
    }

    if (id === 'gd:open_modal') {
      if (!room.game) {
        await interaction.reply({ content: '⚠️ 游戏尚未开始', flags: MessageFlags.Ephemeral });
        return;
      }
      await interaction.showModal(buildPlayInputModal(room.game.level));
      return;
    }

    if (id === 'gd:hint') {
      const seat = this.manager.seatOfUser(room, userId);
      if (!room.game || seat === null) {
        await interaction.reply({ content: '⚠️ 你不在本桌座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const adviceRes = this.manager.getAdviceForUser(channelId, userId);
      if (!adviceRes.ok) {
        await interaction.reply({ content: `⚠️ ${adviceRes.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      const embed = renderCoachHintEmbed(room, seat, adviceRes.advice);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    if (id === 'gd:counter') {
      const seat = this.manager.seatOfUser(room, userId);
      if (!room.game || seat === null) {
        await interaction.reply({ content: '⚠️ 你不在本桌座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const embed = renderCardCounterEmbed(room, seat);
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }

    // 公共牌桌上的「不要」按钮
    if (id === 'gd:pass') {
      const seat = this.manager.seatOfUser(room, userId);
      if (seat === null) {
        await interaction.reply({ content: '⚠️ 你不在本桌座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const res = this.manager.applyPlayerAction(channelId, userId, { type: 'pass', seat });
      if (!res.ok) {
        await interaction.reply({ content: `⚠️ ${res.error}`, flags: MessageFlags.Ephemeral });
        return;
      }
      res.room.tableMessageId = interaction.message.id;
      await interaction.update(renderPublicTable(res.room));
      return;
    }

    // 私密手牌面板上的「不要」按钮
    if (id === 'gd:ephem_pass') {
      const seat = this.manager.seatOfUser(room, userId);
      if (seat === null) {
        await interaction.reply({ content: '⚠️ 你不在本桌座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const res = this.manager.applyPlayerAction(channelId, userId, { type: 'pass', seat });
      if (!res.ok) {
        await interaction.update(renderEphemeralHand(room, this.manager, userId, `⚠️ ${res.error}`));
        return;
      }
      await interaction.update(renderEphemeralHand(res.room, this.manager, userId, '✅ 已选择 **不要 (Pass)**'));
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }

    // 私密手牌面板上的「出AI推荐牌」一键按钮
    if (id === 'gd:play_ai') {
      const seat = this.manager.seatOfUser(room, userId);
      if (seat === null || !room.game) {
        await interaction.reply({ content: '⚠️ 你不在本桌座位上', flags: MessageFlags.Ephemeral });
        return;
      }
      const adviceRes = this.manager.getAdviceForUser(channelId, userId);
      if (!adviceRes.ok) {
        await interaction.update(renderEphemeralHand(room, this.manager, userId, `⚠️ ${adviceRes.error}`));
        return;
      }
      const level = room.game.level;
      const action = decisionToAction(seat, adviceRes.decision);
      const summary =
        adviceRes.decision.type === 'pass'
          ? '不要 (Pass)'
          : adviceRes.decision.type === 'play'
            ? formatPlay(adviceRes.decision.play, level)
            : cardLabel(adviceRes.decision.card);
      const res = this.manager.applyPlayerAction(channelId, userId, action);
      if (!res.ok) {
        await interaction.update(renderEphemeralHand(room, this.manager, userId, `⚠️ ${res.error}`));
        return;
      }
      await interaction.update(renderEphemeralHand(res.room, this.manager, userId, `✅ 已执行 AI 推荐：**${summary}**`));
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }
  }

  private async handleSelectMenu(interaction: StringSelectMenuInteraction): Promise<void> {
    const channelId = interaction.channelId;
    const userId = interaction.user.id;
    const id = interaction.customId;
    const room = this.manager.getRoom(channelId);
    if (!room || !room.game) {
      await interaction.reply({ content: '⚠️ 游戏尚未开始', flags: MessageFlags.Ephemeral });
      return;
    }
    const seat = this.manager.seatOfUser(room, userId);
    if (seat === null) {
      await interaction.reply({ content: '⚠️ 你不在本桌座位上', flags: MessageFlags.Ephemeral });
      return;
    }

    // 1. 切换牌型分类筛选
    if (id === 'gd:filter_cat') {
      const selectedCat = (interaction.values[0] ?? 'all') as PlayCategory;
      const ui = getUiState(room, userId);
      ui.category = selectedCat;
      ui.page = 0;
      await interaction.update(renderEphemeralHand(room, this.manager, userId));
      return;
    }

    // 2. 从下拉菜单直接点击出牌
    if (id === 'gd:pick_play') {
      const ui = getUiState(room, userId);
      const idx = Number(interaction.values[0]);
      const { filteredPlays } = getFilteredLegalPlays(room.game, seat, ui.category);
      const chosen = filteredPlays[idx];
      if (!chosen) {
        await interaction.update(
          renderEphemeralHand(room, this.manager, userId, '⚠️ 该出牌选项已过期，请重新选择'),
        );
        return;
      }
      const level = room.game.level;
      const playText = formatPlay(chosen, level);
      const res = this.manager.applyPlayerAction(channelId, userId, {
        type: 'play',
        seat,
        cards: chosen.cards,
        combo: {
          type: chosen.combo.type,
          key: chosen.combo.key,
          ...(chosen.combo.suit ? { suit: chosen.combo.suit } : {}),
        },
        wildAssignments: chosen.wildAssignments,
      });
      if (!res.ok) {
        await interaction.update(renderEphemeralHand(room, this.manager, userId, `⚠️ ${res.error}`));
        return;
      }
      await interaction.update(
        renderEphemeralHand(res.room, this.manager, userId, `✅ 已出牌：**${playText}**`),
      );
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }

    // 3. 进贡 / 还贡下拉选牌
    if (id === 'gd:pick_tribute') {
      const cardId = Number(interaction.values[0]);
      const isTribute = room.game.phase === 'tribute';
      const action = isTribute
        ? ({ type: 'tribute', seat, card: cardId } as const)
        : ({ type: 'returnTribute', seat, card: cardId } as const);
      const label = cardLabel(cardId);
      const res = this.manager.applyPlayerAction(channelId, userId, action);
      if (!res.ok) {
        await interaction.update(renderEphemeralHand(room, this.manager, userId, `⚠️ ${res.error}`));
        return;
      }
      await interaction.update(
        renderEphemeralHand(
          res.room,
          this.manager,
          userId,
          `✅ 已${isTribute ? '进贡' : '还贡'}：**${label}**`,
        ),
      );
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }

    // 4. 逢人配多解牌型消歧下拉选择
    if (id === 'gd:pick_ambig') {
      const ui = getUiState(room, userId);
      const idx = Number(interaction.values[0]);
      const chosen = ui.pendingInterpretations?.[idx];
      if (!chosen) {
        ui.pendingInterpretations = null;
        await interaction.update(renderEphemeralHand(room, this.manager, userId, '⚠️ 选项已过期，请重新选牌'));
        return;
      }
      const level = room.game.level;
      const playText = formatPlay(chosen, level);
      const res = this.manager.applyPlayerAction(channelId, userId, {
        type: 'play',
        seat,
        cards: chosen.cards,
        combo: {
          type: chosen.combo.type,
          key: chosen.combo.key,
          ...(chosen.combo.suit ? { suit: chosen.combo.suit } : {}),
        },
        wildAssignments: chosen.wildAssignments,
      });
      if (!res.ok) {
        await interaction.update(renderEphemeralHand(room, this.manager, userId, `⚠️ ${res.error}`));
        return;
      }
      await interaction.update(
        renderEphemeralHand(res.room, this.manager, userId, `✅ 已出牌：**${playText}**`),
      );
      await this.syncPublicTable(interaction.channel, res.room);
      return;
    }
  }

  private async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
    const channelId = interaction.channelId;
    if (!channelId) return;
    const userId = interaction.user.id;
    const rawInput = interaction.fields.getTextInputValue('cards_input');
    const res = this.manager.playFromTextInput(channelId, userId, rawInput);
    const room = this.manager.getRoom(channelId);

    const respondEphemeral = async (notice: string) => {
      if (!room) {
        await interaction.reply({ content: notice, flags: MessageFlags.Ephemeral });
        return;
      }
      const rendered = renderEphemeralHand(room, this.manager, userId, notice);
      if (interaction.isFromMessage()) {
        await interaction.update(rendered);
      } else {
        await interaction.reply({ ...rendered, flags: MessageFlags.Ephemeral });
      }
    };

    if (!res.ok) {
      await respondEphemeral(`⚠️ 选牌失败：${res.error}`);
      return;
    }
    if (res.status === 'ambiguous') {
      await respondEphemeral('⚠️ 你输入的牌有多种组牌方式，请在下方下拉菜单中选择：');
      return;
    }

    await respondEphemeral(`✅ 已出牌：**${res.playText}**`);
    await this.syncPublicTable(interaction.channel, res.room);
  }

  /**
   * 同步更新公共频道中的牌桌消息（优先原地 edit 既有牌桌消息，若不存在则发送新消息）
   */
  async syncPublicTable(
    channel: TextBasedChannel | null,
    room: DiscordRoom,
    forceSend = false,
  ): Promise<void> {
    if (!channel || !('send' in channel)) return;
    const rendered = renderPublicTable(room);

    if (!forceSend && room.tableMessageId && 'messages' in channel) {
      try {
        await channel.messages.edit(room.tableMessageId, {
          content: rendered.content ?? null,
          embeds: rendered.embeds,
          components: rendered.components,
        });
        return;
      } catch {
        // 如果原消息已被删除或无法编辑，降级为发送新牌桌消息
      }
    }

    try {
      const sent = await channel.send(rendered);
      room.tableMessageId = sent.id;
    } catch (error) {
      console.error('Failed to send public table message:', error);
    }
  }
}
