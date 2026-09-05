import type { Result } from "@openclaw/normalization-core/result";
// RPC adapter for chat.abort; cancellation policy lives in the sibling modules.
import {
  ErrorCodes,
  errorShape,
  validateChatAbortParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import { createChatAbortOps } from "../chat-abort-ops.js";
import { abortChatRunById, type ChatAbortControllerEntry } from "../chat-abort.js";
import { abortQueuedChatTurnById, type QueuedChatTurnEntry } from "../chat-queued-turns.js";
import { chatRunBelongsToAgent } from "../chat-run-owner.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import {
  resolveRequestedSessionAgentId,
  tryResolveSessionCompatibilityOwnerAgentId,
} from "../session-request-agent.js";
import { loadSessionEntry, resolveSessionStoreKey } from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import {
  canRequesterAbortChatRun,
  canRequesterAbortPreRegisteredRun,
  readPreRegisteredAgentDedupePayloadForSession,
  resolveChatAbortRequester,
  writePreRegisteredAgentAbort,
  writePreRegisteredChatAbort,
} from "./chat-abort-authorization.js";
import {
  abortChatRunsForSessionKeyWithPartials,
  cancelWorkerInferenceForSession,
  abortControlledSubagents,
  descendantAbortError,
} from "./chat-abort-runtime.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import { captureAbortedPartial, persistAbortedPartials } from "./chat-transcript-persistence.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";
import { assertValidParams } from "./validation.js";

type ChatAbortLifecycle = {
  onAuthorizedAfterQueuedAbort?: () => boolean;
  excludeRunIds?: ReadonlySet<string>;
  cascadeDescendants?: true;
};

type ChatAbortTarget = Pick<
  ChatAbortControllerEntry | QueuedChatTurnEntry,
  "sessionKey" | "agentId" | "ownerConnId" | "ownerDeviceId"
>;

