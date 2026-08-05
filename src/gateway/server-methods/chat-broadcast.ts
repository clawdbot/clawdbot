import { resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getReplyPayloadMetadata, type ReplyPayload } from "../../auto-reply/reply-payload.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { projectChatDisplayMessage } from "../chat-display-projection.js";
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

function resolveGlobalAwareNodeChatDeliveryKeys(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  agentId?: string;
}): string[] {
  if (params.sessionKey !== "global") {
    return [params.sessionKey];
  }
  const defaultAgentId = resolveDefaultAgentId(params.cfg);
  const scopedAgentId = params.agentId ?? defaultAgentId;
  const keys = [`agent:${scopedAgentId}:global`];
  if (scopedAgentId === defaultAgentId) {
    keys.push("global");
  }
  return keys;
}

export function sendGlobalAwareNodeChatPayload(params: {
  context: Pick<GatewayRequestContext, "nodeSendToSession"> &
    Partial<Pick<GatewayRequestContext, "getRuntimeConfig">>;
  sessionKey: string;
  agentId?: string;
  event: string;
  payload: unknown;
}): void {
  const deliveryKeys = resolveGlobalAwareNodeChatDeliveryKeys({
    cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
    sessionKey: params.sessionKey,
    agentId: params.agentId,
  });
  for (const deliveryKey of deliveryKeys) {
    params.context.nodeSendToSession(deliveryKey, params.event, params.payload);
  }
}

export function broadcastChatFinal(params: {
  context: ChatBroadcastContext;
  runId: string;
  sessionKey: string;
  agentId?: string;
  message?: Record<string, unknown>;
}): void {
  const seq = nextChatSeq(params.context, params.runId);
  const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    state: "final" as const,
    message: projectChatDisplayMessage(params.message),
  };
  params.context.broadcast("chat", payload, {
    sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({
      cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
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
  const payloadAgentId =
    params.payload.sessionKey === "global" ? params.payload.agentId : undefined;
  const payload = {
    ...params.payload,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
  };
  params.context.broadcast("chat.side_result", payload, {
    sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({
      cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
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

export function broadcastChatError(params: {
  context: ChatBroadcastContext;
  runId: string;
  sessionKey: string;
  agentId?: string;
  errorMessage?: string;
}): void {
  const seq = nextChatSeq(params.context, params.runId);
  const payloadAgentId = params.sessionKey === "global" ? params.agentId : undefined;
  const payload = {
    runId: params.runId,
    sessionKey: params.sessionKey,
    ...(payloadAgentId ? { agentId: payloadAgentId } : {}),
    seq,
    state: "error" as const,
    errorMessage: params.errorMessage,
  };
  params.context.broadcast("chat", payload, {
    sessionKeys: resolveGlobalAwareNodeChatDeliveryKeys({
      cfg: params.context.getRuntimeConfig?.() ?? ({} as OpenClawConfig),
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

export function isSourceReplyTranscriptMirrorPayload(payload: ReplyPayload | undefined): boolean {
  return Boolean(payload && getReplyPayloadMetadata(payload)?.sourceReplyTranscriptMirror);
}
