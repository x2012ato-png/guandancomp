import { REST, Routes } from 'discord.js';
import { guandanSlashCommand } from './commands.ts';

export async function registerDiscordCommands(opts: {
  token: string;
  clientId: string;
  guildId?: string;
}): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(opts.token);
  const body = [guandanSlashCommand.toJSON()];

  if (opts.guildId) {
    await rest.put(Routes.applicationGuildCommands(opts.clientId, opts.guildId), { body });
    console.log(`Registered /guandan slash command to guild ${opts.guildId}`);
  } else {
    await rest.put(Routes.applicationCommands(opts.clientId), { body });
    console.log('Registered global /guandan slash command');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const token = process.env.DISCORD_BOT_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;
  const guildId = process.env.DISCORD_GUILD_ID;

  if (!token || !clientId) {
    console.error('Missing DISCORD_BOT_TOKEN or DISCORD_CLIENT_ID environment variables.');
    process.exit(1);
  }

  registerDiscordCommands({ token, clientId, ...(guildId ? { guildId } : {}) }).catch((err) => {
    console.error('Failed to register commands:', err);
    process.exit(1);
  });
}
