import { randomUUID } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  applyMessageControlDirectives,
  ensureConversationArtifactPaths,
  getConversationArtifactMetadata,
  initState,
  persistConversationArtifactMetadata,
  persistState,
  preprocessConversationMessage,
  processedEventIds,
  processedMessages,
  type ArtifactRecord,
  type BackendName,
} from '@agent-im-relay/core';
import { createFeishuClient } from './api.js';
import type { FeishuConfig } from './config.js';
import {
  buildFeishuBackendConfirmationCardPayload,
  buildFeishuHelpCardPayload,
} from './cards.js';
import {
  FEISHU_CARD_MAX_COUNT,
  buildFeishuFileSummaryCardPayload,
  formatFeishuMarkdownCards,
  normalizeFeishuMarkdownOutput,
} from './formatting.js';
import {
  extractFeishuAttachmentInfos,
  extractFeishuMessageText,
  normalizeFeishuEvent,
  resolveConversationId,
  resolveConversationIdFromAction,
  shouldProcessFeishuMessage,
  type FeishuAttachmentInfo,
  type FeishuActionPayload,
  type FeishuMessagePayload,
  type FeishuRawEvent,
} from './conversation.js';
import {
  buildFeishuSessionChatRecord,
  findFeishuSessionChatBySourceMessage,
  initializeFeishuSessionChats,
  persistFeishuSessionChats,
  resolveFeishuChatSessionKind,
} from './session-chat.js';
import {
  rememberMirroredFeishuMessageId,
  consumeMirroredFeishuMessageId,
} from './launch-state.js';
import { launchFeishuSessionFromPrivateChat } from './launcher.js';
import {
  buildFeishuCardContext,
  drainPendingFeishuAttachments,
  executeFeishuResumeCommand,
  handleFeishuControlAction,
  getFeishuSessionStatus,
  isFeishuHelpCommand,
  openFeishuSessionControlPanel,
  isFeishuDoneCommand,
  isFeishuStatusCommand,
  parseFeishuResumeCommand,
  queuePendingFeishuAttachments,
  resumePendingFeishuRun,
  resolveFeishuMessageRequest,
  type FeishuRuntimeTransport,
  type FeishuTarget,
} from './runtime.js';
import { runFeishuSessionFlow } from './session-flow.js';
import { describeError } from './utils.js';

type FeishuClient = ReturnType<typeof createFeishuClient>;

export const FEISHU_MESSAGE_EVENT_TYPE = 'im.message.receive_v1';
export const FEISHU_CARD_ACTION_EVENT_TYPE = 'card.action.trigger';
export const FEISHU_MENU_ACTION_EVENT_TYPE = 'application.bot.menu_v6';

export type FeishuMessageReceiveEvent = {
  event_id?: string;
  sender?: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
  };
  message: {
    message_id: string;
    root_id?: string;
    chat_id: string;
    chat_type?: 'p2p' | 'group' | string;
    message_type?: string;
    content?: string;
    mentions?: Array<{
      name?: string;
      id?: {
        open_id?: string;
        union_id?: string;
        user_id?: string;
      };
    }>;
  };
};

export type FeishuCardActionTriggerEvent = {
  event_id?: string;
  open_id?: string;
  user_id?: string;
  open_message_id?: string;
  action?: {
    value?: Record<string, unknown>;
    form?: Record<string, unknown>;
    tag?: string;
    option?: string;
    timezone?: string;
  };
};

export type FeishuMenuActionTriggerEvent = {
  event_id?: string;
  operator?: {
    operator_id?: {
      open_id?: string;
      user_id?: string;
    };
  };
  event_key?: string;
  chat_id?: string;
  timestamp?: number;
};

