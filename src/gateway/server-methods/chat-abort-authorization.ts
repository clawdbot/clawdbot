// Authorization and pending-run state transitions for chat cancellation.
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { normalizeAgentId } from "../../routing/session-key.js";
import { parseAgentSessionKey } from "../../sessions/session-key-utils.js";
import type { ChatAbortControllerEntry } from "../chat-abort.js";
import type { QueuedChatTurnEntry } from "../chat-queued-turns.js";
import { ADMIN_SCOPE } from "../method-scopes.js";
import { createChatAbortMarker } from "../server-chat-state.js";
import { pendingChatSendDedupeKey } from "../server-shared.js";
import { setGatewayDedupeEntry } from "./agent-job.js";
import {
  normalizeOptionalChatText as normalizeOptionalText,
  normalizeUnknownChatText as normalizeUnknownText,
} from "./chat-text-normalization.js";
import type { GatewayRequestContext, GatewayRequestHandlerOptions } from "./types.js";

export type ChatAbortRequester = {
  connId?: string;
  deviceId?: string;
  isAdmin: boolean;
};

type PreRegisteredAgentDedupePayload = {
  agentId?: unknown;
  attemptId?: unknown;
  controlUiVisible?: unknown;
  dedupeKeys?: unknown;
  expiresAtMs?: unknown;
  ownerConnId?: unknown;
  ownerDeviceId?: unknown;
  runId?: unknown;
  sessionKey?: unknown;
  sessionKeyAliases?: unknown;
  status?: unknown;
  turnKind?: unknown;
};

type PreRegisteredAgentRun = {
  runId: string;
  sessionKey: string;
  payload: PreRegisteredAgentDedupePayload;
};

export function buildAbortedChatSendPayload(params: {
  runId: string;
  endedAt: number;
  stopReason?: string;
}) {
  return {
    runId: params.runId,
    status: "timeout" as const,
    summary: "aborted",
    ...(params.stopReason ? { stopReason: params.stopReason } : {}),
    endedAt: params.endedAt,
  };
}

export function resolveChatAbortRequester(
  client: GatewayRequestHandlerOptions["client"],
): ChatAbortRequester {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  return {
    connId: normalizeOptionalText(client?.connId),
    deviceId: normalizeOptionalText(client?.connect?.device?.id),
    isAdmin: scopes.includes(ADMIN_SCOPE),
  };
}

export function canRequesterAbortChatRun(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  return false;
}

export function canRequesterAbortChatRunWithoutSessionMatch(
  entry: ChatAbortControllerEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  return Boolean(
    (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) ||
    (ownerConnId && requester.connId && ownerConnId === requester.connId),
  );
}

