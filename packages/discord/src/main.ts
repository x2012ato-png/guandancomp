import { Client, Events, GatewayIntentBits } from 'discord.js';
import { DiscordController } from './controller.ts';
import { registerDiscordCommands } from './registerCommands.ts';

export interface StartBotOptions {
  readonly token: string;
  readonly clientId?: string;
  readonly guildId?: string;
  /** 是否启用 `!gd` 文本消息指令（需要 Developer Portal 开启 Message Content Intent；默认 false，仅用斜杠命令与按钮） */
  readonly enableMessageContentIntent?: boolean;
}

export async function startDiscordBot(opts: StartBotOptions): Promise<Client> {
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages];
  if (opts.enableMessageContentIntent) {
    intents.push(GatewayIntentBits.MessageContent);
  }

  const client = new Client({ intents });
  const controller = new DiscordController();

  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`🃏 Guandan Discord Bot logged in as ${readyClient.user.tag} (App ID: ${readyClient.user.id})`);
    const inviteUrl = `https://discord.com/oauth2/authorize?client_id=${readyClient.user.id}&permissions=274877975552&scope=bot%20applications.commands`;
    console.log(`🔗 Invite URL: ${inviteUrl}`);

    if (process.env.DISCORD_REGISTER_COMMANDS !== 'false') {
      const clientId = opts.clientId ?? readyClient.user.id;
      try {
        await registerDiscordCommands({
          token: opts.token,
          clientId,
          ...(opts.guildId ? { guildId: opts.guildId } : {}),
        });
        // 同时为当前已加入的所有服务器注册 Guild 命令，确保斜杠命令秒级生效
        for (const guild of readyClient.guilds.cache.values()) {
          if (guild.id !== opts.guildId) {
            await registerDiscordCommands({
              token: opts.token,
              clientId,
              guildId: guild.id,
            }).catch((err) => console.warn(`Could not register guild commands for ${guild.name}:`, err));
          }
        }
      } catch (err) {
        console.warn('Could not auto-register slash commands on startup:', err);
      }
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    console.log(`📥 Joined new guild: ${guild.name} (${guild.id}), registering /guandan command...`);
    try {
      await registerDiscordCommands({
        token: opts.token,
        clientId: opts.clientId ?? guild.client.user.id,
        guildId: guild.id,
      });
    } catch (err) {
      console.warn(`Failed to register commands on newly joined guild ${guild.id}:`, err);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    await controller.handleInteraction(interaction);
  });

  if (opts.enableMessageContentIntent) {
    client.on(Events.MessageCreate, async (message) => {
      await controller.handleMessage(message);
    });
  }

  await client.login(opts.token);
  return client;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error(
      [
        '❌ Missing DISCORD_BOT_TOKEN environment variable.',
        '',
        'Usage:',
        '  DISCORD_BOT_TOKEN="your-bot-token" npm -w @guandan/discord run start',
        '',
        'Optional environment variables:',
        '  DISCORD_GUILD_ID="your-server-id"       # Instant guild slash command registration',
        '  DISCORD_MESSAGE_CONTENT="true"          # Also enable !gd text command prefix',
      ].join('\n'),
    );
    process.exit(1);
  }

  startDiscordBot({
    token,
    ...(process.env.DISCORD_CLIENT_ID ? { clientId: process.env.DISCORD_CLIENT_ID } : {}),
    ...(process.env.DISCORD_GUILD_ID ? { guildId: process.env.DISCORD_GUILD_ID } : {}),
    enableMessageContentIntent: process.env.DISCORD_MESSAGE_CONTENT === 'true',
  }).catch((err) => {
    console.error('Failed to start Guandan Discord bot:', err);
    process.exit(1);
  });
}
