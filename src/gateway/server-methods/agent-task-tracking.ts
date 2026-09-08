import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { getLatestLiveSubagentRunByChildSessionKey } from "../../agents/subagents/registry/subagent-registry-read.js";
import { resolveAgentIdFromSessionKey, resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginSubagentRequesterContext } from "../../plugins/runtime/subagent-requester-context.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { finalizeTaskRunByRunId } from "../../tasks/detached-task-runtime.js";
import { findTaskByRunId } from "../../tasks/runtime-internal.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import { formatForLog } from "../ws-log.js";
import type {
  GatewayContextResolver,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
} from "./types.js";

export type TrustedGroupMetadata = {
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
};

export function normalizeTrustedGroupMetadata(value?: {
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

export function resolveTrustedGroupMetadata(params: {
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

export function requestGroupMatchesTrusted(params: {
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
export type GatewayAgentTaskTrackingMode = "cli" | "plugin_subagent" | "none";

export function resolveGatewayAgentTaskTrackingMode(params: {
  client: GatewayRequestHandlerOptions["client"];
  sessionKey?: string;
  inputProvenance?: InputProvenance;
  confirmedAcpManualSpawn?: boolean;
  modelRun?: boolean;
  runId?: string;
}): GatewayAgentTaskTrackingMode {
  // Model probes are stateless one-shot work. A terminal CLI task row would
  // outlive the probe even when its session/transcript effects are internal.
  if (params.modelRun === true) {
    return "none";
  }
  if (!params.sessionKey?.trim()) {
    return "none";
  }
  if (params.inputProvenance?.kind === "inter_session") {
    // Only the settlement batch owns automatic paused-run adoption. Individual
    // announcements and descendant wakes retain their own delivery lifecycle.
    const pausedYieldRun =
      params.inputProvenance.sourceTool === "subagent_settle" &&
      getLatestLiveSubagentRunByChildSessionKey(
        params.sessionKey.trim(),
        (entry) => entry.pauseReason === "sessions_yield",
      );
    return pausedYieldRun ? "plugin_subagent" : "none";
  }
  const runTaskOwner = params.client?.internal?.agentRunTracking;
  if (runTaskOwner === "plugin_subagent") {
    return "plugin_subagent";
  }
  // The subagent registry created the authoritative row before its host-owned
  // gateway dispatch. A CLI row here would represent the same run twice.
  const existingTask = params.runId ? findTaskByRunId(params.runId) : undefined;
  if (
    existingTask?.runtime === "subagent" &&
    existingTask.childSessionKey === params.sessionKey?.trim()
  ) {
    return "none";
  }
  // The native spawn control plane registers the canonical `subagent` row for
  // this same runId once the gateway returns, so tracking here would show one
  // run twice. The marker rides an internal synthetic client only.
  if (runTaskOwner === "native_subagent") {
    return "none";
  }
  // A confirmed ACP manual-spawn child turn already owns its requester-visible
  // `acp` task row from the spawn control plane (src/agents/subagents/spawn/acp-spawn.ts). The
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

export function isConfirmedAcpManualSpawnTaskOwner(params: {
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

export async function registerPluginSubagentRunFromGateway(params: {
  cfg: OpenClawConfig;
  runId: string;
  childSessionKey: string;
  task: string;
  requester?: PluginSubagentRequesterContext;
  pluginId?: string;
  gatewayContextResolver?: GatewayContextResolver;
}): Promise<void> {
  const childSessionKey = params.childSessionKey.trim();
  if (!childSessionKey) {
    return;
  }
  const ownerSessionKey = resolveAgentMainSessionKey({
    cfg: params.cfg,
    agentId: resolveAgentIdFromSessionKey(childSessionKey),
  });
  const requesterSessionKey = params.requester?.sessionKey ?? ownerSessionKey;
  const { adoptPausedSubagentRunForFollowUp, registerSubagentRun } =
    await import("../../agents/subagents/registry/subagent-registry.js");
  // A follow-up aimed at a session paused by sessions_yield continues that run.
  // Registering a sibling row here would reassign the requester to this agent's
  // own main session and leave the original requester waiting behind a row that
  // can no longer announce. A follow-up that names its own requester is opting
  // into its own delivery, so it registers normally rather than silently
  // inheriting the paused row's audience.
  if (
    !params.requester &&
    adoptPausedSubagentRunForFollowUp({
      childSessionKey,
      runId: params.runId,
      task: params.task,
      ...(params.gatewayContextResolver
        ? { gatewayContextResolver: params.gatewayContextResolver }
        : {}),
    })
  ) {
    return;
  }
  registerSubagentRun({
    runId: params.runId,
    childSessionKey,
    controllerSessionKey: ownerSessionKey,
    requesterSessionKey,
    requesterOrigin: params.requester?.origin,
    requesterDisplayKey: params.requester ? requesterSessionKey : "main",
    task: params.task,
    cleanup: "keep",
    ...(params.pluginId ? { label: `plugin:${params.pluginId}` } : {}),
    expectsCompletionMessage: params.requester !== undefined,
    spawnMode: "run",
    ...(params.gatewayContextResolver
      ? { gatewayContextResolver: params.gatewayContextResolver }
      : {}),
  });
}

export function tryFinalizeTrackedAgentTask(params: {
  runId: string;
  sessionKey?: string;
  status: GatewayAgentTaskTerminalStatus;
  error?: string;
  terminalSummary?: string;
  log: Pick<GatewayRequestContext["logGateway"], "warn">;
}): void {
  try {
    finalizeTaskRunByRunId({
      runId: params.runId,
      runtime: "cli",
      sessionKey: params.sessionKey,
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
