import { performance } from "node:perf_hooks";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveProviderIdForAuth } from "../../agents/provider-auth-aliases.js";
import { resolveAgentTimeoutMs } from "../../agents/timeout.js";
import {
  resolveAgentMainSessionKey,
  resolveSessionRoutingContract,
} from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { measureDiagnosticsTimelineSpanSync } from "../../infra/diagnostics-timeline.js";
import { isIncognitoSessionKey } from "../../routing/session-key.js";
import { resolveMissingAgentHarnessSessionError } from "../../sessions/agent-harness-session-key.js";
import { isBrowserOperatorUiClient } from "../../utils/message-channel.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import {
  loadSessionEntry,
  resolveDeletedAgentIdFromSessionKey,
  resolveSessionModelRef,
} from "../session-utils.js";
import {
  hasGatewayAdminScope,
  resolveChatSendActiveScopeKey,
  resolveRequestedChatAgentId,
  validateChatSelectedAgent,
} from "./chat-origin-routing.js";
import { createRestartSafeChatRequest } from "./chat-restart-recovery.js";
import type { NormalizedChatSendRequest } from "./chat-send-request.js";
import { roundedChatSendTimingMs } from "./chat-server-timing.js";
import { normalizeOptionalChatText } from "./chat-text-normalization.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

function loadChatSendSessionContext(params: {
  request: NormalizedChatSendRequest;
  context: GatewayRequestHandlerOptions["context"];
}) {
  const { request, context } = params;
  const { p, explicitOrigin, normalizedAttachments } = request;
  const rawSessionKey = p.sessionKey;
  const agentIdOverride = normalizeOptionalChatText(p.agentId);
  const clientRunId = p.idempotencyKey;
  const pendingChatSendKey = pendingChatSendDedupeKey(clientRunId);
  const runtimeConfig = context.getRuntimeConfig?.();
  const requestedAgentId = resolveRequestedChatAgentId({
    cfg: runtimeConfig,
    requestedSessionKey: rawSessionKey,
    agentId: agentIdOverride,
  });
  // Outside configured global scope, `global` + agentId is the shipped webchat
  // alias for that agent's main thread. Resolve it before every store lookup so
  // reconnect replay cannot create a parallel literal `global` transcript.
  const sessionLoadKey =
    runtimeConfig &&
    runtimeConfig.session?.scope !== "global" &&
    rawSessionKey.trim().toLowerCase() === "global" &&
    requestedAgentId
      ? resolveAgentMainSessionKey({ cfg: runtimeConfig, agentId: requestedAgentId })
      : rawSessionKey;
  const sessionLoadOptions = requestedAgentId ? { agentId: requestedAgentId } : undefined;
  const sessionLoadStartedAtMs = performance.now();
  const sessionLoadResult = measureDiagnosticsTimelineSpanSync(
    "gateway.chat_send.load_session",
    () => loadSessionEntry(sessionLoadKey, sessionLoadOptions),
    {
      phase: "agent-turn",
      attributes: {
        runId: clientRunId,
        hasAttachments: normalizedAttachments.length > 0,
        hasExplicitOrigin: explicitOrigin !== undefined,
      },
    },
  );
  const sessionLoadMs = roundedChatSendTimingMs(performance.now() - sessionLoadStartedAtMs);
  const { cfg, storePath, entry, canonicalKey: sessionKey, legacyKey } = sessionLoadResult;
  const expectedSessionRoutingContract = normalizeOptionalChatText(
    p.expectedSessionRoutingContract,
  );
  const expectedLeafEntryId =
    p.expectedLeafEntryId === null ? null : normalizeOptionalChatText(p.expectedLeafEntryId);
  const sessionRoutingChanged = (candidateConfig: OpenClawConfig) =>
    expectedSessionRoutingContract !== undefined &&
    expectedSessionRoutingContract.toLowerCase() !== resolveSessionRoutingContract(candidateConfig);
  return {
    rawSessionKey,
    sessionLoadKey,
    clientRunId,
    pendingChatSendKey,
    sessionLoadOptions,
    sessionLoadMs,
    cfg,
    storePath,
    entry,
    sessionKey,
    legacyKey,
    sessionRoutingChanged,
    expectedLeafEntryId,
    requestedAgentId,
  };
}

/** Load and validate the session/model facts shared by later admission and dispatch phases. */
export function prepareChatSendSession(params: {
  request: NormalizedChatSendRequest;
  context: GatewayRequestHandlerOptions["context"];
  client: GatewayRequestHandlerOptions["client"];
}) {
  const loaded = loadChatSendSessionContext(params);
  const { request, client } = params;
  const { p, explicitOrigin, normalizedAttachments, turnKind, rawMessage } = request;
  const { cfg, sessionKey, entry, legacyKey, rawSessionKey, requestedAgentId } = loaded;
  if (isIncognitoSessionKey(sessionKey) && !entry) {
    return { ok: false as const, error: `Incognito session "${sessionKey}" was not found.` };
  }
  const missingHarnessSessionError = resolveMissingAgentHarnessSessionError(sessionKey, entry);
  if (missingHarnessSessionError) {
    return { ok: false as const, error: missingHarnessSessionError };
  }

  const selectedAgent = validateChatSelectedAgent({
    cfg,
    requestedSessionKey: rawSessionKey,
    agentId: requestedAgentId,
  });
  if (!selectedAgent.ok) {
    return { ok: false as const, error: selectedAgent.error };
  }
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, sessionKey, entry, {
    acpMetadataSessionKey: legacyKey ?? sessionKey,
  });
  if (deletedAgentId !== null) {
    return {
      ok: false as const,
      error: `Agent "${deletedAgentId}" no longer exists in configuration`,
    };
  }

  const requestedSessionId = normalizeOptionalChatText(p.sessionId);
  const backingSessionId = entry?.sessionId ?? requestedSessionId;
  const agentId = resolveSessionAgentId({
    sessionKey,
    config: cfg,
    agentId: selectedAgent.agentId,
  });
  const activeRunScopeKey = resolveChatSendActiveScopeKey({
    sessionKey,
    agentId: selectedAgent.agentId,
    mainKey: cfg.session?.mainKey,
  });
  const resolvedSessionModel = resolveSessionModelRef(cfg, entry, agentId);
  const resolvedSessionAuthProvider = resolveProviderIdForAuth(resolvedSessionModel.provider, {
    config: cfg,
  });
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideMs: p.timeoutMs });
  const now = Date.now();
  const restartSafeRequest = createRestartSafeChatRequest({
    cfg,
    eligible:
      isBrowserOperatorUiClient(request.clientInfo) &&
      turnKind === "main" &&
      normalizedAttachments.length === 0 &&
      !request.reconnectResumeRequested &&
      explicitOrigin === undefined &&
      p.deliver !== true &&
      p.thinking === undefined &&
      p.fastMode === undefined &&
      p.fastAutoOnSeconds === undefined &&
      p.timeoutMs === undefined &&
      request.systemInputProvenance === undefined &&
      request.systemProvenanceReceipt === undefined &&
      !request.suppressCommandInterpretation,
    message: rawMessage,
    senderIsOwner: hasGatewayAdminScope(client),
  });

  return {
    ok: true as const,
    value: {
      ...loaded,
      selectedAgent,
      requestedSessionId,
      backingSessionId,
      agentId,
      activeRunScopeKey,
      resolvedSessionModel,
      resolvedSessionAuthProvider,
      timeoutMs,
      now,
      restartSafeRequest,
    },
  };
}

export type PreparedChatSendSession = Extract<
  ReturnType<typeof prepareChatSendSession>,
  { ok: true }
>["value"];
