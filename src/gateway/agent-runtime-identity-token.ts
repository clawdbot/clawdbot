// Purpose-scoped local agent runtime identity token for Gateway clients.
import { createHmac, timingSafeEqual } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { ChannelId, ChannelThreadingToolContext } from "../channels/plugins/types.public.js";
import { ensureExecApprovalsSnapshot, loadExecApprovalsAsync } from "../infra/exec-approvals.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { AgentRuntimeMessageActionContext } from "./message-action-turn-capability.js";

const AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT = "openclaw:gateway-agent-runtime-identity-token:v1";
const AGENT_RUNTIME_IDENTITY_TOKEN_KIND = "agent-runtime";

export type AgentRuntimeIdentity = {
  kind: "agentRuntime";
  agentId: string;
  sessionKey: string;
  messageActionContext?: AgentRuntimeMessageActionContext;
};

type AgentRuntimeIdentityTokenPayload = {
  kind: typeof AGENT_RUNTIME_IDENTITY_TOKEN_KIND;
  agentId: string;
  sessionKey: string;
  messageActionContext?: AgentRuntimeMessageActionContext;
};

async function readSharedAgentRuntimeIdentitySecret(): Promise<string | null> {
  return (await loadExecApprovalsAsync()).socket?.token?.trim() || null;
}

async function requireSharedAgentRuntimeIdentitySecret(): Promise<string> {
  const token = (await ensureExecApprovalsSnapshot()).file.socket?.token?.trim();
  if (!token) {
    throw new Error(
      "Unable to mint agent runtime identity token without local socket credentials.",
    );
  }
  return token;
}

