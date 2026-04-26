import { randomUUID } from "node:crypto";
import {
  listAgentIds,
  resolveDefaultAgentId,
  resolveAgentWorkspaceDir,
} from "../../agents/agent-scope.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import {
  resolveAgentAvatar,
  resolvePublicAgentAvatarSource,
} from "../../agents/identity-avatar.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import {
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSpawnedRun,
} from "../../agents/spawned-context.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import {
  resolveBareResetBootstrapFileAccess,
  resolveBareSessionResetPromptState,
} from "../../auto-reply/reply/session-reset-prompt.js";
import {
  buildSessionStartupContextPrelude,
  shouldApplyStartupContext,
} from "../../auto-reply/reply/startup-context.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  evaluateSessionFreshness,
  mergeSessionEntry,
  resolveChannelResetConfig,
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
  resolveAgentMainSessionKey,
  resolveSessionLifecycleTimestamps,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { registerAgentRunContext } from "../../infra/agent-events.js";
import {
  resolveAgentDeliveryPlan,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { shouldDowngradeDeliveryToSessionOnly } from "../../infra/outbound/best-effort-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import { isAbortError } from "../../infra/unhandled-rejections.js";
import {
  loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "../../infra/voicewake-routing.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import {
  classifySessionKeyShape,
  isAcpSessionKey,
  isSubagentSessionKey,
  normalizeAgentId,
} from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "../../tasks/detached-task-runtime.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
} from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import { registerChatAbortController, resolveAgentRunExpiresAtMs } from "../chat-abort.js";
import { MediaOffloadError, parseMessageWithAttachments } from "../chat-attachments.js";
import { resolveAssistantAvatarUrl } from "../control-ui-shared.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { GATEWAY_CLIENT_CAPS, hasGatewayClientCap } from "../protocol/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentWaitParams,
} from "../protocol/index.js";
import { performGatewaySessionReset } from "../session-reset-service.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  canonicalizeSpawnedByForAgent,
  loadGatewaySessionRow,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewayModelSupportsImages,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { waitForAgentJob } from "./agent-job.js";
import { injectTimestamp, timestampOptsFromConfig } from "./agent-timestamp.js";
import {
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  type AgentWaitTerminalSnapshot,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import type { GatewayRequestHandlerOptions, GatewayRequestHandlers } from "./types.js";

const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;

function resolveSenderIsOwnerFromClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function resolveAllowModelOverrideFromClient(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return resolveSenderIsOwnerFromClient(client) || client?.internal?.allowModelOverride === true;
}

function resolveCanResetSessionFromClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  return resolveSenderIsOwnerFromClient(client);
}

async function runSessionResetFromAgent(params: {
  key: string;
  reason: "new" | "reset";
}): Promise<
  | { ok: true; key: string; sessionId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const result = await performGatewaySessionReset({
    key: params.key,
    reason: params.reason,
    commandSource: "gateway:agent",
  });
  if (!result.ok) {
    return result;
  }
  return {
    ok: true,
    key: result.key,
    sessionId: result.entry.sessionId,
  };
}

function resolveSessionRuntimeWorkspace(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionEntry?: SessionEntry;
  spawnedBy?: string;
}): {
  runtimeWorkspaceDir: string;
  isCanonicalWorkspace: boolean;
} {
  const sessionAgentId = resolveAgentIdFromSessionKey(params.sessionKey);
  const workspaceOverride = resolveIngressWorkspaceOverrideForSpawnedRun({
    spawnedBy: params.spawnedBy,
    workspaceDir: params.sessionEntry?.spawnedWorkspaceDir,
  });
  return {
    runtimeWorkspaceDir: workspaceOverride ?? resolveAgentWorkspaceDir(params.cfg, sessionAgentId),
    isCanonicalWorkspace: !workspaceOverride,
  };
}

function emitSessionsChanged(
  context: Pick<
    GatewayRequestHandlerOptions["context"],
    "broadcastToConnIds" | "getSessionEventSubscriberConnIds"
  >,
  payload: { sessionKey?: string; reason: string },
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  const sessionRow = payload.sessionKey ? loadGatewaySessionRow(payload.sessionKey) : null;
  context.broadcastToConnIds(
    "sessions.changed",
    {
      ...payload,
      ts: Date.now(),
      ...(sessionRow
        ? {
            updatedAt: sessionRow.updatedAt ?? undefined,
            sessionId: sessionRow.sessionId,
            kind: sessionRow.kind,
            channel: sessionRow.channel,
            subject: sessionRow.subject,
            groupChannel: sessionRow.groupChannel,
            space: sessionRow.space,
            chatType: sessionRow.chatType,
            origin: sessionRow.origin,
            spawnedBy: sessionRow.spawnedBy,
            spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
            forkedFromParent: sessionRow.forkedFromParent,
            spawnDepth: sessionRow.spawnDepth,
            subagentRole: sessionRow.subagentRole,
            subagentControlScope: sessionRow.subagentControlScope,
            label: sessionRow.label,
            displayName: sessionRow.displayName,
            deliveryContext: sessionRow.deliveryContext,
            parentSessionKey: sessionRow.parentSessionKey,
            childSessions: sessionRow.childSessions,
            thinkingLevel: sessionRow.thinkingLevel,
            fastMode: sessionRow.fastMode,
            verboseLevel: sessionRow.verboseLevel,
            traceLevel: sessionRow.traceLevel,
            reasoningLevel: sessionRow.reasoningLevel,
            elevatedLevel: sessionRow.elevatedLevel,
            sendPolicy: sessionRow.sendPolicy,
            systemSent: sessionRow.systemSent,
            abortedLastRun: sessionRow.abortedLastRun,
            inputTokens: sessionRow.inputTokens,
            outputTokens: sessionRow.outputTokens,
            lastChannel: sessionRow.lastChannel,
            lastTo: sessionRow.lastTo,
            lastAccountId: sessionRow.lastAccountId,
            lastThreadId: sessionRow.lastThreadId,
            totalTokens: sessionRow.totalTokens,
            totalTokensFresh: sessionRow.totalTokensFresh,
            contextTokens: sessionRow.contextTokens,
            estimatedCostUsd: sessionRow.estimatedCostUsd,
            responseUsage: sessionRow.responseUsage,
            modelProvider: sessionRow.modelProvider,
            model: sessionRow.model,
            status: sessionRow.status,
            startedAt: sessionRow.startedAt,
            endedAt: sessionRow.endedAt,
            runtimeMs: sessionRow.runtimeMs,
            compactionCheckpointCount: sessionRow.compactionCheckpointCount,
            latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
          }
        : {}),
    },
    connIds,
    { dropIfSlow: true },
  );
}

