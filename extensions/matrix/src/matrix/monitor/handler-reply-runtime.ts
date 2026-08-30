import type { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";
import type { MatrixOpenClawPreviewMarker } from "../preview-protocol.js";
import { createMatrixDraftController } from "./handler-draft-controller.js";
import { createMatrixReplyDispatcher } from "./handler-reply-dispatcher.js";
import { loadMatrixSendModule, redactMatrixDraftEvent } from "./handler-runtime.js";
import type { MatrixMonitorHandlerParams } from "./handler-types.js";
import {
  createReplyPrefixOptions,
  createTypingCallbacks,
  getAgentScopedMediaLocalRoots,
  logTypingFailure,
} from "./runtime-api.js";

type DraftControllerInput = Parameters<typeof createMatrixDraftController>[0];

export async function createMatrixHandlerReplyRuntime(input: {
  params: MatrixMonitorHandlerParams;
  resolveHumanDelayConfig: typeof resolveHumanDelayConfig;
  route: { agentId: string; accountId: string };
  roomId: string;
  messageId: string;
  threadTarget: DraftControllerInput["threadTarget"];
  replyToEventId?: string;
  enhancedTurnTakingEligible: boolean;
  selfUserId: string;
}) {
  const { params, roomId } = input;
  const {
    cfg,
    client,
    runtime,
    streaming,
    previewToolProgressEnabled,
    replyToMode,
    logVerboseMessage,
  } = params;
  const mediaLocalRoots = getAgentScopedMediaLocalRoots(cfg, input.route.agentId);
  const { onModelSelected, ...prefixOptions } = createReplyPrefixOptions({
    cfg,
    agentId: input.route.agentId,
    channel: "matrix",
    accountId: input.route.accountId,
  });
  const typingCallbacks = createTypingCallbacks({
    start: async () => {
      const { sendTypingMatrix } = await loadMatrixSendModule();
      await sendTypingMatrix(roomId, true, undefined, client);
    },
    stop: async () => {
      const { sendTypingMatrix } = await loadMatrixSendModule();
      await sendTypingMatrix(roomId, false, undefined, client);
    },
    onStartError: (error) => {
      logTypingFailure({
        log: logVerboseMessage,
        channel: "matrix",
        action: "start",
        target: roomId,
        error,
      });
    },
    onStopError: (error) => {
      logTypingFailure({
        log: logVerboseMessage,
        channel: "matrix",
        action: "stop",
        target: roomId,
        error,
      });
    },
  });
  // Matrix drafts are provider-visible before outbound modifiers run. Keep them
  // off when a hook can rewrite or cancel so the original payload cannot escape.
  const hookRunner = getGlobalHookRunner();
  const allowProviderPreview = !(
    (hookRunner?.hasHooks("reply_payload_sending") ?? false) ||
    (hookRunner?.hasHooks("message_sending") ?? false) ||
    (hookRunner?.hasHooks("before_agent_finalize") ?? false)
  );
  const draftController = await createMatrixDraftController({
    streaming: allowProviderPreview ? streaming : "off",
    previewToolProgressEnabled: allowProviderPreview && previewToolProgressEnabled,
    replyToMode,
    messageId: input.messageId,
    threadTarget: input.threadTarget,
    accountConfig: params.accountConfig,
    cfg,
    accountId: input.route.accountId,
    roomId,
    client,
    logVerboseMessage,
    ...(input.enhancedTurnTakingEligible && params.turnTakingCoordinator
      ? {
          previewProtocol: {
            onUpdate: async (update) => {
              await params.turnTakingCoordinator?.observeOutboundPreview({
                roomId,
                senderId: input.selfUserId,
                ...update,
              });
            },
          },
        }
      : {}),
  });
  const { draftStream } = draftController;
  let draftCleanupInFlight: Promise<void> | undefined;
  const settleCurrentDraftPresentation = () => {
    if (draftCleanupInFlight) {
      return draftCleanupInFlight;
    }
    draftCleanupInFlight = (async () => {
      draftController.cancelProgressDraft();
      if (!draftStream) {
        return;
      }
      const draftEventId = await draftStream.stop().catch(() => undefined);
      if (draftController.draftDisposition() !== "active") {
        return;
      }
      if (draftEventId) {
        await draftStream.abandon().catch(() => undefined);
        if (!(await redactMatrixDraftEvent(client, roomId, draftEventId))) {
          return;
        }
      }
      draftController.markDraftConsumed();
    })().finally(() => {
      draftCleanupInFlight = undefined;
    });
    return draftCleanupInFlight;
  };
  let foregroundDraftCleanup: Promise<void> | undefined;
  const settleForegroundDraftPresentation = () =>
    (foregroundDraftCleanup ??= settleCurrentDraftPresentation());
  const replyDispatcher = createMatrixReplyDispatcher({
    cfg,
    prefixOptions,
    humanDelay: input.resolveHumanDelayConfig(cfg, input.route.agentId),
    typingCallbacks,
    streaming,
    draftStream,
    draftController,
    client,
    roomId,
    runtime,
    replyToMode,
    threadTarget: input.threadTarget,
    replyToEventId: input.replyToEventId,
    accountId: input.route.accountId,
    mediaLocalRoots,
    logVerboseMessage,
    enhancedTurnTakingEligible: input.enhancedTurnTakingEligible,
    ...(input.enhancedTurnTakingEligible && params.turnTakingCoordinator
      ? {
          enhancedFinalProtocol: {
            triggerEventId: input.messageId,
            onAcceptedPart: async (update: {
              sourceEventId: string;
              marker: MatrixOpenClawPreviewMarker;
              body: string;
            }) => {
              await params.turnTakingCoordinator?.observeOutboundStandaloneFinalPart({
                roomId,
                senderId: input.selfUserId,
                ...update,
              });
            },
            onAbandoned: async (update: {
              responseId: string;
              sourceEventIds: readonly string[];
            }) => {
              await params.turnTakingCoordinator?.abandonOutboundStandaloneFinal({
                roomId,
                senderId: input.selfUserId,
                ...update,
              });
            },
          },
        }
      : {}),
  });
  return {
    draftController,
    draftStream,
    settleCurrentDraftPresentation,
    settleForegroundDraftPresentation,
    replyDispatcher,
    onModelSelected,
  };
}
