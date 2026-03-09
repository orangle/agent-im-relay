export const relayPlatforms = ['discord', 'feishu'] as const;

export type RelayPlatform = (typeof relayPlatforms)[number];

export function isRelayPlatform(value: unknown): value is RelayPlatform {
  return typeof value === 'string' && relayPlatforms.includes(value as RelayPlatform);
}

export function inferRelayPlatformFromConversationId(conversationId: string): RelayPlatform {
  return /^\d+$/.test(conversationId) ? 'discord' : 'feishu';
}
