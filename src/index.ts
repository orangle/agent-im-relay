import { randomUUID } from 'node:crypto';
import {
  type AnyThreadChannel,
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { streamAgentSession, type AgentStreamEvent } from './agent/session.js';
import { config } from './config.js';
import { askCommand, handleAskCommand } from './commands/ask.js';
import { codeCommand, handleCodeCommand } from './commands/code.js';
import { streamAgentToDiscord, type StreamTargetChannel } from './discord/stream.js';
import { ensureMentionThread } from './discord/thread.js';

type CommandHandler = (interaction: ChatInputCommandInteraction) => Promise<void>;

const commandHandlers = new Map<string, CommandHandler>([
  ['code', handleCodeCommand],
  ['ask', handleAskCommand],
]);

const commandDefinitions = [codeCommand, askCommand];
const threadSessions = new Map<string, string>();

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

const rest = new REST({ version: '10' }).setToken(config.discordToken);

async function registerSlashCommands(): Promise<void> {
  const body = commandDefinitions.map((command) => command.toJSON());

  if (config.guildIds.length > 0) {
    await Promise.all(
      config.guildIds.map(async (guildId) => {
        await rest.put(Routes.applicationGuildCommands(config.discordClientId, guildId), { body });
      }),
    );
    console.log(`Registered slash commands for ${config.guildIds.length} guild(s).`);
    return;
  }

  await rest.put(Routes.applicationCommands(config.discordClientId), { body });
  console.log('Registered global slash commands.');
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function extractMentionPrompt(content: string, botId: string): string {
  const mentionRegex = new RegExp(`<@!?${botId}>`, 'g');
  return content.replace(mentionRegex, '').replace(/\s+/g, ' ').trim();
}

async function* captureAgentEvents(
  events: AsyncIterable<AgentStreamEvent>,
  onEvent: (event: AgentStreamEvent) => void,
): AsyncGenerator<AgentStreamEvent, void> {
  for await (const event of events) {
    onEvent(event);
    yield event;
  }
}

async function runMentionConversation(thread: AnyThreadChannel, prompt: string): Promise<void> {
  const existingSessionId = threadSessions.get(thread.id);
  const initialSessionId = existingSessionId ?? randomUUID();
  let resolvedSessionId = existingSessionId;
  let assistantResponse = '';
  const events = streamAgentSession({
    mode: 'code',
    prompt,
    cwd: config.claudeCwd,
    ...(existingSessionId
      ? { resumeSessionId: existingSessionId }
      : { sessionId: initialSessionId }),
  });

  await streamAgentToDiscord(
    { channel: thread as StreamTargetChannel },
    captureAgentEvents(events, (event) => {
      if (event.type === 'text') {
        assistantResponse += event.delta;
      } else if (event.type === 'done') {
        if (!assistantResponse.trim()) {
          assistantResponse = event.result;
        }
        resolvedSessionId = event.sessionId ?? initialSessionId;
      }
    }),
  );

  if (resolvedSessionId) {
    threadSessions.set(thread.id, resolvedSessionId);
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  console.log(`Received ${signal}. Shutting down...`);
  client.destroy();
}

client.once(Events.ClientReady, async (readyClient) => {
  console.log(`Logged in as ${readyClient.user.tag}`);
  await registerSlashCommands();
});

client.rest.on('rateLimited', (rateLimitData) => {
  console.warn(`Discord rate limit hit on ${rateLimitData.route}`);
});

client.on(Events.Error, (error) => {
  console.error('Discord client error:', error);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const handler = commandHandlers.get(interaction.commandName);
  if (!handler) return;

  try {
    await handler(interaction);
  } catch (error) {
    const errorText = toErrorMessage(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: `Unexpected error: ${errorText}`, ephemeral: true });
    } else {
      await interaction.reply({ content: `Unexpected error: ${errorText}`, ephemeral: true });
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.inGuild()) return;

  const botUser = client.user;
  if (!botUser || !message.mentions.has(botUser)) return;

  const prompt = extractMentionPrompt(message.content, botUser.id);
  if (!prompt) {
    await message.reply('Please include a prompt after mentioning me.');
    return;
  }

  const replyTarget = message.channel.isThread() ? message.channel : message;

  try {
    if (message.channel.isThread()) {
      await runMentionConversation(message.channel, prompt);
      return;
    }

    const thread = await ensureMentionThread(message, prompt);
    await runMentionConversation(thread, prompt);
  } catch (error) {
    const errorText = toErrorMessage(error);
    if ('send' in replyTarget) {
      await replyTarget.send(`Failed to process mention: ${errorText}`);
    } else {
      await replyTarget.reply(`Failed to process mention: ${errorText}`);
    }
  }
});

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

process.on('unhandledRejection', (error) => {
  console.error('Unhandled rejection:', error);
});

void client.login(config.discordToken);
