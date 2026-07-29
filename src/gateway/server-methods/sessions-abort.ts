// Session active-run cancellation and agent-scope resolution.
import {
  normalizeOptionalString,
  readStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { abortEmbeddedAgentRun } from "../../agents/embedded-agent-runner/runs.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import {
  isConfiguredSessionStoreAgentId,
  resolveExistingAgentSessionStoreTargetsSync,
} from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionKeyForRun } from "../server-session-key.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import {
  resolveSessionStoreAgentId,
  resolveSessionStoreKey,
  resolveStoredSessionKeyForAgentStore,
  resolveStoredSessionOwnerAgentId,
} from "../session-store-key.js";
import { loadSessionEntry } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { resolveWorkerSessionTarget } from "../worker-environments/session-target.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { requireSessionKey } from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

export function resolveAbortSessionKey(params: {
  context: Pick<GatewayRequestContext, "chatAbortControllers">;
  requestedKey: string;
  canonicalKey: string;
  activeRunSessionKey?: string;
  aliasKeys?: string[];
}): string {
  if (params.activeRunSessionKey) {
    return params.activeRunSessionKey;
  }
  const candidates = [params.canonicalKey, params.requestedKey, ...(params.aliasKeys ?? [])];
  for (const active of params.context.chatAbortControllers.values()) {
    if (active.controlUiVisible === false) {
      continue;
    }
    for (const candidate of candidates) {
      if (active.sessionKey === candidate) {
        return candidate;
      }
    }
  }
  return params.requestedKey;
}

function resolveSessionKeyAgentId(
  sessionKey: string | undefined,
  cfg: OpenClawConfig,
): string | undefined {
  const key = normalizeOptionalString(sessionKey);
  if (!key) {
    return undefined;
  }
  if (!parseAgentSessionKey(key) && key.toLowerCase().startsWith("agent:")) {
    return undefined;
  }
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: key });
  return resolveSessionStoreAgentId(cfg, canonicalKey);
}

function sessionKeyBelongsToAgent(
  sessionKey: string | undefined,
  agentId: string,
  cfg: OpenClawConfig,
): boolean {
  const key = normalizeOptionalString(sessionKey);
  if (cfg.session?.scope === "global" && key?.toLowerCase() === "global") {
    return true;
  }
  const sessionAgentId = resolveSessionKeyAgentId(sessionKey, cfg);
  return Boolean(sessionAgentId && sessionAgentId === normalizeAgentId(agentId));
}

