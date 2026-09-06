// Session message RPC adapters over canonical chat.send dispatch.
import { randomUUID } from "node:crypto";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsSendParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { terminateAcceptedCollectorRun } from "../../agents/subagents/spawn/subagent-spawn-cleanup.js";
import { resolveSessionWorkStartError, type SessionEntry } from "../../config/sessions.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { reactivateCompletedSubagentSession } from "../session-subagent-reactivation.js";
import {
  loadSessionEntry,
  loadGatewaySessionEntryReadOnly,
  resolveDeletedAgentIdFromSessionKey,
} from "../session-utils.js";
import { handleDirectExternalChatSend } from "./chat-send-external-entry.js";
import { chatHandlers } from "./chat.js";
import { emitSessionsChanged } from "./session-change-event.js";
import { isFreshChatSendStarted } from "./session-create-initial-turn.js";
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
  const loaded = loadGatewaySessionEntryReadOnly(createdKey, { agentId });
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
  };
}

async function handleSessionSend(params: {
  method: "sessions.send" | "sessions.steer";
  req: GatewayRequestHandlerOptions["req"];
  params: Record<string, unknown>;
  respond: RespondFn;
  context: GatewayRequestContext;
  client: GatewayClient | null;
  isWebchatConnect: GatewayRequestHandlerOptions["isWebchatConnect"];
  queueMode?: "interrupt";
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
  let { entry, canonicalKey } = loaded;
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
  const respond = params.respond;
  const dispatchChatSend = async (dispatchRespond: RespondFn) => {
    const options: GatewayRequestHandlerOptions = {
      req: params.req,
      params: {
        sessionKey: canonicalKey,
        ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
        message: (p as { message: string }).message,
        ...(p.mentions ? { mentions: p.mentions } : {}),
        thinking: (p as { thinking?: string }).thinking,
        attachments: (p as { attachments?: unknown[] }).attachments,
        timeoutMs: (p as { timeoutMs?: number }).timeoutMs,
        idempotencyKey,
        ...(params.queueMode ? { queueMode: params.queueMode } : {}),
      },
      respond: dispatchRespond,
      context: params.context,
      client: params.client,
      isWebchatConnect: params.isWebchatConnect,
    };
    if (params.queueMode === "interrupt") {
      await handleDirectExternalChatSend(options);
      return;
    }
    await expectDefined(chatHandlers["chat.send"], "chat.send handler")(options);
  };
  const archivedSessionError = resolveSessionWorkStartError(canonicalKey, entry, {
    allowPendingWorkspace: true,
  });
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
    params.queueMode !== "interrupt" &&
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
  }
  if (!entry?.sessionId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, `session not found: ${key}`));
    return;
  }
  let sendAcked = false;
  let sendPayload: unknown;
  let sendCached = false;
  let startedRunId: string | undefined;
  let interruptedActiveRun = false;
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
    interruptedActiveRun =
      ok &&
      payload !== null &&
      typeof payload === "object" &&
      "interruptedActiveRun" in payload &&
      payload.interruptedActiveRun === true;
    respond(ok, payload, error, meta);
  });
  if (sendAcked) {
    if (isFreshChatSendStarted({ payload: sendPayload, cached: sendCached })) {
      try {
        await reactivateCompletedSubagentSession({
          sessionKey: canonicalKey,
          runId: startedRunId,
          task: (p as { message: string }).message,
          gatewayContextResolver: params.context.resolveGatewayContext,
        });
      } catch (error) {
        if (startedRunId) {
          await terminateAcceptedCollectorRun({
            childSessionKey: canonicalKey,
            gatewayRunId: startedRunId,
            sessionCleanup: "preserve",
          });
        }
        throw error;
      }
    }
    emitSessionsChanged(params.context, {
      sessionKey: canonicalKey,
      ...(requestedAgentId ? { agentId: requestedAgentId } : {}),
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
      queueMode: "interrupt",
    });
  },
};
