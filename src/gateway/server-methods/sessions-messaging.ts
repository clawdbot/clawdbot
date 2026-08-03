// Session message dispatch, steering, and active-run cancellation.
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import {
  abortEmbeddedAgentRun,
  isEmbeddedAgentRunActive,
  waitForEmbeddedAgentRunEnd,
} from "../../agents/embedded-agent-runner/runs.js";
import { clearSessionQueues } from "../../auto-reply/reply/queue/cleanup.js";
import { resolveSessionWorkStartError, type SessionEntry } from "../../config/sessions.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../config/sessions/session-accessor.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { readSessionMessageCountAsync } from "../session-transcript-readers.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  resolveDeletedAgentIdFromSessionKey,
} from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { formatForLog } from "../ws-log.js";
import { handleChatAbortRequestWithLifecycle } from "./chat-abort-handler.js";
import { handleChatSend } from "./chat-send-handler.js";
import { chatHandlers } from "./chat.js";
import { resolveGatewayInflightRequest, type GatewayInflightResult } from "./inflight.js";
import { hasTrackedActiveSessionRun } from "./session-active-runs.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { shouldAttachPendingMessageSeq } from "./session-create-initial-turn.js";
import { resolveAbortSessionKey } from "./sessions-abort.js";
import { sessionCreateHandlers } from "./sessions-create.js";
import { isAgentMainSessionKey, requireSessionKey } from "./sessions-shared.js";
import type {
  GatewayClient,
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  GatewayRequestHandlers,
  RespondFn,
} from "./types.js";
import { assertValidParams } from "./validation.js";

type SessionSteerInflightOwner = {
  respond: RespondFn;
  fail: (error: unknown) => void;
  finish: () => void;
};

function beginSessionSteerInflight(params: {
  context: GatewayRequestContext;
  idempotencyKey: string;
  request: { respond: RespondFn };
}): { kind: "handled"; done: Promise<void> } | { kind: "owner"; owner: SessionSteerInflightOwner } {
  const originalRespond = params.request.respond;
  const dedupeKey = `sessions.steer:${params.idempotencyKey}`;
  const inflight = resolveGatewayInflightRequest({
    context: params.context,
    dedupeKey,
    idempotencyKey: params.idempotencyKey,
    respond: originalRespond,
  });
  if (inflight.kind === "handled") {
    return inflight;
  }

  let resolveResult: (result: GatewayInflightResult) => void = () => {};
  const work = new Promise<GatewayInflightResult>((resolve) => {
    resolveResult = resolve;
  });
  let settled = false;
  const settle = (result: GatewayInflightResult): boolean => {
    if (settled) {
      return false;
    }
    settled = true;
    resolveResult(result);
    return true;
  };
  inflight.inflightMap.set(dedupeKey, work);
  const respond: RespondFn = (ok, payload, error, meta) => {
    settle({
      ok,
      ...(payload !== undefined ? { payload } : {}),
      ...(error ? { error } : {}),
      ...(meta ? { meta } : {}),
    });
    if (meta === undefined) {
      originalRespond(ok, payload, error);
      return;
    }
    originalRespond(ok, payload, error, meta);
  };

  return {
    kind: "owner",
    owner: {
      respond,
      fail: (error) => {
        const responseError = errorShape(ErrorCodes.UNAVAILABLE, formatForLog(error), {
          retryable: true,
        });
        if (
          settle({
            ok: false,
            error: responseError,
          })
        ) {
          originalRespond(false, undefined, responseError);
        }
      },
      finish: () => {
        if (!settled) {
          const error = errorShape(
            ErrorCodes.UNAVAILABLE,
            "sessions.steer ended before producing a response",
            { retryable: true },
          );
          settle({ ok: false, error });
          originalRespond(false, undefined, error);
        }
        if (inflight.inflightMap.get(dedupeKey) === work) {
          inflight.inflightMap.delete(dedupeKey);
        }
      },
    },
  };
}

async function createAgentMainSessionForSend(params: {
  req: GatewayRequestHandlerOptions["req"];
  canonicalKey: string;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
}): Promise<
  | {
      ok: true;
      entry: SessionEntry;
      canonicalKey: string;
      storePath: string;
    }
  | { ok: false; error: ReturnType<typeof errorShape> }
