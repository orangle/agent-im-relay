import { randomUUID } from 'node:crypto';
import { beginFeishuDispatch } from './launch-state.js';
import {
  presentFeishuBusyNotice,
  presentFeishuErrorOutput,
  presentFeishuFinalOutput,
  presentFeishuInterruptCard,
} from './presentation.js';
import {
  runFeishuConversation,
  type FeishuRuntimeTransport,
  type FeishuTarget,
} from './runtime.js';

export async function runFeishuSessionFlow(options: {
  conversationId: string;
  target: FeishuTarget;
  prompt: string;
  mode: 'code' | 'ask';
  transport: FeishuRuntimeTransport;
  defaultCwd: string;
  sourceMessageId?: string;
  attachments?: Parameters<typeof runFeishuConversation>[0]['attachments'];
  attachmentFetchImpl?: Parameters<typeof runFeishuConversation>[0]['attachmentFetchImpl'];
  persistState?: () => Promise<void>;
}): Promise<{ kind: 'blocked' | 'started' | 'busy' | 'error' }> {
  const dispatch = options.sourceMessageId
    ? beginFeishuDispatch(options.sourceMessageId)
    : { dispatchId: randomUUID() };

  const sourceMessageId = options.sourceMessageId;
  let runningReactionId: string | undefined;

  const transitionReaction = async (emojiType: string): Promise<void> => {
    if (!sourceMessageId) {
      return;
    }

    if (runningReactionId && options.transport.deleteReaction) {
      await options.transport.deleteReaction(sourceMessageId, runningReactionId).catch(() => {});
      runningReactionId = undefined;
    }

    runningReactionId = await options.transport.addReaction?.(sourceMessageId, emojiType).catch(() => undefined);
  };

  await transitionReaction('OK');

  const interruptCard = await presentFeishuInterruptCard({
    dispatchId: dispatch.dispatchId,
    conversationId: options.conversationId,
    target: options.target,
    transport: options.transport,
    prompt: options.prompt,
  });

  const result = await runFeishuConversation({
    conversationId: options.conversationId,
    target: options.target,
    prompt: options.prompt,
    mode: options.mode,
    transport: options.transport,
    defaultCwd: options.defaultCwd,
    sourceMessageId: options.sourceMessageId,
    attachments: options.attachments,
    attachmentFetchImpl: options.attachmentFetchImpl,
    persistState: options.persistState,
    streamingCardMessageId: interruptCard.messageId,
    lifecycle: {
      onFinalOutput: async (output) => {
        await transitionReaction('DONE');
        await presentFeishuFinalOutput({
          dispatchId: dispatch.dispatchId,
          output,
          target: options.target,
          transport: options.transport,
        });
      },
      onError: async (error) => {
        await transitionReaction('ERROR');
        await presentFeishuErrorOutput({
          dispatchId: dispatch.dispatchId,
          error,
          target: options.target,
          transport: options.transport,
        });
      },
    },
  });

  if (result.kind === 'busy') {
    await presentFeishuBusyNotice({
      dispatchId: dispatch.dispatchId,
      target: options.target,
      transport: options.transport,
    });
  }

  return result;
}
