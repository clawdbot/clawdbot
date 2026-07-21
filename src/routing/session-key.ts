import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
// Routing session key helpers build stable session keys from route targets.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { ChatType } from "../channels/chat-type.js";
import {
  isCronRunSessionKey,
  normalizeSessionPeerId,
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseAgentSessionKey,
} from "../sessions/session-key-utils.js";
import { normalizeAccountId } from "./account-id.js";

export {
  isCronSessionKey,
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
  parseSessionDeliveryRoute,
  parseThreadSessionSuffix,
  type ParsedAgentSessionKey,
} from "../sessions/session-key-utils.js";
export {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "./account-id.js";
export { isValidAgentId, normalizeAgentId };

/** Legacy on-disk identity used only by doctor/migration and their fixtures. */
export const LEGACY_IMPLICIT_AGENT_ID = "main";
/** @deprecated legacy implicit agent id; use roster default resolution. Removal: next major SDK cut. */
export const DEFAULT_AGENT_ID = LEGACY_IMPLICIT_AGENT_ID;
export const DEFAULT_MAIN_KEY = "main";
const INCOGNITO_SESSION_RE = /^(?:dashboard|subagent|internal-session-effects):incognito-[^:]+$/u;
type SessionKeyShape = "missing" | "agent" | "legacy_or_alias" | "malformed_agent";

function normalizeToken(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value);
}

export function scopedHeartbeatWakeOptions<T extends object>(
  sessionKey: string,
  wakeOptions: T,
  mainKey?: string,
  scope?: "per-sender" | "global",
): T | (T & { sessionKey: string }) | (T & { agentId: string }) {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return wakeOptions;
  }
  if (isCronRunSessionKey(sessionKey)) {
    // Global-scope agents drain the literal "global" queue, not agent-main;
    // a targeted wake on agent:<id>:main would be unresolvable. Drop the
    // sessionKey but carry the agent target so multi-agent global-scope
    // setups still wake the originating agent's heartbeat.
    if (scope === "global") {
      return { ...wakeOptions, agentId: parsed.agentId };
    }
    return {
      ...wakeOptions,
      sessionKey: buildAgentMainSessionKey({ agentId: parsed.agentId, mainKey }),
    };
  }
  return { ...wakeOptions, sessionKey };
}

export function resolveEventSessionKey(
  sessionKey: string,
  mainKey?: string,
  scope?: "per-sender" | "global",
): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed || !isCronRunSessionKey(sessionKey)) {
    return sessionKey;
  }
  // Global-scope agents enqueue/drain via the literal "global" queue; agent-main
  // would strand the event in a queue the heartbeat never peeks.
  if (scope === "global") {
    return "global";
  }
  return buildAgentMainSessionKey({ agentId: parsed.agentId, mainKey });
}

export function normalizeMainKey(value: string | undefined | null): string {
  return normalizeLowercaseStringOrEmpty(value) || DEFAULT_MAIN_KEY;
}

export function toAgentRequestSessionKey(storeKey: string | undefined | null): string | undefined {
  const raw = (storeKey ?? "").trim();
  if (!raw) {
    return undefined;
  }
  return parseAgentSessionKey(raw)?.rest ?? raw;
}

export function agentSessionKeysMatchByRequestKey(
  left: string | undefined | null,
  right: string | undefined | null,
): boolean {
  const leftRaw = (left ?? "").trim();
  const rightRaw = (right ?? "").trim();
  if (!leftRaw || !rightRaw) {
    return false;
  }
  return (
    leftRaw === rightRaw || toAgentRequestSessionKey(leftRaw) === toAgentRequestSessionKey(rightRaw)
  );
}

export function toAgentStoreSessionKey(params: {
  agentId: string;
  requestKey: string | undefined | null;
  mainKey?: string | undefined;
}): string {
  const raw = (params.requestKey ?? "").trim();
  const lowered = normalizeLowercaseStringOrEmpty(raw);
  if (!raw || lowered === DEFAULT_MAIN_KEY) {
    return buildAgentMainSessionKey({ agentId: params.agentId, mainKey: params.mainKey });
  }
  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    return `agent:${parsed.agentId}:${parsed.rest}`;
  }
  const normalized = normalizeSessionKeyPreservingOpaquePeerIds(raw);
  if (lowered.startsWith("agent:")) {
    return normalized;
  }
  return `agent:${normalizeAgentId(params.agentId)}:${normalized}`;
}

export function resolveAgentIdFromSessionKey(
  sessionKey: string | undefined | null,
  configuredDefaultAgentId?: string,
): string {
  const parsed = parseAgentSessionKey(sessionKey);
  if (parsed?.agentId) {
    return normalizeAgentId(parsed.agentId);
  }
  if (configuredDefaultAgentId) {
    return normalizeAgentId(configuredDefaultAgentId);
  }
  throw new Error(
    "Session key does not contain an agent id; resolve it with the configured default agent.",
  );
}

export function classifySessionKeyShape(sessionKey: string | undefined | null): SessionKeyShape {
  const raw = (sessionKey ?? "").trim();
  if (!raw) {
    return "missing";
  }
  if (parseAgentSessionKey(raw)) {
    return "agent";
  }
  return normalizeLowercaseStringOrEmpty(raw).startsWith("agent:")
    ? "malformed_agent"
    : "legacy_or_alias";
}

export function isUnscopedSessionKeySentinel(sessionKey: string | undefined | null): boolean {
  const lowered = normalizeLowercaseStringOrEmpty(sessionKey);
  return lowered === "global" || lowered === "unknown";
}

