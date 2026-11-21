import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import {
  SEATS,
  cardLabel,
  comboLabel,
  generatePlays,
  legalActions,
  pendingActors,
  rankLabel,
  sortHand,
  toPlayerView,
  type CardId,
  type Level,
  type Play,
  type Seat,
} from '@guandan/engine';
import type { CoachAdvice } from '@guandan/protocol';
import {
  PLAY_CATEGORIES,
  categoryOfPlay,
  formatCard,
  formatCardCounter,
  formatHandGrouped,
  formatPlay,
  formatPlayCompact,
  sortRankOrderForDisplay,
  type PlayCategory,
} from './cardsText.ts';
import {
  DiscordRoomManager,
  SEAT_NAMES,
  getUiState,
  seatDisplay,
  seatShortName,
  type DiscordRoom,
} from './room.ts';

export const PAGE_SIZE = 25;

function truncate(text: string, max = 95): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}

export interface RenderedMessage {
  content?: string;
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[];
}

/**
 * 渲染公共频道中的牌桌消息（大厅 / 对局中 / 局间结算 / 终局）
 */
export function renderPublicTable(room: DiscordRoom): RenderedMessage {
  if (!room.game) {
    return renderLobbyTable(room);
  }
  const game = room.game;
  const level = game.level;
  const actors = pendingActors(game);

  const phaseLabels: Record<string, string> = {
    waiting: '准备中',
    tribute: '🎁 进贡阶段',
    return: '🔄 还贡阶段',
    playing: '🃏 出牌阶段',
    handOver: '🏁 本局结束',
    matchOver: '🏆 比赛结束',
  };

  const color =
    game.phase === 'matchOver'
      ? 0xf1c40f
      : game.phase === 'handOver'
        ? 0x2ecc71
        : game.turn !== null && (game.turn === 0 || game.turn === 2)
          ? 0xe74c3c
          : 0x3498db;

  const embed = new EmbedBuilder()
    .setTitle(
      `🃏 掼蛋牌桌 · 第 ${game.handNo} 局 ｜ 本局打【${rankLabel(level)}】(逢人配 ♥${rankLabel(level)}✨)`,
    )
    .setColor(color);

  // 比分与级牌进度
  const redFail = game.aFails[0] > 0 ? ` (打A失误 ${game.aFails[0]}/3)` : '';
  const blueFail = game.aFails[1] > 0 ? ` (打A失误 ${game.aFails[1]}/3)` : '';
  const teamBanner = [
    `🔴 **红队 (1、3号位)**: 打 **${rankLabel(game.teamLevels[0])}**${redFail}${game.levelTeam === 0 ? ' ⭐主庄' : ''}`,
    `🔵 **蓝队 (2、4号位)**: 打 **${rankLabel(game.teamLevels[1])}**${blueFail}${game.levelTeam === 1 ? ' ⭐主庄' : ''}`,
  ].join('　｜　');

  // 四个座位状态
  const finishBadges = ['🏆头游', '🥈二游', '🥉三游', '末游'];
  const seatLines = SEATS.map((s) => {
    const slot = room.seats[s];
    const who = slot ? (slot.bot ? `🤖 ${slot.username}` : `<@${slot.userId}>`) : '空位';
    const count = game.hands[s].length;
    const finishIdx = game.finishOrder.indexOf(s);
    const finishTag = finishIdx >= 0 ? ` **${finishBadges[finishIdx]}**` : ` 剩余 **${count}** 张`;
    const isActor = actors.includes(s);
    const turnArrow = isActor ? '👉 ' : '　 ';
    const turnSuffix = isActor ? ' *(等待行动...)*' : '';
    return `${turnArrow}**${SEAT_NAMES[s]}**: ${who} — ${finishTag}${turnSuffix}`;
  }).join('\n');

  // 当前牌桌 / 进贡信息
  let tableStatus = '';
  if (game.phase === 'tribute' && game.tribute) {
    const waiting = actors.map((s) => seatShortName(room, s)).join('、');
    const paidList =
      game.tribute.paid.length > 0
        ? game.tribute.paid.map((p) => `${seatShortName(room, p.from)}: **${cardLabel(p.card)}**`).join('，')
        : '暂无';
    tableStatus = `**进贡类型**: ${game.tribute.kind === 'double' ? '双下进贡' : '单下进贡'}\n**已交贡牌**: ${paidList}\n**等待进贡**: ${waiting}`;
  } else if (game.phase === 'return' && game.tribute) {
    const waiting = actors.map((s) => seatShortName(room, s)).join('、');
    const linksText = game.tribute.links
      .map(
        (l) =>
          `${seatShortName(room, l.from)} ➔ ${seatShortName(room, l.to)} (贡 **${cardLabel(l.card)}**，${l.returnCard !== null ? '✅已还贡' : '⏳待还贡'})`,
      )
      .join('\n');
    tableStatus = `${linksText}\n**等待还贡**: ${waiting}`;
  } else if (game.phase === 'playing' && game.trick) {
    const trick = game.trick;
    const leaderText = `本轮首出: **${seatShortName(room, trick.leader)}**`;
    const lastPlayText = trick.lastPlay
      ? `当前台面最大: **${seatShortName(room, trick.lastPlay.seat)}** 出 **${formatPlay(trick.lastPlay.play, level)}**`
      : `当前台面: **首出自由出牌**`;
    const historyEntries = trick.history
      .slice(-6)
      .map((h) => `${seatShortName(room, h.seat)}: ${h.play ? formatPlay(h.play, level) : '不要'}`)
      .join('\n');
    tableStatus = `${leaderText}\n${lastPlayText}${historyEntries ? `\n\n**本轮出牌记录**:\n${historyEntries}` : ''}`;
  } else if ((game.phase === 'handOver' || game.phase === 'matchOver') && game.lastResult) {
    const r = game.lastResult;
    const winTeamName = r.winTeam === 0 ? '🔴 红队 (1、3号位)' : '🔵 蓝队 (2、4号位)';
    const orderText = r.finishOrder
      .map((s, idx) => `${finishBadges[idx]}: **${seatShortName(room, s)}**`)
      .join(' ➔ ');
    const upText = r.upgrade === 3 ? '双下 (+3级)' : r.upgrade === 2 ? '单下 (+2级)' : '保级 (+1级)';
    tableStatus = `**本局胜方**: ${winTeamName} · **${upText}**\n**名次**: ${orderText}\n**最新级牌**: 红队 **${rankLabel(r.levelsAfter[0])}** vs 蓝队 **${rankLabel(r.levelsAfter[1])}**`;
    if (r.matchWinner !== null) {
      const champ = r.matchWinner === 0 ? '🔴 红队 (1、3号位)' : '🔵 蓝队 (2、4号位)';
      tableStatus += `\n\n🏆🎉 **恭喜 ${champ} 成功过 A 赢得整场比赛！**`;
    }
  }

  embed.setDescription(`${teamBanner}\n\n**【座位状态】**\n${seatLines}`);
  embed.addFields({
    name: `${phaseLabels[game.phase] ?? game.phase}`,
    value: tableStatus || '等待开始',
  });

  if (room.recentLog.length > 0) {
    embed.addFields({
      name: '📜 最新动态',
      value: room.recentLog.slice(-6).join('\n'),
    });
  }

  const nextActorMentions = actors
    .map((s) => room.seats[s])
    .filter((slot) => slot !== null && !slot.bot)
    .map((slot) => `<@${slot!.userId}> (${SEAT_NAMES[slot!.seat]})`);

  const content =
    nextActorMentions.length > 0
      ? `🔔 轮到 ${nextActorMentions.join('、')} 行动！请点击下方 **「🃏 查看手牌 / 出牌」** 按钮：_（私密弹窗仅你自己可见）_`
      : undefined;

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  if (game.phase === 'playing' || game.phase === 'tribute' || game.phase === 'return') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('gd:hand')
        .setLabel('🃏 查看手牌 / 出牌')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('gd:pass')
        .setLabel('⏭️ 不要 (Pass)')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!(game.phase === 'playing' && game.trick?.lastPlay !== null)),
      new ButtonBuilder()
        .setCustomId('gd:hint')
        .setLabel('💡 AI教练建议')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('gd:counter')
        .setLabel('📊 记牌器')
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  } else if (game.phase === 'handOver') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('gd:nexthand')
        .setLabel('▶️ 开始下一局')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId('gd:hand')
        .setLabel('🃏 查看上局剩余手牌')
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  } else if (game.phase === 'matchOver') {
    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('gd:rematch')
        .setLabel('🔄 重新开始新比赛')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('gd:lobby')
        .setLabel('🪑 返回座位大厅')
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(row);
  }

  return { ...(content ? { content } : {}), embeds: [embed], components };
}