function signPayload(secret: string, payload: string): string {
  return createHmac("sha256", secret)
    .update(AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function signatureMatches(value: string, expected: string): boolean {
  const valueBytes = Buffer.from(value);
  const expectedBytes = Buffer.from(expected);
  return valueBytes.length === expectedBytes.length && timingSafeEqual(valueBytes, expectedBytes);
}

function encodePayload(payload: AgentRuntimeIdentityTokenPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeMessageActionContext(
  value: unknown,
  nowMs: number,
): AgentRuntimeMessageActionContext | undefined {
  if (
    !isRecord(value) ||
    typeof value.expiresAtMs !== "number" ||
    !Number.isFinite(value.expiresAtMs) ||
    nowMs >= value.expiresAtMs
  ) {
    return undefined;
  }
  const rawToolContext = value.toolContext;
  if (rawToolContext !== undefined && !isRecord(rawToolContext)) {
    return undefined;
  }
  const rawCurrentChatType = rawToolContext?.currentChatType;
  const currentChatType = normalizeChatType(
    typeof rawCurrentChatType === "string" ? rawCurrentChatType : undefined,
  );
  const currentMessageId = rawToolContext?.currentMessageId;
  const replyToMode = rawToolContext?.replyToMode;
  const hasRepliedRef = rawToolContext?.hasRepliedRef;
  if (
    (currentMessageId !== undefined &&
      typeof currentMessageId !== "string" &&
      typeof currentMessageId !== "number") ||
    (replyToMode !== undefined &&
      replyToMode !== "off" &&
      replyToMode !== "first" &&
      replyToMode !== "all" &&
      replyToMode !== "batched") ||
    (hasRepliedRef !== undefined &&
      (!isRecord(hasRepliedRef) || typeof hasRepliedRef.value !== "boolean"))
  ) {
    return undefined;
  }
  const readOptionalBoolean = (key: string): boolean | undefined => {
    const candidate = rawToolContext?.[key];
    return typeof candidate === "boolean" ? candidate : undefined;
  };
  const toolContext: ChannelThreadingToolContext | undefined = rawToolContext
    ? ({
        currentChannelId: normalizeOptionalString(rawToolContext.currentChannelId),
        currentChatType,
        currentMessagingTarget: normalizeOptionalString(rawToolContext.currentMessagingTarget),
        currentGraphChannelId: normalizeOptionalString(rawToolContext.currentGraphChannelId),
        currentChannelProvider: normalizeOptionalString(rawToolContext.currentChannelProvider) as
          | ChannelId
          | undefined,
        currentThreadTs: normalizeOptionalString(rawToolContext.currentThreadTs),
        currentMessageId,
        replyToMode:
          replyToMode === "off" ||
          replyToMode === "first" ||
          replyToMode === "all" ||
          replyToMode === "batched"
            ? replyToMode
            : undefined,
        hasRepliedRef:
          isRecord(hasRepliedRef) && typeof hasRepliedRef.value === "boolean"
            ? { value: hasRepliedRef.value }
            : undefined,
        sameChannelThreadRequired: readOptionalBoolean("sameChannelThreadRequired"),
        skipCrossContextDecoration: readOptionalBoolean("skipCrossContextDecoration"),
      } satisfies ChannelThreadingToolContext)
    : undefined;
  return {
    expiresAtMs: value.expiresAtMs,
    sessionId: normalizeOptionalString(value.sessionId),
    requesterAccountId: normalizeOptionalString(value.requesterAccountId),
    requesterSenderId: normalizeOptionalString(value.requesterSenderId),
    toolContext,
  };
}

function decodePayload(value: string, nowMs: number): AgentRuntimeIdentityTokenPayload | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return undefined;
    }
    const raw = parsed as {
      kind?: unknown;
      agentId?: unknown;
      sessionKey?: unknown;
      messageActionContext?: unknown;
    };
    if (
      raw.kind !== AGENT_RUNTIME_IDENTITY_TOKEN_KIND ||
      typeof raw.agentId !== "string" ||
      typeof raw.sessionKey !== "string"
    ) {
      return undefined;
    }
    const agentId = normalizeAgentId(raw.agentId);
    const sessionKey = raw.sessionKey.trim();
    if (!agentId || !sessionKey) {
      return undefined;
    }
    const messageActionContext =
      raw.messageActionContext === undefined
        ? undefined
        : decodeMessageActionContext(raw.messageActionContext, nowMs);
    if (raw.messageActionContext !== undefined && !messageActionContext) {
      return undefined;
    }
    return {
      kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
      agentId,
      sessionKey,
      ...(messageActionContext ? { messageActionContext } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Mint an opaque token that lets trusted local agent-tool clients identify their agent. */
export async function mintAgentRuntimeIdentityToken(params: {
  agentId: string;
  sessionKey: string;
  messageActionContext?: AgentRuntimeMessageActionContext;
}): Promise<string> {
  const payload = encodePayload({
    kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
    agentId: normalizeAgentId(params.agentId),
    sessionKey: params.sessionKey.trim(),
    ...(params.messageActionContext ? { messageActionContext: params.messageActionContext } : {}),
  });
  const signature = signPayload(await requireSharedAgentRuntimeIdentitySecret(), payload);
  return `${payload}.${signature}`;
}

/** Validate a presented agent runtime token and return the internal caller identity. */
export async function verifyAgentRuntimeIdentityToken(
  value: string | null | undefined,
  nowMs?: number,
): Promise<AgentRuntimeIdentity | undefined> {
  const token = value?.trim();
  if (!token) {
    return undefined;
  }
  const [payloadPart, signature, ...extra] = token.split(".");
  if (!payloadPart || !signature || extra.length > 0) {
    return undefined;
  }
  const sharedSecret = await readSharedAgentRuntimeIdentitySecret();
  if (!sharedSecret || !signatureMatches(signature, signPayload(sharedSecret, payloadPart))) {
    return undefined;
  }
  const payload = decodePayload(payloadPart, nowMs ?? Date.now());
  if (!payload) {
    return undefined;
  }
  return {
    kind: "agentRuntime",
    agentId: payload.agentId,
    sessionKey: payload.sessionKey,
    ...(payload.messageActionContext ? { messageActionContext: payload.messageActionContext } : {}),
  };
}