function resolveResumeSessionId(action?: FeishuActionPayload['value']): string | undefined {
  if (!action) {
    return undefined;
  }

  const direct = typeof action.sessionId === 'string' ? action.sessionId : undefined;
  const legacy = typeof action.session_id === 'string' ? action.session_id : undefined;
  const formValue = (() => {
    const form = (action as { form?: Record<string, unknown> }).form;
    if (!form) {
      return undefined;
    }
    const directValue = typeof form.sessionId === 'string' ? form.sessionId : undefined;
    const legacyValue = typeof form.session_id === 'string' ? form.session_id : undefined;
    if (directValue || legacyValue) {
      return directValue ?? legacyValue;
    }

    const entries = Object.values(form).filter(value => typeof value === 'string') as string[];
    if (entries.length === 1) {
      return entries[0];
    }

    return undefined;
  })();
  const raw = direct ?? legacy ?? formValue;
  if (!raw) {
    return undefined;
  }

  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

function buildFeishuStatusText(conversationId: string): string {
  const status = getFeishuSessionStatus(conversationId);
  const lines = [
    '**会话状态信息**',
    '',
    `• Conversation ID: \`${conversationId}\``,
  ];

  if (status.sessionId) {
    lines.push(`• Session ID: \`${status.sessionId}\``);
  }
  if (status.backend) {
    lines.push(`• Backend: ${status.backend}`);
  }
  if (status.model) {
    lines.push(`• Model: ${status.model}`);
  }
  if (status.effort) {
    lines.push(`• Effort: ${status.effort}`);
  }
  if (status.cwd) {
    lines.push(`• 当前目录: \`${status.cwd}\``);
  }
  if (status.hasBinding) {
    lines.push(`• Binding 状态: ${status.bindingStatus ?? 'unknown'}`);
  }
  lines.push(`• Running: ${status.running ? 'yes' : 'no'}`);

  return lines.join('\n');
}

type RouterDependencies = {
  client?: FeishuClient;
  readFileImpl?: typeof readFile;
};

const FEISHU_EVENT_DEDUP_TTL_MS = 5 * 60_000;
const FEISHU_ACTION_DEDUP_TTL_MS = 5_000;
const FEISHU_UNAUTHORIZED_TEXT = 'Unauthorized to perform this action.';
const FEISHU_UNAUTHORIZED_CODE_TEXT = 'Unauthorized to run code tasks. Use /ask for non-tool requests or ask an admin to grant access.';

function isAuthorizationEnabled(config: FeishuConfig): boolean {
  return Array.isArray(config.feishuAuthorizedOpenIds) && config.feishuAuthorizedOpenIds.length > 0;
}

function isAuthorizedActor(config: FeishuConfig, openId?: string): boolean {
  if (!isAuthorizationEnabled(config)) {
    return true;
  }

  if (!openId) {
    return false;
  }

  return config.feishuAuthorizedOpenIds.includes(openId);
}

type ProcessedKeyStore = {
  processed: Set<string>;
  timers: Map<string, ReturnType<typeof setTimeout>>;
};

type DedupEntry = {
  key?: string;
  store: ProcessedKeyStore;
  ttlMs: number;
};

type DedupClaim = {
  duplicate: boolean;
  complete(succeeded: boolean): void;
};

function maybeUnrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof (timer as { unref?: () => void }).unref === 'function') {
    (timer as { unref: () => void }).unref();
  }
}

function scheduleProcessedKey(
  store: ProcessedKeyStore,
  key: string,
  ttlMs: number,
): void {
  const existingTimer = store.timers.get(key);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  store.processed.add(key);
  const timer = setTimeout(() => {
    store.processed.delete(key);
    store.timers.delete(key);
  }, ttlMs);
  maybeUnrefTimer(timer);
  store.timers.set(key, timer);
}

