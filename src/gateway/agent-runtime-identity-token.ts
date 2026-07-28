// Purpose-scoped local agent runtime identity token for Gateway clients.
import { createHmac } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeChatType } from "../channels/chat-type.js";
import type { ChannelId } from "../channels/plugins/types.public.js";
import type { InternalChannelThreadingToolContext } from "../channels/threading-tool-context-internal.js";
import { ensureExecApprovalsSnapshot, loadExecApprovalsAsync } from "../infra/exec-approvals.js";
import { normalizeOptionalAccountId } from "../routing/account-id.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import type { AgentRuntimeMessageActionContext } from "./message-action-turn-capability.js";

const AGENT_RUNTIME_IDENTITY_TOKEN_CONTEXT = "openclaw:gateway-agent-runtime-identity-token:v1";
const AGENT_RUNTIME_IDENTITY_TOKEN_KIND = "agent-runtime";
const MESSAGE_ACTION_TOKEN_TTL_MS = 60_000;
const CRON_SELF_MANAGEMENT_TOKEN_TTL_MS = 60_000;

type AgentRuntimeCronSelfManagementContext = {
  jobId: string;
  expiresAtMs: number;
};

export type AgentRuntimeIdentity = {
  kind: "agentRuntime";
  agentId: string;
  sessionKey: string;
  turnSourceAccountId?: string;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementContext?: AgentRuntimeCronSelfManagementContext;
};

type AgentRuntimeIdentityTokenPayload = {
  kind: typeof AGENT_RUNTIME_IDENTITY_TOKEN_KIND;
  agentId: string;
  sessionKey: string;
  turnSourceAccountId?: string;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementContext?: AgentRuntimeCronSelfManagementContext;
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
  const sourceReplyFinal = value.sourceReplyFinal;
  const sourceReplyToolCallId = normalizeOptionalString(value.sourceReplyToolCallId);
  if (sourceReplyFinal !== undefined && typeof sourceReplyFinal !== "boolean") {
    return undefined;
  }
  if (value.sourceReplyToolCallId !== undefined && !sourceReplyToolCallId) {
    return undefined;
  }
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
  const toolContext: InternalChannelThreadingToolContext | undefined = rawToolContext
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
        currentSourceTurnId: normalizeOptionalString(rawToolContext.currentSourceTurnId),
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
      } satisfies InternalChannelThreadingToolContext)
    : undefined;
  const context = {
    expiresAtMs: value.expiresAtMs,
    sessionId: normalizeOptionalString(value.sessionId),
    requesterAccountId: normalizeOptionalString(value.requesterAccountId),
    requesterSenderId: normalizeOptionalString(value.requesterSenderId),
    toolContext,
  };
  if (sourceReplyFinal === true) {
    if (!sourceReplyToolCallId) {
      return undefined;
    }
    return { ...context, sourceReplyFinal: true, sourceReplyToolCallId };
  }
  return {
    ...context,
    ...(sourceReplyFinal === false ? { sourceReplyFinal: false as const } : {}),
    ...(sourceReplyToolCallId ? { sourceReplyToolCallId } : {}),
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
      turnSourceAccountId?: unknown;
      messageActionContext?: unknown;
      cronSelfManagementContext?: unknown;
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
    const turnSourceAccountId = normalizeOptionalAccountId(
      typeof raw.turnSourceAccountId === "string" ? raw.turnSourceAccountId : undefined,
    );
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
    const rawCronSelfManagement = raw.cronSelfManagementContext;
    const cronSelfManagementJobId =
      isRecord(rawCronSelfManagement) && typeof rawCronSelfManagement.jobId === "string"
        ? rawCronSelfManagement.jobId.trim()
        : "";
    const cronSelfManagementExpiresAtMs = isRecord(rawCronSelfManagement)
      ? rawCronSelfManagement.expiresAtMs
      : undefined;
    const cronSelfManagementContext =
      cronSelfManagementJobId &&
      typeof cronSelfManagementExpiresAtMs === "number" &&
      Number.isFinite(cronSelfManagementExpiresAtMs) &&
      nowMs < cronSelfManagementExpiresAtMs
        ? {
            jobId: cronSelfManagementJobId,
            expiresAtMs: cronSelfManagementExpiresAtMs,
          }
        : undefined;
    if (rawCronSelfManagement !== undefined && !cronSelfManagementContext) {
      return undefined;
    }
    return {
      kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
      agentId,
      sessionKey,
      ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
      ...(messageActionContext ? { messageActionContext } : {}),
      ...(cronSelfManagementContext ? { cronSelfManagementContext } : {}),
    };
  } catch {
    return undefined;
  }
}

/** Mint an opaque token that lets trusted local agent-tool clients identify their agent. */
export async function mintAgentRuntimeIdentityToken(params: {
  agentId: string;
  sessionKey: string;
  turnSourceAccountId?: string;
  messageActionContext?: AgentRuntimeMessageActionContext;
  cronSelfManagementJobId?: string;
}): Promise<string> {
  if (
    params.messageActionContext?.sourceReplyFinal === true &&
    !normalizeOptionalString(params.messageActionContext.sourceReplyToolCallId)
  ) {
    throw new Error("terminal source reply requires tool-call correlation");
  }
  const messageActionContext = params.messageActionContext
    ? {
        ...params.messageActionContext,
        // The process-local turn capability may live for the whole run, but a
        // copied bearer must expire shortly after its individual tool action.
        expiresAtMs: Math.min(
          params.messageActionContext.expiresAtMs,
          Date.now() + MESSAGE_ACTION_TOKEN_TTL_MS,
        ),
      }
    : undefined;
  const turnSourceAccountId = normalizeOptionalAccountId(params.turnSourceAccountId);
  const cronSelfManagementJobId = normalizeOptionalString(params.cronSelfManagementJobId);
  const cronSelfManagementContext = cronSelfManagementJobId
    ? {
        jobId: cronSelfManagementJobId,
        expiresAtMs: Date.now() + CRON_SELF_MANAGEMENT_TOKEN_TTL_MS,
      }
    : undefined;
  const payload = encodePayload({
    kind: AGENT_RUNTIME_IDENTITY_TOKEN_KIND,
    agentId: normalizeAgentId(params.agentId),
    sessionKey: params.sessionKey.trim(),
    ...(turnSourceAccountId ? { turnSourceAccountId } : {}),
    ...(messageActionContext ? { messageActionContext } : {}),
    ...(cronSelfManagementContext ? { cronSelfManagementContext } : {}),
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
  if (!sharedSecret || !safeEqualSecret(signature, signPayload(sharedSecret, payloadPart))) {
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
    ...(payload.turnSourceAccountId ? { turnSourceAccountId: payload.turnSourceAccountId } : {}),
    ...(payload.messageActionContext ? { messageActionContext: payload.messageActionContext } : {}),
    ...(payload.cronSelfManagementContext
      ? { cronSelfManagementContext: payload.cronSelfManagementContext }
      : {}),
  };
}
