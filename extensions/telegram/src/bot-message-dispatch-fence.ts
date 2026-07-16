// Telegram plugin module owns pre-adoption reply-fence authority.
import type { TelegramMessageContext } from "./bot-message-context.js";
import type { DispatchTelegramMessageParams } from "./bot-message-dispatch.types.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import {
  beginTelegramReplyFence,
  buildTelegramNonInterruptingReplyFenceKey,
  buildTelegramReplyFenceLaneKey,
  endTelegramReplyFence,
  isTelegramReplyFenceSuperseded,
  releaseTelegramReplyFenceAbortController,
  resolveTelegramReplyFenceKey,
  shouldSupersedeTelegramReplyFence,
  supersedeTelegramReplyFence,
} from "./telegram-reply-fence.js";

type CreateTelegramReplyFenceParams = Pick<
  DispatchTelegramMessageParams,
  "onTurnAdopted" | "onTurnDeferred" | "onTurnAbandoned" | "turnAbortSignal"
> & {
  context: TelegramMessageContext;
};

export function createTelegramReplyFenceController(params: CreateTelegramReplyFenceParams) {
  const { context } = params;
  const replyFenceKey = resolveTelegramReplyFenceKey({
    ctxPayload: context.ctxPayload,
    chatId: context.chatId,
    threadSpec: context.threadSpec,
  });
  const sequentialKey = getTelegramSequentialKey({
    message: context.msg,
    ...(context.primaryCtx.me ? { me: context.primaryCtx.me } : {}),
  });
  const laneKey = buildTelegramReplyFenceLaneKey({
    accountId: context.route.accountId,
    sequentialKey,
  });
  const supersedes = shouldSupersedeTelegramReplyFence(context.ctxPayload);
  const activeKey = supersedes
    ? replyFenceKey.activeKey
    : buildTelegramNonInterruptingReplyFenceKey({
        activeKey: replyFenceKey.activeKey,
        laneKey,
      });
  // Ambient room-event work uses a separate fence key. Any non-room-event
  // inbound may cancel it without owning abort authority over adopted user turns.
  if (context.ctxPayload.InboundEventKind !== "room_event") {
    supersedeTelegramReplyFence(replyFenceKey.roomEventKey);
  }

  const abortController = new AbortController();
  const abortSignal = params.turnAbortSignal
    ? AbortSignal.any([abortController.signal, params.turnAbortSignal])
    : abortController.signal;
  let generation: number | undefined = beginTelegramReplyFence({
    key: activeKey,
    supersede: supersedes,
    abortController,
    laneKey,
  });
  let abortControllerQueued = false;
  let queuedTurnAdmitted = false;

  const isSuperseded = () =>
    abortController.signal.aborted ||
    (generation !== undefined && isTelegramReplyFenceSuperseded({ key: activeKey, generation }));

  const release = () => {
    if (generation === undefined) {
      return;
    }
    endTelegramReplyFence(activeKey, abortControllerQueued ? undefined : abortController);
    generation = undefined;
  };

  const adoptTurn = async () => {
    await params.onTurnAdopted?.();
    // Fence abort and supersession authority end after durable adoption.
    // Core then owns all interruption of the adopted run.
    release();
    releaseTelegramReplyFenceAbortController(activeKey, abortController);
  };

  return {
    abortSignal,
    adoptTurn,
    generation: () => generation,
    isSuperseded,
    release,
    queuedFollowupLifecycle:
      context.ctxPayload.InboundEventKind === "room_event" ||
      params.onTurnAdopted ||
      params.onTurnDeferred ||
      params.onTurnAbandoned
        ? {
            onEnqueued: () => {
              abortControllerQueued = true;
              params.onTurnDeferred?.();
            },
            onAdmitted: async () => {
              await adoptTurn();
              queuedTurnAdmitted = true;
            },
            onComplete: () => {
              abortControllerQueued = false;
              releaseTelegramReplyFenceAbortController(activeKey, abortController);
              if (!queuedTurnAdmitted) {
                params.onTurnAbandoned?.();
              }
            },
          }
        : undefined,
  };
}

export type TelegramReplyFenceController = ReturnType<typeof createTelegramReplyFenceController>;
