import {
  markDelegateArtifactDeliveryUnavailable,
  prepareDelegateArtifactDelivery,
  recordDelegateArtifactDeliveryBinding,
} from "../agents/delegate-artifacts.js";
import { replaceManagedDelegateReturnInPrompt } from "../agents/internal-events.js";
import { resolveCorrelatedSubagentDelivery } from "../agents/subagents/completion/subagent-completion-delivery.js";
import { resolveContinuationRuntimeConfig } from "../auto-reply/continuation/config.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "../auto-reply/reply/get-reply-run-queue.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { deliverQueuedPostCompactionDelegate } from "../auto-reply/reply/post-compaction-delegate-delivery.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../auto-reply/reply/provider-dispatcher.js";
import { recordInboundSession } from "../channels/session.js";
import { dispatchAssembledChannelTurn } from "../channels/turn/lifecycle.js";
import type { CliDeps } from "../cli/deps.types.js";
import { toErrorObject } from "../infra/errors.js";
import { requestHeartbeatRaw as requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  SessionDeliveryDeadLetteredError,
  SessionDeliveryDeferredError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
} from "../infra/session-delivery-queue-storage.js";
import { enqueueSystemEventRaw as enqueueSystemEvent } from "../infra/system-events.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OutboundReplyPayload } from "../plugin-sdk/reply-payload.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { deliverQueuedGeneratedMediaAgentTurn } from "./server-restart-sentinel-agent-delivery.js";
import { loadSessionEntry } from "./session-utils.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const RESTART_CONTINUATION_BUSY_RETRY_ERROR =
  "restart continuation deferred because previous run is still shutting down";

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

function sessionDeliveryStateDirArgs(stateDir?: string): [] | [string] {
  return stateDir === undefined ? [] : [stateDir];
}

function enqueueRestartSentinelWake(
  message: string,
  sessionKey: string,
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  },
  traceparent?: string,
  sessionDeliveryAckId?: string,
  sessionDeliveryAckStateDir?: string,
  expectedSessionId?: string,
  delegateArtifactReceipt?: NonNullable<
    Extract<QueuedSessionDelivery, { kind: "systemEvent" }>["managedDelegateArtifactDelivery"]
  >["receipt"],
  awaitsTurnAdoption?: boolean,
) {
  enqueueSystemEvent(message, {
    sessionKey,
    trusted: true,
    // The durable row owns this contract; a replayed event must carry it too, or
    // the re-created in-memory copy would be acked at prompt preparation.
    ...(awaitsTurnAdoption ? { sessionDeliveryAwaitsTurnAdoption: true } : {}),
    ...(deliveryContext ? { deliveryContext } : {}),
    ...(traceparent ? { traceparent } : {}),
    ...(sessionDeliveryAckId ? { sessionDeliveryAckId } : {}),
    ...(sessionDeliveryAckStateDir ? { sessionDeliveryAckStateDir } : {}),
    ...(expectedSessionId ? { expectedSessionId } : {}),
    ...(delegateArtifactReceipt ? { delegateArtifactReceipt } : {}),
  });
  requestHeartbeat({ source: "restart-sentinel", intent: "immediate", reason: "wake", sessionKey });
}

function isRestartContinuationBusyPayload(payload: OutboundReplyPayload): boolean {
  return (
    typeof payload.text === "string" && payload.text.trim() === REPLY_RUN_STILL_SHUTTING_DOWN_TEXT
  );
}

export function isRestartContinuationBusyRetry(entry: QueuedSessionDelivery | null): boolean {
  return entry?.lastError === RESTART_CONTINUATION_BUSY_RETRY_ERROR;
}

function resolveQueuedRestartContinuationMessageId(entry: QueuedAgentTurnSessionDelivery): string {
  if (isRestartContinuationBusyRetry(entry) && entry.retryCount > 0) {
    return `${entry.messageId}:retry:${entry.retryCount}`;
  }
  return entry.messageId;
}

function resolveQueuedSessionDeliveryContext(entry: QueuedSessionDelivery):
  | {
      channel?: string;
      to?: string;
      accountId?: string;
      threadId?: string | number;
    }
  | undefined {
  if (entry.kind === "agentTurn" && entry.route) {
    return {
      channel: entry.route.channel,
      to: entry.route.to,
      ...(entry.route.accountId ? { accountId: entry.route.accountId } : {}),
      ...(entry.route.threadId ? { threadId: entry.route.threadId } : {}),
    };
  }
  return entry.deliveryContext;
}

export async function deliverQueuedSessionDeliveryCore(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  stateDir?: string;
}) {
  return await deliverResolvedQueuedSessionDelivery({
    ...params,
    entry: resolveCorrelatedSubagentDelivery(params.entry),
  });
}

