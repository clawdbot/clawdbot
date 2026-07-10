// Gateway agent methods implement agent.run, agent.wait, agent.reset, identity,
// and related session-aware RPC handlers used by UI and operator clients.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { isFutureDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import {
  normalizeStringEntries,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
  hasGatewayClientCap,
} from "../../../packages/gateway-protocol/src/client-info.js";
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateAgentIdentityParams,
  validateAgentParams,
  validateAgentWaitParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import {
  buildAgentRunTerminalOutcome,
  type AgentRunTerminalOutcome,
} from "../../agents/agent-run-terminal-outcome.js";
import { listAgentIds, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { resolveTrustedGroupId } from "../../agents/agent-tools.policy.js";
import {
  consumeExecApprovalFollowupRuntimeHandoff,
  isExecApprovalFollowupSessionRebound,
  parseExecApprovalFollowupApprovalId,
} from "../../agents/bash-tools.exec-approval-followup-state.js";
import { clearAllCliSessions, getCliSessionBinding } from "../../agents/cli-session.js";
import type { AgentCommandOpts } from "../../agents/command/types.js";
import {
  clearEmbeddedAgentRunAbortabilityForRunId,
  isEmbeddedAgentRunAbortableForRunId,
  retainEmbeddedAgentRunAbortabilityForRunId,
} from "../../agents/embedded-agent-runner/runs.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import { resolvePublicAgentAvatarSource } from "../../agents/identity-avatar.js";
import {
  AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION,
  hasGeneratedMediaCompletionEvent,
} from "../../agents/internal-event-contract.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import {
  AGENT_RUN_RESTART_ABORT_STOP_REASON,
  createAgentRunRestartAbortError,
  isAgentRunRestartAbortReason,
} from "../../agents/run-termination.js";
import {
  normalizeAgentRunTimeoutPhase,
  normalizeProviderStarted,
} from "../../agents/run-timeout-attribution.js";
import {
  normalizeSpawnedRunMetadata,
  resolveIngressWorkspaceOverrideForSessionRun,
} from "../../agents/spawned-context.js";
import { consumeSubagentTraceparentHandoff } from "../../agents/subagent-traceparent-handoff.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import type { ContinuationTrigger } from "../../auto-reply/types.js";
import { agentCommandFromIngress } from "../../commands/agent.js";
import {
  evaluateSessionFreshness,
  hasTerminalMainSessionTranscriptNewerThanRegistrySync,
  mergeSessionEntry,
  resolveTerminalMainSessionTranscriptRegistryCheck,
  resolveChannelResetConfig,
  resolveAgentIdFromSessionKey,
  resolveExplicitAgentSessionKey,
  resolveAgentMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionLifecycleTimestamps,
  resolveSessionWorkStartError,
  resolveSessionResetPolicy,
  resolveSessionResetType,
  type SessionEntry,
  type SessionFreshness,
  updateSessionStore,
} from "../../config/sessions.js";
import { hasProviderOwnedSession } from "../../config/sessions/entry-freshness.js";
import { applySessionEntryReplacements } from "../../config/sessions/session-accessor.js";
import { mergeSessionSnapshotChanges } from "../../config/sessions/session-snapshot-merge.js";
import { resolveMaintenanceConfigFromInput } from "../../config/sessions/store-maintenance.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAbortError } from "../../infra/abort-signal.js";
import {
  assertAgentRunLifecycleGenerationCurrent,
  claimAgentRunContext,
  clearAgentRunContext,
  getAgentEventLifecycleGeneration,
} from "../../infra/agent-events.js";
import { emitDiagnosticEvent } from "../../infra/diagnostic-events.js";
import { formatUncaughtError, readErrorName } from "../../infra/errors.js";
import {
  resolveAgentDeliveryPlanWithSessionRoute,
  resolveAgentExplicitRecipientSession,
  resolveAgentOutboundTarget,
} from "../../infra/outbound/agent-delivery.js";
import { shouldDowngradeDeliveryToSessionOnly } from "../../infra/outbound/best-effort-delivery.js";
import { resolveMessageChannelSelection } from "../../infra/outbound/channel-selection.js";
import {
  loadVoiceWakeRoutingConfig,
  resolveVoiceWakeRouteByTrigger,
} from "../../infra/voicewake-routing.js";
import type { PromptImageOrderEntry } from "../../media/prompt-image-order.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import { retainGatewayRootWorkAdmissionContinuation } from "../../process/gateway-work-admission.js";
import {
  classifySessionKeyShape,
  isAcpSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { defaultRuntime } from "../../runtime.js";
import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
  shouldPreserveUserFacingSessionStateForInputProvenance,
  type InputProvenance,
} from "../../sessions/input-provenance.js";
import { resolveSendPolicy } from "../../sessions/send-policy.js";
import {
  parseCronRunScopeSuffix,
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import {
  beginSessionWorkAdmission,
  type SessionWorkAdmissionLease,
} from "../../sessions/session-lifecycle-admission.js";
import { createRunningTaskRun, finalizeTaskRunByRunId } from "../../tasks/detached-task-runtime.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import {
  getGeneratedMediaTaskIdsForSessionKey,
  hasNewGeneratedMediaTaskForSessionKey,
} from "../../tasks/task-status-access.js";
import {
  mergeDeliveryContext,
  normalizeDeliveryContext,
  normalizeSessionDeliveryFields,
  type DeliveryContext,
} from "../../utils/delivery-context.shared.js";
import {
  INTERNAL_MESSAGE_CHANNEL,
  isDeliverableMessageChannel,
  isGatewayMessageChannel,
  isInternalNonDeliveryChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import { resolveGatewayAssistantAvatar } from "../assistant-avatar.js";
import { resolveAssistantIdentity } from "../assistant-identity.js";
import {
  type ChatAbortControllerEntry,
  registerChatAbortController,
  resolveAgentRunExpiresAtMs,
  updateChatRunProvider,
} from "../chat-abort.js";
import {
  MediaOffloadError,
  parseMessageWithAttachments,
  resolveChatAttachmentMaxBytes,
} from "../chat-attachments.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
  performGatewaySessionReset,
} from "../session-reset-service.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  canonicalizeSpawnedByForAgent,
  loadSessionEntry,
  migrateAndPruneGatewaySessionStoreKey,
  resolveDeletedAgentIdFromSessionKey,
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewayModelSupportsImages,
  resolveSessionStoreKey,
  resolveSessionModelRef,
} from "../session-utils.js";
import { formatForLog } from "../ws-log.js";
import { waitForAgentJob } from "./agent-job.js";
import {
  readTerminalSnapshotFromGatewayDedupe,
  setGatewayDedupeEntry,
  type AgentWaitTerminalSnapshot,
  waitForTerminalGatewayDedupe,
} from "./agent-wait-dedupe.js";
import { normalizeRpcAttachmentsToChatAttachments } from "./attachment-normalize.js";
import { emitSessionsChanged } from "./session-change-event.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
} from "./types.js";

const RESET_COMMAND_RE = /^\/(new|reset)(?:\s+([\s\S]*))?$/i;
const CRON_CONTINUATION_RELEASE_RECOVERY_DELAYS_MS = [250, 1_000, 4_000, 15_000] as const;

function isRecoverableTerminalSessionStatus(status: SessionEntry["status"] | undefined): boolean {
  return status === "failed" || status === "timeout" || status === "killed";
}

type AgentSendSessionLifecycleTransition = {
  cfg: OpenClawConfig;
  sessionKey: string;
  sessionId: string;
  storePath: string;
  sessionFile?: string;
  agentId?: string;
  previousSessionId?: string;
  previousSessionFile?: string;
  previousEndReason?: PluginHookSessionEndReason;
};

function formatAttachmentFailureForLog(err: unknown): string {
  const primary = formatUncaughtError(err);
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause === undefined) {
    return primary;
  }
  const causeText = formatUncaughtError(cause);
  if (!causeText || causeText === primary) {
    return primary;
  }
  return `${primary}\nCaused by: ${causeText}`;
}

function logAttachmentFailure(
  logGateway: Pick<GatewayRequestContext["logGateway"], "error">,
  label: string,
  err: unknown,
): void {
  logGateway.error(label, {
    error: formatAttachmentFailureForLog(err),
    consoleMessage: `${label}: ${formatForLog(err)}`,
  });
}

function clientHasAdminScope(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

function respondDeletedAgentSession(params: {
  cfg: OpenClawConfig;
  canonicalKey: string;
  entry?: SessionEntry | null;
  acpMetadataSessionKey?: string;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(
    params.cfg,
    params.canonicalKey,
    params.entry,
    {
      acpMetadataSessionKey: params.acpMetadataSessionKey ?? params.canonicalKey,
    },
  );
  if (deletedAgentId === null) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  );
  return true;
}

function respondUnavailableAgentSessionForKey(params: {
  sessionKey: string;
  agentId?: string;
  respond: GatewayRequestHandlerOptions["respond"];
}): boolean {
  const { cfg, entry, canonicalKey, legacyKey } = loadSessionEntry(params.sessionKey, {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    clone: false,
  });
  if (
    respondDeletedAgentSession({
      cfg,
      canonicalKey,
      entry,
      acpMetadataSessionKey: legacyKey,
      respond: params.respond,
    })
  ) {
    return true;
  }
  const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
  if (!archivedSessionError) {
    return false;
  }
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
  return true;
}

function resolveAllowModelOverrideFromClient(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return clientHasAdminScope(client) || client?.internal?.allowModelOverride === true;
}

function resolveCanUseInternalRuntimeHandoff(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return client?.connect?.client?.mode === GATEWAY_CLIENT_MODES.BACKEND;
}

function resolveCanUseCronRunContinuation(client: GatewayRequestHandlerOptions["client"]): boolean {
  return client?.internal?.cronRunContinuation === true;
}

type RestoredCronContinuation = {
  lifecycleRevision: string;
  sessionId: string;
  provider: string;
  model: string;
  thinking?: string;
  toolsAllow?: string[];
  toolsAllowIsDefault?: boolean;
  cliSessionBindingFacts?: {
    extraSystemPromptStatic?: string;
    sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
    requireExplicitMessageTarget?: boolean;
  };
};

function cronContinuationHasReusableRuntime(params: {
  cfg: OpenClawConfig;
  entry: SessionEntry;
  agentId: string;
  provider: string;
  model: string;
}): boolean {
  const executionProvider =
    resolveCliRuntimeExecutionProvider({
      provider: params.provider,
      cfg: params.cfg,
      agentId: params.agentId,
      modelId: params.model,
    }) ?? params.provider;
  return (
    !isCliProvider(executionProvider, params.cfg) ||
    Boolean(getCliSessionBinding(params.entry, executionProvider)?.sessionId)
  );
}

function withoutCronRunContinuation(entry: SessionEntry): SessionEntry {
  const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = entry;
  return baseEntry;
}

function emitAgentSendSessionLifecycleTransition(
  transition: AgentSendSessionLifecycleTransition | undefined,
): void {
  if (!transition) {
    return;
  }
  if (transition.previousSessionId) {
    emitGatewaySessionEndPluginHook({
      cfg: transition.cfg,
      sessionKey: transition.sessionKey,
      sessionId: transition.previousSessionId,
      storePath: transition.storePath,
      sessionFile: transition.previousSessionFile,
      agentId: transition.agentId,
      reason: transition.previousEndReason ?? "unknown",
      nextSessionId: transition.sessionId,
      nextSessionKey: transition.sessionKey,
    });
  }
  emitGatewaySessionStartPluginHook({
    cfg: transition.cfg,
    sessionKey: transition.sessionKey,
    sessionId: transition.sessionId,
    resumedFrom: transition.previousSessionId,
    storePath: transition.storePath,
    sessionFile: transition.sessionFile,
    agentId: transition.agentId,
  });
}

async function runSessionResetFromAgent(params: {
  key: string;
  agentId?: string;
  reason: "new" | "reset";
  assertCurrent?: () => void;
  onCommitted?: (commit: { key: string; sessionId: string }) => void;
}): Promise<
  | { ok: true; key: string; sessionId?: string }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const result = await performGatewaySessionReset({
    key: params.key,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    reason: params.reason,
    commandSource: "gateway:agent",
    assertCurrent: params.assertCurrent,
    onCommitted: params.onCommitted,
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

function sessionResetAckText(reason: "new" | "reset"): string {
  return reason === "new" ? "✅ New session started." : "✅ Session reset.";
}

function buildBareSessionResetResult(params: {
  reason: "new" | "reset";
  sessionId?: string;
  ackText?: string;
}) {
  return {
    payloads: [{ text: params.ackText ?? sessionResetAckText(params.reason) }],
    meta: {
      durationMs: 0,
      ...(params.sessionId
        ? {
            agentMeta: {
              sessionId: params.sessionId,
            },
          }
        : {}),
    },
  };
}

function buildBareSessionResetResponse(params: {
  runId: string;
  result:
    | ReturnType<typeof buildBareSessionResetResult>
    | Awaited<ReturnType<typeof agentCommandFromIngress>>;
}) {
  return {
    runId: params.runId,
    status: "ok" as const,
    summary: "completed",
    result: params.result,
  };
}

async function deliverBareSessionResetResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  request: {
    replyTo?: string;
    to?: string;
    replyChannel?: string;
    channel?: string;
    replyAccountId?: string;
    accountId?: string;
    threadId?: string | number;
    bestEffortDeliver?: boolean;
  };
  bestEffortDeliver?: boolean;
  deliveryTargetMode?: AgentCommandOpts["deliveryTargetMode"];
  originMessageChannel?: string;
  runId: string;
  assertCurrent?: () => void;
  ackText?: string;
}) {
  const { deliverAgentCommandResult } = await import("../../agents/command/delivery.runtime.js");
  params.assertCurrent?.();
  const result = buildBareSessionResetResult({
    reason: params.reason,
    sessionId: params.sessionId,
    ackText: params.ackText,
  });
  return await deliverAgentCommandResult({
    cfg: params.cfg,
    deps: params.context.deps,
    runtime: defaultRuntime,
    opts: {
      message: params.ackText ?? sessionResetAckText(params.reason),
      ...(params.agentId ? { agentId: params.agentId } : {}),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      sessionKey: params.sessionKey,
      deliver: true,
      replyTo: params.request.replyTo,
      to: params.request.to,
      replyChannel: params.request.replyChannel,
      channel: params.request.channel,
      replyAccountId: params.request.replyAccountId,
      accountId: params.request.accountId,
      threadId: params.request.threadId,
      deliveryTargetMode: params.deliveryTargetMode,
      bestEffortDeliver: params.bestEffortDeliver,
      runId: params.runId,
      messageChannel: params.originMessageChannel,
      runContext: {
        messageChannel: params.originMessageChannel,
        accountId: params.request.replyAccountId ?? params.request.accountId,
        currentThreadTs:
          params.request.threadId != null ? String(params.request.threadId) : undefined,
      },
      allowModelOverride: false,
    },
    outboundSession: undefined,
    sessionEntry: params.sessionEntry,
    result: result as never,
    payloads: result.payloads as never,
    assertDeliveryCurrent: params.assertCurrent,
  });
}

async function resolveBareSessionResetResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestHandlerOptions["context"];
  reason: "new" | "reset";
  sessionId?: string;
  sessionKey: string;
  agentId?: string;
  sessionEntry?: SessionEntry;
  request: Parameters<GatewayRequestHandlers["agent"]>[0]["params"];
  originMessageChannel?: string;
  runId: string;
  assertCurrent?: () => void;
  ackText?: string;
}) {
  params.assertCurrent?.();
  if (params.request.deliver !== true) {
    return buildBareSessionResetResult({
      reason: params.reason,
      sessionId: params.sessionId,
      ackText: params.ackText,
    });
  }
  const sendPolicy = resolveSendPolicy({
    cfg: params.cfg,
    entry: params.sessionEntry,
    sessionKey: params.sessionKey,
    channel: params.sessionEntry?.channel,
    chatType: params.sessionEntry?.chatType,
  });
  if (sendPolicy === "deny") {
    throw new Error("send blocked by session policy");
  }
  const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
    currentSessionKey: params.sessionKey,
    sessionEntry: params.sessionEntry,
    requestedChannel:
      normalizeOptionalString(params.request.replyChannel) ??
      normalizeOptionalString(params.request.channel),
    explicitTo:
      normalizeOptionalString(params.request.replyTo) ?? normalizeOptionalString(params.request.to),
    explicitThreadId: normalizeOptionalString(params.request.threadId),
    accountId:
      normalizeOptionalString(params.request.replyAccountId) ??
      normalizeOptionalString(params.request.accountId),
    wantsDelivery: true,
    turnSourceChannel: normalizeOptionalString(params.request.channel),
    turnSourceTo: normalizeOptionalString(params.request.to),
    turnSourceAccountId: normalizeOptionalString(params.request.accountId),
    turnSourceThreadId: normalizeOptionalString(params.request.threadId),
  });
  params.assertCurrent?.();
  const mainSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey),
  });
  // Main/global resets default to best-effort delivery because no caller session may remain.
  const bestEffortDeliver =
    typeof params.request.bestEffortDeliver === "boolean"
      ? params.request.bestEffortDeliver
      : params.sessionKey === mainSessionKey || params.sessionKey === "global"
        ? true
        : undefined;
  return await deliverBareSessionResetResult({
    cfg: params.cfg,
    context: params.context,
    reason: params.reason,
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    sessionEntry: params.sessionEntry,
    request: {
      ...params.request,
      channel: deliveryPlan.resolvedChannel,
      to: deliveryPlan.resolvedTo ?? deliveryPlan.baseDelivery.to,
      accountId: deliveryPlan.resolvedAccountId ?? deliveryPlan.baseDelivery.accountId,
      threadId: deliveryPlan.resolvedThreadId,
    },
    bestEffortDeliver,
    deliveryTargetMode: deliveryPlan.deliveryTargetMode ?? deliveryPlan.baseDelivery.mode,
    originMessageChannel: params.originMessageChannel ?? deliveryPlan.resolvedChannel,
    runId: params.runId,
    assertCurrent: params.assertCurrent,
    ackText: params.ackText,
  });
}