type GatewayAgentTaskTerminalStatus = Extract<
  TaskStatus,
  "succeeded" | "failed" | "timed_out" | "cancelled"
>;

function resolveFailedTrackedAgentTaskStatus(error: unknown): GatewayAgentTaskTerminalStatus {
  return isAbortError(error) || isTimeoutError(error) ? "timed_out" : "failed";
}

function tryFinalizeTrackedAgentTask(params: {
  runId: string;
  status: GatewayAgentTaskTerminalStatus;
  error?: string;
  terminalSummary?: string;
}): void {
  try {
    finalizeTaskRunByRunId({
      runId: params.runId,
      runtime: "cli",
      status: params.status,
      endedAt: Date.now(),
      ...(params.error !== undefined ? { error: params.error } : {}),
      ...(params.terminalSummary !== undefined ? { terminalSummary: params.terminalSummary } : {}),
    });
  } catch {
    // Best-effort only: background task tracking must not block agent runs.
  }
}

function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromIngress>[0];
  runId: string;
  idempotencyKey: string;
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
}) {
  const inputProvenance = normalizeInputProvenance(params.ingressOpts.inputProvenance);
  const shouldTrackTask =
    params.ingressOpts.sessionKey?.trim() && inputProvenance?.kind !== "inter_session";
  if (shouldTrackTask) {
    try {
      createRunningTaskRun({
        runtime: "cli",
        sourceId: params.runId,
        ownerKey: params.ingressOpts.sessionKey,
        scopeKind: "session",
        requesterOrigin: normalizeDeliveryContext({
          channel: params.ingressOpts.channel,
          to: params.ingressOpts.to,
          accountId: params.ingressOpts.accountId,
          threadId: params.ingressOpts.threadId,
        }),
        childSessionKey: params.ingressOpts.sessionKey,
        runId: params.runId,
        task: params.ingressOpts.message,
        deliveryStatus: "not_applicable",
        startedAt: Date.now(),
      });
    } catch {
      // Best-effort only: background task tracking must not block agent runs.
    }
  }
  void agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps)
    .then((result) => {
      if (shouldTrackTask) {
        const aborted = result?.meta?.aborted === true;
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          status: aborted ? "timed_out" : "succeeded",
          terminalSummary: aborted ? "aborted" : "completed",
        });
      }
      const payload = {
        runId: params.runId,
        status: "ok" as const,
        summary: "completed",
        result,
      };
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `agent:${params.idempotencyKey}`,
        entry: {
          ts: Date.now(),
          ok: true,
          payload,
        },
      });
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.respond(true, payload, undefined, { runId: params.runId });
    })
    .catch((err) => {
      if (shouldTrackTask) {
        const error = String(err);
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          status: resolveFailedTrackedAgentTaskStatus(err),
          error,
          terminalSummary: error,
        });
      }
      const error = errorShape(ErrorCodes.UNAVAILABLE, String(err));
      const payload = {
        runId: params.runId,
        status: "error" as const,
        summary: String(err),
      };
      setGatewayDedupeEntry({
        dedupe: params.context.dedupe,
        key: `agent:${params.idempotencyKey}`,
        entry: {
          ts: Date.now(),
          ok: false,
          payload,
          error,
        },
      });
      params.respond(false, payload, error, {
        runId: params.runId,
        error: formatForLog(err),
      });
    })
    .finally(() => {
      const entry = params.context.chatAbortControllers.get(params.runId);
      if (entry?.controller === params.abortController) {
        params.context.chatAbortControllers.delete(params.runId);
      }
    });
}

