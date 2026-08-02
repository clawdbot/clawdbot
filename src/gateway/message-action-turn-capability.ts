import { randomBytes } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { ChannelThreadingToolContext } from "../channels/plugins/types.public.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../utils/message-channel-normalize.js";

const DEFAULT_TTL_MS = 15 * 60_000;
const MAX_TTL_MS = 24 * 60 * 60_000;
const MAX_ACTIVE_CAPABILITIES = 4096;

export type AgentRuntimeMessageActionContext = {
  expiresAtMs: number;
  sessionId?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  toolContext?: ChannelThreadingToolContext;
};

export type MessageActionTurnCapabilityRejectionReason =
  | "token_missing"
  | "token_conflict"
  | "token_unknown"
  | "expired"
  | "agent_mismatch"
  | "run_mismatch"
  | "session_key_mismatch"
  | "session_id_mismatch";

export type MessageActionTurnCapabilityResolution =
  | { ok: true; context: AgentRuntimeMessageActionContext }
  | { ok: false; reason: MessageActionTurnCapabilityRejectionReason };

type MessageActionTurnCapability = AgentRuntimeMessageActionContext & {
  agentId: string;
  runId: string;
  sessionKey: string;
};

const capabilitiesByToken = new Map<string, MessageActionTurnCapability>();
export function isTrustedMessageActionTurnIngress(provider: string | null | undefined): boolean {
  const normalized = normalizeMessageChannel(provider);
  return normalized !== undefined && isDeliverableMessageChannel(normalized);
}

function resolveTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value) || value === undefined || value <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(Math.trunc(value), MAX_TTL_MS);
}

function copyToolContext(
  context: ChannelThreadingToolContext | undefined,
): ChannelThreadingToolContext | undefined {
  if (!context) {
    return undefined;
  }
  return {
    currentChannelId: normalizeOptionalString(context.currentChannelId),
    currentChatType: context.currentChatType,
    currentMessagingTarget: normalizeOptionalString(context.currentMessagingTarget),
    currentGraphChannelId: normalizeOptionalString(context.currentGraphChannelId),
    currentChannelProvider: context.currentChannelProvider,
    currentThreadTs: normalizeOptionalString(context.currentThreadTs),
    currentMessageId: context.currentMessageId,
    replyToMode: context.replyToMode,
    // Reply-to-first state is intentionally shared across actions in one turn.
    // Preserve only this trusted process-local mutable reference.
    hasRepliedRef: context.hasRepliedRef,
    sameChannelThreadRequired: context.sameChannelThreadRequired,
    skipCrossContextDecoration: context.skipCrossContextDecoration,
  };
}

function evictOldestCapability(): void {
  const oldest = capabilitiesByToken.keys().next().value;
  if (typeof oldest === "string") {
    capabilitiesByToken.delete(oldest);
  }
}

function sweepExpiredMessageActionTurnCapabilities(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [token, capability] of capabilitiesByToken) {
    if (nowMs >= capability.expiresAtMs) {
      capabilitiesByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

/**
 * Mint an opaque current-turn capability from trusted channel ingress.
 * Public Gateway agent requests never receive this token.
 */
export function mintMessageActionTurnCapability(params: {
  agentId: string;
  runId: string;
  sessionKey: string;
  sessionId?: string;
  requesterAccountId?: string;
  requesterSenderId?: string;
  toolContext?: ChannelThreadingToolContext;
  ttlMs?: number;
  nowMs?: number;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const runId = params.runId.trim();
  const sessionKey = params.sessionKey.trim();
  if (!agentId || !runId || !sessionKey) {
    throw new Error("message action turn capability requires agent, run, and session identity");
  }
  const nowMs = params.nowMs ?? Date.now();
  sweepExpiredMessageActionTurnCapabilities(nowMs);
  while (capabilitiesByToken.size >= MAX_ACTIVE_CAPABILITIES) {
    // A bounded fail-closed store prevents abandoned long-running turns from
    // growing process memory without creating a second persistent state path.
    evictOldestCapability();
  }
  const token = randomBytes(32).toString("base64url");
  capabilitiesByToken.set(token, {
    agentId,
    runId,
    sessionKey,
    expiresAtMs: nowMs + resolveTtlMs(params.ttlMs),
    sessionId: normalizeOptionalString(params.sessionId),
    requesterAccountId: normalizeOptionalString(params.requesterAccountId),
    requesterSenderId: normalizeOptionalString(params.requesterSenderId),
    toolContext: copyToolContext(params.toolContext),
  });
  return token;
}

export function resolveMessageActionTurnCapabilityDiagnostic(params: {
  token?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  nowMs?: number;
}): MessageActionTurnCapabilityResolution {
  const token = params.token?.trim();
  if (!token) {
    return { ok: false, reason: "token_missing" };
  }
  const capability = capabilitiesByToken.get(token);
  if (!capability) {
    return { ok: false, reason: "token_unknown" };
  }
  const nowMs = params.nowMs ?? Date.now();
  if (nowMs >= capability.expiresAtMs) {
    capabilitiesByToken.delete(token);
    return { ok: false, reason: "expired" };
  }
  if (capability.agentId !== normalizeAgentId(params.agentId)) {
    return { ok: false, reason: "agent_mismatch" };
  }
  if (capability.runId !== params.runId?.trim()) {
    return { ok: false, reason: "run_mismatch" };
  }
  if (capability.sessionKey !== params.sessionKey.trim()) {
    return { ok: false, reason: "session_key_mismatch" };
  }
  if (capability.sessionId && capability.sessionId !== normalizeOptionalString(params.sessionId)) {
    return { ok: false, reason: "session_id_mismatch" };
  }
  return {
    ok: true,
    context: {
      expiresAtMs: capability.expiresAtMs,
      sessionId: capability.sessionId,
      requesterAccountId: capability.requesterAccountId,
      requesterSenderId: capability.requesterSenderId,
      toolContext: copyToolContext(capability.toolContext),
    },
  };
}

export function resolveMessageActionTurnCapability(params: {
  token?: string;
  agentId: string;
  runId?: string;
  sessionKey: string;
  sessionId?: string;
  nowMs?: number;
}): AgentRuntimeMessageActionContext | undefined {
  const resolution = resolveMessageActionTurnCapabilityDiagnostic(params);
  return resolution.ok ? resolution.context : undefined;
}

export function revokeMessageActionTurnCapability(token: string | undefined): boolean {
  return token ? capabilitiesByToken.delete(token) : false;
}