function loadBareSessionResetDeliverySession(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  agentId: string;
} {
  const selectedGlobalAgentId =
    params.sessionKey === "global" && params.agentId ? params.agentId : undefined;
  const loaded = loadSessionEntry(params.sessionKey, {
    clone: false,
    ...(selectedGlobalAgentId ? { agentId: selectedGlobalAgentId } : {}),
  });
  const loadedCfg = loaded?.cfg ?? params.cfg;
  return {
    cfg: loadedCfg,
    entry: loaded?.entry,
    agentId:
      selectedGlobalAgentId ??
      resolveAgentIdFromSessionKey(params.sessionKey) ??
      resolveDefaultAgentId(loadedCfg),
  };
}

function resolveSessionRuntimeCwd(params: {
  requestedCwd?: string;
  sessionEntry?: SessionEntry;
}): string | undefined {
  return normalizeOptionalString(params.requestedCwd ?? params.sessionEntry?.spawnedCwd);
}

type TrustedGroupMetadata = {
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

function normalizeTrustedGroupMetadata(value?: {
  groupId?: unknown;
  groupChannel?: unknown;
  groupSpace?: unknown;
  space?: unknown;
}): TrustedGroupMetadata {
  return {
    groupId: normalizeOptionalString(value?.groupId),
    groupChannel: normalizeOptionalString(value?.groupChannel),
    groupSpace: normalizeOptionalString(value?.groupSpace ?? value?.space),
  };
}

function resolveSessionKeyGroupId(sessionKey: string): string | undefined {
  const { baseSessionKey } = parseThreadSessionSuffix(sessionKey);
  const conversation = parseRawSessionConversationRef(baseSessionKey ?? sessionKey);
  if (!conversation || (conversation.kind !== "group" && conversation.kind !== "channel")) {
    return undefined;
  }
  return conversation.rawId;
}

function resolveTrustedGroupMetadata(params: {
  sessionKey: string;
  spawnedBy?: string;
  stored: TrustedGroupMetadata;
  inherited?: TrustedGroupMetadata;
}): TrustedGroupMetadata {
  return {
    // Group trust can be inherited from the parent run or recovered from conversation-shaped keys.
    groupId:
      params.stored.groupId ??
      params.inherited?.groupId ??
      resolveSessionKeyGroupId(params.sessionKey) ??
      (params.spawnedBy ? resolveSessionKeyGroupId(params.spawnedBy) : undefined),
    groupChannel: params.stored.groupChannel ?? params.inherited?.groupChannel,
    groupSpace: params.stored.groupSpace ?? params.inherited?.groupSpace,
  };
}

function requestGroupMatchesTrusted(params: {
  requestGroupId?: string;
  trustedGroupId?: string;
}): boolean {
  const requestGroupId = params.requestGroupId?.trim();
  if (!requestGroupId) {
    // Missing group metadata is accepted so non-group channels keep the same send path.
    return true;
  }
  return Boolean(params.trustedGroupId && requestGroupId === params.trustedGroupId);
}

type GatewayAgentTaskTerminalStatus = Extract<
  TaskStatus,
  "succeeded" | "failed" | "timed_out" | "cancelled"
>;
type GatewayAgentTaskTrackingMode = "cli" | "plugin_subagent" | "none";

function resolveGatewayAgentTaskTrackingMode(params: {
  client: GatewayRequestHandlerOptions["client"];
  sessionKey?: string;
  inputProvenance?: InputProvenance;
  confirmedAcpManualSpawn?: boolean;
  modelRun?: boolean;
}): GatewayAgentTaskTrackingMode {
  // Model probes are stateless one-shot work. A terminal CLI task row would
  // outlive the probe even when its session/transcript effects are internal.
  if (params.modelRun === true) {
    return "none";
  }
  if (!params.sessionKey?.trim() || params.inputProvenance?.kind === "inter_session") {
    return "none";
  }
  if (params.client?.internal?.agentRunTracking === "plugin_subagent") {
    return "plugin_subagent";
  }
  // A confirmed ACP manual-spawn child turn already owns its requester-visible
  // `acp` task row from the spawn control plane (src/agents/acp-spawn.ts). The
  // Gateway CLI path runs that same childRunId, so tracking it here would emit a
  // duplicate row for one run. Suppress only the CLI branch; plugin-subagent and
  // normal CLI tracking stay intact.
  if (params.confirmedAcpManualSpawn) {
    return "none";
  }
  return "cli";
}

function isTrustedBackendAcpSpawnClient(client: GatewayRequestHandlerOptions["client"]): boolean {
  // The ACP spawn control plane reaches the gateway through the in-process
  // backend client (src/gateway/call.ts -> mode "backend", id "gateway-client").
  // Only that caller creates the replacement `acp` task row, so CLI suppression
  // is gated to it. An operator-write UI/CLI/mobile or device-token client that
  // merely sets acpTurnSource owns no such row and must keep CLI tracking.
  return (
    client?.connect?.client?.id === GATEWAY_CLIENT_NAMES.GATEWAY_CLIENT &&
    client.connect.client.mode === GATEWAY_CLIENT_MODES.BACKEND &&
    client.isDeviceTokenAuth !== true
  );
}

function isConfirmedAcpManualSpawnTaskOwner(params: {
  acpTurnSource?: string;
  sessionKey?: string;
  client: GatewayRequestHandlerOptions["client"];
  logGateway: Pick<GatewayRequestContext["logGateway"], "warn">;
}): boolean {
  const sessionKey = params.sessionKey;
  if (
    !isTrustedBackendAcpSpawnClient(params.client) ||
    params.acpTurnSource !== "manual_spawn" ||
    sessionKey == null ||
    !isAcpSessionKey(sessionKey)
  ) {
    return false;
  }
  try {
    return readAcpSessionMeta({ sessionKey }) != null;
  } catch (err) {
    params.logGateway.warn(
      `failed to read ACP session metadata for manual-spawn task tracking ${sessionKey}; falling back to cli task tracking: ${formatForLog(
        err,
      )}`,
    );
    return false;
  }
}

async function registerPluginSubagentRunFromGateway(params: {
  cfg: OpenClawConfig;
  runId: string;
  childSessionKey: string;
  task: string;
  requesterOrigin?: DeliveryContext;
  pluginId?: string;
}): Promise<void> {
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return;
  }
  const ownerSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: resolveAgentIdFromSessionKey(childSessionKey),
  });
  const { registerSubagentRun } = await import("../../agents/subagent-registry.js");
  registerSubagentRun({
    runId: params.runId,
    childSessionKey,
    controllerSessionKey: ownerSessionKey,
    requesterSessionKey: ownerSessionKey,
    requesterOrigin: params.requesterOrigin,
    requesterDisplayKey: "main",
    task: params.task,
    cleanup: "keep",
    ...(params.pluginId ? { label: `plugin:${params.pluginId}` } : {}),
    expectsCompletionMessage: false,
    spawnMode: "run",
  });
}

function resolveFailedTrackedAgentTaskStatus(error: unknown): GatewayAgentTaskTerminalStatus {
  return isAbortError(error) || isTimeoutError(error) ? "timed_out" : "failed";
}

function tryFinalizeTrackedAgentTask(params: {
  runId: string;
  status: GatewayAgentTaskTerminalStatus;
  error?: string;
  terminalSummary?: string;
  log: Pick<GatewayRequestContext["logGateway"], "warn">;
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
  } catch (err) {
    // Best-effort only: background task tracking must not block agent runs.
    // Still surface the swallowed error so non-transient finalize failures stay observable.
    params.log.warn(`failed to finalize tracked agent task ${params.runId}: ${formatForLog(err)}`);
  }
}

function resolveAgentDedupeKeys(params: {
  idempotencyKey: string;
  execApprovalFollowupApprovalId?: string;
}): string[] {
  const keys = [`agent:${params.idempotencyKey}`];
  const approvalId = params.execApprovalFollowupApprovalId?.trim();
  if (approvalId) {
    keys.push(`agent:exec-approval-followup:${approvalId}`);
  }
  return uniqueStrings(keys);
}

function readGatewayDedupeEntry(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
}) {
  for (const key of params.keys) {
    const entry = params.dedupe.get(key);
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

function isAcceptedAgentDedupePayload(payload: unknown): payload is {
  acceptedAt?: unknown;
  agentId?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  reservationId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status: "accepted";
} {
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "accepted"
  );
}

function isPreRegistrationAbortedAgentDedupePayload(payload: unknown): payload is {
  agentId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  status: "timeout";
  stopReason?: unknown;
} {
  const stopReason = (payload as { stopReason?: unknown } | null)?.stopReason;
  return (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { status?: unknown }).status === "timeout" &&
    (stopReason === "rpc" || stopReason === "stop")
  );
}

function isPreRegistrationAbortedAgentDedupeEntryForSession(params: {
  entry: ReturnType<typeof readGatewayDedupeEntry> | undefined;
  runId: string;
  sessionKey?: string;
  alternateSessionKeys?: Array<string | undefined>;
}): boolean {
  if (!params.entry?.ok || !isPreRegistrationAbortedAgentDedupePayload(params.entry.payload)) {
    return false;
  }
  const payload = params.entry.payload;
  const payloadRunId = typeof payload.runId === "string" ? payload.runId.trim() : "";
  if (payloadRunId && payloadRunId !== params.runId) {
    return false;
  }
  const payloadSessionKey =
    typeof payload.sessionKey === "string" && payload.sessionKey.trim()
      ? payload.sessionKey.trim()
      : undefined;
  const expectedSessionKeys = new Set(
    [params.sessionKey, ...(params.alternateSessionKeys ?? [])].filter((value): value is string =>
      Boolean(value?.trim()),
    ),
  );
  return (
    !payloadSessionKey ||
    expectedSessionKeys.size === 0 ||
    expectedSessionKeys.has(payloadSessionKey)
  );
}

function setGatewayDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
  entry: Parameters<typeof setGatewayDedupeEntry>[0]["entry"];
}) {
  for (const key of params.keys) {
    setGatewayDedupeEntry({
      dedupe: params.dedupe,
      key,
      entry: params.entry,
    });
  }
}

function setAbortedAgentDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
  agentId?: string;
  sessionKey?: string;
  runId: string;
  stopReason: string;
}) {
  setGatewayDedupeEntries({
    dedupe: params.dedupe,
    keys: params.keys,
    entry: {
      ts: Date.now(),
      ok: true,
      payload: {
        runId: params.runId,
        ...(params.agentId ? { agentId: params.agentId } : {}),
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        status: "timeout" as const,
        summary: "aborted",
        stopReason: params.stopReason,
        timeoutPhase: "queue",
        providerStarted: false,
      },
    },
  });
}

function readAgentRunTimeoutAttribution(meta: unknown) {
  const record =
    meta && typeof meta === "object" && !Array.isArray(meta)
      ? (meta as Record<string, unknown>)
      : undefined;
  return {
    timeoutPhase: normalizeAgentRunTimeoutPhase(record?.timeoutPhase),
    providerStarted: normalizeProviderStarted(record?.providerStarted),
  };
}

function isGatewayAbortSignalReason(reason: unknown): boolean {
  return reason === undefined || isAbortError(reason) || readErrorName(reason) === "TimeoutError";
}

function isGatewayAgentAbortRejection(error: unknown, signal: AbortSignal): boolean {
  if (!signal.aborted) {
    return false;
  }
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return true;
  }
  if (readErrorName(signal.reason) === "TimeoutError") {
    return true;
  }
  if (!isGatewayAbortSignalReason(signal.reason)) {
    return false;
  }
  return isAbortError(error) || readErrorName(error) === "TimeoutError";
}

function resolveGatewayAgentAbortStopReason(signal: AbortSignal): "restart" | "rpc" | "timeout" {
  if (isAgentRunRestartAbortReason(signal.reason)) {
    return "restart";
  }
  return readErrorName(signal.reason) === "TimeoutError" ? "timeout" : "rpc";
}

function resolveAbortedAgentStopReason(entry?: ChatAbortControllerEntry): string {
  return entry?.abortStopReason?.trim() || "rpc";
}

function deleteGatewayDedupeEntries(params: {
  dedupe: GatewayRequestContext["dedupe"];
  keys: readonly string[];
}) {
  for (const key of params.keys) {
    params.dedupe.delete(key);
  }
}