function renderLobbyTable(room: DiscordRoom): RenderedMessage {
  const seatLines = SEATS.map((s) => `• ${seatDisplay(room, s)}`).join('\n');
  const embed = new EmbedBuilder()
    .setTitle('🃏 掼蛋 Discord 牌桌大厅')
    .setColor(0x5865f2)
    .setDescription(
      [
        '欢迎来到掼蛋牌桌！纯文本+按钮/下拉菜单模式，**即使在飞机免费社交 Wi-Fi 下也能流畅游玩**。',
        '',
        '**【队伍分配】**',
        '• 🔴 **红队**：1号位(东) & 3号位(西) 为队友',
        '• 🔵 **蓝队**：2号位(南) & 4号位(北) 为队友',
        '',
        '**【当前座位】**',
        seatLines,
        '',
        '💡 *提示：支持 1~4 名真人玩家，未坐满的空位点击「开始游戏」时会自动补齐 AI（单人或有空位对家时自动配置为高水平 AI 教练）。*',
      ].join('\n'),
    );

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('gd:sit:0').setLabel('坐 1号位(红)').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('gd:sit:1').setLabel('坐 2号位(蓝)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gd:sit:2').setLabel('坐 3号位(红)').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('gd:sit:3').setLabel('坐 4号位(蓝)').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gd:stand').setLabel('离开座位').setStyle(ButtonStyle.Secondary),
  );

  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('gd:start').setLabel('▶️ 开始游戏 (自动补AI)').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('gd:fill_bots').setLabel('🤖 补满AI座位').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gd:clear_bots').setLabel('🧹 清空AI').setStyle(ButtonStyle.Secondary),
  );

  return { embeds: [embed], components: [row1, row2] };
}