export const agentHandlers: GatewayRequestHandlers = {
  agent: async ({ params, respond, context, client, isWebchatConnect }) => {
    const p = params;
    if (!validateAgentParams(p)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: ${formatValidationErrors(validateAgentParams.errors)}`,
        ),
      );
      return;
    }
    const request = p as {
      message: string;
      agentId?: string;
      provider?: string;
      model?: string;
      to?: string;
      replyTo?: string;
      sessionId?: string;
      sessionKey?: string;
      thinking?: string;
      deliver?: boolean;
      attachments?: Array<{
        type?: string;
        mimeType?: string;
        fileName?: string;
        content?: unknown;
      }>;
      channel?: string;
      replyChannel?: string;
      accountId?: string;
      replyAccountId?: string;
      threadId?: string;
      groupId?: string;
      groupChannel?: string;
      groupSpace?: string;
      lane?: string;
      extraSystemPrompt?: string;
      modelRun?: boolean;
      promptMode?: "full" | "minimal" | "none";
      bootstrapContextMode?: "full" | "lightweight";
      bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
      internalEvents?: AgentInternalEvent[];
      idempotencyKey: string;
      timeout?: number;
      bestEffortDeliver?: boolean;
      cleanupBundleMcpOnRunEnd?: boolean;
      label?: string;
      inputProvenance?: InputProvenance;
      workspaceDir?: string;
      voiceWakeTrigger?: string;
    };
    const senderIsOwner = resolveSenderIsOwnerFromClient(client);
    const allowModelOverride = resolveAllowModelOverrideFromClient(client);
    const canResetSession = resolveCanResetSessionFromClient(client);
    const requestedModelOverride = Boolean(request.provider || request.model);
    if (requestedModelOverride && !allowModelOverride) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "provider/model overrides are not authorized for this caller.",
        ),
      );
      return;
    }
    const providerOverride = allowModelOverride ? request.provider : undefined;
    const modelOverride = allowModelOverride ? request.model : undefined;
    const cfg = loadConfig();
    const idem = request.idempotencyKey;
    const normalizedSpawned = normalizeSpawnedRunMetadata({
      groupId: request.groupId,
      groupChannel: request.groupChannel,
      groupSpace: request.groupSpace,
    });
    let resolvedGroupId: string | undefined = normalizedSpawned.groupId;
    let resolvedGroupChannel: string | undefined = normalizedSpawned.groupChannel;
    let resolvedGroupSpace: string | undefined = normalizedSpawned.groupSpace;
    let spawnedByValue: string | undefined;
    const inputProvenance = normalizeInputProvenance(request.inputProvenance);
    const cached = context.dedupe.get(`agent:${idem}`);
    if (cached) {
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);
    const requestedBestEffortDeliver =
      typeof request.bestEffortDeliver === "boolean" ? request.bestEffortDeliver : undefined;

    let message = (request.message ?? "").trim();
    let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    let imageOrder: PromptImageOrderEntry[] = [];
    if (normalizedAttachments.length > 0) {
      const requestedSessionKeyRaw =
        typeof request.sessionKey === "string" && request.sessionKey.trim()
          ? request.sessionKey.trim()
          : undefined;

      let baseProvider: string | undefined;
      let baseModel: string | undefined;
      if (requestedSessionKeyRaw) {
        const { cfg: sessCfg, entry: sessEntry } = loadSessionEntry(requestedSessionKeyRaw);
        const modelRef = resolveSessionModelRef(sessCfg, sessEntry, undefined);
        baseProvider = modelRef.provider;
        baseModel = modelRef.model;
      }
      const effectiveProvider = providerOverride || baseProvider;
      const effectiveModel = modelOverride || baseModel;
      const supportsImages = await resolveGatewayModelSupportsImages({
        loadGatewayModelCatalog: context.loadGatewayModelCatalog,
        provider: effectiveProvider,
        model: effectiveModel,
      });

      try {
        const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
          maxBytes: 5_000_000,
          log: context.logGateway,
          supportsImages,
        });
        message = parsed.message.trim();
        images = parsed.images;
        imageOrder = parsed.imageOrder;
        // offloadedRefs are appended as text markers to `message`; the agent
        // runner will resolve them via detectAndLoadPromptImages.
      } catch (err) {
        // MediaOffloadError indicates a server-side storage fault (ENOSPC, EPERM,
        // etc.). Map it to UNAVAILABLE so clients can retry without treating it as
        // a bad request. All other errors are input-validation failures → 4xx.
        const isServerFault = err instanceof MediaOffloadError;
        respond(
          false,
          undefined,
          errorShape(
            isServerFault ? ErrorCodes.UNAVAILABLE : ErrorCodes.INVALID_REQUEST,
            String(err),
          ),
        );
        return;
      }
    }

    const isKnownGatewayChannel = (value: string): boolean => isGatewayMessageChannel(value);
    const channelHints = [request.channel, request.replyChannel]
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter(Boolean);
    for (const rawChannel of channelHints) {
      const normalized = normalizeMessageChannel(rawChannel);
      if (normalized && normalized !== "last" && !isKnownGatewayChannel(normalized)) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: unknown channel: ${normalized}`,
          ),
        );
        return;
      }
    }

    const knownAgents = listAgentIds(cfg);
    const agentIdRaw = normalizeOptionalString(request.agentId) ?? "";
    let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (agentId && !knownAgents.includes(agentId)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: unknown agent id "${request.agentId}"`,
        ),
      );
      return;
    }

    const requestedSessionKeyRaw = normalizeOptionalString(request.sessionKey);
    if (
      requestedSessionKeyRaw &&
      classifySessionKeyShape(requestedSessionKeyRaw) === "malformed_agent"
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent params: malformed session key "${requestedSessionKeyRaw}"`,
        ),
      );
      return;
    }
    const requestedSessionId = normalizeOptionalString(request.sessionId);
    let requestedSessionKey =
      requestedSessionKeyRaw ??
      (!requestedSessionId
        ? resolveExplicitAgentSessionKey({
            cfg,
            agentId,
          })
        : undefined);
    if (agentId && requestedSessionKeyRaw) {
      const sessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
      if (sessionAgentId !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent params: agent "${request.agentId}" does not match session key agent "${sessionAgentId}"`,
          ),
        );
        return;
      }
    }
    const voiceWakeTrigger = normalizeOptionalString(request.voiceWakeTrigger) ?? "";
    const replyTo = normalizeOptionalString(request.replyTo) ?? "";
    const to = normalizeOptionalString(request.to) ?? "";
    const explicitVoiceWakeSessionTarget =
      !agentId && requestedSessionKeyRaw
        ? (() => {
            const { cfg: sessionCfg, canonicalKey } = loadSessionEntry(requestedSessionKeyRaw);
            const routedAgentId = resolveAgentIdFromSessionKey(canonicalKey);
            const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(sessionCfg));
            if (routedAgentId !== defaultAgentId) {
              return true;
            }
            const mainSessionKey = resolveAgentMainSessionKey({
              cfg: sessionCfg,
              agentId: routedAgentId,
            });
            return canonicalKey !== mainSessionKey;
          })()
        : false;
    const canAutoRouteVoiceWake =
      !agentId && !explicitVoiceWakeSessionTarget && !requestedSessionId && !replyTo && !to;
    const hasVoiceWakeTriggerField = Object.prototype.hasOwnProperty.call(
      request,
      "voiceWakeTrigger",
    );
    if (hasVoiceWakeTriggerField && canAutoRouteVoiceWake) {
      try {
        const routingConfig = await loadVoiceWakeRoutingConfig();
        const route = resolveVoiceWakeRouteByTrigger({
          trigger: voiceWakeTrigger || undefined,
          config: routingConfig,
        });
        if ("agentId" in route) {
          if (knownAgents.includes(route.agentId)) {
            agentId = route.agentId;
            requestedSessionKey = resolveExplicitAgentSessionKey({
              cfg,
              agentId,
            });
          } else {
            context.logGateway.warn(
              `voicewake routing ignored unknown agentId="${route.agentId}" trigger="${voiceWakeTrigger}"`,
            );
          }
        } else if ("sessionKey" in route) {
          if (classifySessionKeyShape(route.sessionKey) !== "malformed_agent") {
            const canonicalRouteSession = loadSessionEntry(route.sessionKey).canonicalKey;
            const routedAgentId = resolveAgentIdFromSessionKey(canonicalRouteSession);
            if (knownAgents.includes(routedAgentId)) {
              requestedSessionKey = canonicalRouteSession;
              agentId = routedAgentId;
            } else {
              context.logGateway.warn(
                `voicewake routing ignored unknown session agent="${routedAgentId}" sessionKey="${canonicalRouteSession}" trigger="${voiceWakeTrigger}"`,
              );
            }
          } else {
            context.logGateway.warn(
              `voicewake routing ignored malformed sessionKey="${route.sessionKey}" trigger="${voiceWakeTrigger}"`,
            );
          }
        }
      } catch (err) {
        context.logGateway.warn(`voicewake routing load failed: ${formatForLog(err)}`);
      }
    }
    let resolvedSessionId = requestedSessionId;
    let sessionEntry: SessionEntry | undefined;
    let bestEffortDeliver = requestedBestEffortDeliver ?? false;
    let cfgForAgent: OpenClawConfig | undefined;
    let resolvedSessionKey = requestedSessionKey;
    let isNewSession = false;
    let skipTimestampInjection = false;
    let shouldPrependStartupContext = false;

    const resetCommandMatch = message.match(RESET_COMMAND_RE);
    if (resetCommandMatch && requestedSessionKey) {
      if (!canResetSession) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${ADMIN_SCOPE}`),
        );
        return;
      }
      const resetReason =
        normalizeOptionalLowercaseString(resetCommandMatch[1]) === "new" ? "new" : "reset";
      const resetResult = await runSessionResetFromAgent({
        key: requestedSessionKey,
        reason: resetReason,
      });
      if (!resetResult.ok) {
        respond(false, undefined, resetResult.error);
        return;
      }
      requestedSessionKey = resetResult.key;
      resolvedSessionId = resetResult.sessionId ?? resolvedSessionId;
      const postResetMessage = normalizeOptionalString(resetCommandMatch[2]) ?? "";
      if (postResetMessage) {
        message = postResetMessage;
      } else {
        const resetLoadedSession = loadSessionEntry(requestedSessionKey);
        const resetCfg = resetLoadedSession?.cfg ?? cfg;
        const resetSessionEntry = resetLoadedSession?.entry;
        const resetSpawnedBy = canonicalizeSpawnedByForAgent(
          resetCfg,
          resolveAgentIdFromSessionKey(requestedSessionKey),
          resetSessionEntry?.spawnedBy,
        );
        const { runtimeWorkspaceDir, isCanonicalWorkspace } = resolveSessionRuntimeWorkspace({
          cfg: resetCfg,
          sessionKey: requestedSessionKey,
          sessionEntry: resetSessionEntry,
          spawnedBy: resetSpawnedBy,
        });
        const resetSessionAgentId = resolveAgentIdFromSessionKey(requestedSessionKey);
        const resetBaseModelRef = resolveSessionModelRef(
          resetCfg,
          resetSessionEntry,
          resetSessionAgentId,
        );
        const resetEffectiveModelRef = {
          provider: providerOverride || resetBaseModelRef.provider,
          model: modelOverride || resetBaseModelRef.model,
        };
        const bareResetPromptState = await resolveBareSessionResetPromptState({
          cfg: resetCfg,
          workspaceDir: runtimeWorkspaceDir,
          isPrimaryRun:
            !isSubagentSessionKey(requestedSessionKey) && !isAcpSessionKey(requestedSessionKey),
          isCanonicalWorkspace,
          hasBootstrapFileAccess: resolveBareResetBootstrapFileAccess({
            cfg: resetCfg,
            agentId: resetSessionAgentId,
            sessionKey: requestedSessionKey,
            workspaceDir: runtimeWorkspaceDir,
            modelProvider: resetEffectiveModelRef.provider,
            modelId: resetEffectiveModelRef.model,
          }),
        });
        // Keep bare /new and /reset behavior aligned with chat.send:
        // reset first, then run a fresh-session greeting prompt in-place.
        // Date is embedded in the prompt so agents read the correct daily
        // memory files; skip further timestamp injection to avoid duplication.
        message = bareResetPromptState.prompt;
        skipTimestampInjection = true;
        shouldPrependStartupContext =
          bareResetPromptState.shouldPrependStartupContext &&
          shouldApplyStartupContext({ cfg, action: resetReason });
      }
    }

    // Inject timestamp into user-authored messages that don't already have one.
    // Channel messages (Discord, Telegram, etc.) get timestamps via envelope
    // formatting in a separate code path — they never reach this handler.
    // See: https://github.com/openclaw/openclaw/issues/3658
    if (!skipTimestampInjection) {
      message = injectTimestamp(message, timestampOptsFromConfig(cfg));
    }

    if (requestedSessionKey) {
      const { cfg, storePath, entry, canonicalKey } = loadSessionEntry(requestedSessionKey);
      cfgForAgent = cfg;
      const now = Date.now();
      const resetPolicy = resolveSessionResetPolicy({
        sessionCfg: cfg.session,
        resetType: resolveSessionResetType({ sessionKey: canonicalKey }),
        resetOverride: resolveChannelResetConfig({
          sessionCfg: cfg.session,
          channel: entry?.lastChannel ?? entry?.channel ?? request.channel,
        }),
      });
      const freshness = entry
        ? evaluateSessionFreshness({
            updatedAt: entry.updatedAt,
            ...resolveSessionLifecycleTimestamps({
              entry,
              storePath,
              agentId: resolveAgentIdFromSessionKey(canonicalKey),
            }),
            now,
            policy: resetPolicy,
          })
        : undefined;
      const canReuseSession = Boolean(entry?.sessionId) && (freshness?.fresh ?? false);
      const usableRequestedSessionId =
        requestedSessionId && (!entry?.sessionId || canReuseSession)
          ? requestedSessionId
          : undefined;
      const sessionId = usableRequestedSessionId
        ? usableRequestedSessionId
        : ((canReuseSession ? entry?.sessionId : undefined) ?? randomUUID());
      isNewSession =
        !entry ||
        (!canReuseSession && !usableRequestedSessionId) ||
        Boolean(usableRequestedSessionId && entry?.sessionId !== usableRequestedSessionId);
      const touchInteraction =
        request.bootstrapContextRunKind !== "cron" &&
        request.bootstrapContextRunKind !== "heartbeat" &&
        !request.internalEvents?.length;
      const labelValue = normalizeOptionalString(request.label) || entry?.label;
      const sessionAgent = resolveAgentIdFromSessionKey(canonicalKey);
      spawnedByValue = canonicalizeSpawnedByForAgent(cfg, sessionAgent, entry?.spawnedBy);
      let inheritedGroup:
        | { groupId?: string; groupChannel?: string; groupSpace?: string }
        | undefined;
      if (spawnedByValue && (!resolvedGroupId || !resolvedGroupChannel || !resolvedGroupSpace)) {
        try {
          const parentEntry = loadSessionEntry(spawnedByValue)?.entry;
          inheritedGroup = {
            groupId: parentEntry?.groupId,
            groupChannel: parentEntry?.groupChannel,
            groupSpace: parentEntry?.space,
          };
        } catch {
          inheritedGroup = undefined;
        }
      }
      resolvedGroupId = resolvedGroupId || inheritedGroup?.groupId;
      resolvedGroupChannel = resolvedGroupChannel || inheritedGroup?.groupChannel;
      resolvedGroupSpace = resolvedGroupSpace || inheritedGroup?.groupSpace;
      const deliveryFields = normalizeSessionDeliveryFields(entry);
      // When the session has no delivery context yet (e.g. a freshly-spawned subagent
      // with deliver: false), seed it from the request's channel/to/threadId params.
      // Without this, subagent sessions end up with a channel-only deliveryContext
      // and no `to`/`threadId`, which causes announce delivery to either target the
      // wrong channel (when the parent's lastTo drifts) or fail entirely.
      const requestDeliveryHint = normalizeDeliveryContext({
        channel: request.channel?.trim(),
        to: request.to?.trim(),
        accountId: request.accountId?.trim(),
        // Pass threadId directly — normalizeDeliveryContext handles both
        // string and numeric threadIds (e.g., Matrix uses integers).
        threadId: request.threadId,
      });
      const effectiveDelivery = mergeDeliveryContext(
        deliveryFields.deliveryContext,
        requestDeliveryHint,
      );
      const effectiveDeliveryFields = normalizeSessionDeliveryFields({
        deliveryContext: effectiveDelivery,
      });
      const nextEntryPatch: SessionEntry = {
        sessionId,
        updatedAt: now,
        sessionStartedAt: isNewSession
          ? now
          : (entry?.sessionStartedAt ??
            resolveSessionLifecycleTimestamps({
              entry,
              storePath,
              agentId: resolveAgentIdFromSessionKey(canonicalKey),
            }).sessionStartedAt),
        lastInteractionAt: touchInteraction ? now : entry?.lastInteractionAt,
        thinkingLevel: entry?.thinkingLevel,
        fastMode: entry?.fastMode,
        verboseLevel: entry?.verboseLevel,
        traceLevel: entry?.traceLevel,
        reasoningLevel: entry?.reasoningLevel,
        systemSent: entry?.systemSent,
        sendPolicy: entry?.sendPolicy,
        skillsSnapshot: entry?.skillsSnapshot,
        deliveryContext: effectiveDeliveryFields.deliveryContext,
        lastChannel: effectiveDeliveryFields.lastChannel ?? entry?.lastChannel,
        lastTo: effectiveDeliveryFields.lastTo ?? entry?.lastTo,
        lastAccountId: effectiveDeliveryFields.lastAccountId ?? entry?.lastAccountId,
        lastThreadId: effectiveDeliveryFields.lastThreadId ?? entry?.lastThreadId,
        modelOverride: entry?.modelOverride,
        providerOverride: entry?.providerOverride,
        label: labelValue,
        spawnedBy: spawnedByValue,
        spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
        spawnDepth: entry?.spawnDepth,
        channel: entry?.channel ?? request.channel?.trim(),
        groupId: resolvedGroupId ?? entry?.groupId,
        groupChannel: resolvedGroupChannel ?? entry?.groupChannel,
        space: resolvedGroupSpace ?? entry?.space,
        cliSessionIds: entry?.cliSessionIds,
        cliSessionBindings: entry?.cliSessionBindings,
        claudeCliSessionId: entry?.claudeCliSessionId,
      };
      sessionEntry = mergeSessionEntry(entry, nextEntryPatch);
      const sendPolicy = resolveSendPolicy({
        cfg,
        entry,
        sessionKey: canonicalKey,
        channel: entry?.channel,
        chatType: entry?.chatType,
      });
      if (sendPolicy === "deny") {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
        );
        return;
      }
      resolvedSessionId = sessionId;
      const canonicalSessionKey = canonicalKey;
      resolvedSessionKey = canonicalSessionKey;
      const agentId = resolveAgentIdFromSessionKey(canonicalSessionKey);
      const mainSessionKey = resolveAgentMainSessionKey({ cfg, agentId });
      if (storePath) {
        const persisted = await updateSessionStore(storePath, (store) => {
          const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({
            cfg,
            key: requestedSessionKey,
            store,
          });
          const merged = mergeSessionEntry(store[primaryKey], nextEntryPatch);
          store[primaryKey] = merged;
          return merged;
        });
        sessionEntry = persisted;
      }
      if (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global") {
        context.addChatRun(idem, {
          sessionKey: canonicalSessionKey,
          clientRunId: idem,
        });
        if (requestedBestEffortDeliver === undefined) {
          bestEffortDeliver = true;
        }
      }
      registerAgentRunContext(idem, { sessionKey: canonicalSessionKey });
    }

    const runId = idem;
    const connId = typeof client?.connId === "string" ? client.connId : undefined;
    const wantsToolEvents = hasGatewayClientCap(
      client?.connect?.caps,
      GATEWAY_CLIENT_CAPS.TOOL_EVENTS,
    );
    if (connId && wantsToolEvents) {
      context.registerToolEventRecipient(runId, connId);
      // Register for any other active runs *in the same session* so
      // late-joining clients (e.g. page refresh mid-response) receive
      // in-progress tool events without leaking cross-session data.
      for (const [activeRunId, active] of context.chatAbortControllers) {
        if (activeRunId !== runId && active.sessionKey === requestedSessionKey) {
          context.registerToolEventRecipient(activeRunId, connId);
        }
      }
    }

    const wantsDelivery = request.deliver === true;
    const explicitTo =
      normalizeOptionalString(request.replyTo) ?? normalizeOptionalString(request.to);
    const explicitThreadId = normalizeOptionalString(request.threadId);
    const turnSourceChannel = normalizeOptionalString(request.channel);
    const turnSourceTo = normalizeOptionalString(request.to);
    const turnSourceAccountId = normalizeOptionalString(request.accountId);
    const deliveryPlan = resolveAgentDeliveryPlan({
      sessionEntry,
      requestedChannel: request.replyChannel ?? request.channel,
      explicitTo,
      explicitThreadId,
      accountId: request.replyAccountId ?? request.accountId,
      wantsDelivery,
      turnSourceChannel,
      turnSourceTo,
      turnSourceAccountId,
      turnSourceThreadId: explicitThreadId,
    });

    let resolvedChannel = deliveryPlan.resolvedChannel;
    let deliveryTargetMode = deliveryPlan.deliveryTargetMode;
    let resolvedAccountId = deliveryPlan.resolvedAccountId;
    let resolvedTo = deliveryPlan.resolvedTo;
    let effectivePlan = deliveryPlan;
    let deliveryDowngradeReason: string | null = null;

    if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
      const cfgResolved = cfgForAgent ?? cfg;
      try {
        const selection = await resolveMessageChannelSelection({ cfg: cfgResolved });
        resolvedChannel = selection.channel;
        deliveryTargetMode = deliveryTargetMode ?? "implicit";
        effectivePlan = {
          ...deliveryPlan,
          resolvedChannel,
          deliveryTargetMode,
          resolvedAccountId,
        };
      } catch (err) {
        const shouldDowngrade = shouldDowngradeDeliveryToSessionOnly({
          wantsDelivery,
          bestEffortDeliver,
          resolvedChannel,
        });
        if (!shouldDowngrade) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(err)));
          return;
        }
        deliveryDowngradeReason = String(err);
      }
    }

    if (!resolvedTo && isDeliverableMessageChannel(resolvedChannel)) {
      const cfgResolved = cfgForAgent ?? cfg;
      const fallback = resolveAgentOutboundTarget({
        cfg: cfgResolved,
        plan: effectivePlan,
        targetMode: deliveryTargetMode ?? "implicit",
        validateExplicitTarget: false,
      });
      if (fallback.resolvedTarget?.ok) {
        resolvedTo = fallback.resolvedTo;
      }
    }

    if (wantsDelivery && resolvedChannel === INTERNAL_MESSAGE_CHANNEL) {
      const shouldDowngrade = shouldDowngradeDeliveryToSessionOnly({
        wantsDelivery,
        bestEffortDeliver,
        resolvedChannel,
      });
      if (!shouldDowngrade) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            "delivery channel is required: pass --channel/--reply-channel or use a main session with a previous channel",
          ),
        );
        return;
      }
      context.logGateway.info(
        deliveryDowngradeReason
          ? `agent delivery downgraded to session-only (bestEffortDeliver): ${deliveryDowngradeReason}`
          : "agent delivery downgraded to session-only (bestEffortDeliver): no deliverable channel",
      );
    }

    const normalizedTurnSource = normalizeMessageChannel(turnSourceChannel);
    const turnSourceMessageChannel =
      normalizedTurnSource && isGatewayMessageChannel(normalizedTurnSource)
        ? normalizedTurnSource
        : undefined;
    const originMessageChannel =
      turnSourceMessageChannel ??
      (client?.connect && isWebchatConnect(client.connect)
        ? INTERNAL_MESSAGE_CHANNEL
        : resolvedChannel);

    const deliver = request.deliver === true && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;

    // Register before the accepted ack so an immediate chat.abort/sessions.abort
    // cannot race the active-run entry. Agent RPC runs use the agent timeout;
    // chat.send keeps the shorter chat cleanup cap.
    const now = Date.now();
    const timeoutMs = resolveAgentTimeoutMs({
      cfg: cfgForAgent ?? cfg,
      overrideSeconds: typeof request.timeout === "number" ? request.timeout : undefined,
    });
    const activeRunAbort = registerChatAbortController({
      chatAbortControllers: context.chatAbortControllers,
      runId,
      sessionId: resolvedSessionId ?? runId,
      sessionKey: resolvedSessionKey,
      timeoutMs,
      now,
      expiresAtMs: resolveAgentRunExpiresAtMs({ now, timeoutMs }),
      ownerConnId: typeof client?.connId === "string" ? client.connId : undefined,
      ownerDeviceId:
        typeof client?.connect?.device?.id === "string" ? client.connect.device.id : undefined,
      kind: "agent",
    });

    const accepted = {
      runId,
      status: "accepted" as const,
      acceptedAt: Date.now(),
    };
    // Store an in-flight ack so retries do not spawn a second run.
    setGatewayDedupeEntry({
      dedupe: context.dedupe,
      key: `agent:${idem}`,
      entry: {
        ts: Date.now(),
        ok: true,
        payload: accepted,
      },
    });
    respond(true, accepted, undefined, { runId });

    let dispatched = false;
    try {
      if (resolvedSessionKey) {
        await reactivateCompletedSubagentSession({
          sessionKey: resolvedSessionKey,
          runId,
        });
      }

      if (requestedSessionKey && resolvedSessionKey && isNewSession) {
        emitSessionsChanged(context, {
          sessionKey: resolvedSessionKey,
          reason: "create",
        });
      }
      if (resolvedSessionKey) {
        emitSessionsChanged(context, {
          sessionKey: resolvedSessionKey,
          reason: "send",
        });
      }

      if (shouldPrependStartupContext && resolvedSessionKey) {
        const { runtimeWorkspaceDir } = resolveSessionRuntimeWorkspace({
          cfg: cfgForAgent ?? cfg,
          sessionKey: resolvedSessionKey,
          sessionEntry,
          spawnedBy: spawnedByValue,
        });
        const startupContextPrelude = await buildSessionStartupContextPrelude({
          workspaceDir: runtimeWorkspaceDir,
          cfg: cfgForAgent ?? cfg,
        });
        if (startupContextPrelude) {
          message = `${startupContextPrelude}\n\n${message}`;
        }
      }

      const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;
      const ingressAgentId =
        agentId &&
        (!resolvedSessionKey || resolveAgentIdFromSessionKey(resolvedSessionKey) === agentId)
          ? agentId
          : undefined;

      dispatchAgentRunFromGateway({
        ingressOpts: {
          message,
          images,
          imageOrder,
          agentId: ingressAgentId,
          provider: providerOverride,
          model: modelOverride,
          to: resolvedTo,
          sessionId: resolvedSessionId,
          sessionKey: resolvedSessionKey,
          thinking: request.thinking,
          deliver,
          deliveryTargetMode,
          channel: resolvedChannel,
          accountId: resolvedAccountId,
          threadId: resolvedThreadId,
          runContext: {
            messageChannel: originMessageChannel,
            accountId: resolvedAccountId,
            groupId: resolvedGroupId,
            groupChannel: resolvedGroupChannel,
            groupSpace: resolvedGroupSpace,
            currentThreadTs: resolvedThreadId != null ? String(resolvedThreadId) : undefined,
          },
          groupId: resolvedGroupId,
          groupChannel: resolvedGroupChannel,
          groupSpace: resolvedGroupSpace,
          spawnedBy: spawnedByValue,
          timeout: request.timeout?.toString(),
          bestEffortDeliver,
          messageChannel: originMessageChannel,
          runId,
          lane: request.lane,
          cleanupBundleMcpOnRunEnd: request.cleanupBundleMcpOnRunEnd === true,
          modelRun: request.modelRun === true,
          promptMode: request.promptMode,
          extraSystemPrompt: request.extraSystemPrompt,
          bootstrapContextMode: request.bootstrapContextMode,
          bootstrapContextRunKind: request.bootstrapContextRunKind,
          internalEvents: request.internalEvents,
          inputProvenance,
          abortSignal: activeRunAbort.controller.signal,
          // Internal-only: allow workspace override for spawned subagent runs.
          workspaceDir: resolveIngressWorkspaceOverrideForSpawnedRun({
            spawnedBy: spawnedByValue,
            workspaceDir: sessionEntry?.spawnedWorkspaceDir,
          }),
          senderIsOwner,
          allowModelOverride,
        },
        runId,
        idempotencyKey: idem,
        abortController: activeRunAbort.controller,
        respond,
        context,
      });
      dispatched = true;
    } finally {
      if (!dispatched) {
        activeRunAbort.cleanup();
      }
    }
  },
  "agent.identity.get": ({ params, respond }) => {
    if (!validateAgentIdentityParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.identity.get params: ${formatValidationErrors(
            validateAgentIdentityParams.errors,
          )}`,
        ),
      );
      return;
    }
    const p = params;
    const agentIdRaw = normalizeOptionalString(p.agentId) ?? "";
    const sessionKeyRaw = normalizeOptionalString(p.sessionKey) ?? "";
    let agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (sessionKeyRaw) {
      if (classifySessionKeyShape(sessionKeyRaw) === "malformed_agent") {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: malformed session key "${sessionKeyRaw}"`,
          ),
        );
        return;
      }
      const resolved = resolveAgentIdFromSessionKey(sessionKeyRaw);
      if (agentId && resolved !== agentId) {
        respond(
          false,
          undefined,
          errorShape(
            ErrorCodes.INVALID_REQUEST,
            `invalid agent.identity.get params: agent "${agentIdRaw}" does not match session key agent "${resolved}"`,
          ),
        );
        return;
      }
      agentId = resolved;
    }
    const cfg = loadConfig();
    const identity = resolveAssistantIdentity({ cfg, agentId });
    const avatarValue =
      resolveAssistantAvatarUrl({
        avatar: identity.avatar,
        agentId: identity.agentId,
        basePath: cfg.gateway?.controlUi?.basePath,
      }) ?? identity.avatar;
    const avatarResolution = resolveAgentAvatar(cfg, identity.agentId, { includeUiOverride: true });
    respond(
      true,
      {
        ...identity,
        avatar: avatarValue,
        avatarSource: resolvePublicAgentAvatarSource(avatarResolution),
        avatarStatus: avatarResolution.kind,
        avatarReason: avatarResolution.kind === "none" ? avatarResolution.reason : undefined,
      },
      undefined,
    );
  },
  "agent.wait": async ({ params, respond, context }) => {
    if (!validateAgentWaitParams(params)) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          `invalid agent.wait params: ${formatValidationErrors(validateAgentWaitParams.errors)}`,
        ),
      );
      return;
    }
    const p = params;
    const runId = (p.runId ?? "").trim();
    const timeoutMs =
      typeof p.timeoutMs === "number" && Number.isFinite(p.timeoutMs)
        ? Math.max(0, Math.floor(p.timeoutMs))
        : 30_000;
    // `hasActiveChatRun` drives snapshot preference, so it must reflect
    // chat.send specifically — not an agent-kind entry registered by the
    // `agent` RPC for its own abort surface.
    const activeChatEntry = context.chatAbortControllers.get(runId);
    const hasActiveChatRun = activeChatEntry !== undefined && activeChatEntry.kind !== "agent";

    const cachedGatewaySnapshot = readTerminalSnapshotFromGatewayDedupe({
      dedupe: context.dedupe,
      runId,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
    });
    if (cachedGatewaySnapshot) {
      respond(true, {
        runId,
        status: cachedGatewaySnapshot.status,
        startedAt: cachedGatewaySnapshot.startedAt,
        endedAt: cachedGatewaySnapshot.endedAt,
        error: cachedGatewaySnapshot.error,
      });
      return;
    }

    const lifecycleAbortController = new AbortController();
    const dedupeAbortController = new AbortController();
    const lifecyclePromise = waitForAgentJob({
      runId,
      timeoutMs,
      signal: lifecycleAbortController.signal,
      // When chat.send is active with the same runId, ignore cached lifecycle
      // snapshots so stale agent results do not preempt the active chat run.
      ignoreCachedSnapshot: hasActiveChatRun,
    });
    const dedupePromise = waitForTerminalGatewayDedupe({
      dedupe: context.dedupe,
      runId,
      timeoutMs,
      signal: dedupeAbortController.signal,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
    });

    const first = await Promise.race([
      lifecyclePromise.then((snapshot) => ({ source: "lifecycle" as const, snapshot })),
      dedupePromise.then((snapshot) => ({ source: "dedupe" as const, snapshot })),
    ]);

    let snapshot: AgentWaitTerminalSnapshot | Awaited<ReturnType<typeof waitForAgentJob>> =
      first.snapshot;
    if (snapshot) {
      if (first.source === "lifecycle") {
        dedupeAbortController.abort();
      } else {
        lifecycleAbortController.abort();
      }
    } else {
      snapshot = first.source === "lifecycle" ? await dedupePromise : await lifecyclePromise;
      lifecycleAbortController.abort();
      dedupeAbortController.abort();
    }

    if (!snapshot) {
      respond(true, {
        runId,
        status: "timeout",
      });
      return;
    }
    respond(true, {
      runId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      error: snapshot.error,
    });
  },
};