function dispatchAgentRunFromGateway(params: {
  ingressOpts: Parameters<typeof agentCommandFromIngress>[0];
  runId: string;
  dedupeKeys: readonly string[];
  /**
   * Controller whose signal is wired into `ingressOpts.abortSignal`. Used on
   * completion to drop the matching `chatAbortControllers` entry without
   * touching a same-runId entry owned by a concurrent chat.send.
   */
  abortController: AbortController;
  cleanupAbortController: () => void;
  respond: GatewayRequestHandlerOptions["respond"];
  context: GatewayRequestHandlerOptions["context"];
  taskTrackingMode: Exclude<GatewayAgentTaskTrackingMode, "plugin_subagent">;
  onSettled?: (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }) => Promise<boolean> | boolean;
}) {
  const shouldTrackTask = params.taskTrackingMode === "cli";
  let taskTracked = false;
  if (shouldTrackTask) {
    try {
      taskTracked = Boolean(
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
        }),
      );
    } catch (err) {
      // Best-effort only: background task tracking must not block agent runs.
      // Still surface the swallowed error so non-transient tracking failures stay observable.
      params.context.logGateway.warn(
        `failed to start tracked agent task ${params.runId}: ${formatForLog(err)}`,
      );
    }
  }
  const settle = async (outcome: {
    terminalOutcome: AgentRunTerminalOutcome;
    onRecovered?: () => void;
  }): Promise<boolean> => {
    try {
      return (await params.onSettled?.(outcome)) ?? true;
    } catch (error) {
      params.context.logGateway.warn(
        `failed to settle agent continuation ${params.runId}: ${formatForLog(error)}`,
      );
      return false;
    }
  };
  void agentCommandFromIngress(params.ingressOpts, defaultRuntime, params.context.deps)
    .then(async (result) => {
      const aborted = result?.meta?.aborted === true;
      const timeoutAttribution = readAgentRunTimeoutAttribution(result?.meta);
      if (taskTracked) {
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          status: aborted ? "timed_out" : "succeeded",
          terminalSummary: aborted ? "aborted" : "completed",
          log: params.context.logGateway,
        });
      }
      const payload = {
        runId: params.runId,
        status: aborted ? ("timeout" as const) : ("ok" as const),
        summary: aborted ? "aborted" : "completed",
        ...(aborted ? { stopReason: result?.meta?.stopReason ?? "rpc" } : {}),
        ...(aborted && timeoutAttribution.timeoutPhase
          ? { timeoutPhase: timeoutAttribution.timeoutPhase }
          : {}),
        ...(aborted && timeoutAttribution.providerStarted !== undefined
          ? { providerStarted: timeoutAttribution.providerStarted }
          : {}),
        result,
      };
      const terminalOutcome = buildAgentRunTerminalOutcome({
        status:
          aborted || result?.meta?.stopReason === "timeout" || timeoutAttribution.timeoutPhase
            ? "timeout"
            : result?.meta?.error || result?.meta?.stopReason === "error"
              ? "error"
              : "ok",
        error: result?.meta?.error,
        stopReason: result?.meta?.stopReason,
        livenessState: result?.meta?.livenessState,
        timeoutPhase: timeoutAttribution.timeoutPhase,
        providerStarted: timeoutAttribution.providerStarted,
      });
      const persistTerminalDedupe = () => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: {
            ts: Date.now(),
            ok: true,
            payload,
          },
        });
      };
      const settled = await settle({ terminalOutcome, onRecovered: persistTerminalDedupe });
      if (!settled) {
        const summary = "failed to persist cron continuation settlement";
        const error = errorShape(ErrorCodes.UNAVAILABLE, summary);
        const failedPayload = { runId: params.runId, status: "error" as const, summary };
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: { ts: Date.now(), ok: false, payload: failedPayload, error },
        });
        params.respond(false, failedPayload, error, { runId: params.runId, error: summary });
        return;
      }
      persistTerminalDedupe();
      // Send a second res frame (same id) so TS clients with expectFinal can wait.
      // Swift clients will typically treat the first res as the result and ignore this.
      params.respond(true, payload, undefined, { runId: params.runId });
    })
    .catch(async (err: unknown) => {
      // Restored from upstream b4f69286fd (closes openclaw/openclaw#83962): match
      // TimeoutError and signal.reason TimeoutError shapes so timed-out runs
      // classify as timeout (not error) and keep dedupe.ok true. isAbortError
      // alone matches only name="AbortError" and misses both shapes.
      const aborted = isGatewayAgentAbortRejection(err, params.abortController.signal);
      const renderedErr = formatForLog(err);
      if (taskTracked) {
        tryFinalizeTrackedAgentTask({
          runId: params.runId,
          status: aborted ? "timed_out" : resolveFailedTrackedAgentTaskStatus(err),
          error: renderedErr,
          terminalSummary: renderedErr,
          log: params.context.logGateway,
        });
      }
      const error = errorShape(ErrorCodes.UNAVAILABLE, renderedErr);
      const stopReason = resolveGatewayAgentAbortStopReason(params.abortController.signal);
      const terminalOutcome = buildAgentRunTerminalOutcome({
        status: aborted ? "timeout" : "error",
        error: renderedErr,
        stopReason,
        timeoutPhase: aborted ? "gateway_draining" : undefined,
      });
      const payload = {
        runId: params.runId,
        status: aborted ? ("timeout" as const) : ("error" as const),
        summary: aborted ? "aborted" : renderedErr,
        ...(aborted ? { stopReason, timeoutPhase: "gateway_draining" as const } : {}),
      };
      const persistTerminalDedupe = (settlementPersisted: boolean) => {
        setGatewayDedupeEntries({
          dedupe: params.context.dedupe,
          keys: params.dedupeKeys,
          entry: {
            ts: Date.now(),
            ok: aborted && settlementPersisted,
            payload,
            ...(aborted ? {} : { error }),
          },
        });
      };
      const settled = await settle({
        terminalOutcome,
        onRecovered: () => persistTerminalDedupe(true),
      });
      persistTerminalDedupe(settled);
      params.respond(aborted && settled, payload, aborted && settled ? undefined : error, {
        runId: params.runId,
        ...(aborted ? {} : { error: formatForLog(err) }),
      });
    })
    .finally(() => {
      clearAgentRunContext(params.runId, params.ingressOpts.lifecycleGeneration);
      params.cleanupAbortController();
    });
}

function shouldSuppressAgentPromptPersistence(params: {
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
}): boolean {
  if (
    params.inputProvenance?.kind !== "inter_session" ||
    params.inputProvenance.sourceTool !== "subagent_announce"
  ) {
    return false;
  }
  return (
    params.internalEvents?.some(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    ) === true
  );
}

