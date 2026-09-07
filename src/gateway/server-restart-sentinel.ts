// Gateway restart sentinel recovery resumes pending continuations and outbound delivery.
import {
  resolveCorrelatedSubagentDelivery,
  settleCorrelatedSubagentDelivery,
} from "../agents/subagents/completion/subagent-completion-delivery.js";
import { REPLY_RUN_STILL_SHUTTING_DOWN_TEXT } from "../auto-reply/reply/get-reply-run-queue.js";
import { finalizeInboundContext } from "../auto-reply/reply/inbound-context.js";
import { dispatchReplyWithBufferedBlockDispatcherCore } from "../auto-reply/reply/provider-dispatcher.js";
import { recordInboundSession } from "../channels/session.js";
import { dispatchAssembledChannelTurn } from "../channels/turn/lifecycle.js";
import type { CliDeps } from "../cli/deps.types.js";
import { getRuntimeConfig } from "../config/io.js";
import { resolveSystemMainSessionTarget } from "../config/sessions.js";
import { appendAssistantMessageToSessionTranscript } from "../config/sessions/transcript.js";
import { formatErrorMessage, toErrorObject } from "../infra/errors.js";
import { requestHeartbeat } from "../infra/heartbeat-wake.js";
import {
  clearRestartSentinelIfRevision,
  finalizeUpdateRestartSentinelRunningVersion,
  formatRestartSentinelMessage,
  readRestartSentinel,
  type RestartSentinelContinuation,
  type RestartSentinelPayload,
  summarizeRestartSentinel,
} from "../infra/restart-sentinel.js";
import {
  drainPendingSessionDelivery,
  recoverPendingSessionDeliveries,
  type SessionDeliveryRecoveryLogger,
  type SettleSessionDeliveryFn,
} from "../infra/session-delivery-queue-recovery.js";
import {
  enqueueSessionDelivery,
  markSessionDeliveryAttemptStarted,
  markSessionDeliverySettlement,
  SessionDeliveryDeadLetteredError,
  SessionDeliverySafeRetryError,
  type QueuedSessionDelivery,
  type QueuedSessionDeliveryPayload,
  type SessionDeliveryRoute,
} from "../infra/session-delivery-queue-storage.js";
import { withSystemEventOwner } from "../infra/system-event-ownership.js";
import { enqueueSystemEvent } from "../infra/system-events.js";
import { isPendingControlPlaneUpdateRestartSentinel } from "../infra/update-control-plane-sentinel.js";
import { recordUpdateRunVerification } from "../infra/update-run-ledger.js";
import {
  renderUpdateRunReport,
  updateRunReportInputFromSentinel,
} from "../infra/update-run-report.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OutboundReplyPayload } from "../plugin-sdk/reply-payload.js";
import { runWithGatewayIndependentRootWorkAdmission } from "../process/gateway-work-admission.js";
import { removeCronRunContinuationSessionIfIdle } from "../tasks/cron-run-continuation-cleanup.js";
import {
  type DeliveryContext,
  mergeDeliveryContext,
  normalizeDeliveryContext,
} from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel.js";
import { deliverQueuedGeneratedMediaAgentTurn } from "./server-restart-sentinel-agent-delivery.js";
import {
  deliverRestartSentinelNotice,
  enqueueRestartSentinelNotice,
} from "./server-restart-sentinel-notice.js";
import { finalizeRestartUpdateRun } from "./server-restart-update-run.js";
import { loadSessionEntry } from "./session-utils.js";
import { runStartupTasks, type StartupTask } from "./startup-tasks.js";
import { resolveUpdateRunNoticeTarget } from "./update-run-notice-target.js";

const log = createSubsystemLogger("gateway/restart-sentinel");
const RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS = process.env.VITEST ? 1 : 6_000;
const RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS = 20;
const CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS = process.env.VITEST ? 1 : 2_000;
const CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS = 900;
const RESTART_CONTINUATION_BUSY_RETRY_ERROR =
  "restart continuation deferred because previous run is still shutting down";
let latestUpdateRestartSentinel: RestartSentinelPayload | null = null;

/** Settles every queue entry through its durable producer before cron cleanup. */
export const settleQueuedSessionDelivery: SettleSessionDeliveryFn = async (entry, outcome) => {
  await settleCorrelatedSubagentDelivery(entry, outcome);
  await removeCronRunContinuationSessionIfIdle(entry.sessionKey, entry.id);
};

type QueuedAgentTurnSessionDelivery = Extract<QueuedSessionDelivery, { kind: "agentTurn" }>;