function createFeishuIngressDeduplicator() {
  const inFlightKeys = new Set<string>();
  const processedActionKeys = new Set<string>();
  const eventTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const messageTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const actionTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const eventStore: ProcessedKeyStore = {
    processed: processedEventIds,
    timers: eventTimers,
  };
  const messageStore: ProcessedKeyStore = {
    processed: processedMessages,
    timers: messageTimers,
  };
  const actionStore: ProcessedKeyStore = {
    processed: processedActionKeys,
    timers: actionTimers,
  };

  function claim(entries: DedupEntry[]): DedupClaim {
    const normalizedEntries = entries
      .filter((entry): entry is DedupEntry & { key: string } => typeof entry.key === 'string' && entry.key.length > 0)
      .filter((entry, index, allEntries) => allEntries.findIndex((candidate) => candidate.key === entry.key) === index);

    if (normalizedEntries.some((entry) => entry.store.processed.has(entry.key) || inFlightKeys.has(entry.key))) {
      return {
        duplicate: true,
        complete: () => undefined,
      };
    }

    for (const entry of normalizedEntries) {
      inFlightKeys.add(entry.key);
    }

    return {
      duplicate: false,
      complete(succeeded: boolean): void {
        for (const entry of normalizedEntries) {
          inFlightKeys.delete(entry.key);
          if (succeeded) {
            scheduleProcessedKey(entry.store, entry.key, entry.ttlMs);
          }
        }
      },
    };
  }

  function claimMessage(payload: FeishuMessageReceiveEvent): DedupClaim {
    return claim([
      {
        key: typeof payload.event_id === 'string' ? `feishu:event:${payload.event_id}` : undefined,
        store: eventStore,
        ttlMs: FEISHU_EVENT_DEDUP_TTL_MS,
      },
      {
        key: typeof payload.message.message_id === 'string'
          ? `feishu:message:${payload.message.message_id}`
          : undefined,
        store: messageStore,
        ttlMs: FEISHU_EVENT_DEDUP_TTL_MS,
      },
    ]);
  }

  function claimCardAction(payload: FeishuCardActionTriggerEvent): DedupClaim {
    const actionValue = payload.action?.value;
    const actionKey = typeof payload.event_id === 'string'
      ? undefined
      : JSON.stringify({
        actorId: payload.open_id ?? payload.user_id,
        openMessageId: payload.open_message_id,
        tag: payload.action?.tag,
        option: payload.action?.option,
        timezone: payload.action?.timezone,
        value: actionValue,
      });

    return claim([
      {
        key: typeof payload.event_id === 'string' ? `feishu:event:${payload.event_id}` : undefined,
        store: eventStore,
        ttlMs: FEISHU_EVENT_DEDUP_TTL_MS,
      },
      {
        key: actionKey ? `feishu:action:${actionKey}` : undefined,
        store: actionStore,
        ttlMs: FEISHU_ACTION_DEDUP_TTL_MS,
      },
    ]);
  }

  function claimMenuAction(payload: FeishuMenuActionTriggerEvent): DedupClaim {
    const operatorId = payload.operator?.operator_id?.open_id ?? payload.operator?.operator_id?.user_id;
    const menuKey = typeof payload.event_id === 'string'
      ? undefined
      : typeof payload.timestamp === 'number'
        ? `feishu:menu:${payload.chat_id ?? ''}:${payload.event_key ?? ''}:${operatorId ?? ''}:${payload.timestamp}`
        : undefined;

    return claim([
      {
        key: typeof payload.event_id === 'string' ? `feishu:event:${payload.event_id}` : undefined,
        store: eventStore,
        ttlMs: FEISHU_EVENT_DEDUP_TTL_MS,
      },
      {
        key: menuKey,
        store: eventStore,
        ttlMs: FEISHU_EVENT_DEDUP_TTL_MS,
      },
    ]);
  }

  return {
    claimMessage,
    claimCardAction,
    claimMenuAction,
  };
}

function resolveSenderOpenId(payload: FeishuMessageReceiveEvent): string | undefined {
  return payload.sender?.sender_id?.open_id;
}

function shouldFallbackToChatSend(error: unknown): boolean {
  return error instanceof Error
    && /Feishu reply message failed with HTTP 400(?:[.:]|$)/.test(error.message);
}

async function withReplyFallback<T>(
  target: FeishuTarget,
  attemptReply: () => Promise<T>,
  attemptChatSend: () => Promise<T>,
): Promise<T> {
  if (!target.replyToMessageId) {
    return attemptChatSend();
  }

  try {
    return await attemptReply();
  } catch (error) {
    if (!shouldFallbackToChatSend(error)) {
      throw error;
    }

    return attemptChatSend();
  }
}