async function deliverResolvedQueuedSessionDelivery(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  stateDir?: string;
}) {
  if (params.entry.kind === "postCompactionDelegate") {
    await deliverQueuedPostCompactionDelegate({ entry: params.entry });
    return;
  }
  const { cfg, agentId, entry, storePath, canonicalKey } = loadSessionEntry(
    params.entry.sessionKey,
  );
  const queuedDeliveryContext = resolveQueuedSessionDeliveryContext(params.entry);

  if (params.entry.kind === "systemEvent") {
    if (
      params.entry.expectedSessionId &&
      (!entry?.sessionId || entry.sessionId !== params.entry.expectedSessionId)
    ) {
      const receipt = params.entry.managedDelegateArtifactDelivery?.receipt;
      if (receipt) {
        markDelegateArtifactDeliveryUnavailable({
          dispatchId: receipt.dispatchId,
          recipientSessionKey: receipt.recipientSessionKey,
          recipientSessionId: receipt.recipientSessionId,
          reason: "recipient-incarnation-changed",
          ...(params.stateDir
            ? {
                options: {
                  env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
                },
              }
            : {}),
        });
      }
      log.warn("session event delivery skipped: session changed", {
        sessionKey: canonicalKey,
        queueId: params.entry.id,
      });
      return;
    }
    let deliveryText = params.entry.text;
    const managedDelivery = params.entry.managedDelegateArtifactDelivery;
    if (managedDelivery) {
      const { projection, receipt } = managedDelivery;
      if (
        projection.arrivalContext.dispatchId !== receipt.dispatchId ||
        projection.arrivalContext.binding.recipientSessionKey !== receipt.recipientSessionKey ||
        projection.arrivalContext.binding.recipientSessionId !== receipt.recipientSessionId
      ) {
        markDelegateArtifactDeliveryUnavailable({
          dispatchId: receipt.dispatchId,
          recipientSessionKey: receipt.recipientSessionKey,
          recipientSessionId: receipt.recipientSessionId,
          reason: "delivery-state-unavailable",
          ...(params.stateDir
            ? {
                options: {
                  env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
                },
              }
            : {}),
        });
        return;
      }
      const runtime = resolveContinuationRuntimeConfig(cfg);
      const prepared = prepareDelegateArtifactDelivery({
        projection,
        runtimeEnabled: runtime.enabled,
        crossSessionEnabled: runtime.crossSessionTargeting === "enabled",
        currentRecipientSessionId: entry?.sessionId,
        ...(params.stateDir
          ? {
              options: {
                env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
              },
            }
          : {}),
      });
      if (prepared.status === "deferred") {
        throw new SessionDeliveryDeferredError("managed delegate return delivery is disabled");
      }
      if (prepared.status === "acknowledged") {
        return;
      }
      if (prepared.status === "unavailable") {
        markDelegateArtifactDeliveryUnavailable({
          dispatchId: receipt.dispatchId,
          recipientSessionKey: receipt.recipientSessionKey,
          recipientSessionId: receipt.recipientSessionId,
          reason: "delivery-state-unavailable",
          ...(params.stateDir
            ? {
                options: {
                  env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
                },
              }
            : {}),
        });
        return;
      }
      const artifactOptions = params.stateDir
        ? {
            options: {
              env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir },
            },
          }
        : {};
      recordDelegateArtifactDeliveryBinding({
        dispatchId: receipt.dispatchId,
        recipientSessionKey: receipt.recipientSessionKey,
        recipientSessionId: receipt.recipientSessionId,
        phase: "replay",
        availability: prepared.projection.arrivalContext.availability,
        ...artifactOptions,
      });
      const refreshed = prepareDelegateArtifactDelivery({
        projection,
        runtimeEnabled: runtime.enabled,
        crossSessionEnabled: runtime.crossSessionTargeting === "enabled",
        currentRecipientSessionId: entry?.sessionId,
        ...artifactOptions,
      });
      if (refreshed.status === "acknowledged") {
        return;
      }
      if (refreshed.status !== "ready") {
        throw new SessionDeliverySafeRetryError(
          "managed delegate return changed during replay preparation",
        );
      }
      deliveryText = replaceManagedDelegateReturnInPrompt(params.entry.text, refreshed.projection);
    }
    enqueueRestartSentinelWake(
      deliveryText,
      canonicalKey,
      queuedDeliveryContext,
      params.entry.traceparent,
      params.entry.id,
      params.stateDir,
      params.entry.expectedSessionId,
      params.entry.managedDelegateArtifactDelivery?.receipt,
      params.entry.awaitPromptAdoption,
    );
    if (managedDelivery) {
      // In-memory enqueue only makes the prompt eligible. The durable queue row
      // remains pending until transcript admission adopts and acknowledges it.
      throw new SessionDeliveryDeferredError(
        "managed delegate return is awaiting durable recipient adoption",
      );
    }
    if (params.entry.awaitPromptAdoption) {
      // Same contract for opt-in plain events: the in-memory queue is not
      // durable, so completing the row here would drop the notice if the process
      // died before the prompt consumed it. The prompt-drain path acks the row
      // via the event's sessionDeliveryAckId once it is actually adopted.
      throw new SessionDeliveryDeferredError("system event is awaiting durable prompt adoption");
    }
    return;
  }

  if (
    params.entry.expectedSessionId &&
    (!entry?.sessionId || entry.sessionId !== params.entry.expectedSessionId)
  ) {
    log.warn("restart continuation skipped: session changed", {
      sessionKey: canonicalKey,
      queueId: params.entry.id,
      expectedSessionId: params.entry.expectedSessionId,
      actualSessionId: entry?.sessionId ?? null,
    });
    enqueueRestartSentinelWake(
      params.entry.message,
      canonicalKey,
      queuedDeliveryContext,
      params.entry.traceparent,
      params.entry.id,
      params.stateDir,
    );
    return;
  }

  if (!params.entry.route) {
    enqueueRestartSentinelWake(
      params.entry.message,
      canonicalKey,
      queuedDeliveryContext,
      params.entry.traceparent,
      params.entry.id,
      params.stateDir,
    );
    return;
  }

  if (
    await deliverQueuedGeneratedMediaAgentTurn({
      entry: params.entry,
      canonicalKey,
      agentId,
      storePath,
      sessionEntry: entry,
      ...(params.stateDir !== undefined ? { stateDir: params.stateDir } : {}),
    })
  ) {
    return;
  }
  if (params.entry.deliveryStartedAt !== undefined) {
    await markSessionDeliverySettlement(
      params.entry,
      "moved-to-failed",
      ...sessionDeliveryStateDirArgs(params.stateDir),
    );
    throw new SessionDeliveryDeadLetteredError(
      "queued agent turn dead-lettered after an interrupted unproven attempt",
    );
  }

  const route = params.entry.route;
  const messageId = resolveQueuedRestartContinuationMessageId(params.entry);
  const userMessage = params.entry.message.trim();
  let dispatchError: unknown;
  const ctxPayload = finalizeInboundContext(
    {
      // The per-message timestamp prefix is applied at the single LLM boundary
      // (normalizeMessagesForLlmBoundary) from each message's own timestamp, so
      // the current turn and historical turns carry identical bytes on the wire.
      // See: https://github.com/openclaw/openclaw/issues/3658
      Body: userMessage,
      BodyForAgent: userMessage,
      BodyForCommands: "",
      RawBody: userMessage,
      CommandBody: "",
      SessionKey: canonicalKey,
      AccountId: route.accountId,
      MessageSid: messageId,
      Timestamp: Date.now(),
      InputProvenance: {
        kind: "internal_system",
        sourceChannel: route.channel,
        sourceTool: "restart-sentinel",
      },
      Provider: INTERNAL_MESSAGE_CHANNEL,
      Surface: INTERNAL_MESSAGE_CHANNEL,
      ChatType: route.chatType,
      CommandAuthorized: true,
      GatewayClientScopes: ["operator.admin"],
      GatewayClientCaps: [],
      ReplyToId: route.replyToId,
      OriginatingChannel: route.channel,
      OriginatingTo: route.to,
      ExplicitDeliverRoute: false,
      MessageThreadId: route.threadId,
    },
    {
      forceBodyForCommands: true,
      forceChatType: true,
    },
  );
  await dispatchAssembledChannelTurn({
    cfg,
    channel: route.channel,
    accountId: route.accountId,
    agentId,
    routeSessionKey: canonicalKey,
    storePath,
    ctxPayload,
    recordInboundSession,
    dispatchReplyWithBufferedBlockDispatcher: dispatchReplyWithBufferedBlockDispatcherCore,
    replyOptions: {
      sourceReplyDeliveryMode: "message_tool_only",
    },
    // Preflight remains retryable. Ownership starts only after the agent runner
    // has durably adopted the turn and before it can execute tools or reply.
    turnAdoptionLifecycle: {
      admission: "cancel-only",
      onAdopted: () =>
        markSessionDeliveryAttemptStarted(
          params.entry,
          ...sessionDeliveryStateDirArgs(params.stateDir),
        ),
    },
    delivery: {
      preparePayload: (payload) => {
        if (isRestartContinuationBusyPayload(payload)) {
          throw new SessionDeliverySafeRetryError(RESTART_CONTINUATION_BUSY_RETRY_ERROR);
        }
        return payload;
      },
      durable: false,
      // Restart continuations are internal lifecycle turns. Visible follow-up
      // must go through the message tool; automatic final delivery stays off.
      deliver: async () => ({ visibleReplySent: false }),
      onError: (err, info) => {
        dispatchError ??= err;
        log.warn(`restart continuation dispatch failed during ${info.kind}: ${String(err)}`, {
          sessionKey: canonicalKey,
        });
      },
    },
    record: {
      onRecordError: (err) => {
        log.warn(`restart continuation failed to record inbound session metadata: ${String(err)}`, {
          sessionKey: canonicalKey,
        });
      },
    },
  });
  if (dispatchError) {
    throw toErrorObject(dispatchError, "Non-Error thrown");
  }
}