export function readPreRegisteredAgentDedupePayloadForSession(params: {
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  runId: string;
  sessionKey: string;
  agentId?: string;
  defaultAgentId: string;
  includeHidden?: boolean;
}): PreRegisteredAgentDedupePayload | undefined {
  if (!params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (!params.includeHidden && payload.controlUiVisible === false) {
    return undefined;
  }
  const payloadRunId = normalizeUnknownText(payload.runId);
  if (payloadRunId && payloadRunId !== params.runId) {
    return undefined;
  }
  const payloadSessionKeys = new Set([
    normalizeUnknownText(payload.sessionKey),
    ...(Array.isArray(payload.sessionKeyAliases)
      ? payload.sessionKeyAliases.map(normalizeUnknownText)
      : []),
  ]);
  const hasPayloadSessionKey = [...payloadSessionKeys].some(Boolean);
  if (
    (hasPayloadSessionKey && !payloadSessionKeys.has(params.sessionKey)) ||
    (!hasPayloadSessionKey && payloadRunId !== params.runId)
  ) {
    return undefined;
  }
  const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
  if (agentId) {
    const parsed = parseAgentSessionKey(params.sessionKey);
    const sessionAgentId =
      params.sessionKey === "global"
        ? resolveStoredGlobalRunAgentId(
            normalizeUnknownText(payload.agentId),
            params.defaultAgentId,
          )
        : parsed?.agentId
          ? normalizeAgentId(parsed.agentId)
          : undefined;
    if (sessionAgentId && sessionAgentId !== agentId) {
      return undefined;
    }
  }
  return payload;
}

export function readPreRegisteredRun(params: {
  key: string;
  entry: GatewayRequestContext["dedupe"] extends Map<string, infer T> ? T | undefined : never;
  keyPrefix: string;
}): PreRegisteredAgentRun | undefined {
  if (!params.key.startsWith(params.keyPrefix) || !params.entry?.ok) {
    return undefined;
  }
  const payload = params.entry.payload as PreRegisteredAgentDedupePayload | undefined;
  if (payload?.status !== "accepted") {
    return undefined;
  }
  if (payload.controlUiVisible === false) {
    return undefined;
  }
  const runId =
    normalizeUnknownText(payload.runId) ??
    normalizeOptionalText(params.key.slice(params.keyPrefix.length));
  const sessionKey = normalizeUnknownText(payload.sessionKey);
  if (!runId || !sessionKey) {
    return undefined;
  }
  return { runId, sessionKey, payload };
}

export function canRequesterAbortPreRegisteredRun(
  payload: PreRegisteredAgentDedupePayload,
  requester: ChatAbortRequester,
): boolean {
  return canRequesterAbortChatRun(
    {
      controller: new AbortController(),
      sessionId: "",
      sessionKey: normalizeUnknownText(payload.sessionKey) ?? "",
      startedAtMs: 0,
      expiresAtMs: 0,
      ownerConnId: normalizeUnknownText(payload.ownerConnId),
      ownerDeviceId: normalizeUnknownText(payload.ownerDeviceId),
      controlUiVisible: payload.controlUiVisible === false ? false : undefined,
      kind: "agent",
    },
    requester,
  );
}

function resolvePreRegisteredAgentDedupeKeys(
  payload: PreRegisteredAgentDedupePayload,
  runId: string,
): string[] {
  const keys = [`agent:${runId}`];
  const payloadKeys = Array.isArray(payload.dedupeKeys) ? payload.dedupeKeys : [];
  for (const key of payloadKeys) {
    const normalized = normalizeUnknownText(key);
    if (normalized?.startsWith("agent:")) {
      keys.push(normalized);
    }
  }
  return uniqueStrings(keys);
}

export function resolveStoredGlobalRunAgentId(
  agentId: string | undefined,
  defaultAgentId: string,
): string {
  return normalizeOptionalText(agentId)?.toLowerCase() ?? defaultAgentId.toLowerCase();
}

export function writePreRegisteredAgentAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  sessionKey?: string;
  payload: PreRegisteredAgentDedupePayload;
  stopReason: string;
  endedAt?: number;
}) {
  const endedAt = params.endedAt ?? Date.now();
  const payloadAgentId = normalizeUnknownText(params.payload.agentId);
  for (const key of resolvePreRegisteredAgentDedupeKeys(params.payload, params.runId)) {
    setGatewayDedupeEntry({
      dedupe: params.context.dedupe,
      key,
      entry: {
        ts: endedAt,
        ok: true,
        payload: {
          runId: params.runId,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
          ...(params.payload.controlUiVisible === false ? { controlUiVisible: false } : {}),
          status: "timeout" as const,
          summary: "aborted",
          stopReason: params.stopReason,
          endedAt,
        },
      },
    });
  }
}

export function writePreRegisteredChatAbort(params: {
  context: GatewayRequestContext;
  runId: string;
  stopReason: string;
  endedAt?: number;
  attemptId?: string;
}) {
  const endedAt = params.endedAt ?? Date.now();
  const payload = buildAbortedChatSendPayload({
    runId: params.runId,
    stopReason: params.stopReason,
    endedAt,
  });
  params.context.chatAbortedRuns.set(params.runId, createChatAbortMarker(endedAt));
  const pendingKey = pendingChatSendDedupeKey(params.runId);
  const pendingAttemptId = normalizeUnknownText(
    (params.context.dedupe.get(pendingKey)?.payload as PreRegisteredAgentDedupePayload | undefined)
      ?.attemptId,
  );
  if (!params.attemptId || pendingAttemptId === params.attemptId) {
    params.context.dedupe.delete(pendingKey);
  }
  setGatewayDedupeEntry({
    dedupe: params.context.dedupe,
    key: `chat:${params.runId}`,
    entry: { ts: endedAt, ok: true, payload },
  });
}

