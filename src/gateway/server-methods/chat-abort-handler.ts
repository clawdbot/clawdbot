// RPC adapter for chat.abort; cancellation policy lives in the sibling modules.
import {
  ErrorCodes,
  errorShape,
  formatValidationErrors,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { abortChatRunById } from "../chat-abort.js";
import { abortQueuedChatTurnById } from "../chat-queued-turns.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import {
  canRequesterAbortChatRun,
  canRequesterAbortChatRunWithoutSessionMatch,
  canRequesterAbortPreRegisteredRun,
  canRequesterAbortQueuedChatTurn,
  canRequesterAbortQueuedChatTurnWithoutSessionMatch,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  resolveStoredGlobalRunAgentId,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  cancelWorkerInferenceForSession,
  createChatAbortOps,
  ensureChatQueuedTurns,
  persistAbortedPartials,
} from "./chat-abort-runtime.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

export async function handleChatAbortRequest({
  params,
  respond,
  context,
  client,
}: GatewayRequestHandlerOptions): Promise<void> {
  if (!validateChatAbortParams(params)) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `invalid chat.abort params: ${formatValidationErrors(validateChatAbortParams.errors)}`,
      ),
    );
    return;
  }
  const {
    sessionKey: rawSessionKey,
    runId,
    preserveSideRuns,
  } = params as {
    sessionKey: string;
    agentId?: string;
    runId?: string;
    preserveSideRuns?: boolean;
  };
  const agentIdOverride = normalizeOptionalText((params as { agentId?: string }).agentId);
  const abortCfg = context.getRuntimeConfig();
  const defaultAgentId = resolveDefaultAgentId(abortCfg);
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const abortSessionResolvesGlobal =
    resolveSessionStoreKey({ cfg: abortCfg, sessionKey: rawSessionKey }) === "global";
  const inferredGlobalAgentId =
    !agentIdOverride && parsedAbortSessionKey && abortSessionResolvesGlobal
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const abortAgentId =
    agentIdOverride ??
    inferredGlobalAgentId ??
    (abortSessionResolvesGlobal ? defaultAgentId : undefined);
  if (
    agentIdOverride &&
    parsedAbortSessionKey &&
    normalizeAgentId(parsedAbortSessionKey.agentId) !== normalizeAgentId(agentIdOverride)
  ) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `agentId "${agentIdOverride}" does not match session key "${rawSessionKey}"`,
      ),
    );
    return;
  }
  const canonicalAbortSessionKey =
    abortAgentId && abortSessionResolvesGlobal ? "global" : rawSessionKey;

  const ops = createChatAbortOps(context);
  const requester = resolveChatAbortRequester(client);

  const sessionLoadOptions = abortAgentId ? { agentId: abortAgentId } : undefined;
  const { entry: abortSessionEntry } = loadSessionEntry(rawSessionKey, sessionLoadOptions);
  const cancelWorkerRun = (sessionId = abortSessionEntry?.sessionId): string[] =>
    requester.isAdmin
      ? cancelWorkerInferenceForSession({ context, sessionId, ...(runId ? { runId } : {}) })
      : [];
  const respondWithWorkerRuns = (localRunIds: string[], sessionId?: string): void => {
    const runIds = [...new Set([...localRunIds, ...cancelWorkerRun(sessionId)])];
    respond(true, { ok: true, aborted: runIds.length > 0, runIds });
  };

  if (!runId) {
    const res = await abortChatRunsForSessionKeyWithPartials({
      context,
      ops,
      sessionKey: canonicalAbortSessionKey,
      sessionKeyAliases: canonicalAbortSessionKey === rawSessionKey ? undefined : [rawSessionKey],
      agentId: abortAgentId,
      sessionId: abortSessionEntry?.sessionId,
      defaultAgentId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      requester,
      preserveSideRuns,
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
    return;
  }
  const normalizedAgentIdOverride = abortAgentId?.toLowerCase();

  const active = context.chatAbortControllers.get(runId);
  if (!active) {
    const readPendingRunForAbort = (
      entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never,
    ) => {
      const canonicalMatch = readPreRegisteredAgentDedupePayloadForSession({
        entry,
        runId,
        sessionKey: canonicalAbortSessionKey,
        agentId: abortAgentId,
        defaultAgentId,
        includeHidden: true,
      });
      if (canonicalMatch) {
        return {
          sessionKey: normalizeUnknownText(canonicalMatch.sessionKey)
            ? canonicalAbortSessionKey
            : undefined,
          payload: canonicalMatch,
        };
      }
      if (rawSessionKey === canonicalAbortSessionKey) {
        return undefined;
      }
      const aliasMatch = readPreRegisteredAgentDedupePayloadForSession({
        entry,
        runId,
        sessionKey: rawSessionKey,
        agentId: abortAgentId,
        defaultAgentId,
        includeHidden: true,
      });
      return aliasMatch
        ? {
            sessionKey: normalizeUnknownText(aliasMatch.sessionKey) ? rawSessionKey : undefined,
            payload: aliasMatch,
          }
        : undefined;
    };
    const pendingChatMatch = readPendingRunForAbort(
      context.dedupe.get(pendingChatSendDedupeKey(runId)),
    );
    if (pendingChatMatch) {
      if (!canRequesterAbortPreRegisteredRun(pendingChatMatch.payload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      writePreRegisteredChatAbort({
        context,
        runId,
        stopReason: "rpc",
        attemptId: normalizeUnknownText(pendingChatMatch.payload.attemptId),
      });
      respondWithWorkerRuns([runId]);
      return;
    }
    const pendingAgentEntry = context.dedupe.get(`agent:${runId}`);
    const pendingAgentMatch = readPendingRunForAbort(pendingAgentEntry);
    if (pendingAgentMatch) {
      const pendingAgentPayload = pendingAgentMatch.payload;
      if (!canRequesterAbortPreRegisteredRun(pendingAgentPayload, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      writePreRegisteredAgentAbort({
        context,
        runId,
        sessionKey: pendingAgentMatch.sessionKey,
        payload: pendingAgentPayload,
        stopReason: "rpc",
      });
      respondWithWorkerRuns([runId]);
      return;
    }
    // Queued followup/collect turns keep a cancel identity after chat.send
    // terminalizes; abort them here so Esc cannot report done while they run.
    const chatQueuedTurns = ensureChatQueuedTurns(context);
    const queued = chatQueuedTurns.get(runId);
    if (queued) {
      const abortSessionKeysForQueued = new Set([rawSessionKey, canonicalAbortSessionKey]);
      if (
        !abortSessionKeysForQueued.has(queued.sessionKey) &&
        !canRequesterAbortQueuedChatTurnWithoutSessionMatch(queued, requester)
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
        );
        return;
      }
      if (
        normalizedAgentIdOverride &&
        queued.sessionKey === "global" &&
        resolveStoredGlobalRunAgentId(queued.agentId, defaultAgentId) !== normalizedAgentIdOverride
      ) {
        respond(
          false,
          undefined,
          errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
        );
        return;
      }
      if (!canRequesterAbortQueuedChatTurn(queued, requester)) {
        respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
        return;
      }
      const queuedRes = abortQueuedChatTurnById(chatQueuedTurns, {
        runId,
        sessionKey: queued.sessionKey,
        stopReason: "rpc",
        allowSessionMismatch: true,
      });
      respondWithWorkerRuns(queuedRes.aborted ? [runId] : []);
      return;
    }
    const workerSessionId = abortSessionEntry?.sessionId;
    if (
      !workerSessionId ||
      !asWorkerInferenceControl(context.workerEnvironmentService)?.hasInferenceForSession(
        workerSessionId,
        runId,
      )
    ) {
      respond(true, { ok: true, aborted: false, runIds: [] });
      return;
    }
    if (!requester.isAdmin) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    respondWithWorkerRuns([]);
    return;
  }
  const abortSessionKeysForRun = new Set([rawSessionKey, canonicalAbortSessionKey]);
  if (
    !abortSessionKeysForRun.has(active.sessionKey) &&
    !canRequesterAbortChatRunWithoutSessionMatch(active, requester)
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
    );
    return;
  }
  if (
    normalizedAgentIdOverride &&
    active.sessionKey === "global" &&
    resolveStoredGlobalRunAgentId(active.agentId, defaultAgentId) !== normalizedAgentIdOverride
  ) {
    respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
    );
    return;
  }
  if (!canRequesterAbortChatRun(active, requester)) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
    return;
  }

  const partialText = context.chatRunState.runs.get(runId)?.buffer;
  const res = abortChatRunById(ops, {
    runId,
    sessionKey: active.sessionKey,
    stopReason: "rpc",
  });
  if (res.aborted && active.controlUiVisible !== false && partialText && partialText.trim()) {
    await persistAbortedPartials({
      context,
      sessionKey: active.sessionKey,
      snapshots: [
        {
          runId,
          sessionId: active.sessionId,
          agentId: active.agentId,
          text: partialText,
          abortOrigin: "rpc",
        },
      ],
    });
  }
  respondWithWorkerRuns(res.aborted ? [runId] : [], active.sessionId);
}
