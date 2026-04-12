import { randomUUID } from "node:crypto";
import { listAgentIds, resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import {
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSpawnedRun,
} from "../../agents/spawned-context.js";
import { buildBareSessionResetPrompt } from "../../auto-reply/reply/session-reset-prompt.js";
import {
  buildSessionStartupContextPrelude,
  shouldApplyStartupContext,
} from "../../auto-reply/reply/startup-context.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import { loadConfig } from "../../config/config.js";
import {
  mergeSessionEntry,
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
  resolveAgentMainSessionKey,
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
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import { classifySessionKeyShape, normalizeAgentId } from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeInputProvenance, type InputProvenance } from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";
import { createRunningTaskRun } from "../../tasks/task-executor.js";
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

function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromIngress>[0];
  runId: string;
  idempotencyKey: string;
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
      bootstrapContextMode?: "full" | "lightweight";
      bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
      internalEvents?: AgentInternalEvent[];
      idempotencyKey: string;
      timeout?: number;
      bestEffortDeliver?: boolean;
      label?: string;
      inputProvenance?: InputProvenance;
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

    const agentIdRaw = normalizeOptionalString(request.agentId) ?? "";
    const agentId = agentIdRaw ? normalizeAgentId(agentIdRaw) : undefined;
    if (agentId) {
      const knownAgents = listAgentIds(cfg);
      if (!knownAgents.includes(agentId)) {
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
    let requestedSessionKey =
      requestedSessionKeyRaw ??
      resolveExplicitAgentSessionKey({
        cfg,
        agentId,
      });
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
    let resolvedSessionId = normalizeOptionalString(request.sessionId);
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
        // Keep bare /new and /reset behavior aligned with chat.send:
        // reset first, then run a fresh-session greeting prompt in-place.
        // Date is embedded in the prompt so agents read the correct daily
        // memory files; skip further timestamp injection to avoid duplication.
        message = buildBareSessionResetPrompt(cfg);
        skipTimestampInjection = true;
        shouldPrependStartupContext = shouldApplyStartupContext({ cfg, action: resetReason });
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
      isNewSession = !entry;
      const now = Date.now();
      const sessionId = entry?.sessionId ?? randomUUID();
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
      // Without this, subagent sessions end up with deliveryContext: {channel: "slack"}
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
      const sessionAgentId = resolveAgentIdFromSessionKey(resolvedSessionKey);
      const runtimeWorkspaceDir =
        resolveIngressWorkspaceOverrideForSpawnedRun({
          spawnedBy: spawnedByValue,
          workspaceDir: sessionEntry?.spawnedWorkspaceDir,
        }) ?? resolveAgentWorkspaceDir(cfgForAgent ?? cfg, sessionAgentId);
      const startupContextPrelude = await buildSessionStartupContextPrelude({
        workspaceDir: runtimeWorkspaceDir,
        cfg: cfgForAgent ?? cfg,
      });
      if (startupContextPrelude) {
        message = `${startupContextPrelude}\n\n${message}`;
      }
    }

    const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;

    dispatchAgentRunFromGateway({
      ingressOpts: {
        message,
        images,
        imageOrder,
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
        extraSystemPrompt: request.extraSystemPrompt,
        bootstrapContextMode: request.bootstrapContextMode,
        bootstrapContextRunKind: request.bootstrapContextRunKind,
        internalEvents: request.internalEvents,
        inputProvenance,
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
      respond,
      context,
    });
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
    respond(true, { ...identity, avatar: avatarValue }, undefined);
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
    const hasActiveChatRun = context.chatAbortControllers.has(runId);

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