export function resolveAuthorizedPreRegisteredRunsForSessionKeys(params: {
  context: GatewayRequestContext;
  sessionKeys: Iterable<string>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
  keyPrefix: string;
  preserveSideRuns?: boolean;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const authorizedByRunId = new Map<string, PreRegisteredAgentRun>();
  let matchedSessionRuns = 0;
  for (const [key, entry] of params.context.dedupe) {
    const run = readPreRegisteredRun({ key, entry, keyPrefix: params.keyPrefix });
    if (!run) {
      continue;
    }
    if (params.preserveSideRuns && normalizeUnknownText(run.payload.turnKind) === "btw") {
      continue;
    }
    const runSessionKeys = [
      run.sessionKey,
      ...(Array.isArray(run.payload.sessionKeyAliases)
        ? run.payload.sessionKeyAliases.map(normalizeUnknownText)
        : []),
    ];
    if (!runSessionKeys.some((sessionKey) => Boolean(sessionKey && sessionKeys.has(sessionKey)))) {
      continue;
    }
    if (params.context.chatAbortControllers.has(run.runId)) {
      continue;
    }
    const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
    if (
      agentId &&
      run.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(
        normalizeUnknownText(run.payload.agentId),
        params.defaultAgentId,
      ) !== agentId
    ) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortPreRegisteredRun(run.payload, params.requester)) {
      authorizedByRunId.set(run.runId, run);
    }
  }
  return {
    matchedSessionRuns,
    authorizedRuns: [...authorizedByRunId.values()],
  };
}

export function resolveAuthorizedRunsForSessionKeys(params: {
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  agentId?: string;
  defaultAgentId: string;
  requester: ChatAbortRequester;
  preserveSideRuns?: boolean;
}) {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (sessionKey) => normalizeOptionalText(sessionKey)).filter(
      (sessionKey): sessionKey is string => Boolean(sessionKey),
    ),
  );
  const sessionIds = new Set(
    Array.from(params.sessionIds ?? [], (sessionId) => normalizeOptionalText(sessionId)).filter(
      (sessionId): sessionId is string => Boolean(sessionId),
    ),
  );
  const agentId = normalizeOptionalText(params.agentId)?.toLowerCase();
  const authorizedRuns: Array<{ runId: string; sessionKey: string }> = [];
  let matchedSessionRuns = 0;
  for (const [runId, active] of params.chatAbortControllers) {
    if (active.controlUiVisible === false) {
      continue;
    }
    if (params.preserveSideRuns && active.turnKind === "btw") {
      continue;
    }
    if (!sessionKeys.has(active.sessionKey) && !sessionIds.has(active.sessionId)) {
      continue;
    }
    if (
      agentId &&
      active.sessionKey === "global" &&
      resolveStoredGlobalRunAgentId(active.agentId, params.defaultAgentId) !== agentId
    ) {
      continue;
    }
    matchedSessionRuns += 1;
    if (canRequesterAbortChatRun(active, params.requester)) {
      authorizedRuns.push({ runId, sessionKey: active.sessionKey });
    }
  }
  return {
    matchedSessionRuns,
    authorizedRuns,
  };
}

export function canRequesterAbortQueuedChatTurn(
  entry: QueuedChatTurnEntry,
  requester: ChatAbortRequester,
): boolean {
  // Same ownership rules as active chat runs.
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  if (!ownerDeviceId && !ownerConnId) {
    return true;
  }
  if (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) {
    return true;
  }
  if (ownerConnId && requester.connId && ownerConnId === requester.connId) {
    return true;
  }
  return false;
}

export function canRequesterAbortQueuedChatTurnWithoutSessionMatch(
  entry: QueuedChatTurnEntry,
  requester: ChatAbortRequester,
): boolean {
  if (requester.isAdmin) {
    return true;
  }
  const ownerDeviceId = normalizeOptionalText(entry.ownerDeviceId);
  const ownerConnId = normalizeOptionalText(entry.ownerConnId);
  return Boolean(
    (ownerDeviceId && requester.deviceId && ownerDeviceId === requester.deviceId) ||
    (ownerConnId && requester.connId && ownerConnId === requester.connId),
  );
}