/**
 * 渲染仅对该玩家可见的私密手牌与出牌操作面板（Ephemeral Message）
 */
export function renderEphemeralHand(
  room: DiscordRoom,
  manager: DiscordRoomManager,
  userId: string,
  notice?: string,
): RenderedMessage {
  const seat = manager.seatOfUser(room, userId);
  if (seat === null || !room.game) {
    const embed = new EmbedBuilder()
      .setTitle('🃏 私密手牌面板')
      .setColor(0x95a5a6)
      .setDescription(seat === null ? '你当前不在牌桌座位上，请先在公共牌桌点击座位入座。' : '游戏尚未开始。');
    return { embeds: [embed], components: [] };
  }

  const game = room.game;
  const level = game.level;
  const view = toPlayerView(game, seat);
  const ui = getUiState(room, userId);
  const { groupedText, indexedText } = formatHandGrouped(view.myHand, level);

  const embed = new EmbedBuilder()
    .setTitle(`🃏 你的私密手牌 · ${SEAT_NAMES[seat]} (剩余 ${view.myHand.length} 张)`)
    .setColor(seat === 0 || seat === 2 ? 0xe74c3c : 0x3498db);

  const descParts: string[] = [];
  if (notice) {
    descParts.push(`> ${notice}\n`);
  }
  descParts.push(`**本局级牌**: **${rankLabel(level)}** (红桃 ♥${rankLabel(level)}✨ 为逢人配，可代替除王外任意牌)`);

  if (game.phase === 'playing' && game.trick) {
    if (game.trick.lastPlay) {
      descParts.push(
        `**当前需压过**: ${seatShortName(room, game.trick.lastPlay.seat)} 的 **${formatPlay(game.trick.lastPlay.play, level)}**`,
      );
    } else {
      descParts.push(
        `**当前台面**: ${game.turn === seat ? '🌟 **轮到你首出（可出任意合法牌型）**' : `等待 ${seatShortName(room, game.turn!)} 首出`}`,
      );
    }
  } else if (game.phase === 'tribute') {
    descParts.push(
      view.myDuty === 'tribute'
        ? '🎁 **请从下方下拉菜单选择要进贡的最大单张（红桃级牌除外）**'
        : '⏳ 等待其他玩家进贡...',
    );
  } else if (game.phase === 'return') {
    descParts.push(
      view.myDuty === 'return'
        ? `🔄 **请从下方下拉菜单选择要还贡的牌（点数 ≤ ${game.config.returnMaxRank}）**`
        : '⏳ 等待其他玩家还贡...',
    );
  }

  descParts.push('\n**【手牌按点数分组】**\n' + groupedText);
  descParts.push('\n**【手牌编号（用于 `#编号` 手动选牌）】**\n' + indexedText);
  embed.setDescription(descParts.join('\n'));

  const components: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

  // 情况 1：玩家手动输入的选牌存在多种合法牌型解释（如逢人配组合歧义），优先展示消歧菜单
  if (ui.pendingInterpretations && ui.pendingInterpretations.length > 0 && view.myDuty === 'play') {
    const select = new StringSelectMenuBuilder()
      .setCustomId('gd:pick_ambig')
      .setPlaceholder('⚠️ 你选的牌有多种组牌方式，请选择具体牌型：')
      .addOptions(
        ui.pendingInterpretations.slice(0, PAGE_SIZE).map((p, idx) =>
          new StringSelectMenuOptionBuilder()
            .setLabel(truncate(formatPlayCompact(p, level), 95))
            .setDescription(truncate(formatPlay(p, level), 95))
            .setValue(String(idx)),
        ),
      );
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('gd:cancel_ambig').setLabel('❌ 取消重选').setStyle(ButtonStyle.Secondary),
      ),
    );
    return { embeds: [embed], components };
  }

  // 情况 2：进贡或还贡阶段且轮到该玩家
  if ((view.myDuty === 'tribute' || view.myDuty === 'return') && (game.phase === 'tribute' || game.phase === 'return')) {
    const actions = manager.getRoom(room.channelId)
      ? (view.myDuty === 'tribute' || view.myDuty === 'return'
          ? getTributeOrReturnCards(game, seat)
          : [])
      : [];
    if (actions.length > 0) {
      const select = new StringSelectMenuBuilder()
        .setCustomId('gd:pick_tribute')
        .setPlaceholder(view.myDuty === 'tribute' ? '🎁 请选择要进贡的牌...' : '🔄 请选择要还贡的牌...')
        .addOptions(
          actions.slice(0, PAGE_SIZE).map((cardId) =>
            new StringSelectMenuOptionBuilder()
              .setLabel(`${formatCard(cardId, level)} (卡牌ID #${cardId})`)
              .setDescription(view.myDuty === 'tribute' ? '点击立即进贡此牌' : '点击立即还贡此牌')
              .setValue(String(cardId)),
          ),
        );
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
    }
    components.push(
      new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId('gd:refresh_hand').setLabel('🔄 刷新手牌').setStyle(ButtonStyle.Secondary),
      ),
    );
    return { embeds: [embed], components };
  }

  // 情况 3：出牌阶段且轮到该玩家
  if (view.myDuty === 'play' && game.phase === 'playing' && game.trick) {
    const toBeat = game.trick.lastPlay?.play.combo ?? null;
    const { allPlays, byCategory, activeCategory: activeCat, filteredPlays } = getFilteredLegalPlays(
      game,
      seat,
      ui.category,
    );
    if (activeCat !== ui.category) {
      ui.category = activeCat;
      ui.page = 0;
    }

    const totalPages = Math.max(1, Math.ceil(filteredPlays.length / PAGE_SIZE));
    const currentPage = Math.min(Math.max(0, ui.page), totalPages - 1);
    ui.page = currentPage;
    const pagePlays = filteredPlays.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

    // Row 1: 牌型分类筛选下拉菜单（当总出牌数 > 0 时展示）
    if (allPlays.length > 0) {
      const catOptions = PLAY_CATEGORIES.filter(
        (c) => c.id === 'all' || (byCategory.get(c.id)?.length ?? 0) > 0,
      ).map((c) => {
        const count = byCategory.get(c.id)?.length ?? 0;
        return new StringSelectMenuOptionBuilder()
          .setLabel(`${c.emoji} ${c.label} (${count}种)`)
          .setValue(c.id)
          .setDefault(c.id === activeCat);
      });

      const catSelect = new StringSelectMenuBuilder()
        .setCustomId('gd:filter_cat')
        .setPlaceholder('📂 按牌型筛选合法出牌...')
        .addOptions(catOptions);
      components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(catSelect));

      // Row 2: 当前分类与页码下的具体出牌下拉菜单（最多 25 项，点击即出牌）
      if (pagePlays.length > 0) {
        const playSelect = new StringSelectMenuBuilder()
          .setCustomId('gd:pick_play')
          .setPlaceholder(
            `🃏 选择要出的牌 (${ currentPage + 1 }/${totalPages}页，共${filteredPlays.length}种)...`,
          )
          .addOptions(
            pagePlays.map((p, idx) => {
              const globalIdx = currentPage * PAGE_SIZE + idx;
              return new StringSelectMenuOptionBuilder()
                .setLabel(truncate(formatPlayCompact(p, level), 95))
                .setDescription(truncate(formatPlay(p, level), 95))
                .setValue(String(globalIdx));
            }),
          );
        components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(playSelect));
      }
    } else {
      embed.addFields({
        name: '⚠️ 无牌可压',
        value: '你手中没有能压过当前台面的牌型，请点击下方 **「⏭️ 不要 (Pass)」**。',
      });
    }

    // 获取 AI 推荐的一键按钮文案
    const adviceRes = manager.getAdviceForUser(room.channelId, userId);
    let aiBtnLabel = '✨ 出AI推荐牌';
    if (adviceRes.ok) {
      if (adviceRes.decision.type === 'pass') {
        aiBtnLabel = '✨ AI推荐: 不要(Pass)';
      } else if (adviceRes.decision.type === 'play') {
        aiBtnLabel = truncate(`✨ AI推荐: ${formatPlayCompact(adviceRes.decision.play, level)}`, 75);
      }
    }

    // Row 3: 快捷操作按钮（AI推荐一键出、不要、手动输入选牌、刷新）
    const actionButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('gd:play_ai')
        .setLabel(aiBtnLabel)
        .setStyle(ButtonStyle.Success)
        .setDisabled(!adviceRes.ok),
      new ButtonBuilder()
        .setCustomId('gd:ephem_pass')
        .setLabel('⏭️ 不要 (Pass)')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(toBeat === null),
      new ButtonBuilder()
        .setCustomId('gd:open_modal')
        .setLabel('⌨️ 手动输入选牌')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId('gd:refresh_hand')
        .setLabel('🔄 刷新')
        .setStyle(ButtonStyle.Secondary),
    );
    components.push(actionButtons);

    // Row 4: 如果当前分类合法出牌超过 25 种，提供翻页按钮
    if (totalPages > 1) {
      const pageRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('gd:page_prev')
          .setLabel(`⬅️ 上一页 (${currentPage + 1}/${totalPages})`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage <= 0),
        new ButtonBuilder()
          .setCustomId('gd:page_next')
          .setLabel(`➡️ 下一页 (${currentPage + 1}/${totalPages})`)
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(currentPage >= totalPages - 1),
      );
      components.push(pageRow);
    }

    return { embeds: [embed], components };
  }

  // 情况 4：当前未轮到该玩家行动（可随时看牌、刷新、看记牌器）
  const waitRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('gd:refresh_hand').setLabel('🔄 刷新手牌状态').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gd:counter').setLabel('📊 查看记牌器').setStyle(ButtonStyle.Secondary),
  );
  components.push(waitRow);
  return { embeds: [embed], components };
}