/** Classifies process-only session keys without consulting runtime registry state. */
export function isIncognitoSessionKey(sessionKey: string | undefined | null): boolean {
  const rest = parseAgentSessionKey(sessionKey)?.rest;
  return typeof rest === "string" && INCOGNITO_SESSION_RE.test(rest);
}

export function scopeLegacySessionKeyToAgent(params: {
  agentId?: string | undefined;
  sessionKey?: string | undefined;
  mainKey?: string | undefined;
}): string | undefined {
  const raw = (params.sessionKey ?? "").trim();
  if (!raw) {
    return undefined;
  }
  const agentId = params.agentId?.trim();
  if (!agentId || classifySessionKeyShape(raw) !== "legacy_or_alias") {
    return raw;
  }
  return toAgentStoreSessionKey({
    agentId,
    requestKey: raw,
    mainKey: params.mainKey,
  });
}

export function normalizeOptionalAgentId(value: unknown): string | undefined {
  const trimmed = normalizeOptionalString(value);
  return trimmed ? normalizeAgentId(trimmed) : undefined;
}

export function sanitizeAgentId(value: string | undefined | null): string {
  return normalizeAgentId(value);
}

export function buildAgentMainSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
}): string {
  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.mainKey);
  return `agent:${agentId}:${mainKey}`;
}

export function buildAgentPeerSessionKey(params: {
  agentId: string;
  mainKey?: string | undefined;
  channel: string;
  accountId?: string | null;
  peerKind?: ChatType | null;
  peerId?: string | null;
  identityLinks?: Record<string, string[]>;
  /** DM session scope. */
  dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
}): string {
  const peerKind = params.peerKind ?? "direct";
  if (peerKind === "direct") {
    const dmScope = params.dmScope ?? "main";
    let peerId = (params.peerId ?? "").trim();
    const linkedPeerId =
      dmScope === "main"
        ? null
        : resolveLinkedPeerId({
            identityLinks: params.identityLinks,
            channel: params.channel,
            peerId,
          });
    if (linkedPeerId) {
      peerId = linkedPeerId;
    }
    peerId = normalizeLowercaseStringOrEmpty(peerId);
    if (dmScope === "per-account-channel-peer" && peerId) {
      const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
      const accountId = normalizeAccountId(params.accountId);
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:${accountId}:direct:${peerId}`;
    }
    if (dmScope === "per-channel-peer" && peerId) {
      const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
      return `agent:${normalizeAgentId(params.agentId)}:${channel}:direct:${peerId}`;
    }
    if (dmScope === "per-peer" && peerId) {
      return `agent:${normalizeAgentId(params.agentId)}:direct:${peerId}`;
    }
    return buildAgentMainSessionKey({
      agentId: params.agentId,
      mainKey: params.mainKey,
    });
  }
  const channel = normalizeLowercaseStringOrEmpty(params.channel) || "unknown";
  const peerId =
    normalizeSessionPeerId({
      channel: params.channel,
      peerKind,
      peerId: params.peerId,
    }) || "unknown";
  return `agent:${normalizeAgentId(params.agentId)}:${channel}:${peerKind}:${peerId}`;
}

function resolveLinkedPeerId(params: {
  identityLinks?: Record<string, string[]>;
  channel: string;
  peerId: string;
}): string | null {
  const identityLinks = params.identityLinks;
  if (!identityLinks) {
    return null;
  }
  const peerId = params.peerId.trim();
  if (!peerId) {
    return null;
  }
  const candidates = new Set<string>();
  const rawCandidate = normalizeToken(peerId);
  if (rawCandidate) {
    candidates.add(rawCandidate);
  }
  const channel = normalizeToken(params.channel);
  if (channel) {
    const scopedCandidate = normalizeToken(`${channel}:${peerId}`);
    if (scopedCandidate) {
      candidates.add(scopedCandidate);
    }
  }
  if (candidates.size === 0) {
    return null;
  }
  for (const [canonical, ids] of Object.entries(identityLinks)) {
    const canonicalName = canonical.trim();
    if (!canonicalName) {
      continue;
    }
    if (!Array.isArray(ids)) {
      continue;
    }
    for (const id of ids) {
      const normalized = normalizeToken(id);
      if (normalized && candidates.has(normalized)) {
        return canonicalName;
      }
    }
  }
  return null;
}

export function buildGroupHistoryKey(params: {
  channel: string;
  accountId?: string | null;
  peerKind: "group" | "channel";
  peerId: string;
}): string {
  const channel = normalizeToken(params.channel) || "unknown";
  const accountId = normalizeAccountId(params.accountId);
  const peerId =
    normalizeSessionPeerId({
      channel,
      peerKind: params.peerKind,
      peerId: params.peerId,
    }) || "unknown";
  return `${channel}:${accountId}:${params.peerKind}:${peerId}`;
}

export function resolveThreadSessionKeys(params: {
  baseSessionKey: string;
  threadId?: string | null;
  parentSessionKey?: string;
  useSuffix?: boolean;
  normalizeThreadId?: (threadId: string) => string;
}): { sessionKey: string; parentSessionKey?: string } {
  const threadId = (params.threadId ?? "").trim();
  if (!threadId) {
    return { sessionKey: params.baseSessionKey, parentSessionKey: undefined };
  }
  const normalizedThread =
    params.normalizeThreadId?.(threadId) ?? normalizeLowercaseStringOrEmpty(threadId);
  const useSuffix = params.useSuffix ?? true;
  const sessionKey = useSuffix
    ? `${params.baseSessionKey}:thread:${normalizedThread}`
    : params.baseSessionKey;
  return { sessionKey, parentSessionKey: params.parentSessionKey };
}
