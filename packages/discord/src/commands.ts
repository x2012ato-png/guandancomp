import { SlashCommandBuilder } from 'discord.js';

export const guandanSlashCommand = new SlashCommandBuilder()
  .setName('guandan')
  .setDescription('在 Discord 频道中进行掼蛋游戏（纯文本+按钮/下拉菜单，支持飞机免费社交 Wi-Fi）')
  .addSubcommand((sub) =>
    sub.setName('create').setDescription('在当前频道创建或刷新掼蛋牌桌大厅'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('sit')
      .setDescription('入座指定座位（1、3号位为红队，2、4号位为蓝队）')
      .addIntegerOption((opt) =>
        opt
          .setName('seat')
          .setDescription('座位号 (1-4)')
          .setRequired(true)
          .addChoices(
            { name: '1号位 (红队·东)', value: 1 },
            { name: '2号位 (蓝队·南)', value: 2 },
            { name: '3号位 (红队·西，1号队友)', value: 3 },
            { name: '4号位 (蓝队·北，2号队友)', value: 4 },
          ),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('start').setDescription('开始游戏（未坐满的空位将自动补齐 AI）'),
  )
  .addSubcommand((sub) =>
    sub.setName('hand').setDescription('私密查看手牌与出牌面板（仅你自己可见）'),
  )
  .addSubcommand((sub) =>
    sub
      .setName('play')
      .setDescription('快速输入牌面简写或编号出牌（如 88, 55522, 34567, ♥2, #1 #2）')
      .addStringOption((opt) =>
        opt
          .setName('cards')
          .setDescription('牌面简写（如 88、55522、34567、小王）或手牌编号（如 #1 #2）')
          .setRequired(true),
      ),
  )
  .addSubcommand((sub) =>
    sub.setName('pass').setDescription('本轮不要（过牌）'),
  )
  .addSubcommand((sub) =>
    sub.setName('hint').setDescription('私密查看 AI 教练对当前手牌的出牌建议'),
  )
  .addSubcommand((sub) =>
    sub.setName('counter').setDescription('私密查看外场剩余未知牌记牌器'),
  )
  .addSubcommand((sub) =>
    sub.setName('reset').setDescription('重置并关闭当前频道的掼蛋牌桌'),
  );
