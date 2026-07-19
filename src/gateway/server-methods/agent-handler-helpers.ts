import { GATEWAY_CLIENT_MODES } from "../../../packages/gateway-protocol/src/client-info.js";
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import { getCliSessionBinding } from "../../agents/cli-session.js";
import { AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION } from "../../agents/internal-event-contract.js";
import type { AgentInternalEvent } from "../../agents/internal-events.js";
import { resolveCliRuntimeExecutionProvider } from "../../agents/model-runtime-aliases.js";
import { isCliProvider } from "../../agents/model-selection.js";
import {
  resolveAgentIdFromSessionKey,
  resolveSessionWorkStartError,
  type SessionEntry,
} from "../../config/sessions.js";
import { formatSqliteSessionFileMarker } from "../../config/sessions/sqlite-marker.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookSessionEndReason } from "../../plugins/hook-types.js";
import {
  AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE,
  resolveAgentHarnessSessionContextError,
  resolveAgentHarnessSessionIdMismatchError,
} from "../../sessions/agent-harness-session-key.js";
import type { InputProvenance } from "../../sessions/input-provenance.js";
import { setSafeTimeout } from "../../utils/timer-delay.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import {
  emitGatewaySessionEndPluginHook,
  emitGatewaySessionStartPluginHook,
} from "../session-reset-service.js";
import { loadSessionEntry, resolveDeletedAgentIdFromSessionKey } from "../session-utils.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

export const CRON_CONTINUATION_RELEASE_RECOVERY_DELAYS_MS = [250, 1_000, 4_000, 15_000] as const;

export type RestoredCronContinuation = {
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

export function clientHasAdminScope(client: GatewayRequestHandlerOptions["client"]): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return scopes.includes(ADMIN_SCOPE);
}

export function respondDeletedAgentSession(params: {
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
    { acpMetadataSessionKey: params.acpMetadataSessionKey ?? params.canonicalKey },
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

export function respondUnavailableAgentSessionForKey(params: {
  sessionKey: string;
  requestedSessionId?: string;
  isRawModelRun: boolean;
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
  const harnessSessionError = resolveAgentHarnessSessionContextError(canonicalKey, entry);
  if (harnessSessionError) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, harnessSessionError));
    return true;
  }
  const harnessSessionIdError = resolveAgentHarnessSessionIdMismatchError(
    entry,
    params.requestedSessionId,
  );
  if (harnessSessionIdError) {
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, harnessSessionIdError));
    return true;
  }
  if (params.isRawModelRun && entry?.modelSelectionLocked === true) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE),
    );
    return true;
  }
  const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
  if (!archivedSessionError) {
    return false;
  }
  params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
  return true;
}

export function resolveAllowModelOverrideFromClient(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return clientHasAdminScope(client) || client?.internal?.allowModelOverride === true;
}

export function resolveCanUseInternalRuntimeHandoff(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return client?.connect?.client?.mode === GATEWAY_CLIENT_MODES.BACKEND;
}

export function resolveCanUseCronRunContinuation(
  client: GatewayRequestHandlerOptions["client"],
): boolean {
  return client?.internal?.cronRunContinuation === true;
}

export function cronContinuationHasReusableRuntime(params: {
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

export function withoutCronRunContinuation(entry: SessionEntry): SessionEntry {
  const { cronRunContinuation: _cronRunContinuation, ...baseEntry } = entry;
  return baseEntry;
}

export function emitAgentSendSessionLifecycleTransition(
  transition:
    | {
        cfg: OpenClawConfig;
        sessionKey: string;
        sessionId: string;
        storePath: string;
        sessionFile?: string;
        agentId?: string;
        previousSessionId?: string;
        previousSessionFile?: string;
        previousEndReason?: PluginHookSessionEndReason;
      }
    | undefined,
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

export function shouldSuppressAgentPromptPersistence(params: {
  inputProvenance?: InputProvenance;
  internalEvents?: AgentInternalEvent[];
}): boolean {
  return (
    params.inputProvenance?.kind === "inter_session" &&
    params.inputProvenance.sourceTool === "subagent_announce" &&
    params.internalEvents?.some(
      (event) =>
        event.type === AGENT_INTERNAL_EVENT_TYPE_TASK_COMPLETION && event.source === "subagent",
    ) === true
  );
}

export function withSqliteSessionFileMarker(params: {
  agentId: string | undefined;
  entry: SessionEntry;
  sessionKey: string;
  storePath: string;
}): SessionEntry {
  const agentId = params.agentId ?? resolveAgentIdFromSessionKey(params.sessionKey);
  if (!agentId) {
    return params.entry;
  }
  const sessionFile = formatSqliteSessionFileMarker({
    agentId,
    sessionId: params.entry.sessionId,
    storePath: params.storePath,
  });
  return params.entry.sessionFile === sessionFile ? params.entry : { ...params.entry, sessionFile };
}

export function yieldAfterAgentAcceptedAck(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 10);
  });
}

export function waitForCronContinuationReleaseRecovery(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setSafeTimeout(resolve, delayMs);
    timer.unref?.();
  });
}