function createTransport(
  client: FeishuClient,
  readFileImpl: typeof readFile,
): FeishuRuntimeTransport {
  async function sendText(target: FeishuTarget, content: string): Promise<void> {
    const normalized = normalizeFeishuMarkdownOutput(content);
    if (!normalized) {
      return;
    }

    const cards = formatFeishuMarkdownCards(normalized);
    if (cards.length === 0) {
      return;
    }

    if (cards.length > FEISHU_CARD_MAX_COUNT) {
      const { filePath, filename } = await writeLargeOutputFile({
        conversationId: target.chatId,
        content: normalized,
      });
      const summaryCard = buildFeishuFileSummaryCardPayload({
        title: '内容较长，已生成文件',
        intro: '内容较长，已改为文件发送，请查看附件。',
        files: [filename],
        note: '如需我拆解重点或转成卡片展示，请告诉我。',
      });

      await withReplyFallback(
        target,
        async () => client.replyMessage({
          messageId: target.replyToMessageId!,
          msgType: 'interactive',
          content: JSON.stringify(summaryCard),
        }),
        async () => client.sendCard(target.chatId, summaryCard),
      );

      await uploadFile(target, filePath);
      return;
    }

    for (const card of cards) {
      await withReplyFallback(
        target,
        async () => {
          await client.replyMessage({
            messageId: target.replyToMessageId!,
            msgType: 'interactive',
            content: JSON.stringify(card.card),
          });
        },
        async () => {
          await client.sendCard(target.chatId, card.card);
        },
      );
    }
  }

  async function sendCard(target: FeishuTarget, card: Record<string, unknown>): Promise<string | undefined> {
    return withReplyFallback(
      target,
      async () => {
        return client.replyMessage({
          messageId: target.replyToMessageId!,
          msgType: 'interactive',
          content: JSON.stringify(card),
        });
      },
      async () => {
        return client.sendCard(target.chatId, card);
      },
    );
  }

  async function updateCard(target: FeishuTarget, messageId: string, card: Record<string, unknown>): Promise<void> {
    await client.updateCardMessage(messageId, card);
  }

  async function uploadFile(target: FeishuTarget, filePath: string): Promise<void> {
    const buffer = await readFileImpl(filePath);
    const fileKey = await client.uploadFileContent({
      fileName: filePath.split('/').pop() ?? 'artifact',
      data: buffer,
    });

    await withReplyFallback(
      target,
      async () => {
        await client.replyMessage({
          messageId: target.replyToMessageId!,
          msgType: 'file',
          content: JSON.stringify({ file_key: fileKey }),
        });
      },
      async () => {
        await client.sendFileMessage(target.chatId, fileKey);
      },
    );
  }

  return {
    sendText,
    sendCard,
    updateCard,
    uploadFile,
  };
}

async function buildManagedAttachment(
  client: FeishuClient,
  messageId: string,
  fileInfo: FeishuAttachmentInfo,
): Promise<{
  fileKey: string;
  name: string;
  url: string;
  contentType?: string;
  size?: number;
}> {
  const response = await client.downloadMessageResource(messageId, fileInfo.fileKey, fileInfo.resourceType);
  if (!response.ok) {
    throw new Error(`Failed to download Feishu attachment: ${fileInfo.fileName}`);
  }

  const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    fileKey: fileInfo.fileKey,
    name: fileInfo.fileName,
    url: `data:${contentType};base64,${buffer.toString('base64')}`,
    contentType,
    size: buffer.byteLength,
  };
}

async function buildManagedAttachments(
  client: FeishuClient,
  messageId: string,
  attachments: FeishuAttachmentInfo[],
) {
  return Promise.all(attachments.map(async attachment =>
    buildManagedAttachment(client, messageId, attachment)));
}

function buildAttachmentReceiptText(attachments: FeishuAttachmentInfo[]): string {
  const onlyImages = attachments.every(attachment => attachment.resourceType === 'image');
  if (attachments.length === 1) {
    return onlyImages
      ? 'Image received. Send a prompt to use it.'
      : 'File received. Send a prompt to use it.';
  }

  return onlyImages
    ? 'Images received. Send a prompt to use them.'
    : 'Attachments received. Send a prompt to use them.';
}

async function writeLargeOutputFile(options: {
  conversationId: string;
  content: string;
}): Promise<{ filePath: string; filename: string }> {
  const paths = await ensureConversationArtifactPaths(options.conversationId);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `feishu-output-${timestamp}.md`;
  const filePath = path.join(paths.outgoingDir, filename);

  await writeFile(filePath, options.content, 'utf8');
  const storedStats = await stat(filePath);
  const record: ArtifactRecord = {
    id: randomUUID(),
    filename,
    relativePath: path.join('outgoing', filename),
    mimeType: 'text/markdown',
    size: storedStats.size,
    kind: 'markdown',
    createdAt: new Date().toISOString(),
  };

  const existing = await getConversationArtifactMetadata(options.conversationId);
  await persistConversationArtifactMetadata(options.conversationId, {
    incoming: existing.incoming,
    outgoing: [...existing.outgoing, record],
    lastUpdatedAt: record.createdAt,
  });

  return { filePath, filename };
}

export function normalizeFeishuMessageReceiveEvent(payload: FeishuMessageReceiveEvent): FeishuRawEvent {
  return {
    event: {
      message: {
        message_id: payload.message.message_id,
        root_message_id: payload.message.root_id,
        chat_id: payload.message.chat_id,
        chat_type: payload.message.chat_type,
        message_type: payload.message.message_type,
        content: payload.message.content,
        mentions: payload.message.mentions,
      },
    },
  };
}