export function getFilteredLegalPlays(
  game: NonNullable<DiscordRoom['game']>,
  seat: Seat,
  category: PlayCategory,
): {
  allPlays: Play[];
  byCategory: Map<PlayCategory, Play[]>;
  activeCategory: PlayCategory;
  filteredPlays: Play[];
} {
  const toBeat = game.trick?.lastPlay?.play.combo ?? null;
  const hand = game.hands[seat];
  const allPlays = generatePlays(hand, game.level, game.config, toBeat);

  const byCategory = new Map<PlayCategory, Play[]>();
  byCategory.set('all', allPlays);
  for (const cat of PLAY_CATEGORIES) {
    if (cat.id !== 'all') byCategory.set(cat.id, []);
  }
  for (const p of allPlays) {
    const cat = categoryOfPlay(p);
    byCategory.get(cat)!.push(p);
  }

  let activeCategory = category;
  if ((byCategory.get(activeCategory)?.length ?? 0) === 0) {
    activeCategory = 'all';
  }

  const filteredPlays =
    activeCategory === 'all'
      ? allPlays
      : sortRankOrderForDisplay(byCategory.get(activeCategory) ?? [], game.level);

  return { allPlays, byCategory, activeCategory, filteredPlays };
}

export function getTributeOrReturnCards(game: NonNullable<DiscordRoom['game']>, seat: Seat): CardId[] {
  const actions = legalActions(game, seat);
  const cards: CardId[] = [];
  for (const a of actions) {
    if (a.type === 'tribute' || a.type === 'returnTribute') {
      cards.push(a.card);
    }
  }
  return sortHand(cards, game.level);
}