function yieldAfterAgentAcceptedAck(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

function waitForCronContinuationReleaseRecovery(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setSafeTimeout(resolve, delayMs);
    timer.unref?.();
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
      cwd?: string;
      extraSystemPrompt?: string;
      modelRun?: boolean;
      promptMode?: "full" | "minimal" | "none";
      bootstrapContextMode?: "full" | "lightweight";
      // Commitment fan-out scope is scheduler-internal and cannot be selected over Gateway RPC.
      bootstrapContextRunKind?: "default" | "heartbeat" | "cron";
      acpTurnSource?: "manual_spawn";
      internalRuntimeHandoffId?: string;
      execApprovalFollowupExpectedSessionId?: string;
      internalEvents?: AgentInternalEvent[];
      suppressPromptPersistence?: boolean;
      sessionEffects?: "visible" | "internal";
      idempotencyKey: string;
      sourceReplyDeliveryMode?: "automatic" | "message_tool_only";
      disableMessageTool?: boolean;
      timeout?: number;
      bestEffortDeliver?: boolean;
      cleanupBundleMcpOnRunEnd?: boolean;
      label?: string;
      inputProvenance?: InputProvenance;
      workspaceDir?: string;
      voiceWakeTrigger?: string;
      drainsContinuationDelegateQueue?: boolean;
      continuationTrigger?: ContinuationTrigger;
      traceparent?: string;
    };
    if (request.cwd && !path.isAbsolute(request.cwd)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "cwd must be absolute"));
      return;
    }
    if (request.cwd && !normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId)) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "cwd is reserved for plugin-owned subagent runs"),
      );
      return;
    }
    const allowModelOverride = resolveAllowModelOverrideFromClient(client);
    const canUseInternalRuntimeHandoff = resolveCanUseInternalRuntimeHandoff(client);
    const canUseCronRunContinuation = resolveCanUseCronRunContinuation(client);
    const requestedModelOverride = Boolean(request.provider || request.model);
    const requestedInternalSessionEffects = request.sessionEffects === "internal";
    const requestedPromptPersistenceSuppression = request.suppressPromptPersistence === true;
    const isOneShotModelRun = request.modelRun === true;
    const isRawModelRun = isOneShotModelRun || request.promptMode === "none";
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
    if (
      (requestedInternalSessionEffects || requestedPromptPersistenceSuppression) &&
      !canUseInternalRuntimeHandoff
    ) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "internal session-effect controls are reserved for backend callers.",
        ),
      );
      return;
    }
    const providerOverride = allowModelOverride ? request.provider : undefined;
    const modelOverride = allowModelOverride ? request.model : undefined;
    const cfg = context.getRuntimeConfig();
    const idem = request.idempotencyKey;
    const runId = idem;
    const lifecycleGeneration = getAgentEventLifecycleGeneration();
    const execApprovalFollowupApprovalId = parseExecApprovalFollowupApprovalId(idem);
    if (execApprovalFollowupApprovalId && !canUseInternalRuntimeHandoff) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          "exec approval followup idempotency keys are reserved for backend callers.",
        ),
      );
      return;
    }
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
    const preserveUserFacingSessionModelState =
      canUseInternalRuntimeHandoff &&
      shouldPreserveUserFacingSessionStateForInputProvenance(inputProvenance);
    // `modelRun` is the existing stateless probe contract. Derive its hidden
    // effects here without granting the caller any backend-only handoff controls.
    const sessionEffects =
      isOneShotModelRun || requestedInternalSessionEffects ? "internal" : request.sessionEffects;
    const suppressVisibleSessionEffects = sessionEffects === "internal";
    const agentDedupeKeys = resolveAgentDedupeKeys({
      idempotencyKey: idem,
      execApprovalFollowupApprovalId,
    });
    const cached = readGatewayDedupeEntry({
      dedupe: context.dedupe,
      keys: agentDedupeKeys,
    });
    if (cached) {
      if (cached.ok && isAcceptedAgentDedupePayload(cached.payload)) {
        const cachedRunId =
          typeof cached.payload.runId === "string" && cached.payload.runId.trim()
            ? cached.payload.runId.trim()
            : runId;
        const cachedSessionKey =
          typeof cached.payload.sessionKey === "string" && cached.payload.sessionKey.trim()
            ? cached.payload.sessionKey.trim()
            : undefined;
        const cachedAgentId =
          cachedSessionKey === "global" &&
          typeof cached.payload.agentId === "string" &&
          cached.payload.agentId.trim()
            ? cached.payload.agentId.trim()
            : undefined;
        respond(
          true,
          {
            runId: cachedRunId,
            status: "in_flight" as const,
            ...(cachedSessionKey ? { sessionKey: cachedSessionKey } : {}),
            ...(cachedAgentId ? { agentId: cachedAgentId } : {}),
          },
          undefined,
          {
            cached: true,
            runId: cachedRunId,
          },
        );
        return;
      }
      respond(cached.ok, cached.payload, cached.error, {
        cached: true,
      });
      return;
    }
    let agentDedupeReserved = false;
    let agentRunAccepted = false;
    const agentReservationId = randomUUID();
    let committedResetCompletion:
      | {
          reason: "new" | "reset";
          sessionId?: string;
          sessionKey: string;
          agentId?: string;
          followUpPending: boolean;
        }
      | undefined;
    const ownerConnId = typeof client?.connId === "string" ? client.connId : undefined;
    const ownerDeviceId =
      typeof client?.connect?.device?.id === "string" ? client.connect.device.id : undefined;
    const reservePreAcceptedAgentDedupe = (sessionKey?: string, dedupeAgentId?: string) => {
      if (agentDedupeReserved) {
        return;
      }
      const dedupeSessionResolvesGlobal = sessionKey
        ? resolveSessionStoreKey({ cfg, sessionKey }) === "global"
        : false;
      const acceptedAt = Date.now();
      const pendingTimeoutMs = resolveAgentTimeoutMs({
        cfg,
        overrideSeconds: typeof request.timeout === "number" ? request.timeout : undefined,
      });
      setGatewayDedupeEntries({
        dedupe: context.dedupe,
        keys: agentDedupeKeys,
        entry: {
          ts: acceptedAt,
          ok: true,
          payload: {
            runId,
            reservationId: agentReservationId,
            status: "accepted" as const,
            ...(sessionKey ? { sessionKey } : {}),
            ...(dedupeAgentId && (!sessionKey || dedupeSessionResolvesGlobal)
              ? { agentId: dedupeAgentId }
              : {}),
            controlUiVisible: !suppressVisibleSessionEffects,
            acceptedAt,
            dedupeKeys: agentDedupeKeys,
            expiresAtMs: resolveAgentRunExpiresAtMs({
              now: acceptedAt,
              timeoutMs: pendingTimeoutMs,
            }),
            ownerConnId,
            ownerDeviceId,
          },
        },
      });
      agentDedupeReserved = true;
    };
    const clearUnacceptedAgentDedupe = () => {
      if (!agentDedupeReserved || agentRunAccepted) {
        return;
      }
      const reservedEntry = readGatewayDedupeEntry({
        dedupe: context.dedupe,
        keys: agentDedupeKeys,
      });
      if (
        isPreRegistrationAbortedAgentDedupeEntryForSession({
          entry: reservedEntry,
          runId,
        })
      ) {
        return;
      }
      if (
        reservedEntry?.ok &&
        isAcceptedAgentDedupePayload(reservedEntry.payload) &&
        reservedEntry.payload.reservationId !== agentReservationId
      ) {
        return;
      }
      deleteGatewayDedupeEntries({
        dedupe: context.dedupe,
        keys: agentDedupeKeys,
      });
      agentDedupeReserved = false;
    };
    const abortForLifecycleRotation = (target?: {
      sessionKey?: string;
      agentId?: string;
    }): boolean => {
      if (lifecycleGeneration === getAgentEventLifecycleGeneration()) {
        return false;
      }
      if (committedResetCompletion) {
        const completion = committedResetCompletion;
        const responsePayload = buildBareSessionResetResponse({
          runId,
          result: buildBareSessionResetResult({
            reason: completion.reason,
            sessionId: completion.sessionId,
            ackText: completion.followUpPending
              ? `${sessionResetAckText(completion.reason)} Gateway restarted before the follow-up ran; send the follow-up message again.`
              : undefined,
          }),
        });
        agentRunAccepted = true;
        setGatewayDedupeEntries({
          dedupe: context.dedupe,
          keys: agentDedupeKeys,
          entry: {
            ts: Date.now(),
            ok: true,
            payload: responsePayload,
          },
        });
        respond(true, responsePayload, undefined, { runId });
        emitSessionsChanged(context, {
          sessionKey: completion.sessionKey,
          ...(completion.sessionKey === "global" && completion.agentId
            ? { agentId: completion.agentId }
            : {}),
          reason: completion.reason,
        });
        return true;
      }
      const stopReason = AGENT_RUN_RESTART_ABORT_STOP_REASON;
      agentRunAccepted = true;
      setAbortedAgentDedupeEntries({
        dedupe: context.dedupe,
        keys: agentDedupeKeys,
        agentId: target?.agentId,
        sessionKey: target?.sessionKey,
        runId,
        stopReason,
      });
      respond(
        true,
        {
          runId,
          status: "timeout" as const,
          summary: "aborted",
          stopReason,
          timeoutPhase: "queue" as const,
          providerStarted: false,
        },
        undefined,
        { runId },
      );
      return true;
    };
    const normalizedAttachments = normalizeRpcAttachmentsToChatAttachments(request.attachments);
    const requestedBestEffortDeliver =
      typeof request.bestEffortDeliver === "boolean" ? request.bestEffortDeliver : undefined;

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

    const requestedSessionKeyParam = normalizeOptionalString(request.sessionKey);
    const requestedSessionId = normalizeOptionalString(request.sessionId);
    const requestedToRaw = normalizeOptionalString(request.to);
    const sessionKeyFromTo =
      !requestedSessionKeyParam &&
      !requestedSessionId &&
      classifySessionKeyShape(requestedToRaw) === "agent"
        ? requestedToRaw
        : undefined;
    const requestedSessionKeyRaw = requestedSessionKeyParam ?? sessionKeyFromTo;
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
    if (!agentId && requestedSessionKeyRaw) {
      const parsed = parseAgentSessionKey(requestedSessionKeyRaw);
      const inferredAgentId =
        parsed && resolveSessionStoreKey({ cfg, sessionKey: requestedSessionKeyRaw }) === "global"
          ? normalizeAgentId(parsed.agentId)
          : undefined;
      if (inferredAgentId) {
        if (!knownAgents.includes(inferredAgentId)) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `invalid agent params: unknown agent id "${parsed?.agentId}"`,
            ),
          );
          return;
        }
        agentId = inferredAgentId;
      }
    }
    const explicitRecipientChannel = normalizeMessageChannel(request.channel);
    const explicitRecipient =
      !requestedSessionKeyRaw &&
      !requestedSessionId &&
      agentId &&
      explicitRecipientChannel &&
      isDeliverableMessageChannel(explicitRecipientChannel) &&
      requestedToRaw
        ? { agentId, channel: explicitRecipientChannel, to: requestedToRaw }
        : undefined;
    let explicitRecipientSession:
      | Awaited<ReturnType<typeof resolveAgentExplicitRecipientSession>>
      | undefined;
    if (explicitRecipient) {
      // Route lookup can load provider-owned normalization. Reserve before awaiting it so retries
      // cannot start a second run while the canonical session key is still being determined.
      reservePreAcceptedAgentDedupe(undefined, explicitRecipient.agentId);
      try {
        explicitRecipientSession = await resolveAgentExplicitRecipientSession({
          cfg,
          agentId: explicitRecipient.agentId,
          channel: explicitRecipient.channel,
          to: explicitRecipient.to,
          accountId: normalizeOptionalString(request.accountId),
          threadId: request.threadId,
        });
      } catch (err) {
        clearUnacceptedAgentDedupe();
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
    }
    if (explicitRecipientSession?.error) {
      clearUnacceptedAgentDedupe();
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, explicitRecipientSession.error.message),
      );
      return;
    }
    let requestedSessionKey =
      requestedSessionKeyRaw ??
      explicitRecipientSession?.sessionKey ??
      (!requestedSessionId
        ? resolveExplicitAgentSessionKey({
            cfg,
            agentId,
          })
        : undefined);
    if (agentId && requestedSessionKeyRaw) {
      const parsedRequestedSessionKey = parseAgentSessionKey(requestedSessionKeyRaw);
      const requestedCanonicalKey = resolveSessionStoreKey({
        cfg,
        sessionKey: requestedSessionKeyRaw,
      });
      const sessionAgentId = parsedRequestedSessionKey?.agentId
        ? normalizeAgentId(parsedRequestedSessionKey.agentId)
        : requestedCanonicalKey === "global"
          ? agentId
          : resolveAgentIdFromSessionKey(requestedSessionKeyRaw);
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
    // Keep unavailable-session rejection ahead of dedupe, media offload, reset,
    // and dispatch so agent RPC shares the chat.send / sessions.send boundary.
    if (
      requestedSessionKey &&
      respondUnavailableAgentSessionForKey({ sessionKey: requestedSessionKey, agentId, respond })
    ) {
      clearUnacceptedAgentDedupe();
      return;
    }
    // Drop an exec-approval followup whose session key was rebound by /new or
    // /reset while the approval was pending, before the handler touches the
    // rebound session (store write, run registration, dedupe, accepted ack).
    if (execApprovalFollowupApprovalId && requestedSessionKeyRaw) {
      const expectedSessionId = normalizeOptionalString(
        request.execApprovalFollowupExpectedSessionId,
      );
      let currentSessionId: string | undefined;
      try {
        currentSessionId = normalizeOptionalString(
          loadSessionEntry(requestedSessionKeyRaw).entry?.sessionId,
        );
      } catch {
        currentSessionId = undefined;
      }
      if (
        isExecApprovalFollowupSessionRebound({
          expectedSessionId,
          resolvedSessionId: currentSessionId,
        })
      ) {
        emitDiagnosticEvent({
          type: "exec.approval.followup_suppressed",
          approvalId: execApprovalFollowupApprovalId,
          reason: "session_rebound",
          phase: "gateway_preflight",
        });
        context.logGateway.info(
          `Dropping stale exec approval followup ${execApprovalFollowupApprovalId}: session ${requestedSessionKeyRaw} rebound (expected ${expectedSessionId}, current ${currentSessionId}) before the approval resolved`,
        );
        const droppedPayload = {
          runId,
          status: "ok" as const,
          summary: "exec approval followup dropped: session was reset before the approval resolved",
        };
        setGatewayDedupeEntries({
          dedupe: context.dedupe,
          keys: agentDedupeKeys,
          entry: { ts: Date.now(), ok: true, payload: droppedPayload },
        });
        respond(true, droppedPayload, undefined, { runId });
        return;
      }
    }
    // Reserve the run before awaited attachment/session/delivery work so duplicate calls dedupe and
    // pre-registration chat.abort can be made durable by idempotency key.
    const preAcceptedReservedSessionKey =
      requestedSessionKey &&
      resolveSessionStoreKey({ cfg, sessionKey: requestedSessionKey }) === "global"
        ? "global"
        : requestedSessionKey;
    if (preAcceptedReservedSessionKey) {
      reservePreAcceptedAgentDedupe(preAcceptedReservedSessionKey, agentId);
    }
    const preAttachmentSession = requestedSessionKey
      ? (() => {
          const loaded = loadSessionEntry(requestedSessionKey, {
            ...(agentId ? { agentId } : {}),
            clone: false,
          });
          return loaded.entry
            ? {
                canonicalKey: loaded.canonicalKey,
                sessionId: loaded.entry.sessionId,
              }
            : undefined;
        })()
      : undefined;
    let gatewayWorkAdmission: SessionWorkAdmissionLease | undefined;
    let gatewayAdmissionTransferred = false;
    let cronContinuationClaim:
      | {
          storePath: string;
          sessionKey: string;
          lifecycleRevision: string;
          initialEntry: SessionEntry;
          mediaTaskIdsBefore: ReadonlySet<string>;
        }
      | undefined;
    let cronContinuationReleaseRecoveryScheduled = false;
    const releaseCronContinuationClaim = async (outcome?: {
      terminalOutcome: AgentRunTerminalOutcome;
    }): Promise<boolean> => {
      const claim = cronContinuationClaim;
      if (!claim) {
        return true;
      }
      const baseSessionKey = parseCronRunScopeSuffix(claim.sessionKey).baseSessionKey;
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const released = await applySessionEntryReplacements({
            activeSessionKey: claim.sessionKey,
            requireWriteSuccess: true,
            sessionKeys:
              baseSessionKey && baseSessionKey !== claim.sessionKey
                ? [claim.sessionKey, baseSessionKey]
                : [claim.sessionKey],
            skipMaintenance: false,
            storePath: claim.storePath,
            update: (entries) => {
              const entriesByKey = new Map(
                entries.map(({ sessionKey, entry }) => [sessionKey, entry]),
              );
              let current = entriesByKey.get(claim.sessionKey);
              const marker = current?.cronRunContinuation;
              if (
                !current ||
                marker?.phase !== "continuing" ||
                marker.ownerRunId !== runId ||
                marker.lifecycleRevision !== claim.lifecycleRevision
              ) {
                return { result: false };
              }
              const continuationCommittedWork =
                outcome?.terminalOutcome.reason === "completed" ||
                hasNewGeneratedMediaTaskForSessionKey(claim.sessionKey, claim.mediaTaskIdsBefore);
              if (!continuationCommittedWork) {
                current = structuredClone(claim.initialEntry);
              } else if (outcome?.terminalOutcome) {
                const terminalOutcome = outcome.terminalOutcome;
                current.status =
                  terminalOutcome.status === "ok"
                    ? "done"
                    : terminalOutcome.status === "timeout"
                      ? "timeout"
                      : "failed";
                current.endedAt = terminalOutcome.endedAt ?? Date.now();
              }
              const baseEntry = baseSessionKey ? entriesByKey.get(baseSessionKey) : undefined;
              const canPersistToBase =
                baseSessionKey !== undefined &&
                baseSessionKey !== claim.sessionKey &&
                baseEntry?.lifecycleRevision === claim.lifecycleRevision;
              const replacements: Array<{ sessionKey: string; entry: SessionEntry }> = [];
              if (continuationCommittedWork && canPersistToBase && baseEntry && baseSessionKey) {
                const nextBaseEntry = withoutCronRunContinuation(current);
                replacements.push({
                  sessionKey: baseSessionKey,
                  entry: mergeSessionSnapshotChanges({
                    initial: withoutCronRunContinuation(claim.initialEntry),
                    next: nextBaseEntry,
                    current: baseEntry,
                  }),
                });
              }
              const releaseSourceMarker = continuationCommittedWork
                ? marker
                : (claim.initialEntry.cronRunContinuation ?? marker);
              const {
                ownerRunId: _ownerRunId,
                ownerLifecycleGeneration: _ownerLifecycleGeneration,
                ...releasedMarker
              } = releaseSourceMarker;
              const baseWasSuperseded = Boolean(
                baseEntry && baseEntry.lifecycleRevision !== claim.lifecycleRevision,
              );
              current.cronRunContinuation = {
                ...releasedMarker,
                phase: "ready",
                basePersisted:
                  releasedMarker.basePersisted === true || canPersistToBase || baseWasSuperseded,
              };
              current.updatedAt = Date.now();
              replacements.push({ sessionKey: claim.sessionKey, entry: current });
              return { replacements, result: true };
            },
          });
          cronContinuationClaim = undefined;
          if (released) {
            if (baseSessionKey) {
              emitSessionsChanged(context, {
                sessionKey: baseSessionKey,
                reason: "cron-continuation",
              });
            }
          }
          return released;
        } catch (error) {
          context.logGateway.warn(
            `failed to release cron continuation ${runId} (${attempt}/3): ${formatForLog(error)}`,
          );
        }
      }
      return false;
    };
    const scheduleCronContinuationReleaseRecovery = (
      outcome?: { terminalOutcome: AgentRunTerminalOutcome },
      onRecovered?: () => void,
    ): void => {
      const claim = cronContinuationClaim;
      if (!claim || cronContinuationReleaseRecoveryScheduled) {
        return;
      }
      cronContinuationReleaseRecoveryScheduled = true;
      const ownerLifecycleGeneration = lifecycleGeneration;
      // Keep the failed settlement recoverable without retaining the process or
      // transferring claim ownership beyond this request's gateway generation.
      void (async () => {
        for (const delayMs of CRON_CONTINUATION_RELEASE_RECOVERY_DELAYS_MS) {
          await waitForCronContinuationReleaseRecovery(delayMs);
          if (
            cronContinuationClaim !== claim ||
            getAgentEventLifecycleGeneration() !== ownerLifecycleGeneration
          ) {
            return;
          }
          if (await releaseCronContinuationClaim(outcome)) {
            try {
              onRecovered?.();
            } catch (error) {
              context.logGateway.warn(
                `failed to refresh recovered cron continuation dedupe ${runId}: ${formatForLog(error)}`,
              );
            }
            return;
          }
        }
        context.logGateway.warn(`cron continuation release recovery exhausted for ${runId}`);
      })();
    };
    const releaseCronContinuationClaimWithRecovery = async (
      outcome?: { terminalOutcome: AgentRunTerminalOutcome },
      onRecovered?: () => void,
    ): Promise<boolean> => {
      const released = await releaseCronContinuationClaim(outcome);
      if (!released && cronContinuationClaim) {
        scheduleCronContinuationReleaseRecovery(outcome, onRecovered);
      }
      return released;
    };

    try {
      let message = (request.message ?? "").trim();
      if (!isRawModelRun) {
        message = annotateInterSessionPromptText(message, inputProvenance);
      }
      let images: Array<{ type: "image"; data: string; mimeType: string }> = [];
      let imageOrder: PromptImageOrderEntry[] = [];
      if (normalizedAttachments.length > 0) {
        let baseProvider: string | undefined;
        let baseModel: string | undefined;
        let requestedAcpMeta: ReturnType<typeof readAcpSessionMeta>;
        if (requestedSessionKeyRaw) {
          const {
            cfg: sessCfg,
            entry: sessEntry,
            canonicalKey: sessCanonicalKey,
          } = loadSessionEntry(requestedSessionKeyRaw, {
            ...(agentId ? { agentId } : {}),
            clone: false,
          });
          const sessionAgentId =
            sessCanonicalKey === "global" && agentId
              ? agentId
              : resolveAgentIdFromSessionKey(sessCanonicalKey);
          const modelRef = resolveSessionModelRef(sessCfg, sessEntry, sessionAgentId);
          baseProvider = modelRef.provider;
          baseModel = modelRef.model;
          requestedAcpMeta = readAcpSessionMeta({ sessionKey: sessCanonicalKey });
        }
        const effectiveProvider = providerOverride || baseProvider;
        const effectiveModel = modelOverride || baseModel;
        const isConfirmedAcpSession =
          request.acpTurnSource === "manual_spawn" &&
          isAcpSessionKey(requestedSessionKeyRaw) &&
          requestedAcpMeta != null;
        const supportsInlineImages = isConfirmedAcpSession
          ? true
          : await resolveGatewayModelSupportsImages({
              loadGatewayModelCatalog: context.loadGatewayModelCatalog,
              provider: effectiveProvider,
              model: effectiveModel,
            });

        try {
          const parsed = await parseMessageWithAttachments(message, normalizedAttachments, {
            maxBytes: resolveChatAttachmentMaxBytes(cfg),
            log: context.logGateway,
            supportsInlineImages,
            // agent.run does not yet wire a ctx.MediaPaths stage path, so reject
            // non-image attachments explicitly (UnsupportedAttachmentError)
            // instead of saving them where the agent cannot reach them.
            acceptNonImage: false,
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
          logAttachmentFailure(context.logGateway, "agent attachment parse failed", err);
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

      // Accept internal non-delivery sources (heartbeat, cron, webhook) as valid
      // channel hints so subagent spawns from those parent runs are not rejected.
      const isKnownGatewayChannel = (value: string): boolean =>
        isGatewayMessageChannel(value) || isInternalNonDeliveryChannel(value);
      const channelHints = normalizeStringEntries(
        [request.channel, request.replyChannel].filter(
          (value): value is string => typeof value === "string",
        ),
      );
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

      const voiceWakeTrigger = normalizeOptionalString(request.voiceWakeTrigger) ?? "";
      const replyTo = normalizeOptionalString(request.replyTo) ?? "";
      const recipientChannel = explicitRecipientSession?.channel ?? request.channel;
      const recipientAccountId = explicitRecipientSession?.accountId ?? request.accountId;
      const recipientThreadId = explicitRecipientSession?.threadId ?? request.threadId;
      const to = sessionKeyFromTo ? "" : (explicitRecipientSession?.to ?? requestedToRaw ?? "");
      const explicitVoiceWakeSessionTarget =
        !agentId && requestedSessionKeyRaw
          ? (() => {
              const { cfg: sessionCfg, canonicalKey } = loadSessionEntry(requestedSessionKeyRaw, {
                clone: false,
              });
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
      const hasVoiceWakeTriggerField = Object.hasOwn(request, "voiceWakeTrigger");
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
              const canonicalRouteSession = loadSessionEntry(route.sessionKey, {
                clone: false,
              }).canonicalKey;
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
      let sessionContinuationTraceparent: string | undefined;
      let effectiveBootstrapContextRunKind = request.bootstrapContextRunKind;
      let restoredCronContinuation: RestoredCronContinuation | undefined;
      let restoredCronContinuationIdentity:
        | Pick<RestoredCronContinuation, "lifecycleRevision" | "sessionId">
        | undefined;
      let restoredCronContinuationError: string | undefined;
      let sessionPersistedBeforeGatewayAdmission = false;
      let bestEffortDeliver = requestedBestEffortDeliver ?? false;
      let cfgForAgent: OpenClawConfig | undefined;
      let resolvedSessionKey = requestedSessionKey;
      let resolvedSessionAgentId: string | undefined;
      let isNewSession = false;
      let supersededSessionId: string | undefined;
      let skipAgentInitialSessionTouch = false;
      let pendingChatRun: { sessionKey: string; agentId?: string } | undefined;
      let admittedSessionId = resolvedSessionId ?? runId;
      let admittedRunAbort: ReturnType<typeof registerChatAbortController> | undefined;
      let postAdmissionAbort: ReturnType<typeof readGatewayDedupeEntry>;
      let postAdmissionTimeout:
        | {
            runId: string;
            status: "timeout";
            summary: "aborted";
            stopReason: "timeout";
            timeoutPhase: "queue";
            providerStarted: false;
          }
        | undefined;
      let postAdmissionSuperseded = false;
      let lifecycleRotatedDuringAdmission = false;
      const admissionAgentId = () =>
        resolvedSessionKey === "global"
          ? (resolvedSessionAgentId ?? agentId ?? resolveDefaultAgentId(cfgForAgent ?? cfg))
          : undefined;
      const assertGatewayWorkAdmissionAllowed = () => {
        const latestPreRegistrationAbort = readGatewayDedupeEntry({
          dedupe: context.dedupe,
          keys: agentDedupeKeys,
        });
        if (
          isPreRegistrationAbortedAgentDedupeEntryForSession({
            entry: latestPreRegistrationAbort,
            runId,
            sessionKey: resolvedSessionKey,
            alternateSessionKeys: [preAcceptedReservedSessionKey, requestedSessionKey],
          })
        ) {
          postAdmissionAbort = latestPreRegistrationAbort;
          return;
        }
        if (agentDedupeReserved) {
          if (!latestPreRegistrationAbort) {
            postAdmissionTimeout = {
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason: "timeout",
              timeoutPhase: "queue",
              providerStarted: false,
            };
            setAbortedAgentDedupeEntries({
              dedupe: context.dedupe,
              keys: agentDedupeKeys,
              agentId: admissionAgentId(),
              sessionKey: resolvedSessionKey,
              runId,
              stopReason: "timeout",
            });
            return;
          }
          if (
            !latestPreRegistrationAbort.ok ||
            !isAcceptedAgentDedupePayload(latestPreRegistrationAbort.payload)
          ) {
            postAdmissionAbort = latestPreRegistrationAbort;
            return;
          }
          if (latestPreRegistrationAbort.payload.reservationId !== agentReservationId) {
            postAdmissionSuperseded = true;
            return;
          }
          if (
            !isFutureDateTimestampMs(latestPreRegistrationAbort.payload.expiresAtMs, {
              nowMs: Date.now(),
            })
          ) {
            postAdmissionTimeout = {
              runId,
              status: "timeout",
              summary: "aborted",
              stopReason: "timeout",
              timeoutPhase: "queue",
              providerStarted: false,
            };
            setAbortedAgentDedupeEntries({
              dedupe: context.dedupe,
              keys: agentDedupeKeys,
              agentId: admissionAgentId(),
              sessionKey: resolvedSessionKey,
              runId,
              stopReason: "timeout",
            });
            return;
          }
        }
        lifecycleRotatedDuringAdmission = abortForLifecycleRotation({
          sessionKey: resolvedSessionKey,
          agentId: admissionAgentId(),
        });
        if (lifecycleRotatedDuringAdmission || !resolvedSessionKey) {
          return;
        }
        let latestEntry = loadSessionEntry(resolvedSessionKey, {
          ...(resolvedSessionKey === "global" ? { agentId: admissionAgentId() } : {}),
          clone: false,
        }).entry;
        // Legacy stores may only carry the requested spelling (e.g. bare
        // "main"); a canonical-only re-read would misreport those sessions
        // as deleted mid-start.
        if (!latestEntry && requestedSessionKey && requestedSessionKey !== resolvedSessionKey) {
          latestEntry = loadSessionEntry(requestedSessionKey, { clone: false }).entry;
        }
        if (sessionPersistedBeforeGatewayAdmission && !latestEntry) {
          throw new Error(
            `Session "${resolvedSessionKey}" was deleted while starting work. Retry.`,
          );
        }
        const archivedError = resolveSessionWorkStartError(resolvedSessionKey, latestEntry);
        if (archivedError) {
          throw new Error(archivedError);
        }
        if (latestEntry?.sessionId && latestEntry.sessionId !== supersededSessionId) {
          admittedSessionId = latestEntry.sessionId;
        }
      };
      const interruptGatewayWorkAdmission = () => {
        if (admittedRunAbort?.entry) {
          admittedRunAbort.entry.abortStopReason = AGENT_RUN_RESTART_ABORT_STOP_REASON;
        }
        if (admittedRunAbort) {
          admittedRunAbort.controller.abort(createAgentRunRestartAbortError());
          return;
        }
        const reservedEntry = readGatewayDedupeEntry({
          dedupe: context.dedupe,
          keys: agentDedupeKeys,
        });
        if (
          reservedEntry?.ok &&
          isAcceptedAgentDedupePayload(reservedEntry.payload) &&
          reservedEntry.payload.reservationId === agentReservationId
        ) {
          setAbortedAgentDedupeEntries({
            dedupe: context.dedupe,
            keys: agentDedupeKeys,
            agentId: admissionAgentId(),
            sessionKey: resolvedSessionKey,
            runId,
            stopReason: AGENT_RUN_RESTART_ABORT_STOP_REASON,
          });
        }
      };
      const acquireGatewayWorkAdmission = async (scope: string) => {
        if (gatewayWorkAdmission) {
          return;
        }
        gatewayWorkAdmission = await beginSessionWorkAdmission({
          scope,
          identities: [resolvedSessionKey, resolvedSessionId],
          assertAllowed: assertGatewayWorkAdmissionAllowed,
          onInterrupt: interruptGatewayWorkAdmission,
        });
      };
      const respondToGatewayAdmissionOutcome = (): boolean => {
        if (postAdmissionAbort) {
          gatewayWorkAdmission?.release();
          agentRunAccepted = true;
          respond(postAdmissionAbort.ok, postAdmissionAbort.payload, postAdmissionAbort.error, {
            cached: true,
            runId,
          });
          return true;
        }
        if (postAdmissionTimeout) {
          gatewayWorkAdmission?.release();
          agentRunAccepted = true;
          respond(true, postAdmissionTimeout, undefined, { cached: true, runId });
          return true;
        }
        if (postAdmissionSuperseded) {
          gatewayWorkAdmission?.release();
          agentRunAccepted = true;
          respond(true, { runId, status: "in_flight" as const }, undefined, {
            cached: true,
            runId,
          });
          return true;
        }
        if (lifecycleRotatedDuringAdmission) {
          gatewayWorkAdmission?.release();
          return true;
        }
        return false;
      };

      const resetCommandMatch = message.match(RESET_COMMAND_RE);
      if (resetCommandMatch && requestedSessionKey) {
        if (abortForLifecycleRotation({ sessionKey: requestedSessionKey, agentId })) {
          return;
        }
        const postResetMessage = normalizeOptionalString(resetCommandMatch[2]) ?? "";
        if (!clientHasAdminScope(client)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, `missing scope: ${ADMIN_SCOPE}`),
          );
          return;
        }
        const resetReason =
          normalizeOptionalLowercaseString(resetCommandMatch[1]) === "new" ? "new" : "reset";
        let resetResult: Awaited<ReturnType<typeof runSessionResetFromAgent>>;
        try {
          resetResult = await runSessionResetFromAgent({
            key: requestedSessionKey,
            ...(requestedSessionKey === "global" && agentId ? { agentId } : {}),
            reason: resetReason,
            assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
            onCommitted: (commit) => {
              committedResetCompletion = {
                reason: resetReason,
                sessionId: commit.sessionId,
                sessionKey: commit.key,
                agentId,
                followUpPending: Boolean(postResetMessage),
              };
            },
          });
        } catch (err) {
          if (abortForLifecycleRotation({ sessionKey: requestedSessionKey, agentId })) {
            return;
          }
          throw err;
        }
        if (!resetResult.ok) {
          respond(false, undefined, resetResult.error);
          return;
        }
        requestedSessionKey = resetResult.key;
        resolvedSessionId = resetResult.sessionId ?? resolvedSessionId;
        committedResetCompletion = {
          reason: resetReason,
          sessionId: resetResult.sessionId,
          sessionKey: resetResult.key,
          agentId,
          followUpPending: Boolean(postResetMessage),
        };
        if (postResetMessage) {
          if (abortForLifecycleRotation({ sessionKey: resetResult.key, agentId })) {
            return;
          }
          message = postResetMessage;
        } else {
          let resetAckResult: Awaited<ReturnType<typeof resolveBareSessionResetResult>>;
          try {
            const deliverySession =
              request.deliver === true
                ? loadBareSessionResetDeliverySession({
                    cfg,
                    sessionKey: resetResult.key,
                    ...(agentId ? { agentId } : {}),
                  })
                : undefined;
            resetAckResult = await resolveBareSessionResetResult({
              cfg: deliverySession?.cfg ?? cfg,
              context,
              reason: resetReason,
              sessionId: resetResult.sessionId,
              sessionKey: resetResult.key,
              agentId: deliverySession?.agentId ?? agentId,
              sessionEntry: deliverySession?.entry,
              request: sessionKeyFromTo ? { ...request, to: undefined } : request,
              runId,
              assertCurrent: () => assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration),
            });
          } catch (err) {
            if (abortForLifecycleRotation({ sessionKey: resetResult.key, agentId })) {
              return;
            }
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
            return;
          }
          const responsePayload = buildBareSessionResetResponse({
            runId,
            result: resetAckResult,
          });
          agentRunAccepted = true;
          setGatewayDedupeEntries({
            dedupe: context.dedupe,
            keys: agentDedupeKeys,
            entry: {
              ts: Date.now(),
              ok: true,
              payload: responsePayload,
            },
          });
          respond(true, responsePayload, undefined, { runId });
          emitSessionsChanged(context, {
            sessionKey: resetResult.key,
            ...(resetResult.key === "global" && agentId ? { agentId } : {}),
            reason: resetReason,
          });
          return;
        }
      }

      // The per-message timestamp prefix is now applied at the single LLM
      // boundary (normalizeMessagesForLlmBoundary), derived from each message's
      // own timestamp, so the current turn and all historical turns carry
      // identical bytes on the wire. The transient gateway injectTimestamp call
      // is removed — stamping the live turn here would diverge from the bare
      // stored history and bust the prompt cache.
      // See: https://github.com/openclaw/openclaw/issues/3658

      if (requestedSessionKey) {
        const sessionLoadOptions = {
          ...(agentId ? { agentId } : {}),
          clone: false,
        };
        const {
          cfg: cfgLocal,
          storePath,
          entry,
          canonicalKey,
          legacyKey,
        } = loadSessionEntry(requestedSessionKey, sessionLoadOptions);
        cfgForAgent = cfgLocal;
        const isGeneratedMediaCronContinuation =
          hasGeneratedMediaCompletionEvent(request.internalEvents) &&
          parseCronRunScopeSuffix(canonicalKey).runId !== undefined;
        if (isGeneratedMediaCronContinuation) {
          if (!canUseCronRunContinuation) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                "cron run completion handoffs are reserved for server-owned callers",
              ),
            );
            return;
          }
          const marker = entry?.cronRunContinuation;
          const continuationSessionId = normalizeOptionalString(entry?.sessionId);
          const staleClaim =
            marker?.phase === "continuing" &&
            marker.ownerLifecycleGeneration !== lifecycleGeneration;
          if (staleClaim || (marker?.phase === "ready" && marker.basePersisted !== true)) {
            respond(
              false,
              undefined,
              errorShape(
                ErrorCodes.INVALID_REQUEST,
                staleClaim
                  ? "cron run continuation owner was lost during gateway restart"
                  : "cron run continuation base session was not persisted",
              ),
            );
            return;
          }
          if (!marker || marker.phase !== "ready" || !continuationSessionId) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation is not ready"),
            );
            return;
          }
          if (requestedSessionId && requestedSessionId !== continuationSessionId) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation session changed"),
            );
            return;
          }
          restoredCronContinuationIdentity = {
            lifecycleRevision: marker.lifecycleRevision,
            sessionId: continuationSessionId,
          };
          effectiveBootstrapContextRunKind = "cron";
        }
        const sessionExistedBeforeAttachmentSetup =
          preAttachmentSession?.canonicalKey === canonicalKey ? preAttachmentSession : undefined;
        if (sessionExistedBeforeAttachmentSetup && !entry) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session "${canonicalKey}" was deleted while starting work. Retry.`,
            ),
          );
          return;
        }
        if (
          sessionExistedBeforeAttachmentSetup &&
          entry?.sessionId !== sessionExistedBeforeAttachmentSetup.sessionId
        ) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Session "${canonicalKey}" changed while starting work. Retry.`,
            ),
          );
          return;
        }
        sessionPersistedBeforeGatewayAdmission = entry !== undefined;
        if (
          respondDeletedAgentSession({
            cfg: cfgLocal,
            canonicalKey,
            entry,
            acpMetadataSessionKey: legacyKey,
            respond,
          })
        ) {
          return;
        }
        sessionContinuationTraceparent = entry?.continuationTraceparent;
        const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
        if (archivedSessionError) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
          return;
        }
        const sessionMaintenanceConfig = resolveMaintenanceConfigFromInput(
          cfgLocal.session?.maintenance,
        );
        const canonicalSessionAgentId =
          canonicalKey === "global"
            ? (agentId ?? resolveDefaultAgentId(cfgLocal))
            : resolveAgentIdFromSessionKey(canonicalKey);
        const now = Date.now();
        const resetPolicy = resolveSessionResetPolicy({
          sessionCfg: cfgLocal.session,
          resetType: resolveSessionResetType({ sessionKey: canonicalKey }),
          resetOverride: resolveChannelResetConfig({
            sessionCfg: cfgLocal.session,
            channel: entry?.lastChannel ?? entry?.channel ?? recipientChannel,
          }),
        });
        const lifecycleTimestamps = entry
          ? resolveSessionLifecycleTimestamps({
              entry,
              storePath,
              agentId: canonicalSessionAgentId,
            })
          : undefined;
        const skipImplicitExpiry =
          restoredCronContinuationIdentity !== undefined ||
          (resetPolicy.configured !== true && hasProviderOwnedSession(entry));
        let freshness = entry
          ? skipImplicitExpiry
            ? ({ fresh: true } satisfies SessionFreshness)
            : evaluateSessionFreshness({
                updatedAt: entry.updatedAt,
                ...lifecycleTimestamps,
                now,
                policy: resetPolicy,
              })
          : undefined;
        const visibleRequest =
          effectiveBootstrapContextRunKind !== "cron" &&
          effectiveBootstrapContextRunKind !== "heartbeat" &&
          !request.internalEvents?.length;
        const resolveFailedSessionTranscriptMissingForEntry = (
          candidateEntry: SessionEntry | undefined,
        ) => {
          if (candidateEntry?.status !== "failed" || !candidateEntry.sessionId?.trim()) {
            return false;
          }
          try {
            const sessionPathOpts = resolveSessionFilePathOptions({
              storePath,
              agentId: canonicalSessionAgentId,
            });
            return !existsSync(
              resolveSessionFilePath(candidateEntry.sessionId, candidateEntry, sessionPathOpts),
            );
          } catch {
            return true;
          }
        };
        const failedSessionTranscriptMissing = resolveFailedSessionTranscriptMissingForEntry(entry);
        const mainSessionKeyForRequest = resolveAgentMainSessionKey({
          cfg: cfgLocal,
          agentId: canonicalSessionAgentId,
        });
        const isSystemGatewayRun =
          effectiveBootstrapContextRunKind === "cron" ||
          effectiveBootstrapContextRunKind === "heartbeat";
        const requestedSessionMatchesEntry = Boolean(
          requestedSessionId && entry?.sessionId?.trim() === requestedSessionId,
        );
        const terminalMainTranscriptCheck =
          isSystemGatewayRun || requestedSessionMatchesEntry
            ? undefined
            : resolveTerminalMainSessionTranscriptRegistryCheck({
                entry,
                sessionScope: cfgLocal.session?.scope,
                sessionKey: canonicalKey,
                agentId: canonicalSessionAgentId,
                mainKey: cfgLocal.session?.mainKey,
                storePath,
              });
        const terminalMainTranscriptNewerThanRegistry = terminalMainTranscriptCheck
          ? hasTerminalMainSessionTranscriptNewerThanRegistrySync({
              entry,
              sessionScope: cfgLocal.session?.scope,
              sessionKey: canonicalKey,
              agentId: canonicalSessionAgentId,
              mainKey: cfgLocal.session?.mainKey,
              storePath,
            })
          : false;
        const canReuseSession =
          Boolean(entry?.sessionId) &&
          (freshness?.fresh ?? false) &&
          !failedSessionTranscriptMissing &&
          !terminalMainTranscriptNewerThanRegistry;
        let usableRequestedSessionId =
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
        let rotatedSessionId = Boolean(entry?.sessionId && entry.sessionId !== sessionId);
        const touchInteraction = visibleRequest;
        const sessionAgent = canonicalSessionAgentId;
        type AgentSessionPatchBuild = {
          patch: Partial<SessionEntry>;
          spawnedBy: string | undefined;
          groupId: string | undefined;
          groupChannel: string | undefined;
          groupSpace: string | undefined;
          freshSessionRotatedSinceLoad: boolean;
          isNewSession: boolean;
          rotatedSessionId: boolean;
          usableRequestedSessionId: string | undefined;
          freshness: typeof freshness;
        };
        const requestDeliveryHint = normalizeDeliveryContext({
          channel: recipientChannel?.trim(),
          to,
          accountId: recipientAccountId?.trim(),
          // Pass threadId directly — normalizeDeliveryContext handles both
          // string and numeric threadIds (e.g., Matrix uses integers).
          threadId: recipientThreadId,
        });
        const buildSessionPatch = (
          freshEntry: SessionEntry | undefined,
        ): AgentSessionPatchBuild => {
          const freshSpawnedBy = canonicalizeSpawnedByForAgent(
            cfgLocal,
            sessionAgent,
            freshEntry?.spawnedBy,
          );
          const storedGroup = normalizeTrustedGroupMetadata(freshEntry);
          let inheritedGroup: TrustedGroupMetadata | undefined;
          if (
            freshSpawnedBy &&
            (!storedGroup.groupId || !storedGroup.groupChannel || !storedGroup.groupSpace)
          ) {
            try {
              const parentEntry = loadSessionEntry(freshSpawnedBy)?.entry;
              inheritedGroup = normalizeTrustedGroupMetadata({
                groupId: parentEntry?.groupId,
                groupChannel: parentEntry?.groupChannel,
                groupSpace: parentEntry?.space,
              });
            } catch {
              inheritedGroup = undefined;
            }
          }
          const trustedGroup = resolveTrustedGroupMetadata({
            sessionKey: canonicalKey,
            spawnedBy: freshSpawnedBy,
            stored: storedGroup,
            inherited: inheritedGroup,
          });
          const validatedGroup = trustedGroup.groupId
            ? resolveTrustedGroupId({
                groupId: trustedGroup.groupId,
                sessionKey: canonicalKey,
                spawnedBy: freshSpawnedBy,
              })
            : undefined;
          const nextGroup =
            validatedGroup?.dropped === true
              ? {
                  groupId: undefined,
                  groupChannel: undefined,
                  groupSpace: undefined,
                }
              : (() => {
                  const trustRequestSelectors =
                    Boolean(trustedGroup.groupId) &&
                    requestGroupMatchesTrusted({
                      requestGroupId: normalizedSpawned.groupId,
                      trustedGroupId: trustedGroup.groupId,
                    });
                  return {
                    groupId: trustedGroup.groupId,
                    groupChannel:
                      trustedGroup.groupChannel ??
                      (trustRequestSelectors ? normalizedSpawned.groupChannel : undefined),
                    groupSpace:
                      trustedGroup.groupSpace ??
                      (trustRequestSelectors ? normalizedSpawned.groupSpace : undefined),
                  };
                })();

          const deliveryFields = normalizeSessionDeliveryFields(freshEntry);
          // When the session has no delivery context yet (e.g. a freshly-spawned
          // subagent with deliver: false), seed it from request channel/to/threadId.
          const effectiveDelivery = mergeDeliveryContext(
            deliveryFields.deliveryContext,
            requestDeliveryHint,
          );
          const effectiveDeliveryFields = normalizeSessionDeliveryFields({
            route: deliveryFields.route,
            deliveryContext: effectiveDelivery,
          });
          const labelValue = normalizeOptionalString(request.label) || freshEntry?.label;
          const channelValue = freshEntry?.channel ?? recipientChannel?.trim();
          const pluginOwnerId =
            freshEntry === undefined
              ? normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId)
              : undefined;
          const freshSessionRotatedSinceLoad = Boolean(
            entry?.sessionId && freshEntry?.sessionId && freshEntry.sessionId !== entry.sessionId,
          );
          const freshLifecycleTimestamps = freshEntry
            ? resolveSessionLifecycleTimestamps({
                entry: freshEntry,
                storePath,
                agentId: sessionAgent,
              })
            : undefined;
          const freshSkipImplicitExpiry =
            restoredCronContinuationIdentity !== undefined ||
            (resetPolicy.configured !== true && hasProviderOwnedSession(freshEntry));
          const freshFreshness = freshEntry
            ? freshSkipImplicitExpiry
              ? ({ fresh: true } satisfies SessionFreshness)
              : evaluateSessionFreshness({
                  updatedAt: freshEntry.updatedAt,
                  ...freshLifecycleTimestamps,
                  now,
                  policy: resetPolicy,
                })
            : undefined;
          const freshRequestedSessionMatchesEntry = Boolean(
            requestedSessionId && freshEntry?.sessionId?.trim() === requestedSessionId,
          );
          const freshTerminalMainTranscriptNewerThanRegistry =
            isSystemGatewayRun || freshRequestedSessionMatchesEntry
              ? false
              : hasTerminalMainSessionTranscriptNewerThanRegistrySync({
                  entry: freshEntry,
                  sessionScope: cfgLocal.session?.scope,
                  sessionKey: canonicalKey,
                  agentId: sessionAgent,
                  mainKey: cfgLocal.session?.mainKey,
                  storePath,
                });
          const freshFailedSessionTranscriptMissing =
            resolveFailedSessionTranscriptMissingForEntry(freshEntry);
          const freshCanReuseSession =
            Boolean(freshEntry?.sessionId) &&
            (freshFreshness?.fresh ?? false) &&
            !freshFailedSessionTranscriptMissing &&
            !freshTerminalMainTranscriptNewerThanRegistry;
          const freshUsableRequestedSessionId =
            requestedSessionId && (!freshEntry?.sessionId || freshCanReuseSession)
              ? requestedSessionId
              : undefined;
          const freshSessionId = freshUsableRequestedSessionId
            ? freshUsableRequestedSessionId
            : ((freshCanReuseSession ? freshEntry?.sessionId : undefined) ?? sessionId);
          const freshIsNewSession =
            !freshEntry ||
            (!freshCanReuseSession && !freshUsableRequestedSessionId) ||
            Boolean(
              freshUsableRequestedSessionId &&
              freshEntry?.sessionId !== freshUsableRequestedSessionId,
            );
          const freshRotatedSessionId = Boolean(
            freshEntry?.sessionId && freshEntry.sessionId !== freshSessionId,
          );
          const patchSessionId = freshSessionRotatedSinceLoad
            ? freshEntry?.sessionId
            : freshSessionId;
          const shouldClearRotatedState = freshRotatedSessionId && !freshSessionRotatedSinceLoad;
          const freshRecoverTerminalSession =
            freshCanReuseSession &&
            visibleRequest &&
            isRecoverableTerminalSessionStatus(freshEntry?.status);
          const shouldClearTerminalState =
            freshRecoverTerminalSession &&
            !freshSessionRotatedSinceLoad &&
            patchSessionId === freshEntry?.sessionId;
          const patch: Partial<SessionEntry> = {
            sessionId: patchSessionId,
            updatedAt: now,
            ...(freshIsNewSession && !freshSessionRotatedSinceLoad
              ? { sessionStartedAt: now }
              : {}),
            ...(touchInteraction ? { lastInteractionAt: now } : {}),
            ...(effectiveDeliveryFields.route ? { route: effectiveDeliveryFields.route } : {}),
            ...(effectiveDeliveryFields.deliveryContext
              ? { deliveryContext: effectiveDeliveryFields.deliveryContext }
              : {}),
            ...(effectiveDeliveryFields.lastChannel
              ? { lastChannel: effectiveDeliveryFields.lastChannel }
              : {}),
            ...(effectiveDeliveryFields.lastTo ? { lastTo: effectiveDeliveryFields.lastTo } : {}),
            ...(effectiveDeliveryFields.lastAccountId
              ? { lastAccountId: effectiveDeliveryFields.lastAccountId }
              : {}),
            ...(effectiveDeliveryFields.lastThreadId != null
              ? { lastThreadId: effectiveDeliveryFields.lastThreadId }
              : {}),
            ...(labelValue ? { label: labelValue } : {}),
            ...(freshSpawnedBy ? { spawnedBy: freshSpawnedBy } : {}),
            ...(channelValue ? { channel: channelValue } : {}),
            groupId: nextGroup.groupId,
            groupChannel: nextGroup.groupChannel,
            space: nextGroup.groupSpace,
            ...(pluginOwnerId ? { pluginOwnerId } : {}),
            ...(shouldClearRotatedState || shouldClearTerminalState
              ? {
                  status: undefined,
                  startedAt: undefined,
                  endedAt: undefined,
                  runtimeMs: undefined,
                  abortedLastRun: undefined,
                  ...(shouldClearRotatedState ? { sessionFile: undefined } : {}),
                }
              : {}),
          };
          if (shouldClearRotatedState) {
            clearAllCliSessions(patch);
          }
          return {
            patch,
            spawnedBy: freshSpawnedBy,
            groupId: nextGroup.groupId,
            groupChannel: nextGroup.groupChannel,
            groupSpace: nextGroup.groupSpace,
            freshSessionRotatedSinceLoad,
            isNewSession: freshIsNewSession,
            rotatedSessionId: freshRotatedSessionId,
            usableRequestedSessionId: freshUsableRequestedSessionId,
            freshness: freshFreshness,
          };
        };
        let patchBuild = buildSessionPatch(entry);
        isNewSession = patchBuild.isNewSession;
        rotatedSessionId = patchBuild.rotatedSessionId;
        usableRequestedSessionId = patchBuild.usableRequestedSessionId;
        freshness = patchBuild.freshness;
        sessionEntry = mergeSessionEntry(entry, patchBuild.patch);
        resolvedSessionId = sessionEntry?.sessionId ?? sessionId;
        admittedSessionId = resolvedSessionId ?? runId;
        const canonicalSessionKey = canonicalKey;
        resolvedSessionKey = canonicalSessionKey;
        const sessionAgentId = canonicalSessionAgentId;
        resolvedSessionAgentId = sessionAgentId;
        const mainSessionKey = mainSessionKeyForRequest;
        try {
          await acquireGatewayWorkAdmission(storePath ?? `agent:${sessionAgentId}`);
        } catch (err) {
          respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
          return;
        }
        if (respondToGatewayAdmissionOutcome()) {
          return;
        }
        // Legacy stores may lack sessionStartedAt entirely. Pre-compute a
        // JSONL-transcript-derived candidate outside the store lock; the
        // updater below only writes it when the freshly-loaded store still
        // lacks the field, so a concurrent writer that sets it cannot be
        // clobbered (the #5369 stale-writeback class).
        const recoveredSessionStartedAt: number | undefined =
          !isNewSession && entry !== undefined && entry.sessionStartedAt === undefined
            ? resolveSessionLifecycleTimestamps({
                entry,
                storePath,
                agentId: sessionAgentId,
              }).sessionStartedAt
            : undefined;
        if (storePath && !suppressVisibleSessionEffects) {
          if (abortForLifecycleRotation({ sessionKey: canonicalSessionKey, agentId })) {
            return;
          }
          const requestedStoreKey = requestedSessionKey;
          let deniedBySendPolicy = false;
          let singleEntryPersistence:
            | {
                sessionKey: string;
                entry: SessionEntry;
              }
            | undefined;
          let persisted: SessionEntry | undefined;
          let archivedDuringStoreUpdateError: string | undefined;
          let deletedDuringStoreUpdateError: string | undefined;
          try {
            persisted = await updateSessionStore(
              storePath,
              (store) => {
                // The writer lock may outlive this request's lifecycle. Check at
                // transaction admission; once admitted, let the atomic write finish.
                assertAgentRunLifecycleGenerationCurrent(lifecycleGeneration);
                const storeKeysBeforeMigration = new Set(Object.keys(store));
                const preMigrationTarget = resolveGatewaySessionStoreTarget({
                  cfg: cfgLocal,
                  key: requestedStoreKey,
                  store,
                  ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
                });
                const preMigrationEntry = resolveFreshestSessionEntryFromStoreKeys(
                  store,
                  preMigrationTarget.storeKeys,
                );
                const initialTarget = resolveGatewaySessionStoreTarget({
                  cfg: cfgLocal,
                  key: canonicalSessionKey,
                  store,
                  ...(sessionAgentId ? { agentId: sessionAgentId } : {}),
                });
                const initialEntry = resolveFreshestSessionEntryFromStoreKeys(
                  store,
                  initialTarget.storeKeys,
                );
                // A completed delete must win over this request's earlier read;
                // otherwise the initial touch would recreate the removed row.
                // The row counts as deleted only when both the requested and
                // canonical alias sets miss it: exec-approval followups read
                // under the canonical key while legacy stores may only carry
                // the requested spelling (e.g. bare "main").
                if (entry && !preMigrationEntry && !initialEntry) {
                  deletedDuringStoreUpdateError = `Session "${canonicalSessionKey}" was deleted while starting work. Retry.`;
                  throw new Error(deletedDuringStoreUpdateError);
                }
                const archivedError = resolveSessionWorkStartError(
                  preMigrationTarget.canonicalKey,
                  preMigrationEntry,
                );
                if (archivedError) {
                  archivedDuringStoreUpdateError = archivedError;
                  throw new Error(archivedError);
                }
                const hadLegacyStoreKey = preMigrationTarget.storeKeys.some(
                  (storeKey) =>
                    storeKey !== preMigrationTarget.canonicalKey && Object.hasOwn(store, storeKey),
                );
                const { target, primaryKey } = migrateAndPruneGatewaySessionStoreKey({
                  cfg: cfgLocal,
                  key: requestedStoreKey,
                  store,
                });
                const prunedStoreKey = [...storeKeysBeforeMigration].some(
                  (storeKey) => !Object.hasOwn(store, storeKey),
                );
                const freshEntry = store[primaryKey];
                if (restoredCronContinuationIdentity) {
                  const marker = freshEntry?.cronRunContinuation;
                  const provider = normalizeOptionalString(freshEntry?.modelProvider);
                  const model = normalizeOptionalString(freshEntry?.model);
                  const identityMatches =
                    marker?.phase === "ready" &&
                    marker.basePersisted === true &&
                    marker.lifecycleRevision ===
                      restoredCronContinuationIdentity.lifecycleRevision &&
                    freshEntry?.sessionId === restoredCronContinuationIdentity.sessionId;
                  if (!identityMatches || !freshEntry || !provider || !model) {
                    restoredCronContinuationError =
                      "cron run continuation changed before admission";
                    throw new Error(restoredCronContinuationError);
                  }
                  if (
                    !cronContinuationHasReusableRuntime({
                      cfg: cfgLocal,
                      entry: freshEntry,
                      agentId: canonicalSessionAgentId,
                      provider,
                      model,
                    })
                  ) {
                    restoredCronContinuationError =
                      "cron run continuation has no reusable native CLI session";
                    throw new Error(restoredCronContinuationError);
                  }
                  restoredCronContinuation = {
                    ...restoredCronContinuationIdentity,
                    provider,
                    model,
                    ...(freshEntry.thinkingLevel ? { thinking: freshEntry.thinkingLevel } : {}),
                    ...(marker.toolsAllow !== undefined
                      ? { toolsAllow: [...marker.toolsAllow] }
                      : {}),
                    ...(marker.toolsAllowIsDefault === true ? { toolsAllowIsDefault: true } : {}),
                    ...(marker.cliSessionBindingFacts
                      ? { cliSessionBindingFacts: { ...marker.cliSessionBindingFacts } }
                      : {}),
                  };
                  freshEntry.cronRunContinuation = {
                    ...marker,
                    phase: "continuing",
                    ownerRunId: runId,
                    ownerLifecycleGeneration: lifecycleGeneration,
                  };
                  cronContinuationClaim = {
                    storePath,
                    sessionKey: primaryKey,
                    lifecycleRevision: marker.lifecycleRevision,
                    initialEntry: structuredClone(freshEntry),
                    mediaTaskIdsBefore: getGeneratedMediaTaskIdsForSessionKey(primaryKey),
                  };
                }
                patchBuild = buildSessionPatch(freshEntry);
                const effectivePatch =
                  recoveredSessionStartedAt !== undefined &&
                  freshEntry?.sessionStartedAt === undefined &&
                  freshEntry?.sessionId === entry?.sessionId
                    ? {
                        ...patchBuild.patch,
                        sessionStartedAt: recoveredSessionStartedAt,
                        continuationTraceparent: undefined,
                      }
                    : { ...patchBuild.patch, continuationTraceparent: undefined };
                const merged = mergeSessionEntry(freshEntry, effectivePatch);
                const sendPolicy =
                  request.deliver === true
                    ? resolveSendPolicy({
                        cfg: cfgLocal,
                        entry: merged,
                        sessionKey: canonicalKey,
                        channel: merged?.channel,
                        chatType: merged?.chatType,
                      })
                    : "allow";
                if (sendPolicy === "deny") {
                  deniedBySendPolicy = true;
                  return merged;
                }
                store[primaryKey] = merged;
                const canonicalKeyChanged = target.canonicalKey !== preMigrationTarget.canonicalKey;
                singleEntryPersistence =
                  freshEntry && !hadLegacyStoreKey && !canonicalKeyChanged && !prunedStoreKey
                    ? {
                        sessionKey: primaryKey,
                        entry: merged,
                      }
                    : undefined;
                return merged;
              },
              {
                takeCacheOwnership: true,
                ...(restoredCronContinuationIdentity
                  ? { activeSessionKey: canonicalSessionKey, requireWriteSuccess: true }
                  : {}),
                maintenanceConfig: sessionMaintenanceConfig,
                resolveSingleEntryPersistence: () => singleEntryPersistence,
              },
            );
          } catch (err) {
            if (abortForLifecycleRotation({ sessionKey: canonicalSessionKey, agentId })) {
              return;
            }
            if (archivedDuringStoreUpdateError) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.INVALID_REQUEST, archivedDuringStoreUpdateError),
              );
              return;
            }
            if (deletedDuringStoreUpdateError) {
              respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
              return;
            }
            if (restoredCronContinuationError) {
              respond(
                false,
                undefined,
                errorShape(ErrorCodes.UNAVAILABLE, restoredCronContinuationError),
              );
              return;
            }
            throw err;
          }
          if (persisted) {
            sessionEntry = persisted;
            resolvedSessionId = sessionEntry.sessionId;
            sessionPersistedBeforeGatewayAdmission = true;
          }
          if (
            patchBuild.isNewSession &&
            entry?.sessionId &&
            resolvedSessionId !== entry.sessionId
          ) {
            supersededSessionId = entry.sessionId;
          }
          admittedSessionId = resolvedSessionId ?? runId;
          try {
            assertGatewayWorkAdmissionAllowed();
          } catch (err) {
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
            return;
          }
          if (respondToGatewayAdmissionOutcome()) {
            return;
          }
          if (abortForLifecycleRotation({ sessionKey: canonicalSessionKey, agentId })) {
            return;
          }
          skipAgentInitialSessionTouch = touchInteraction;
          if (deniedBySendPolicy) {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
            );
            return;
          }
        }
        isNewSession = patchBuild.isNewSession;
        rotatedSessionId = patchBuild.rotatedSessionId;
        usableRequestedSessionId = patchBuild.usableRequestedSessionId;
        freshness = patchBuild.freshness;
        spawnedByValue = patchBuild.spawnedBy;
        resolvedGroupId = patchBuild.groupId;
        resolvedGroupChannel = patchBuild.groupChannel;
        resolvedGroupSpace = patchBuild.groupSpace;
        if (isNewSession && entry?.sessionId && resolvedSessionId !== entry.sessionId) {
          supersededSessionId = entry.sessionId;
        }
        if (
          !suppressVisibleSessionEffects &&
          isNewSession &&
          resolvedSessionId &&
          storePath &&
          !patchBuild.freshSessionRotatedSinceLoad
        ) {
          const previousSessionId = rotatedSessionId ? entry?.sessionId : undefined;
          const sessionLifecycleTransition: AgentSendSessionLifecycleTransition = {
            cfg: cfgLocal,
            sessionKey: canonicalSessionKey,
            sessionId: resolvedSessionId,
            storePath,
            sessionFile: sessionEntry?.sessionFile,
            agentId: sessionAgentId,
            previousSessionId,
            previousSessionFile: previousSessionId ? entry?.sessionFile : undefined,
            previousEndReason: previousSessionId
              ? (freshness?.staleReason ??
                (usableRequestedSessionId && entry?.sessionId !== usableRequestedSessionId
                  ? "new"
                  : "unknown"))
              : undefined,
          };
          emitAgentSendSessionLifecycleTransition(sessionLifecycleTransition);
        }
        if (request.deliver === true) {
          const sendPolicy = resolveSendPolicy({
            cfg: cfgLocal,
            entry: sessionEntry,
            sessionKey: canonicalKey,
            channel: sessionEntry?.channel,
            chatType: sessionEntry?.chatType,
          });
          if (sendPolicy === "deny") {
            respond(
              false,
              undefined,
              errorShape(ErrorCodes.INVALID_REQUEST, "send blocked by session policy"),
            );
            return;
          }
        }
        if (
          !suppressVisibleSessionEffects &&
          (canonicalSessionKey === mainSessionKey || canonicalSessionKey === "global")
        ) {
          const selectedGlobalAgentId =
            canonicalSessionKey === "global" ? sessionAgentId : undefined;
          pendingChatRun = {
            sessionKey: canonicalSessionKey,
            ...(selectedGlobalAgentId ? { agentId: selectedGlobalAgentId } : {}),
          };
          if (requestedBestEffortDeliver === undefined) {
            bestEffortDeliver = true;
          }
        }
      }

      const activeSessionAgentId =
        resolvedSessionKey === "global" && resolvedSessionAgentId
          ? resolvedSessionAgentId
          : resolvedSessionKey
            ? resolveAgentIdFromSessionKey(resolvedSessionKey)
            : (agentId ?? resolveDefaultAgentId(cfgForAgent ?? cfg));

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
          const sameSession = active.sessionKey === resolvedSessionKey;
          const sameSelectedGlobalAgent =
            resolvedSessionKey === "global" ? active.agentId === activeSessionAgentId : true;
          if (activeRunId !== runId && sameSession && sameSelectedGlobalAgent) {
            context.registerToolEventRecipient(activeRunId, connId);
          }
        }
      }

      const wantsDelivery = request.deliver === true;
      const explicitTo = replyTo || to || undefined;
      const explicitThreadId = normalizeOptionalString(recipientThreadId);
      const turnSourceChannel = normalizeOptionalString(recipientChannel);
      const turnSourceTo = to || undefined;
      const turnSourceAccountId = normalizeOptionalString(recipientAccountId);
      const deliveryPlan = await resolveAgentDeliveryPlanWithSessionRoute({
        cfg: cfgForAgent ?? cfg,
        agentId: activeSessionAgentId,
        currentSessionKey: resolvedSessionKey,
        sessionEntry,
        requestedChannel: request.replyChannel ?? recipientChannel,
        explicitTo,
        explicitThreadId,
        accountId: request.replyAccountId ?? recipientAccountId,
        wantsDelivery,
        turnSourceChannel,
        turnSourceTo,
        turnSourceAccountId,
        turnSourceThreadId: explicitThreadId,
      });

      let resolvedChannel = deliveryPlan.resolvedChannel;
      let deliveryTargetMode = deliveryPlan.deliveryTargetMode;
      const resolvedAccountId = deliveryPlan.resolvedAccountId;
      let resolvedTo = deliveryPlan.resolvedTo;
      let effectivePlan = deliveryPlan;
      let deliveryDowngradeReason: string | null = null;
      let deliveryTargetResolutionError: Error | undefined = deliveryPlan.targetResolutionError;

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
            respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
            return;
          }
          deliveryDowngradeReason = String(err);
        }
      }

      if (wantsDelivery && deliveryTargetResolutionError) {
        if (!bestEffortDeliver) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, String(deliveryTargetResolutionError)),
          );
          return;
        }
        deliveryDowngradeReason = String(deliveryTargetResolutionError);
        resolvedChannel = INTERNAL_MESSAGE_CHANNEL;
        deliveryTargetMode = undefined;
        resolvedTo = undefined;
        effectivePlan = {
          ...deliveryPlan,
          resolvedChannel,
          resolvedTo,
          deliveryTargetMode,
        };
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
        } else if (fallback.resolvedTarget && !fallback.resolvedTarget.ok) {
          deliveryTargetResolutionError = fallback.resolvedTarget.error;
        }
      }

      if (wantsDelivery && isDeliverableMessageChannel(resolvedChannel) && !resolvedTo) {
        if (!bestEffortDeliver) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              deliveryTargetResolutionError
                ? String(deliveryTargetResolutionError)
                : `delivery target is required for ${resolvedChannel}: pass --to/--reply-to or configure a default target`,
            ),
          );
          return;
        }
        context.logGateway.info(
          deliveryTargetResolutionError
            ? `agent delivery target missing (bestEffortDeliver): ${String(deliveryTargetResolutionError)}`
            : "agent delivery target missing (bestEffortDeliver): no deliverable target",
        );
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
        normalizedTurnSource && isKnownGatewayChannel(normalizedTurnSource)
          ? normalizedTurnSource
          : undefined;
      const originMessageChannel =
        turnSourceMessageChannel ??
        (client?.connect && isWebchatConnect(client.connect)
          ? INTERNAL_MESSAGE_CHANNEL
          : resolvedChannel);

      const deliver = request.deliver === true && resolvedChannel !== INTERNAL_MESSAGE_CHANNEL;

      const preRegistrationAbort = readGatewayDedupeEntry({
        dedupe: context.dedupe,
        keys: agentDedupeKeys,
      });
      if (
        isPreRegistrationAbortedAgentDedupeEntryForSession({
          entry: preRegistrationAbort,
          runId,
          sessionKey: resolvedSessionKey,
          alternateSessionKeys: [preAcceptedReservedSessionKey, requestedSessionKey],
        })
      ) {
        agentRunAccepted = true;
        respond(true, preRegistrationAbort?.payload, undefined, {
          cached: true,
          runId,
        });
        return;
      }
      if (
        abortForLifecycleRotation({
          sessionKey: resolvedSessionKey,
          agentId: resolvedSessionKey === "global" ? activeSessionAgentId : undefined,
        })
      ) {
        return;
      }

      // Register before the accepted ack so an immediate chat.abort/sessions.abort
      // cannot race the active-run entry. Agent RPC runs use the agent timeout;
      // chat.send keeps the shorter chat cleanup cap.
      const now = Date.now();
      if (restoredCronContinuationIdentity && !restoredCronContinuation) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.UNAVAILABLE, "cron run continuation could not be restored"),
        );
        return;
      }
      const timeoutMs = resolveAgentTimeoutMs({
        cfg: cfgForAgent ?? cfg,
        overrideSeconds: typeof request.timeout === "number" ? request.timeout : undefined,
      });
      const effectiveProviderOverride = restoredCronContinuation?.provider ?? providerOverride;
      const effectiveModelOverride = restoredCronContinuation?.model ?? modelOverride;
      const effectiveThinking = restoredCronContinuation
        ? restoredCronContinuation.thinking
        : request.thinking;
      const effectiveAllowModelOverride =
        allowModelOverride || restoredCronContinuation !== undefined;
      const restoredCronContinuationLifecycleRevision = restoredCronContinuation?.lifecycleRevision;
      const activeModelProvider =
        effectiveProviderOverride ??
        resolveSessionModelRef(cfgForAgent ?? cfg, sessionEntry, activeSessionAgentId).provider;
      const activeAuthProvider = resolveProviderIdForAuth(activeModelProvider, {
        config: cfgForAgent ?? cfg,
      });
      const lifecycleStorePath = resolvedSessionKey
        ? loadSessionEntry(resolvedSessionKey, {
            ...(resolvedSessionKey === "global" ? { agentId: activeSessionAgentId } : {}),
            clone: false,
          }).storePath
        : `agent:${activeSessionAgentId}`;
      try {
        await acquireGatewayWorkAdmission(lifecycleStorePath);
        assertGatewayWorkAdmissionAllowed();
        const hasAdmissionOutcome = Boolean(
          postAdmissionAbort ||
          postAdmissionTimeout ||
          postAdmissionSuperseded ||
          lifecycleRotatedDuringAdmission,
        );
        if (!hasAdmissionOutcome) {
          admittedRunAbort = registerChatAbortController({
            chatAbortControllers: context.chatAbortControllers,
            runId,
            sessionId: admittedSessionId,
            sessionKey: resolvedSessionKey,
            agentId: admissionAgentId(),
            timeoutMs,
            now,
            expiresAtMs: resolveAgentRunExpiresAtMs({ now, timeoutMs }),
            ownerConnId,
            ownerDeviceId,
            providerId: activeModelProvider,
            authProviderId: activeAuthProvider,
            isAbortable: () => isEmbeddedAgentRunAbortableForRunId(runId),
            onRemoved: () => clearEmbeddedAgentRunAbortabilityForRunId(runId),
            controlUiVisible: !suppressVisibleSessionEffects,
            kind: "agent",
            lifecycleGeneration,
          });
        }
      } catch (err) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, formatForLog(err)));
        return;
      }
      if (respondToGatewayAdmissionOutcome()) {
        return;
      }
      const activeGatewayWorkAdmission = gatewayWorkAdmission;
      if (!activeGatewayWorkAdmission) {
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"));
        return;
      }
      const activeRunAbort = admittedRunAbort;
      if (!activeRunAbort) {
        activeGatewayWorkAdmission.release();
        respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "agent run admission failed"));
        return;
      }
      resolvedSessionId = admittedSessionId;
      const existingRunAbort = context.chatAbortControllers.get(runId);
      if (!activeRunAbort.registered && existingRunAbort) {
        activeGatewayWorkAdmission.release();
        agentRunAccepted = existingRunAbort.kind === "agent";
        respond(true, { runId, status: "in_flight" as const }, undefined, {
          cached: true,
          runId,
        });
        return;
      }
      if (!activeRunAbort.registered) {
        activeGatewayWorkAdmission.release();
      }
      let releaseGatewayRootContinuation: (() => void) | undefined;
      const cleanupAdmittedRun: typeof activeRunAbort.cleanup = (options) => {
        activeRunAbort.cleanup(options);
        activeGatewayWorkAdmission.release();
        releaseGatewayRootContinuation?.();
        releaseGatewayRootContinuation = undefined;
      };
      if (activeRunAbort.registered) {
        retainEmbeddedAgentRunAbortabilityForRunId(runId);
        if (pendingChatRun) {
          context.addChatRun(runId, {
            ...pendingChatRun,
            clientRunId: runId,
          });
        }
        if (resolvedSessionKey) {
          claimAgentRunContext(
            runId,
            suppressVisibleSessionEffects
              ? { isControlUiVisible: false, lifecycleGeneration }
              : {
                  sessionKey: resolvedSessionKey,
                  lifecycleGeneration,
                },
          );
        }
      }

      const resolvedThreadId = explicitThreadId ?? deliveryPlan.resolvedThreadId;
      // Confirmed only when the caller is the trusted in-process backend ACP
      // spawn client, the turn is an ACP manual spawn, the canonical session key
      // is ACP-shaped, and persisted ACP metadata exists for it; the spawn
      // control plane owns that childRunId's `acp` task row in those cases.
      const confirmedAcpManualSpawn = isConfirmedAcpManualSpawnTaskOwner({
        acpTurnSource: request.acpTurnSource,
        sessionKey: resolvedSessionKey,
        client,
        logGateway: context.logGateway,
      });
      const taskTrackingMode = resolveGatewayAgentTaskTrackingMode({
        client,
        sessionKey: resolvedSessionKey,
        inputProvenance,
        confirmedAcpManualSpawn,
        modelRun: isOneShotModelRun,
      });
      let dispatchTaskTrackingMode: Exclude<GatewayAgentTaskTrackingMode, "plugin_subagent"> =
        taskTrackingMode === "cli" ? "cli" : "none";
      if (taskTrackingMode === "plugin_subagent" && resolvedSessionKey) {
        try {
          await registerPluginSubagentRunFromGateway({
            cfg,
            runId,
            childSessionKey: resolvedSessionKey,
            task: request.message.trim(),
            requesterOrigin: normalizeDeliveryContext({
              channel: resolvedChannel,
              to: resolvedTo,
              accountId: resolvedAccountId,
              threadId: resolvedThreadId,
            }),
            pluginId: normalizeOptionalString(client?.internal?.pluginRuntimeOwnerId),
          });
        } catch (err) {
          context.logGateway.warn(
            `failed to register plugin subagent run ${runId}; falling back to cli task tracking: ${formatForLog(
              err,
            )}`,
          );
          dispatchTaskTrackingMode = "cli";
        }
      }

      const accepted = {
        runId,
        sessionKey: resolvedSessionKey,
        ...(resolvedSessionKey === "global" ? { agentId: activeSessionAgentId } : {}),
        status: "accepted" as const,
        acceptedAt: Date.now(),
      };
      const acceptedDedupePayload = {
        ...accepted,
        controlUiVisible: !suppressVisibleSessionEffects,
        dedupeKeys: agentDedupeKeys,
        ownerConnId,
        ownerDeviceId,
      };
      agentRunAccepted = true;
      // Store an in-flight ack so retries do not spawn a second run.
      setGatewayDedupeEntries({
        dedupe: context.dedupe,
        keys: agentDedupeKeys,
        entry: {
          ts: Date.now(),
          ok: true,
          payload: acceptedDedupePayload,
        },
      });
      respond(true, accepted, undefined, { runId });
      // Give the accepted frame one event-loop turn to flush before the runner
      // starts potentially heavy synchronous prompt/context setup. The dispatch
      // is scheduled out of this request handler so immediate agent.wait calls
      // can reach the gateway before the pre-turn runner monopolizes the loop.
      gatewayAdmissionTransferred = true;
      // Reserve the detached run before this request releases its root. Otherwise
      // its inherited ALS context becomes retired and rejects subordinate work.
      releaseGatewayRootContinuation = retainGatewayRootWorkAdmissionContinuation() ?? undefined;
      void activeGatewayWorkAdmission.run(async () => {
        await yieldAfterAgentAcceptedAck();

        let dispatched = false;
        try {
          if (activeRunAbort.controller.signal.aborted) {
            const stopReason = resolveAbortedAgentStopReason(activeRunAbort.entry);
            setAbortedAgentDedupeEntries({
              dedupe: context.dedupe,
              keys: agentDedupeKeys,
              agentId: resolvedSessionKey === "global" ? activeSessionAgentId : undefined,
              runId,
              stopReason,
            });
            respond(
              true,
              {
                runId,
                status: "timeout" as const,
                summary: "aborted",
                stopReason,
                timeoutPhase: "queue" as const,
                providerStarted: false,
              },
              undefined,
              { runId },
            );
            return;
          }

          if (!isOneShotModelRun && resolvedSessionKey) {
            await reactivateCompletedSubagentSession({
              sessionKey: resolvedSessionKey,
              runId,
              task: message,
            });
          }

          if (
            !suppressVisibleSessionEffects &&
            requestedSessionKey &&
            resolvedSessionKey &&
            isNewSession
          ) {
            emitSessionsChanged(context, {
              sessionKey: resolvedSessionKey,
              ...(resolvedSessionKey === "global" ? { agentId: activeSessionAgentId } : {}),
              reason: "create",
            });
          }
          if (!suppressVisibleSessionEffects && resolvedSessionKey) {
            emitSessionsChanged(context, {
              sessionKey: resolvedSessionKey,
              ...(resolvedSessionKey === "global" ? { agentId: activeSessionAgentId } : {}),
              reason: "send",
            });
          }

          if (!isRawModelRun) {
            message = annotateInterSessionPromptText(message, inputProvenance);
          }

          const ingressAgentId =
            resolvedSessionKey === "global"
              ? activeSessionAgentId
              : agentId &&
                  (!resolvedSessionKey ||
                    resolveAgentIdFromSessionKey(resolvedSessionKey) === agentId)
                ? agentId
                : undefined;
          let execApprovalFollowupRuntimeHandoff =
            canUseInternalRuntimeHandoff && execApprovalFollowupApprovalId
              ? consumeExecApprovalFollowupRuntimeHandoff({
                  handoffId: request.internalRuntimeHandoffId,
                  approvalId: execApprovalFollowupApprovalId,
                  idempotencyKey: idem,
                  sessionKey: resolvedSessionKey,
                })
              : undefined;
          if (
            !execApprovalFollowupRuntimeHandoff &&
            canUseInternalRuntimeHandoff &&
            execApprovalFollowupApprovalId &&
            requestedSessionKeyRaw &&
            requestedSessionKeyRaw !== resolvedSessionKey
          ) {
            execApprovalFollowupRuntimeHandoff = consumeExecApprovalFollowupRuntimeHandoff({
              handoffId: request.internalRuntimeHandoffId,
              approvalId: execApprovalFollowupApprovalId,
              idempotencyKey: idem,
              sessionKey: requestedSessionKeyRaw,
            });
          }
          const execApprovalFollowupElevatedDefaults =
            execApprovalFollowupRuntimeHandoff?.bashElevated;
          const subagentTraceparentHandoff = consumeSubagentTraceparentHandoff({
            idempotencyKey: idem,
            sessionKey: resolvedSessionKey,
          })?.traceparent;
          const trustedContinuationRuntimeHandoff =
            canUseInternalRuntimeHandoff || Boolean(subagentTraceparentHandoff);
          const inheritedTraceparent =
            (canUseInternalRuntimeHandoff ? request.traceparent : undefined) ??
            subagentTraceparentHandoff ??
            sessionContinuationTraceparent;

          dispatchAgentRunFromGateway({
            ingressOpts: {
              message,
              images,
              imageOrder,
              agentId: ingressAgentId,
              provider: effectiveProviderOverride,
              model: effectiveModelOverride,
              to: resolvedTo,
              sessionId: resolvedSessionId,
              sessionKey: resolvedSessionKey,
              thinking: effectiveThinking,
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
              ...(execApprovalFollowupElevatedDefaults
                ? { bashElevated: execApprovalFollowupElevatedDefaults }
                : {}),
              groupId: resolvedGroupId,
              groupChannel: resolvedGroupChannel,
              groupSpace: resolvedGroupSpace,
              spawnedBy: spawnedByValue,
              timeout: request.timeout?.toString(),
              bestEffortDeliver,
              messageChannel: originMessageChannel,
              runId,
              lane: request.lane,
              modelRun: request.modelRun === true,
              promptMode: request.promptMode,
              extraSystemPrompt: request.extraSystemPrompt,
              bootstrapContextMode: request.bootstrapContextMode,
              bootstrapContextRunKind: effectiveBootstrapContextRunKind,
              toolsAllow: restoredCronContinuation?.toolsAllow,
              toolsAllowIsDefault: restoredCronContinuation?.toolsAllowIsDefault,
              requireExplicitMessageTarget:
                restoredCronContinuation?.cliSessionBindingFacts?.requireExplicitMessageTarget,
              cliSessionBindingFacts: restoredCronContinuation?.cliSessionBindingFacts,
              acpTurnSource: request.acpTurnSource,
              internalEvents: request.internalEvents,
              inputProvenance,
              senderIsOwner: restoredCronContinuation ? true : clientHasAdminScope(client),
              sessionEffects,
              skipInitialSessionTouch: skipAgentInitialSessionTouch,
              preserveUserFacingSessionModelState:
                preserveUserFacingSessionModelState && !restoredCronContinuation,
              sourceReplyDeliveryMode: restoredCronContinuation
                ? restoredCronContinuation.cliSessionBindingFacts?.sourceReplyDeliveryMode
                : request.sourceReplyDeliveryMode,
              disableMessageTool: request.disableMessageTool,
              suppressPromptPersistence:
                requestedPromptPersistenceSuppression ||
                shouldSuppressAgentPromptPersistence({
                  inputProvenance,
                  internalEvents: request.internalEvents,
                }),
              cleanupBundleMcpOnRunEnd: request.cleanupBundleMcpOnRunEnd,
              // Internal continuation controls: reserved for backend callers.
              // These fields are stripped from the public generated schema, but
              // raw RPC clients can still set them. Ignore them for non-backend
              // clients so an ordinary caller cannot force continuation
              // queue-drain semantics or mark runs continuation/heartbeat-like.
              drainsContinuationDelegateQueue: trustedContinuationRuntimeHandoff
                ? request.drainsContinuationDelegateQueue
                : undefined,
              continuationTrigger: trustedContinuationRuntimeHandoff
                ? request.continuationTrigger
                : undefined,
              traceparent: inheritedTraceparent,
              abortSignal: activeRunAbort.controller.signal,
              lifecycleGeneration,
              onActiveModelSelected: async ({ provider, model }) => {
                updateChatRunProvider(context.chatAbortControllers, {
                  runId,
                  providerId: provider,
                  authProviderId: resolveProviderIdForAuth(provider, {
                    config: cfgForAgent ?? cfg,
                  }),
                });
                if (restoredCronContinuationLifecycleRevision && resolvedSessionKey) {
                  const persistedSelectedModel = await applySessionEntryReplacements({
                    activeSessionKey: resolvedSessionKey,
                    requireWriteSuccess: true,
                    sessionKeys: [resolvedSessionKey],
                    skipMaintenance: false,
                    storePath: lifecycleStorePath,
                    update: (entries) => {
                      const current = entries.find(
                        (entry) => entry.sessionKey === resolvedSessionKey,
                      )?.entry;
                      const marker = current?.cronRunContinuation;
                      if (
                        !current ||
                        marker?.phase !== "continuing" ||
                        marker.ownerRunId !== runId ||
                        marker.lifecycleRevision !== restoredCronContinuationLifecycleRevision
                      ) {
                        return { result: false };
                      }
                      const executionProvider =
                        resolveCliRuntimeExecutionProvider({
                          provider,
                          cfg: cfgForAgent ?? cfg,
                          agentId: activeSessionAgentId,
                          modelId: model,
                        }) ?? provider;
                      const cronRunContinuation = { ...marker };
                      if (isCliProvider(executionProvider, cfgForAgent ?? cfg)) {
                        cronRunContinuation.cliExecutionProvider = executionProvider;
                      } else {
                        delete cronRunContinuation.cliExecutionProvider;
                      }
                      return {
                        replacements: [
                          {
                            sessionKey: resolvedSessionKey,
                            entry: {
                              ...current,
                              cronRunContinuation,
                              modelProvider: provider,
                              model,
                              updatedAt: Date.now(),
                            },
                          },
                        ],
                        result: true,
                      };
                    },
                  });
                  if (!persistedSelectedModel) {
                    throw new Error("cron run continuation changed before model execution");
                  }
                }
              },
              onSessionIdChanged: (sessionId) => {
                if (activeRunAbort.entry) {
                  activeRunAbort.entry.sessionId = sessionId;
                }
              },
              // Internal-only: allow workspace override for spawned subagent runs.
              workspaceDir: resolveIngressWorkspaceOverrideForSessionRun({
                spawnedBy: spawnedByValue,
                workspaceDir: sessionEntry?.spawnedWorkspaceDir,
                cwd: sessionEntry?.spawnedCwd,
              }),
              cwd: resolveSessionRuntimeCwd({
                requestedCwd: request.cwd,
                sessionEntry,
              }),
              // Plugin tools created for Gateway-owned turns must resolve the live
              // Gateway subagent and node runtimes, not standalone placeholders.
              allowGatewaySubagentBinding: true,
              allowModelOverride: effectiveAllowModelOverride,
            },
            runId,
            dedupeKeys: agentDedupeKeys,
            abortController: activeRunAbort.controller,
            cleanupAbortController: cleanupAdmittedRun,
            onSettled: restoredCronContinuation
              ? async ({ terminalOutcome, onRecovered }) =>
                  await releaseCronContinuationClaimWithRecovery({ terminalOutcome }, onRecovered)
              : undefined,
            respond,
            context,
            taskTrackingMode: dispatchTaskTrackingMode,
          });
          dispatched = true;
        } catch (err) {
          const error = errorShape(ErrorCodes.UNAVAILABLE, formatForLog(err));
          const payload = {
            runId,
            status: "error" as const,
            summary: formatForLog(err),
          };
          setGatewayDedupeEntries({
            dedupe: context.dedupe,
            keys: agentDedupeKeys,
            entry: {
              ts: Date.now(),
              ok: false,
              payload,
              error,
            },
          });
          respond(false, payload, error, {
            runId,
            error: formatForLog(err),
          });
        } finally {
          if (!dispatched) {
            try {
              await releaseCronContinuationClaimWithRecovery();
            } finally {
              cleanupAdmittedRun({ force: true });
            }
          }
        }
      });
    } finally {
      if (!gatewayAdmissionTransferred) {
        gatewayWorkAdmission?.release();
        await releaseCronContinuationClaimWithRecovery();
      }
      clearUnacceptedAgentDedupe();
    }
  },
  "agent.identity.get": ({ params, respond, context }) => {
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
    const cfg = context.getRuntimeConfig();
    const identity = resolveAssistantIdentity({ cfg, agentId });
    const avatarProjection = resolveGatewayAssistantAvatar({ cfg, identity });
    const avatarResolution = avatarProjection.resolution;
    respond(
      true,
      {
        ...identity,
        avatar: avatarProjection.avatar,
        avatarSource: avatarResolution
          ? resolvePublicAgentAvatarSource(avatarResolution)
          : undefined,
        avatarStatus: avatarResolution?.kind,
        avatarReason: avatarResolution?.kind === "none" ? avatarResolution.reason : undefined,
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
        stopReason: cachedGatewaySnapshot.stopReason,
        livenessState: cachedGatewaySnapshot.livenessState,
        yielded: cachedGatewaySnapshot.yielded,
        pendingError: cachedGatewaySnapshot.pendingError,
        timeoutPhase: cachedGatewaySnapshot.timeoutPhase,
        providerStarted: cachedGatewaySnapshot.providerStarted,
      });
      return;
    }

    const lifecycleAbortController = new AbortController();
    const dedupeAbortController = new AbortController();
    const dedupePromise = waitForTerminalGatewayDedupe({
      dedupe: context.dedupe,
      runId,
      timeoutMs,
      signal: dedupeAbortController.signal,
      ignoreAgentTerminalSnapshot: hasActiveChatRun,
    });

    if (hasActiveChatRun) {
      const snapshot = await dedupePromise;
      dedupeAbortController.abort();
      if (!snapshot) {
        respond(true, {
          runId,
          status: "timeout",
          timeoutPhase: "gateway_draining",
        });
        return;
      }
      respond(true, {
        runId,
        status: snapshot.status,
        startedAt: snapshot.startedAt,
        endedAt: snapshot.endedAt,
        error: snapshot.error,
        stopReason: snapshot.stopReason,
        livenessState: snapshot.livenessState,
        yielded: snapshot.yielded,
        pendingError: snapshot.pendingError,
        timeoutPhase: snapshot.timeoutPhase,
        providerStarted: snapshot.providerStarted,
      });
      return;
    }

    const lifecyclePromise = waitForAgentJob({
      runId,
      timeoutMs,
      signal: lifecycleAbortController.signal,
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
      const activeRunRegistered = activeChatEntry !== undefined;
      respond(true, {
        runId,
        status: "timeout",
        timeoutPhase: activeRunRegistered ? "gateway_draining" : "queue",
        ...(activeRunRegistered ? {} : { providerStarted: false }),
      });
      return;
    }
    respond(true, {
      runId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      endedAt: snapshot.endedAt,
      error: snapshot.error,
      stopReason: snapshot.stopReason,
      livenessState: snapshot.livenessState,
      yielded: snapshot.yielded,
      pendingError: snapshot.pendingError,
      timeoutPhase: snapshot.timeoutPhase,
      providerStarted: snapshot.providerStarted,
    });
  },
};
