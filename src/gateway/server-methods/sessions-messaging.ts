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
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import { readSessionMessageCountAsync } from "../session-transcript-readers.js";
import {
  loadSessionEntry,
  loadSessionEntryReadOnly,
  resolveDeletedAgentIdFromSessionKey,
} from "../session-utils.js";
import { asWorkerInferenceControl } from "../worker-environments/inference-control.js";
import { chatHandlers } from "./chat.js";
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
}): Promise<{ interrupted: boolean; error?: ReturnType<typeof errorShape> }> {
  const cfg = params.context.getRuntimeConfig();
  const hasTrackedRun = hasTrackedActiveSessionRun({
    context: params.context,
    requestedKey: params.requestedKey,
    canonicalKey: params.canonicalKey,
    agentId: params.agentId,
    defaultAgentId: resolveDefaultAgentId(cfg),
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

    await expectDefined(
      chatHandlers["chat.abort"],
      "chat.abort handler",
    )({
      req: params.req,
      params: {
        sessionKey: abortSessionKey,
        ...(params.canonicalKey === "global" && params.agentId ? { agentId: params.agentId } : {}),
      },
      respond: (ok, _payload, error) => {
        abortOk = ok;
        abortError = error;
      },
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });

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
  const dispatchChatSend = async (respond: RespondFn) => {
    await expectDefined(
      chatHandlers["chat.send"],
      "chat.send handler",
    )({
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
      respond,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });
  };
  const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry);
  if (archivedSessionError) {
    // An explicit retry may already have a terminal chat.send result. Let the
    // owning handler replay that result before it applies the archive guard.
    if (explicitIdempotencyKey) {
      await dispatchChatSend(params.respond);
      return;
    }
    params.respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, archivedSessionError));
    return;
  }
  if (!entry?.sessionId && !params.interruptIfActive && isAgentMainSessionKey(cfg, canonicalKey)) {
    // Sending to an empty agent main session should create it; steering still requires an active row.
    const created = await createAgentMainSessionForSend({
      req: params.req,
      canonicalKey,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    });
    if (!created.ok) {
      params.respond(false, undefined, created.error);
      return;
    }
    entry = created.entry;
    canonicalKey = created.canonicalKey;
    storePath = created.storePath;
  }
  if (!entry?.sessionId) {
    params.respond(
      false,
      undefined,
      errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`),
    );
    return;
  }

  let interruptedActiveRun = false;
  if (params.interruptIfActive) {
    const interruptResult = await interruptSessionRunIfActive({
      req: params.req,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
      requestedKey: key,
      canonicalKey,
      agentId: requestedAgentId,
      sessionId: entry.sessionId,
    });
    if (interruptResult.error) {
      params.respond(false, undefined, interruptResult.error);
      return;
    }
    interruptedActiveRun = interruptResult.interrupted;
  }

  const messageSeq =
    (await readSessionMessageCountAsync({
      agentId: requestedAgentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: canonicalKey,
      storePath,
    })) + 1;
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
      params.respond(
        true,
        {
          ...(payload && typeof payload === "object" ? payload : {}),
          messageSeq,
          ...(interruptedActiveRun ? { interruptedActiveRun: true } : {}),
        },
        undefined,
        meta,
      );
      return;
    }
    params.respond(
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
  });
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