/**
 * 渲染 AI 教练建议私密 Embed
 */
export function renderCoachHintEmbed(room: DiscordRoom, seat: Seat, advice: CoachAdvice): EmbedBuilder {
  const level = room.game!.level;
  const recText =
    advice.decision.type === 'pass'
      ? '⏭️ **不要 (Pass)**'
      : `🃏 **${formatPlay(advice.decision.play, level)}**`;

  const embed = new EmbedBuilder()
    .setTitle(`💡 AI 教练战术分析 · ${SEAT_NAMES[seat]}`)
    .setColor(0x2ecc71)
    .setDescription(
      [
        `**推荐行动**: ${recText}`,
        '',
        '**战术理由**:',
        ...(advice.reasons.length > 0 ? advice.reasons.map((r) => `• ${r}`) : ['• 综合手牌轮次与控场最优']),
      ].join('\n'),
    );

  if (advice.insights) {
    if (advice.insights.grouping) {
      embed.addFields({
        name: '🧩 建议拆牌方案',
        value: truncate(advice.insights.grouping, 1000),
      });
    }
    if (advice.insights.assessment.length > 0) {
      embed.addFields({
        name: '📈 局势评估',
        value: truncate(advice.insights.assessment.map((a) => `• ${a}`).join('\n'), 1000),
      });
    }
  }
  return embed;
}

/**
 * 渲染私密记牌器 Embed
 */
export function renderCardCounterEmbed(room: DiscordRoom, seat: Seat): EmbedBuilder {
  const game = room.game!;
  const text = formatCardCounter(game.playedCards, game.hands[seat], game.level);
  return new EmbedBuilder()
    .setTitle(`📊 实时记牌器 · ${SEAT_NAMES[seat]}视角（外场未知牌统计）`)
    .setColor(0x9b59b6)
    .setDescription(
      `已扣除**本局所有已打出的公开牌**以及**你自己的手牌**，其余三位玩家手中合计剩余：\n\n${text}`,
    );
}

/**
 * 构建手动输入选牌的 Discord Modal
 */
export function buildPlayInputModal(level: Level): ModalBuilder {
  const modal = new ModalBuilder()
    .setCustomId('gd:modal_play')
    .setTitle(`手动输入出牌 (本局打 ${rankLabel(level)})`);

  const input = new TextInputBuilder()
    .setCustomId('cards_input')
    .setLabel('输入牌面简写 或 #手牌编号')
    .setPlaceholder('示例: 88 | 55522 | 34567 | 10 10 | ♥2 ♠A | 小王 | #1 #2 #3 | #1-5')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(80);

  modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  return modal;
}