function sessionDeliveryStateDirArgs(stateDir?: string): [] | [string] {
  return stateDir === undefined ? [] : [stateDir];
}

function cloneRestartSentinelPayload(
  payload: RestartSentinelPayload | null,
): RestartSentinelPayload | null {
  return payload ? structuredClone(payload) : null;
}

function enqueueRestartSentinelWake(
  message: string,
  sessionKey: string,
  agentId?: string,
  deliveryContext?: DeliveryContext,
) {
  const eventOptions = {
    sessionKey,
    ...(deliveryContext ? { deliveryContext } : {}),
  };
  enqueueSystemEvent(message, agentId ? withSystemEventOwner(eventOptions, agentId) : eventOptions);
  requestHeartbeat({
    source: "restart-sentinel",
    intent: "immediate",
    reason: "wake",
    ...(agentId ? { agentId } : {}),
    sessionKey,
  });
}

async function waitForRetry(delayMs: number) {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });
}

const buildRestartContinuationMessageId = (params: {
  sessionKey: string;
  kind: RestartSentinelContinuation["kind"];
  revision: number;
}) => `restart-sentinel:${params.sessionKey}:${params.kind}:${params.revision}`;

function isRestartContinuationBusyPayload(payload: OutboundReplyPayload): boolean {
  return (
    typeof payload.text === "string" && payload.text.trim() === REPLY_RUN_STILL_SHUTTING_DOWN_TEXT
  );
}

function isRestartContinuationBusyRetry(entry: QueuedSessionDelivery | null): boolean {
  return entry?.lastError === RESTART_CONTINUATION_BUSY_RETRY_ERROR;
}

function resolveQueuedRestartContinuationMessageId(entry: QueuedAgentTurnSessionDelivery): string {
  if (isRestartContinuationBusyRetry(entry) && entry.retryCount > 0) {
    return `${entry.messageId}:retry:${entry.retryCount}`;
  }
  return entry.messageId;
}