function resolveScopedAbortKey(params: {
  cfg: OpenClawConfig;
  key: string | undefined;
  agentId: string | undefined;
}): string | undefined {
  const key = normalizeOptionalString(params.key);
  if (!key) {
    return undefined;
  }
  const requestedAgentId = normalizeOptionalString(params.agentId);
  if (!requestedAgentId) {
    return key;
  }
  const scopedAgentId = normalizeAgentId(requestedAgentId);
  const ownerAgentId = resolveStoredSessionOwnerAgentId({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
  if (ownerAgentId && ownerAgentId !== scopedAgentId) {
    return undefined;
  }
  return resolveStoredSessionKeyForAgentStore({
    cfg: params.cfg,
    agentId: scopedAgentId,
    sessionKey: key,
  });
}

export const sessionAbortHandlers: GatewayRequestHandlers = {
  "sessions.abort": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    if (!assertValidParams(params, validateSessionsAbortParams, "sessions.abort", respond)) {
      return;
    }
    const p = params;
    const cfg = context.getRuntimeConfig();
    const requestedRunId = readStringValue(p.runId);
    const requestedKey = normalizeOptionalString(p.key);
    const requestedParamAgentId = normalizeOptionalString(p.agentId);
    const clearQueued = p.clearQueued === true;
    const workerRunSessionId = requestedRunId
      ? asWorkerInferenceControl(context.workerEnvironmentService)?.resolveInferenceSessionForRunId(
          requestedRunId,
        )
      : undefined;
    const workerRunTarget = workerRunSessionId
      ? resolveWorkerSessionTarget(cfg, workerRunSessionId)
      : undefined;
    const scopedRequestedKey = resolveScopedAbortKey({
      cfg,
      key: requestedKey,
      agentId: requestedParamAgentId,
    });
    if (requestedKey && requestedParamAgentId && !scopedRequestedKey) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "session key agent does not match agentId"),
      );
      return;
    }
    const requestedKeyAgentId = scopedRequestedKey
      ? resolveSessionKeyAgentId(scopedRequestedKey, cfg)
      : undefined;
    const activeRun = requestedRunId ? context.chatAbortControllers.get(requestedRunId) : undefined;
    const activeRunSessionKey = activeRun?.sessionKey;
    const activeRunAgentId = normalizeOptionalString(activeRun?.agentId);
    const inferredRunAgentId =
      requestedParamAgentId ??
      (requestedRunId && scopedRequestedKey?.toLowerCase() === "global"
        ? activeRunAgentId
        : undefined) ??
      requestedKeyAgentId ??
      workerRunTarget?.agentId ??
      (requestedRunId && !activeRunSessionKey ? resolveDefaultAgentId(cfg) : undefined);
    const requestedRunAgentId = requestedRunId
      ? inferredRunAgentId
        ? normalizeAgentId(inferredRunAgentId)
        : undefined
      : undefined;
    const scopedActiveRunSessionKey = activeRunSessionKey
      ? requestedRunAgentId
        ? sessionKeyBelongsToAgent(activeRunSessionKey, requestedRunAgentId, cfg)
          ? activeRunSessionKey
          : undefined
        : activeRunSessionKey
      : undefined;
    const keyCandidate =
      scopedRequestedKey ??
      scopedActiveRunSessionKey ??
      (requestedRunId
        ? resolveSessionKeyForRun(requestedRunId, {
            agentId: requestedRunAgentId ?? resolveDefaultAgentId(cfg),
          })
        : undefined) ??
      workerRunTarget?.sessionKey;
    if (!keyCandidate && requestedRunId) {
      respond(true, { ok: true, abortedRunId: null, status: "no-active-run" });
      return;
    }
    const key = requireSessionKey(keyCandidate, respond);
    if (!key) {
      return;
    }
    const requestedGlobalAgent = resolveRequestedGlobalAgentId(
      cfg,
      key,
      requestedParamAgentId ?? requestedRunAgentId,
    );
    if (!requestedGlobalAgent.ok) {
      respond(false, undefined, requestedGlobalAgent.error);
      return;
    }
    const requestedGlobalAgentId = requestedGlobalAgent.agentId;
    const targetAgentId =
      requestedGlobalAgentId ??
      resolveSessionStoreAgentId(cfg, resolveSessionStoreKey({ cfg, sessionKey: key }));
    const configuredTarget = isConfiguredSessionStoreAgentId(cfg, targetAgentId);
    const existingTargets = configuredTarget
      ? []
      : resolveExistingAgentSessionStoreTargetsSync(cfg, targetAgentId);
    const hasExactActiveRun = requestedRunId
      ? scopedActiveRunSessionKey === key
      : [...context.chatAbortControllers.values()].some(
          (entry) => entry.controlUiVisible !== false && entry.sessionKey === key,
        );
    if (!configuredTarget && existingTargets.length === 0 && !hasExactActiveRun) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `agent "${targetAgentId}" not found`),
      );
      return;
    }
    // An exact live controller is already authoritative. Avoid opening the fallback store when
    // neither config nor persistence owns it; that edge is the only one that could create state.
    const loadedSession =
      configuredTarget || existingTargets.length > 0
        ? loadSessionEntry(key, { agentId: requestedGlobalAgentId })
        : undefined;
    const canonicalKey =
      loadedSession?.canonicalKey ??
      resolveSessionStoreKey({
        cfg,
        sessionKey: key,
        ...(requestedGlobalAgentId ? { storeAgentId: requestedGlobalAgentId } : {}),
      });
    const sessionEntry = loadedSession?.entry;
    const requestedKeyAliases =
      requestedKey &&
      requestedKey !== key &&
      (!requestedParamAgentId || sessionKeyBelongsToAgent(requestedKey, requestedParamAgentId, cfg))
        ? [requestedKey]
        : undefined;
    const resolvedAbortSessionKey = resolveAbortSessionKey({
      context,
      requestedKey: key,
      canonicalKey,
      activeRunSessionKey: scopedActiveRunSessionKey,
      aliasKeys: requestedKeyAliases,
    });
    const abortSessionKey =
      canonicalKey === "global" && requestedGlobalAgentId ? "global" : resolvedAbortSessionKey;
    const abortAgentId =
      abortSessionKey === "global" ? (requestedGlobalAgentId ?? activeRunAgentId) : undefined;
    // Capture run kinds before the abort because abortChatRunById deletes entries
    // from chatAbortControllers synchronously. We use this snapshot to choose the
    // correct dedupe namespace: agent-kind runs use "agent:" (their runId equals
    // their idempotency key), while chat-send runs use "chat:" so the abort
    // snapshot does not collide with the agent RPC dedupe cache.
    const preAbortRunKinds = new Map<string, "chat-send" | "agent" | undefined>();
    if (requestedRunId) {
      preAbortRunKinds.set(requestedRunId, activeRun?.kind);
    } else {
      for (const [rid, entry] of context.chatAbortControllers) {
        preAbortRunKinds.set(rid, entry.kind);
      }
    }
    let abortedRunId: string | null = null;
    let aborted = false;
    let chatAbortSucceeded = false;
    let responseMeta: Record<string, unknown> | undefined;
    const persistedSessionId = sessionEntry?.sessionId;
    const onAuthorizedAfterQueuedAbort =
      !requestedRunId && canonicalKey !== "global" && (clearQueued || persistedSessionId)
        ? () => {
            let queueCleared = false;
            if (clearQueued) {
              // Explicit full-session stops clear first so an aborting run cannot
              // promote queued work. Ordinary sessions.abort calls preserve it.
              const cleared = clearSessionQueues([
                key,
                ...(requestedKeyAliases ?? []),
                canonicalKey,
                ...(persistedSessionId ? [persistedSessionId] : []),
              ]);
              queueCleared = cleared.followupCleared > 0 || cleared.laneCleared > 0;
            }
            // Persisted channel replies are active session work even when they
            // have no connection-owned chat controller.
            const embeddedAborted = persistedSessionId
              ? abortEmbeddedAgentRun(persistedSessionId)
              : false;
            return embeddedAborted || queueCleared;
          }
        : undefined;
    await handleChatAbortRequestWithLifecycle(
      {
        req,
        params: {
          sessionKey: abortSessionKey,
          runId: requestedRunId,
          ...(abortAgentId ? { agentId: abortAgentId } : {}),
        },
        respond: (ok, payload, error, meta) => {
          if (!ok) {
            respond(ok, payload, error, meta);
            return;
          }
          chatAbortSucceeded = true;
          responseMeta = meta;
          const runIds =
            payload &&
            typeof payload === "object" &&
            Array.isArray((payload as { runIds?: unknown[] }).runIds)
              ? (payload as { runIds: unknown[] }).runIds.filter((value): value is string =>
                  Boolean(normalizeOptionalString(value)),
                )
              : [];
          const firstAbortedRunId = runIds[0] ?? null;
          abortedRunId = firstAbortedRunId;
          aborted =
            firstAbortedRunId !== null ||
            (payload !== null &&
              typeof payload === "object" &&
              (payload as { aborted?: unknown }).aborted === true);
          const workerOnly = Boolean(workerRunSessionId && !activeRun);
          if (firstAbortedRunId && !workerOnly) {
            const endedAt = Date.now();
            const runKind = preAbortRunKinds.get(firstAbortedRunId);
            const dedupePrefix = runKind === "agent" ? "agent" : "chat";
            setGatewayDedupeEntry({
              dedupe: context.dedupe,
              key: `${dedupePrefix}:${firstAbortedRunId}`,
              entry: {
                ts: endedAt,
                ok: true,
                payload: {
                  status: "timeout",
                  runId: firstAbortedRunId,
                  ...(abortAgentId ? { agentId: abortAgentId } : {}),
                  stopReason: "rpc",
                  endedAt,
                },
              },
            });
          }
        },
        context,
        client,
        isWebchatConnect,
      },
      onAuthorizedAfterQueuedAbort ? { onAuthorizedAfterQueuedAbort } : {},
    );
    if (!chatAbortSucceeded) {
      return;
    }
    respond(
      true,
      {
        ok: true,
        abortedRunId,
        status: aborted ? "aborted" : "no-active-run",
      },
      undefined,
      responseMeta,
    );
    if (aborted) {
      emitSessionsChanged(context, {
        sessionKey: canonicalKey,
        ...(canonicalKey === "global" && abortAgentId ? { agentId: abortAgentId } : {}),
        reason: "abort",
      });
    }
  },
};