export function normalizeFeishuCardActionTriggerEvent(payload: FeishuCardActionTriggerEvent): FeishuRawEvent {
  const actionValue = payload.action?.value ?? {};
  const actionForm = payload.action?.form;
  return {
    action: {
      value: {
        ...actionValue,
        ...(actionForm ? { form: actionForm } : {}),
        replyToMessageId: typeof actionValue.replyToMessageId === 'string'
          ? actionValue.replyToMessageId
          : payload.open_message_id,
      },
    },
  };
}

export function normalizeFeishuMenuActionTriggerEvent(payload: FeishuMenuActionTriggerEvent): FeishuRawEvent {
  return {
    action: {
      value: {
        source: 'menu',
        action: payload.event_key,
        chatId: payload.chat_id,
        conversationId: payload.chat_id,
      },
    },
  };
}

export function createFeishuEventRouter(
  config: FeishuConfig,
  dependencies: RouterDependencies = {},
) {
  const client = dependencies.client ?? createFeishuClient(config);
  const readFileImpl = dependencies.readFileImpl ?? readFile;
  const transport = createTransport(client, readFileImpl);
  const ingressDeduplicator = createFeishuIngressDeduplicator();
  let initialized = false;

  async function ensureInitialized(): Promise<void> {
    if (initialized) {
      return;
    }

    await initState('feishu');
    await initializeFeishuSessionChats(config.stateFile);
    initialized = true;
  }

  async function persistFeishuState(): Promise<void> {
    await persistState('feishu');
    try {
      await persistFeishuSessionChats(config.stateFile);
    } catch (error) {
      console.warn('[feishu] failed to persist session chat index:', error);
    }
  }

  async function persistFeishuMessageControls(
    conversationId: string,
    directives: ReturnType<typeof preprocessConversationMessage>['directives'],
  ): Promise<void> {
    const results = applyMessageControlDirectives({ conversationId, directives });
    if (results.some(result => result.persist)) {
      await persistFeishuState();
    }
  }

  async function handleMessageEvent(payload: FeishuMessageReceiveEvent): Promise<void> {
    const dedup = ingressDeduplicator.claimMessage(payload);
    if (dedup.duplicate) {
      return;
    }

    let succeeded = false;
    try {
      await ensureInitialized();
      const rawEvent = normalizeFeishuMessageReceiveEvent(payload);
      const event = normalizeFeishuEvent(rawEvent);
      const message = rawEvent.event?.message;
      if (event.kind !== 'message' || !message) {
        succeeded = true;
        return;
      }

      const conversationId = resolveConversationId(event);
      if (!conversationId) {
        succeeded = true;
        return;
      }

      const target = {
        chatId: message.chat_id,
        replyToMessageId: message.message_id,
      };

      const senderOpenId = resolveSenderOpenId(payload);
      const sessionKind = resolveFeishuChatSessionKind({
        chatId: message.chat_id,
        chatType: message.chat_type,
      });

      if (sessionKind.kind === 'session-chat' && consumeMirroredFeishuMessageId(message.message_id)) {
        succeeded = true;
        return;
      }

      if (sessionKind.kind !== 'session-chat' && !shouldProcessFeishuMessage(message)) {
        succeeded = true;
        return;
      }

      const attachmentInfos = extractFeishuAttachmentInfos(message);
      const messageText = extractFeishuMessageText(message);
      if (attachmentInfos.length > 0 && !messageText) {
        queuePendingFeishuAttachments(
          conversationId,
          await buildManagedAttachments(client, message.message_id, attachmentInfos),
        );
        await transport.sendText(target, buildAttachmentReceiptText(attachmentInfos));
        succeeded = true;
        return;
      }

      const preprocessed = preprocessConversationMessage(messageText);

      if (isFeishuDoneCommand(preprocessed.prompt)) {
        if (message.chat_type === 'p2p') {
          await transport.sendText(target, 'Use /done inside the session chat you want to close.');
          succeeded = true;
          return;
        }

        if (isAuthorizationEnabled(config) && !isAuthorizedActor(config, senderOpenId)) {
          await transport.sendText(target, FEISHU_UNAUTHORIZED_TEXT);
          succeeded = true;
          return;
        }

        await handleFeishuControlAction({
          action: {
            conversationId,
            type: 'done',
          },
          target,
          transport,
          persist: persistFeishuState,
        });
        succeeded = true;
        return;
      }

      if (isFeishuHelpCommand(preprocessed.prompt)) {
        await transport.sendCard(
          target,
          buildFeishuHelpCardPayload(
            conversationId,
            buildFeishuCardContext(conversationId, target),
          ),
        );
        succeeded = true;
        return;
      }

      if (isFeishuStatusCommand(preprocessed.prompt)) {
        await transport.sendText(target, buildFeishuStatusText(conversationId));
        succeeded = true;
        return;
      }

      const resumeCmd = parseFeishuResumeCommand(preprocessed.prompt);
      if (resumeCmd.isResume) {
        if (!resumeCmd.sessionId) {
          await transport.sendText(target, 'Usage: /resume <session_id>');
          succeeded = true;
          return;
        }

        if (sessionKind.kind !== 'session-chat') {
          await transport.sendText(target, 'Use /resume inside the session chat you want to resume.');
          succeeded = true;
          return;
        }

        if (isAuthorizationEnabled(config) && !isAuthorizedActor(config, senderOpenId)) {
          await transport.sendText(target, FEISHU_UNAUTHORIZED_TEXT);
          succeeded = true;
          return;
        }

        const result = await executeFeishuResumeCommand(conversationId, resumeCmd.sessionId);
        await transport.sendText(target, result.message);

        if (result.success) {
          await persistFeishuState();
        }

        succeeded = true;
        return;
      }

      const request = resolveFeishuMessageRequest(preprocessed.prompt);

      const hasRunContent = Boolean(request.prompt) || preprocessed.directives.length > 0;
      if (
        hasRunContent
        && request.mode === 'code'
        && isAuthorizationEnabled(config)
        && !isAuthorizedActor(config, senderOpenId)
      ) {
        await transport.sendText(target, FEISHU_UNAUTHORIZED_CODE_TEXT);
        succeeded = true;
        return;
      }

      if (
        hasRunContent
        && request.mode === 'code'
        && isAuthorizationEnabled(config)
        && sessionKind.kind === 'session-chat'
        && senderOpenId
        && sessionKind.record.creatorOpenId !== senderOpenId
      ) {
        await transport.sendText(target, FEISHU_UNAUTHORIZED_CODE_TEXT);
        succeeded = true;
        return;
      }

      const inlineAttachments = attachmentInfos.length > 0
        ? await buildManagedAttachments(client, message.message_id, attachmentInfos)
        : [];

      if (message.chat_type === 'p2p') {
        const duplicateSessionChat = findFeishuSessionChatBySourceMessage({
          sourceP2pChatId: message.chat_id,
          sourceMessageId: message.message_id,
        });
        if (duplicateSessionChat) {
          succeeded = true;
          return;
        }

        const creatorOpenId = senderOpenId;
        if (!creatorOpenId) {
          await transport.sendText(target, 'Could not determine the Feishu user for this private chat.');
          succeeded = true;
          return;
        }

        if (!request.prompt && preprocessed.directives.length === 0) {
          await transport.sendText(target, 'Please include a prompt after mentioning the bot.');
          succeeded = true;
          return;
        }

        try {
          const launch = await launchFeishuSessionFromPrivateChat({
            client,
            sourceChatId: message.chat_id,
            sourceMessageId: message.message_id,
            creatorOpenId,
            prompt: request.prompt,
            mode: request.mode,
            persist: persistFeishuState,
          });
          if (launch.mirroredMessageId) {
            rememberMirroredFeishuMessageId(launch.mirroredMessageId);
          }
          await persistFeishuMessageControls(launch.sessionChatId, preprocessed.directives);

          if (!request.prompt) {
            succeeded = true;
            return;
          }

          await runFeishuSessionFlow({
            conversationId: launch.sessionChatId,
            target: {
              chatId: launch.sessionChatId,
            },
            prompt: request.prompt,
            mode: request.mode,
            transport,
            defaultCwd: config.claudeCwd,
            sourceMessageId: message.message_id,
            attachments: [
              ...drainPendingFeishuAttachments(message.chat_id),
              ...inlineAttachments,
            ],
            persistState: persistFeishuState,
          });
        } catch (error) {
          await transport.sendText(target, describeError(error));
          succeeded = true;
          return;
        }
        succeeded = true;
        return;
      }

      if (!request.prompt) {
        if (preprocessed.directives.length > 0) {
          await persistFeishuMessageControls(conversationId, preprocessed.directives);
        } else {
          await transport.sendText(target, 'Please include a prompt after mentioning the bot.');
        }
        succeeded = true;
        return;
      }

      try {
        await persistFeishuMessageControls(conversationId, preprocessed.directives);
        await runFeishuSessionFlow({
          conversationId,
          target,
          prompt: request.prompt,
          mode: request.mode,
          transport,
          defaultCwd: config.claudeCwd,
          sourceMessageId: message.message_id,
          attachments: [
            ...drainPendingFeishuAttachments(message.chat_id),
            ...inlineAttachments,
          ],
          persistState: persistFeishuState,
        });
      } catch (error) {
        await transport.sendText(target, describeError(error)).catch(() => {});
        succeeded = true;
        return;
      }
      succeeded = true;
    } finally {
      dedup.complete(succeeded);
    }
  }

  async function handleCardActionEvent(payload: FeishuCardActionTriggerEvent): Promise<void> {
    const dedup = ingressDeduplicator.claimCardAction(payload);
    if (dedup.duplicate) {
      return;
    }

    let succeeded = false;
    try {
      await ensureInitialized();
      const rawEvent = normalizeFeishuCardActionTriggerEvent(payload);
      const event = normalizeFeishuEvent(rawEvent);
      const action = rawEvent.action?.value as FeishuActionPayload['value'] | undefined;
      const conversationId = resolveConversationIdFromAction(event);
      if (!action || !conversationId || typeof action.chatId !== 'string') {
        succeeded = true;
        return;
      }

      const target = {
        chatId: action.chatId,
        replyToMessageId: typeof action.replyToMessageId === 'string' ? action.replyToMessageId : undefined,
      };
      const actionType = action.action;
      if (typeof actionType !== 'string') {
        succeeded = true;
        return;
      }

      if (actionType === 'control-panel') {
        await openFeishuSessionControlPanel({
          conversationId,
          target,
          transport,
        });
        succeeded = true;
        return;
      }

      if (actionType === 'status') {
        await transport.sendText(target, buildFeishuStatusText(conversationId));
        succeeded = true;
        return;
      }

      if (actionType === 'command') {
        const commandValue = typeof action.command === 'string' ? action.command.trim().toLowerCase() : '';
        if (!commandValue) {
          succeeded = true;
          return;
        }

        if (commandValue === 'help') {
          await transport.sendCard(
            target,
            buildFeishuHelpCardPayload(
              conversationId,
              buildFeishuCardContext(conversationId, target),
            ),
          );
          succeeded = true;
          return;
        }

        if (commandValue === 'status') {
          await transport.sendText(target, buildFeishuStatusText(conversationId));
          succeeded = true;
          return;
        }

        if (commandValue === 'done') {
          const sessionKind = resolveFeishuChatSessionKind({ chatId: target.chatId });
          if (sessionKind.kind !== 'session-chat') {
            await transport.sendText(target, 'Use /done inside the session chat you want to close.');
            succeeded = true;
            return;
          }

          const actorOpenId = payload.open_id ?? payload.user_id;
          if (isAuthorizationEnabled(config) && !isAuthorizedActor(config, actorOpenId)) {
            await transport.sendText(target, FEISHU_UNAUTHORIZED_TEXT);
            succeeded = true;
            return;
          }

          await handleFeishuControlAction({
            action: {
              conversationId,
              type: 'done',
            },
            target,
            transport,
            persist: persistFeishuState,
          });
          succeeded = true;
          return;
        }

        succeeded = true;
        return;
      }

      if (actionType === 'resume') {
        const sessionId = resolveResumeSessionId(action);
        if (!sessionId) {
          await transport.sendText(target, 'Usage: /resume <session_id>');
          succeeded = true;
          return;
        }

        const sessionKind = resolveFeishuChatSessionKind({ chatId: target.chatId });
        if (sessionKind.kind !== 'session-chat') {
          await transport.sendText(target, 'Use /resume inside the session chat you want to resume.');
          succeeded = true;
          return;
        }

        const actorOpenId = payload.open_id ?? payload.user_id;
        if (isAuthorizationEnabled(config) && !isAuthorizedActor(config, actorOpenId)) {
          await transport.sendText(target, FEISHU_UNAUTHORIZED_TEXT);
          succeeded = true;
          return;
        }

        const result = await executeFeishuResumeCommand(conversationId, sessionId);
        await transport.sendText(target, result.message);
        if (result.success) {
          await persistFeishuState();
        }
        succeeded = true;
        return;
      }

      const actorOpenId = payload.open_id ?? payload.user_id;
      if (isAuthorizationEnabled(config) && !isAuthorizedActor(config, actorOpenId)) {
        await transport.sendText(target, FEISHU_UNAUTHORIZED_TEXT);
        succeeded = true;
        return;
      }

      const result = await handleFeishuControlAction({
        action: actionType === 'backend'
          ? { conversationId, type: 'backend', value: String(action.value) as BackendName }
          : actionType === 'confirm-backend'
            ? { conversationId, type: 'confirm-backend', value: String(action.value) as BackendName }
            : actionType === 'cancel-backend'
              ? { conversationId, type: 'cancel-backend' }
              : actionType === 'model'
                ? { conversationId, type: 'model', value: String(action.value) }
                : actionType === 'effort'
                  ? { conversationId, type: 'effort', value: String(action.value) }
                  : actionType === 'done'
                    ? { conversationId, type: 'done' }
                    : { conversationId, type: 'interrupt' },
        target,
        transport,
        persist: persistFeishuState,
      });

      if (result.kind === 'backend-confirmation') {
        await transport.sendCard(
          target,
          buildFeishuBackendConfirmationCardPayload(
            result.card,
            buildFeishuCardContext(conversationId, target),
          ),
        );
        succeeded = true;
        return;
      }

      if (actionType === 'backend' || actionType === 'confirm-backend' || actionType === 'model') {
        try {
          const resumed = await resumePendingFeishuRun({
            conversationId,
            transport,
            defaultCwd: config.claudeCwd,
            persistState: persistFeishuState,
            fallback: typeof action.prompt === 'string' && action.prompt.trim()
              ? {
                target,
                prompt: action.prompt.trim(),
                mode: action.mode === 'ask' ? 'ask' : 'code',
                sourceMessageId: target.replyToMessageId,
              }
              : undefined,
          });

          if (resumed.kind === 'busy') {
            await transport.sendText(target, 'Conversation is already running.');
          }
        } catch (error) {
          await transport.sendText(target, describeError(error)).catch(() => {});
          succeeded = true;
          return;
        }
      }
      succeeded = true;
    } finally {
      dedup.complete(succeeded);
    }
  }

  async function handleMenuActionEvent(payload: FeishuMenuActionTriggerEvent): Promise<void> {
    const dedup = ingressDeduplicator.claimMenuAction(payload);
    if (dedup.duplicate) {
      return;
    }

    let succeeded = false;
    try {
      await ensureInitialized();
      const rawEvent = normalizeFeishuMenuActionTriggerEvent(payload);
      const event = normalizeFeishuEvent(rawEvent);
      const action = rawEvent.action?.value as FeishuActionPayload['value'] | undefined;
      const conversationId = resolveConversationIdFromAction(event);
      if (
        event.kind !== 'action'
        || event.source !== 'menu'
        || event.action !== 'open-session-controls'
        || !action
        || !conversationId
        || typeof action.chatId !== 'string'
      ) {
        succeeded = true;
        return;
      }

      await openFeishuSessionControlPanel({
        conversationId,
        target: {
          chatId: action.chatId,
        },
        transport,
        requireKnownSessionChat: true,
      });
      succeeded = true;
    } finally {
      dedup.complete(succeeded);
    }
  }

  return {
    handleMessageEvent,
    handleCardActionEvent,
    handleMenuActionEvent,
  };
}

export function buildFeishuLongConnectionEventHandlers(router: {
  handleMessageEvent(payload: FeishuMessageReceiveEvent): Promise<void>;
  handleCardActionEvent(payload: FeishuCardActionTriggerEvent): Promise<void>;
  handleMenuActionEvent(payload: FeishuMenuActionTriggerEvent): Promise<void>;
}) {
  return {
    [FEISHU_MESSAGE_EVENT_TYPE]: async (payload: FeishuMessageReceiveEvent) => router.handleMessageEvent(payload),
    [FEISHU_CARD_ACTION_EVENT_TYPE]: async (payload: FeishuCardActionTriggerEvent) => router.handleCardActionEvent(payload),
    [FEISHU_MENU_ACTION_EVENT_TYPE]: async (payload: FeishuMenuActionTriggerEvent) => router.handleMenuActionEvent(payload),
  };
}
