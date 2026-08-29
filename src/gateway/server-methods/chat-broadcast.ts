import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
import { tryResolveSessionCompatibilityOwnerAgentId } from "../session-request-agent.js";
import type { GatewayRequestContext } from "./types.js";

type ChatBroadcastContext = Pick<
  GatewayRequestContext,
  "broadcast" | "nodeSendToSession" | "agentRunSeq"
> &
  Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;

type SideResultPayload = {
  kind: "btw";
  runId: string;
  sessionKey: string;
  agentId?: string;
  question: string;
  text: string;
  isError?: boolean;
  ts: number;
};

function nextChatSeq(context: { agentRunSeq: Map<string, number> }, runId: string): number {
  const next = (context.agentRunSeq.get(runId) ?? 0) + 1;
  context.agentRunSeq.set(runId, next);
  return next;
}

export function resolveGlobalAwareNodeChatDeliveryKeys(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): string[] {
  if (parseAgentSessionKey(params.sessionKey)) {
    return [params.sessionKey];
  }
  const unscopedOwnerAgentId = tryResolveSessionCompatibilityOwnerAgentId(
    params.cfg,
    params.sessionKey,
  );
  const selectedAgentId = params.agentId ?? unscopedOwnerAgentId;
  if (!selectedAgentId) {
    return [params.sessionKey];
  }
  const scopedAgentId = normalizeAgentId(selectedAgentId);
  const keys = [`agent:${scopedAgentId}:${params.sessionKey}`];
  if (
    unscopedOwnerAgentId &&
    normalizeAgentId(unscopedOwnerAgentId) === normalizeAgentId(scopedAgentId)
  ) {
    keys.push(params.sessionKey);
  }
  return keys;
}

function resolveChatSessionKeys(params: {
  context: Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  sessionKey: string;
  agentId?: string;
}): string[] {
  return resolveGlobalAwareNodeChatDeliveryKeys({
    cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
}

export function sendGlobalAwareNodeChatPayload(params: {
  context: Pick<GatewayRequestContext, "nodeSendToSession"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  sessionKey: string;
  agentId?: string;
  event: string;
  payload: unknown;
}): void {
  const deliveryKeys = resolveChatSessionKeys({
    context: params.context,
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  for (const deliveryKey of deliveryKeys) {
    params.context.nodeSendToSession(deliveryKey, params.event, params.payload);
  }
}

type ChatBroadcastParams = {
  context: ChatBroadcastContext;
  runId: string;
  sessionKey: string;
  agentId?: string;
};

type ChatTerminal =
  | { state: "final" | "aborted"; message?: Record<string, unknown>; stopReason?: string }
  | { state: "error"; errorMessage?: string; stopReason?: string; errorKind?: "timeout" };

export function broadcastChatTerminal(params: ChatBroadcastParams & ChatTerminal): void {
  const seq = nextChatSeq(params.context, params.runId);
  const payloadAgentId = parseAgentSessionKey(params.sessionKey) ? undefined : params.agentId;
  const terminal =
    params.state !== "error"
      ? {
          state: params.state,
          message: projectChatDisplayMessage(params.message),
          ...(params.stopReason ? { stopReason: params.stopReason } : {}),
        }
      : {
          state: params.state,
          errorMessage: params.errorMessage,
          ...(params.stopReason ? { stopReason: params.stopReason } : {}),
          ...(params.errorKind ? { errorKind: params.errorKind } : {}),
        };
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    ...terminal,
  };
  params.context.broadcast("chat", payload, {
    sessionKeys: resolveChatSessionKeys({
      context: params.context,
      sessionKey: params.sessionKey,
      agentId: payloadAgentId,
    }),
  });
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.sessionKey,
    agentId: payloadAgentId,
    event: "chat",
    payload,
  });
  params.context.agentRunSeq.delete(params.runId);
}

export function broadcastChatFinal(
  params: ChatBroadcastParams & { message?: Record<string, unknown> },
): void {
  broadcastChatTerminal({ ...params, state: "final" });
}

export function isBtwReplyPayload(payload: ReplyPayload | undefined): payload is ReplyPayload & {
  btw: { question: string };
  text: string;
} {
  return (
    typeof payload?.btw?.question === "string" &&
    payload.btw.question.trim().length > 0 &&
    typeof payload.text === "string" &&
    payload.text.trim().length > 0
  );
}

export function broadcastSideResult(params: {
  context: ChatBroadcastContext;
  payload: SideResultPayload;
}): void {
  const seq = nextChatSeq(params.context, params.payload.runId);
  const payloadAgentId = parseAgentSessionKey(params.payload.sessionKey)
    ? undefined
    : params.payload.agentId;
  const payload = {
    ...params.payload,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
  };
  params.context.broadcast("chat.side_result", payload, {
    sessionKeys: resolveChatSessionKeys({
      context: params.context,
      sessionKey: params.payload.sessionKey,
      agentId: payloadAgentId,
    }),
  });
  sendGlobalAwareNodeChatPayload({
    context: params.context,
    sessionKey: params.payload.sessionKey,
    agentId: payloadAgentId,
    event: "chat.side_result",
    payload,
  });
}

export function broadcastChatError(
  params: ChatBroadcastParams & Omit<Extract<ChatTerminal, { state: "error" }>, "state">,
): void {
  broadcastChatTerminal({ ...params, state: "error" });
}

export function isSourceReplyTranscriptMirrorPayload(payload: ReplyPayload | undefined): boolean {
  return Boolean(payload && getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror);
}