> {
  const agentId = parseAgentSessionKey(params.canonicalKey)?.agentId;
  if (!agentId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${params.canonicalKey}`),
    };
  }

  let createResult:
    | { ok: boolean; payload?: { key?: string }; error?: ReturnType<typeof errorShape> }
    | undefined;
  await expectDefined(
    sessionCreateHandlers["sessions.create"],
    "sessions.create handler",
  )({
    req: params.req,
    params: {
      key: params.canonicalKey,
      agentId,
    },
    respond: (ok, payload, error) => {
      createResult = {
        ok,
        payload: payload && typeof payload === "object" ? (payload as { key?: string }) : undefined,
        error,
      };
    },
    context: params.context,
    client: params.client,
    isWebchatConnect: params.isWebchatConnect,
  });

  if (!createResult) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, "sessions.create did not respond"),
    };
  }
  if (!createResult.ok) {
    return {
      ok: false,
      error: createResult.error ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to create session"),
    };
  }

  const createdKey = normalizeOptionalString(createResult.payload?.key) ?? params.canonicalKey;
  const loaded = loadSessionEntryReadOnly(createdKey);
  if (!loaded.entry?.sessionId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.UNAVAILABLE, `session not created: ${createdKey}`),
    };
  }
  return {
    ok: true,
    entry: loaded.entry,
    canonicalKey: loaded.canonicalKey,
    storePath: loaded.storePath,
  };
}

export async function interruptSessionRunIfActive(params: {
  req: GatewayRequestHandlerOptions["req"];
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  requestedKey: string;
  canonicalKey: string;
  agentId?: string;
  sessionId?: string;
  excludeRunIds?: ReadonlySet<string>;
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const cfg = params.context.getRuntimeConfig();
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
    agentId: params.agentId,
    defaultAgentId: resolveDefaultAgentId(cfg),
    excludeRunIds: params.excludeRunIds,
  });
  const hasEmbeddedRun =
    typeof params.sessionId === "string" && params.sessionId
      ? isEmbeddedAgentRunActive(params.sessionId)
      : false;
  const hasWorkerRun =
    typeof params.sessionId === "string" && params.sessionId
      ? (asWorkerInferenceControl(params.context.workerEnvironmentService)?.hasInferenceForSession(
          params.sessionId,
        ) ?? false)
      : false;

  if (!hasTrackedRun && !hasEmbeddedRun && !hasWorkerRun) {
    return { interrupted: false };
  }

  if (hasTrackedRun || hasWorkerRun) {
    let abortOk = true;
    let abortError: ReturnType<typeof errorShape> | undefined;
    const abortSessionKey = resolveAbortSessionKey({
      context: params.context,
      requestedKey: params.requestedKey,
      canonicalKey: params.canonicalKey,
    });

    await handleChatAbortRequestWithLifecycle(
      {
        req: params.req,
        params: {
          sessionKey: abortSessionKey,
          ...(params.canonicalKey === "global" && params.agentId
            ? { agentId: params.agentId }
            : {}),
        },
        respond: (ok, _payload, error) => {
          abortOk = ok;
          abortError = error;
        },
        context: params.context,
        client: params.client,
        isWebchatConnect: params.isWebchatConnect,
      },
      params.excludeRunIds ? { excludeRunIds: params.excludeRunIds } : {},
    );

    if (!abortOk) {
      return {
        interrupted: true,
        error:
          abortError ?? errorShape(ErrorCodes.UNAVAILABLE, "failed to interrupt active session"),
      };
    }
  }

  if (hasEmbeddedRun && params.sessionId) {
    abortEmbeddedAgentRun(params.sessionId);
  }

  // Clear queued follow-up work for both requested aliases and the canonical session id.
  clearSessionQueues([params.requestedKey, params.canonicalKey, params.sessionId]);

  if (hasEmbeddedRun && params.sessionId) {
    const ended = await waitForEmbeddedAgentRunEnd(params.sessionId, 15_000);
    if (!ended) {
      return {
        interrupted: true,
        error: errorShape(
          ErrorCodes.UNAVAILABLE,
          `Session ${params.requestedKey} is still active; try again in a moment.`,
        ),
      };
    }
  }

  return { interrupted: true };
}

async function handleSessionSend(params: {
  method: "sessions.send" | "sessions.steer";
  req: GatewayRequestHandlerOptions["req"];
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  interruptIfActive: boolean;
}) {
  if (
    !assertValidParams(params.params, validateSessionsSendParams, params.method, params.respond)
  ) {
    return;
  }
  const p = params.params;
  const key = requireSessionKey((p as { key?: unknown }).key, params.respond);
  if (!key) {
    return;
  }
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(
    cfg,
    key,
    (p as { agentId?: string }).agentId,
  );
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return;
  }
  const requestedAgentId = requestedAgent.agentId;
  const loaded = loadSessionEntry(key, { agentId: requestedAgentId });
  const { legacyKey } = loaded;
  let { entry, canonicalKey, storePath } = loaded;
  // Reject sends/steers targeting sessions whose owning agent was deleted (#65524).
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, canonicalKey, entry, {
    acpMetadataSessionKey: legacyKey ?? canonicalKey,
  });
  if (deletedAgentId !== null) {
    params.respond(
      false,
      undefined,
      errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Agent "${deletedAgentId}" no longer exists in configuration`,
      ),
    );
    return;
  }
  const rawIdempotencyKey = (p as { idempotencyKey?: string }).idempotencyKey;
  const explicitIdempotencyKey =
    typeof rawIdempotencyKey === "string" && rawIdempotencyKey.trim()
      ? rawIdempotencyKey.trim()
      : undefined;
  const idempotencyKey = explicitIdempotencyKey ?? randomUUID();
  const steerInflight =
    params.interruptIfActive && explicitIdempotencyKey
      ? beginSessionSteerInflight({
          context: params.context,
          idempotencyKey,
          request: params,
        })
      : undefined;
  if (steerInflight?.kind === "handled") {
    await steerInflight.done;
    return;
  }
  const steerInflightOwner = steerInflight?.owner;
  const respond = steerInflightOwner?.respond ?? params.respond;

  try {
    const dispatchChatSend = async (
      dispatchRespond: RespondFn,
      onAdmissionOwned?: () => Promise<boolean>,
    ) => {
      const options: GatewayRequestHandlerOptions = {
        req: params.req,
        params: {
          sessionKey: canonicalKey,
          ...(canonicalKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {}),
          message: (p as { message: string }).message,
          thinking: (p as { thinking?: string }).thinking,
          attachments: (p as { attachments?: unknown[] }).attachments,
          timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
          idempotencyKey,
        },
        respond: dispatchRespond,
        context: params.context,
        client: params.client,
        isWebchatConnect: params.isWebchatConnect,
      };
      if (onAdmissionOwned) {
        await handleChatSend(options, onAdmissionOwned);
        return;
      }
      await expectDefined(chatHandlers["chat.send"], "chat.send handler")(options);
    };
    const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
    if (archivedSessionError) {
      // An explicit retry may already have a terminal chat.send result. Let the
      // owning handler replay that result before it applies the archive guard.
      if (explicitIdempotencyKey) {
        await dispatchChatSend(respond);
        return;
      }
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
      return;
    }
    if (
      !entry?.sessionId &&
      !params.interruptIfActive &&
      isAgentMainSessionKey(cfg, canonicalKey)
    ) {
      // Sending to an empty agent main session should create it; steering still requires an active row.
      const created = await createAgentMainSessionForSend({
        req: params.req,
        canonicalKey,
        context: params.context,
        client: params.client,
        isWebchatConnect: params.isWebchatConnect,
      });
      if (!created.ok) {
        respond(false, undefined, created.error);
        return;
      }
      entry = created.entry;
      canonicalKey = created.canonicalKey;
      storePath = created.storePath;
    }
    if (!entry?.sessionId) {
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
      );
      return;
    }
    const admittedEntry = entry;
    const admittedSessionId = entry.sessionId;

    const readNextMessageSeq = async () =>
      (await readSessionMessageCountAsync({
        agentId: requestedAgentId,
        sessionEntry: admittedEntry,
        sessionId: admittedSessionId,
        sessionKey: canonicalKey,
        storePath,
      })) + 1;
    let messageSeq: number | undefined;
    try {
      messageSeq = await readNextMessageSeq();
    } catch (error) {
      if (!isSessionTranscriptProjectionUnavailableError(error)) {
        throw error;
      }
      // Projection rebuilds are transient and happen before dispatch, so callers
      // can safely retry the same idempotency key without duplicating a turn.
      respond(
        false,
        undefined,
        errorShape(ErrorCodes.UNAVAILABLE, "session transcript is rebuilding; retry shortly", {
          details: { method: params.method },
          retryable: true,
          retryAfterMs: 250,
        }),
      );
      return;
    }

    let interruptedActiveRun = false;
    const onAdmissionOwned = params.interruptIfActive
      ? async (): Promise<boolean> => {
          const interruptResult = await interruptSessionRunIfActive({
            req: params.req,
            context: params.context,
            client: params.client,
            isWebchatConnect: params.isWebchatConnect,
            requestedKey: key,
            canonicalKey,
            agentId: requestedAgentId,
            sessionId: admittedSessionId,
            excludeRunIds: new Set([idempotencyKey]),
          });
          if (interruptResult.error) {
            respond(false, undefined, interruptResult.error);
            return false;
          }
          interruptedActiveRun = interruptResult.interrupted;
          try {
            // A run can finish before the active check or while an interruption
            // drains. Refresh only for new sends; replays retain their original result.
            messageSeq = await readNextMessageSeq();
          } catch (error) {
            if (!isSessionTranscriptProjectionUnavailableError(error)) {
              throw error;
            }
            // Interruption may already have committed side effects. The sequence is
            // optional, so preserve delivery and let transcript events reconcile it.
            messageSeq = undefined;
          }
          return true;
        }
      : undefined;

    let sendAcked = false;
    let sendPayload: unknown;
    let sendCached = false;
    let startedRunId: string | undefined;
    await dispatchChatSend((ok, payload, error, meta) => {
      sendAcked = ok;
      sendPayload = payload;
      sendCached = meta?.cached === true;
      startedRunId =
        payload &&
        typeof payload === "object" &&
        typeof (payload as { runId?: unknown }).runId === "string"
          ? (payload as { runId: string }).runId
          : undefined;
      if (ok && shouldAttachPendingMessageSeq({ payload, cached: meta?.cached === true })) {
        respond(
          true,
          {
            ...(payload && typeof payload === "object" ? payload : {}),
            ...(messageSeq !== undefined ? { messageSeq } : {}),
            ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
          },
          undefined,
          meta,
        );
        return;
      }
      respond(
        ok,
        ok && payload && typeof payload === "object"
          ? {
              ...payload,
              ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
            }
          : payload,
        error,
        meta,
      );
    }, onAdmissionOwned);
    if (sendAcked) {
      if (shouldAttachPendingMessageSeq({ payload: sendPayload, cached: sendCached })) {
        await reactivateCompletedSubagentSession({
          sessionKey: canonicalKey,
          runId: startedRunId,
          task: (p as { message: string }).message,
        });
      }
      emitSessionsChanged(params.context, {
        sessionKey: canonicalKey,
        ...(canonicalKey === "global" && requestedAgentId ? { agentId: requestedAgentId } : {}),
        reason: interruptedActiveRun ? "steer" : "send",
      });
    }
  } catch (error) {
    if (steerInflightOwner) {
      steerInflightOwner.fail(error);
      return;
    }
    throw error;
  } finally {
    steerInflightOwner?.finish();
  }
}

export const sessionMessagingHandlers: GatewayRequestHandlers = {
  "sessions.send": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.send",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: false,
    });
  },
  "sessions.steer": async ({ req, params, respond, context, client, isWebchatConnect }) => {
    await handleSessionSend({
      method: "sessions.steer",
      req,
      params,
      respond,
      context,
      client,
      isWebchatConnect,
      interruptIfActive: true,
    });
  },
};