function resolveQueuedSessionDeliveryContext(
  entry: QueuedSessionDelivery,
): DeliveryContext | undefined {
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

export async function deliverQueuedSessionDelivery(params: {
  deps: CliDeps;
  entry: QueuedSessionDelivery;
  stateDir?: string;
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  const queuedEntry = resolveCorrelatedSubagentDelivery(params.entry);
  const { cfg, agentId, entry, storePath, canonicalKey } = loadSessionEntry(queuedEntry.sessionKey);
  const deliveryContext = resolveQueuedSessionDeliveryContext(queuedEntry);

  if (queuedEntry.kind === "systemEvent") {
    const { agentId: systemEventAgentId, text } = queuedEntry;
    enqueueRestartSentinelWake(text, canonicalKey, systemEventAgentId, deliveryContext);
    return;
  }

  if (
    queuedEntry.expectedSessionId &&
    (!entry?.sessionId || entry.sessionId !== queuedEntry.expectedSessionId)
  ) {
    log.warn("restart continuation skipped: session changed", {
      sessionKey: canonicalKey,
      queueId: queuedEntry.id,
      expectedSessionId: queuedEntry.expectedSessionId,
      actualSessionId: entry?.sessionId ?? null,
    });
    enqueueRestartSentinelWake(queuedEntry.message, canonicalKey, undefined, deliveryContext);
    return;
  }

  if (!queuedEntry.route) {
    enqueueRestartSentinelWake(queuedEntry.message, canonicalKey, undefined, deliveryContext);
    return;
  }

  if (
    await deliverQueuedGeneratedMediaAgentTurn({
      entry: queuedEntry,
      runtimeContextFragments: queuedEntry.runtimeContextFragments,
      canonicalKey,
      agentId,
      storePath,
      sessionEntry: entry,
      ...(params.stateDir !== undefined ? { stateDir: params.stateDir } : {}),
      ...(params.resolveGatewayContext
        ? { resolveGatewayContext: params.resolveGatewayContext }
        : {}),
    })
  ) {
    return;
  }
  if (queuedEntry.deliveryStartedAt !== undefined) {
    await markSessionDeliverySettlement(
      queuedEntry,
      "moved-to-failed",
      ...sessionDeliveryStateDirArgs(params.stateDir),
    );
    throw new SessionDeliveryDeadLetteredError(
      "queued agent turn dead-lettered after an interrupted unproven attempt",
    );
  }

  const route = queuedEntry.route;
  const messageId = resolveQueuedRestartContinuationMessageId(queuedEntry);
  const userMessage = queuedEntry.message.trim();
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
          queuedEntry,
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

function buildQueuedRestartContinuation(params: {
  sessionKey: string;
  agentId?: string;
  continuation: RestartSentinelContinuation;
  route?: SessionDeliveryRoute;
  expectedSessionId?: string | undefined;
  revision: number;
  deliveryContext?: DeliveryContext;
  idempotencyKey?: string;
}): QueuedSessionDeliveryPayload {
  const idempotencyKey =
    params.idempotencyKey ??
    buildRestartContinuationMessageId({
      sessionKey: params.sessionKey,
      kind: params.continuation.kind,
      revision: params.revision,
    });
  if (params.continuation.kind === "systemEvent") {
    return {
      kind: "systemEvent",
      sessionKey: params.sessionKey,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      text: params.continuation.text,
      ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
      idempotencyKey,
      maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
      completionRetention: "permanent",
    };
  }
  return {
    kind: "agentTurn",
    sessionKey: params.sessionKey,
    message: params.continuation.message,
    messageId: idempotencyKey,
    ...(params.expectedSessionId ? { expectedSessionId: params.expectedSessionId } : {}),
    maxRetries: RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS,
    completionRetention: "permanent",
    ...(params.route ? { route: params.route } : {}),
    ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
    idempotencyKey,
  };
}

async function drainRestartContinuationQueue(params: {
  deps: CliDeps;
  entryId: string;
  log: SessionDeliveryRecoveryLogger;
}) {
  for (let attempt = 1; attempt <= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS; attempt += 1) {
    const queued = await drainPendingSessionDelivery({
      id: params.entryId,
      logLabel: "restart continuation",
      log: params.log,
      bypassBackoff: true,
      deliver: (entry, context = {}) =>
        deliverQueuedSessionDelivery({
          deps: params.deps,
          entry,
          ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
        }),
      onSettled: settleQueuedSessionDelivery,
    });

    if (!isRestartContinuationBusyRetry(queued)) {
      return;
    }
    if (attempt >= RESTART_CONTINUATION_BUSY_MAX_ATTEMPTS) {
      return;
    }
    params.log.info(
      `restart continuation: entry ${params.entryId} still waiting for the previous run to clear; retrying in ${RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS}ms`,
    );
    await waitForRetry(RESTART_CONTINUATION_BUSY_RETRY_DELAY_MS);
  }
}

export async function recoverPendingRestartContinuationDeliveries(params: {
  deps: CliDeps;
  log?: SessionDeliveryRecoveryLogger;
  maxEnqueuedAt?: number;
  resolveGatewayContext?: import("./server-methods/types.js").GatewayContextResolver;
}) {
  await recoverPendingSessionDeliveries({
    deliver: (entry, context = {}) =>
      deliverQueuedSessionDelivery({
        deps: params.deps,
        entry,
        ...(context.stateDir !== undefined ? { stateDir: context.stateDir } : {}),
        ...(params.resolveGatewayContext
          ? { resolveGatewayContext: params.resolveGatewayContext }
          : {}),
      }),
    log: params.log ?? log,
    maxEnqueuedAt: params.maxEnqueuedAt,
    onSettled: settleQueuedSessionDelivery,
  });
}

async function loadRestartSentinelStartupTask(params: {
  deps: CliDeps;
  attempt?: number;
}): Promise<StartupTask | null> {
  const sentinel = await readRestartSentinel();
  if (!sentinel) {
    return null;
  }
  const payload = sentinel.payload;
  const sentinelRevision = sentinel.revision;
  if (payload.kind === "update") {
    recordLatestUpdateRestartSentinel(payload);
  }
  const sessionKey = payload.sessionKey?.trim();
  const message = formatRestartSentinelMessage(payload);
  let updateRun = payload.kind === "update" ? await finalizeRestartUpdateRun(payload) : undefined;
  const updateRunId = updateRun?.runId;
  let noticeMessage =
    payload.kind === "update"
      ? renderUpdateRunReport(updateRun ?? updateRunReportInputFromSentinel(payload)).markdown
      : message;
  const summary = summarizeRestartSentinel(payload);
  const wakeDeliveryContext = mergeDeliveryContext(
    payload.threadId != null
      ? { ...payload.deliveryContext, threadId: payload.threadId }
      : payload.deliveryContext,
    undefined,
  );

  const run = async () => {
    let routedSessionKey = sessionKey;
    let wakeAgentId: string | undefined;
    if (
      isPendingControlPlaneUpdateRestartSentinel(payload) &&
      (!updateRun || updateRun.status === "running")
    ) {
      const attempt = params.attempt ?? 0;
      if (attempt < CONTROL_PLANE_UPDATE_PENDING_MAX_ATTEMPTS) {
        const timer = setTimeout(() => {
          void runWithGatewayIndependentRootWorkAdmission(async () => {
            await scheduleRestartSentinelWakeAttempt({
              deps: params.deps,
              attempt: attempt + 1,
            });
          }, "restart-sentinel:wake").catch((err: unknown) => {
            log.warn(`restart sentinel pending update retry failed: ${formatErrorMessage(err)}`);
          });
        }, CONTROL_PLANE_UPDATE_PENDING_RETRY_DELAY_MS);
        timer.unref?.();
        return { status: "skipped" as const, reason: "update-restart-pending" };
      }
      log.warn(`${summary}: update restart sentinel remained pending after retry window`, {
        sessionKey,
        reason: payload.stats?.reason ?? null,
      });
      if (updateRunId) {
        // Expiry bounds notice delivery, not CLI verification. Only Gateway-owned
        // runs finish here; first-terminal-wins preserves completed CLI results.
        updateRun = await finalizeRestartUpdateRun(payload, true);
        if (updateRun) {
          noticeMessage = renderUpdateRunReport(updateRun).markdown;
        }
      }
    }

    // A pending owner can outlive this retry window. Reserving the permanent
    // finished-notice key now would suppress its eventual verified report.
    if (updateRun?.status === "running") {
      return { status: "skipped" as const, reason: "update-restart-pending" };
    }

    if (!routedSessionKey) {
      const controlPlaneOnlyConfigRestart =
        (payload.kind === "config-patch" || payload.kind === "config-apply") &&
        (typeof payload.message !== "string" || payload.message.trim().length === 0) &&
        !payload.continuation &&
        !payload.deliveryContext &&
        payload.threadId == null;
      if (controlPlaneOnlyConfigRestart) {
        // A targetless config acknowledgement has no agent turn to resume.
        // Synthesizing a main-session wake races real restart recovery and spends a model turn.
        const consumed = await clearRestartSentinelIfRevision(sentinelRevision);
        if (!consumed) {
          log.info(`${summary}: newer restart sentinel preserved while consuming config restart`);
        }
        return { status: "ran" as const };
      }
      const systemTarget = resolveSystemMainSessionTarget(getRuntimeConfig());
      // Session-less recovery belongs to system work, never another agent's recent conversation.
      routedSessionKey = systemTarget.sessionKey;
      wakeAgentId = systemTarget.agentId;
    }

    const continuation = sessionKey ? payload.continuation : undefined;
    const session = loadSessionEntry(routedSessionKey);
    const { cfg, entry, canonicalKey } = session;
    const target = resolveUpdateRunNoticeTarget({
      cfg,
      sessionKey,
      session,
      explicitDeliveryContext: sessionKey ? payload.deliveryContext : undefined,
      threadId: sessionKey ? payload.threadId : undefined,
    });
    const route = target.kind === "route" ? target.route : undefined;
    const deliveryContext =
      normalizeDeliveryContext(route) ?? (sessionKey ? wakeDeliveryContext : undefined);
    let continuationQueueId: string | undefined;
    let wakeQueueId: string | undefined;
    let noticeQueueId: string | undefined;
    let noticeQueueCreated = false;
    const continuationRoute = continuation ? route : undefined;

    let internalNoticeWritten = false;
    if (updateRun?.verification.noticeDelivered) {
      internalNoticeWritten = true;
    } else if (sessionKey && target.kind === "internal") {
      const { agentId, entry: internalEntry, storePath } = target.session;
      const notice = await appendAssistantMessageToSessionTranscript({
        agentId,
        sessionKey: canonicalKey,
        expectedSessionId: internalEntry.sessionId,
        expectedLifecycleRevision: internalEntry.lifecycleRevision ?? null,
        storePath,
        text: noticeMessage,
        idempotencyKey: updateRunId
          ? `update-run-finished:${updateRunId}`
          : `restart-sentinel-notice:${canonicalKey}:${sentinelRevision}`,
      }).catch((error: unknown) => ({ ok: false as const, reason: formatErrorMessage(error) }));
      internalNoticeWritten = notice.ok;
      if (notice.ok && updateRunId) {
        recordUpdateRunVerification(updateRunId, { noticeDelivered: true });
      }
      if (!notice.ok) {
        log.warn(
          `${summary}: internal restart notice append failed; falling back to wake: ${notice.reason}`,
          {
            sessionKey: canonicalKey,
          },
        );
      }
    }

    const routedAgentTurnContinuation =
      continuation?.kind === "agentTurn" && continuationRoute !== undefined;
    // Inline transcript publication also broadcasts to Control UI. An update
    // outcome needs no model wake unless continuation work remains; heartbeats
    // can silently suppress the notice or contradict the recorded outcome.
    const updateComplete =
      (internalNoticeWritten || (updateRunId && route)) &&
      payload.kind === "update" &&
      !continuation;
    if (!routedAgentTurnContinuation && !updateComplete) {
      wakeQueueId = await enqueueSessionDelivery(
        buildQueuedRestartContinuation({
          sessionKey: canonicalKey,
          agentId: wakeAgentId,
          continuation: { kind: "systemEvent", text: message },
          revision: sentinelRevision,
          deliveryContext,
          idempotencyKey: `restart-sentinel-wake:${canonicalKey}:${sentinelRevision}`,
        }),
      );
    }

    if (!sessionKey && payload.continuation) {
      log.warn(`${summary}: continuation skipped: restart sentinel sessionKey unavailable`, {
        sessionKey: canonicalKey,
        continuationKind: payload.continuation.kind,
      });
    }

    if (continuation) {
      continuationQueueId = await enqueueSessionDelivery(
        buildQueuedRestartContinuation({
          sessionKey: canonicalKey,
          continuation,
          revision: sentinelRevision,
          route: continuationRoute,
          expectedSessionId: entry?.sessionId,
          deliveryContext,
        }),
      );
    }

    if (route && !updateRun?.verification.noticeDelivered) {
      const queuedNotice = await enqueueRestartSentinelNotice({
        cfg,
        ...route,
        message: noticeMessage,
        sessionKey: canonicalKey,
        revision: sentinelRevision,
        ...(updateRunId ? { deliveryIntentId: `update-run-finished:${updateRunId}` } : {}),
      });
      noticeQueueId = queuedNotice.id;
      noticeQueueCreated = queuedNotice.created;
    }

    // Every downstream intent is durable before consuming the singleton. A
    // failed or stale compare-delete cannot lose work or remove a newer row.
    const consumed = await clearRestartSentinelIfRevision(sentinelRevision);
    if (!consumed) {
      log.info(`${summary}: newer restart sentinel preserved while draining durable work`, {
        sessionKey: canonicalKey,
      });
    }

    if (wakeQueueId) {
      await drainRestartContinuationQueue({ deps: params.deps, entryId: wakeQueueId, log });
    }

    if (route && noticeQueueId && noticeQueueCreated) {
      const delivered = await deliverRestartSentinelNotice({
        deps: params.deps,
        cfg,
        sessionKey: canonicalKey,
        summary,
        message: noticeMessage,
        ...route,
        queueId: noticeQueueId,
      });
      if (delivered && updateRunId) {
        recordUpdateRunVerification(updateRunId, { noticeDelivered: true });
      }
    } else if (noticeQueueId && !noticeQueueCreated) {
      log.info(`${summary}: durable restart notice already owned`, {
        sessionKey: canonicalKey,
      });
    }

    if (continuationQueueId) {
      await drainRestartContinuationQueue({
        deps: params.deps,
        entryId: continuationQueueId,
        log,
      });
    }

    return { status: "ran" as const };
  };

  return {
    source: "restart-sentinel",
    ...(sessionKey ? { sessionKey } : {}),
    run,
  };
}

async function scheduleRestartSentinelWakeAttempt(params: { deps: CliDeps; attempt: number }) {
  const task = await loadRestartSentinelStartupTask(params);
  if (!task) {
    return;
  }
  await runStartupTasks({ tasks: [task], log });
}

export async function scheduleRestartSentinelWake(params: { deps: CliDeps }) {
  await scheduleRestartSentinelWakeAttempt({ ...params, attempt: 0 });
}

export async function refreshLatestUpdateRestartSentinel(): Promise<RestartSentinelPayload | null> {
  const current = await readRestartSentinel();
  if (
    current?.payload.kind === "update" &&
    isPendingControlPlaneUpdateRestartSentinel(current.payload)
  ) {
    latestUpdateRestartSentinel = cloneRestartSentinelPayload(current.payload);
    return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
  }
  const finalized = await finalizeUpdateRestartSentinelRunningVersion();
  const sentinel = finalized ?? current;
  if (sentinel?.payload.kind === "update") {
    latestUpdateRestartSentinel = cloneRestartSentinelPayload(sentinel.payload);
  }
  return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
}

export function getLatestUpdateRestartSentinel(): RestartSentinelPayload | null {
  return cloneRestartSentinelPayload(latestUpdateRestartSentinel);
}

export function recordLatestUpdateRestartSentinel(payload: RestartSentinelPayload): void {
  latestUpdateRestartSentinel = cloneRestartSentinelPayload(payload);
}
