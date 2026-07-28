import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  GATEWAY_CLIENT_MODES,
  GATEWAY_CLIENT_NAMES,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { readAcpSessionMeta } from "../../acp/runtime/session-meta.js";
import { isTimeoutError } from "../../agents/failover-error.js";
import { resolveAgentIdFromSessionKey, resolveAgentMainSessionKey } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { isAcpSessionKey } from "../../routing/session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import {
  parseRawSessionConversationRef,
  parseThreadSessionSuffix,
} from "../../sessions/session-key-utils.js";
import { finalizeTaskRunByRunId } from "../../tasks/detached-task-runtime.js";
import type { TaskStatus } from "../../tasks/task-registry.types.js";
import type { DeliveryContext } from "../../utils/delivery-context.shared.js";
import { formatForLog } from "../ws-log.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

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

export function resolveFailedTrackedAgentTaskStatus(
  error: unknown,
): GatewayAgentTaskTerminalStatus {
  return isAbortError(error) || isTimeoutError(error) ? "timed_out" : "failed";
}

export function tryFinalizeTrackedAgentTask(params: {
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