export async function handleChatAbortRequestWithLifecycle(
  { params, respond, context, client, sessionMutationAuthorization }: GatewayRequestHandlerOptions,
  lifecycle: ChatAbortLifecycle = {},
): Promise<void> {
  if (!assertValidParams(params, validateChatAbortParams, "chat.abort", respond)) {
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
  const parsedAbortSessionKey = parseAgentSessionKey(rawSessionKey);
  const compatibilityDefaultAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    abortCfg,
    rawSessionKey,
  );
  const inferredSessionAgentId =
    !agentIdOverride && parsedAbortSessionKey
      ? normalizeAgentId(parsedAbortSessionKey.agentId)
      : undefined;
  const bareSessionAgentResolution = !parsedAbortSessionKey
    ? resolveRequestedSessionAgentId(abortCfg, rawSessionKey, agentIdOverride)
    : undefined;
  if (bareSessionAgentResolution && !bareSessionAgentResolution.ok) {
    respond(false, undefined, bareSessionAgentResolution.error);
    return;
  }
  const abortAgentId = parsedAbortSessionKey
    ? (agentIdOverride ?? inferredSessionAgentId)
    : bareSessionAgentResolution?.agentId;
  if (!abortAgentId) {
    respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        rawSessionKey.trim().toLowerCase() === "global"
          ? "agentId is required for global chat.abort when no compatibility owner exists"
          : "agentId is required for unscoped chat.abort when no compatibility owner exists",
      ),
    );
    return;
  }
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
  const canonicalAbortSessionKey = resolveSessionStoreKey({
    cfg: abortCfg,
    sessionKey: rawSessionKey,
    storeAgentId: abortAgentId,
  });
  const ops = createChatAbortOps(context);
  const requester = resolveChatAbortRequester(client);

  const sessionLoadOptions = { agentId: abortAgentId };
  const abortSession: Result<ReturnType<typeof loadSessionEntry>, unknown> = (() => {
    try {
      return { ok: true, value: loadSessionEntry(canonicalAbortSessionKey, sessionLoadOptions) };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  const abortSessionEntry = abortSession.ok ? abortSession.value.entry : undefined;
  const cancelWorkerRun = (sessionId = abortSessionEntry?.sessionId): string[] =>
    requester.isAdmin
      ? cancelWorkerInferenceForSession({ context, sessionId, ...(runId ? { runId } : {}) })
      : [];
  const respondWithWorkerRuns = (localRunIds: string[], sessionId?: string): void => {
    const runIds = [...new Set([...localRunIds, ...cancelWorkerRun(sessionId)])];
    if (!abortSession.ok) {
      throw abortSession.error;
    }
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
      session: abortSession,
      defaultAgentId: compatibilityDefaultAgentId,
      abortOrigin: "rpc",
      stopReason: "rpc",
      requester,
      assertCurrent: sessionMutationAuthorization?.assertCurrent,
      preserveSideRuns,
      excludeRunIds: lifecycle.excludeRunIds,
      onAuthorizedAfterQueuedAbort: lifecycle.onAuthorizedAfterQueuedAbort,
      cascadeDescendants: lifecycle.cascadeDescendants,
    });
    if (res.unauthorized) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return;
    }
    const error = res.error ?? descendantAbortError(res.descendants, "Session");
    if (error) {
      respond(false, undefined, error);
      return;
    }
    respond(true, { ok: true, aborted: res.aborted, runIds: res.runIds });
    return;
  }
  const normalizedAgentIdOverride = normalizeAgentId(abortAgentId);
  const authorizeRunTarget = (target: ChatAbortTarget): boolean => {
    if (
      target.sessionKey !== rawSessionKey &&
      target.sessionKey !== canonicalAbortSessionKey &&
      !canRequesterAbortChatRun(target, requester, { requireOwnerMatch: true })
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match sessionKey"),
      );
      return false;
    }
    if (
      !chatRunBelongsToAgent(
        {
          agentId: target.agentId,
          sessionKey: target.sessionKey,
          defaultAgentId: compatibilityDefaultAgentId,
        },
        normalizedAgentIdOverride,
      )
    ) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, "runId does not match agentId"),
      );
      return false;
    }
    if (!canRequesterAbortChatRun(target, requester)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "unauthorized"));
      return false;
    }
    return true;
  };

  const active = context.chatAbortControllers.get(runId);
  if (!active) {
    const readPendingRunForAbort = (
      entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never,
    ) => {
      for (const sessionKey of new Set([canonicalAbortSessionKey, rawSessionKey])) {
        const payload = readPreRegisteredAgentDedupePayloadForSession({
          entry,
          runId,
          sessionKey,
          agentId: abortAgentId,
          defaultAgentId: compatibilityDefaultAgentId,
          includeHidden: true,
        });
        if (payload) {
          return {
            sessionKey: normalizeUnknownText(payload.sessionKey) ? sessionKey : undefined,
            payload,
          };
        }
      }
      return undefined;
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
    const chatQueuedTurns = context.chatQueuedTurns;
    const queued = chatQueuedTurns.get(runId);
    if (queued) {
      if (!authorizeRunTarget(queued)) {
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
      if (!abortSession.ok) {
        throw abortSession.error;
      }
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
  if (!authorizeRunTarget(active)) {
    return;
  }
  let aborted = false;
  const { sessionKey, sessionId, agentId, controlUiVisible } = active;
  const partialText = context.chatRunState.resolveBuffer(runId, { final: true }).text;
  const snapshot =
    controlUiVisible !== false && partialText?.trim()
      ? captureAbortedPartial({
          runId,
          sessionKey,
          sessionId,
          agentId: agentId ?? abortAgentId,
          text: partialText,
          abortOrigin: "rpc",
          ...(sessionKey === rawSessionKey || sessionKey === canonicalAbortSessionKey
            ? { session: abortSession }
            : {}),
        })
      : undefined;
  const descendants = await abortControlledSubagents({
    cfg: abortCfg,
    sessionKey,
    agentId,
    requesterTurnRunId: runId,
    beforeKill: () =>
      (aborted = abortChatRunById(ops, { runId, sessionKey, stopReason: "rpc" }).aborted),
  });
  // Transcript failure must not abandon children after the parent loses its controller.
  if (aborted && snapshot) {
    await persistAbortedPartials({ context, snapshots: [snapshot] });
  }
  if (!abortSession.ok) {
    throw abortSession.error;
  }
  const descendantError = descendantAbortError(descendants, "Parent run");
  if (descendantError) {
    respond(false, undefined, descendantError);
    return;
  }
  respondWithWorkerRuns(aborted ? [runId] : [], sessionId);
}

export async function handleChatAbortRequest(options: GatewayRequestHandlerOptions): Promise<void> {
  await handleChatAbortRequestWithLifecycle(options);
}
