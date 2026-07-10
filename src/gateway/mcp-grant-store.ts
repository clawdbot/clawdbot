import crypto from "node:crypto";
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "../agents/exec-defaults.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";

export type McpLoopbackRequestContext = {
  sessionKey: string;
  runtimePolicySessionKey?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  modelProvider?: string;
  modelId?: string;
  messageProvider?: string;
  clientCaps?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string;
  currentInboundAudio?: boolean;
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  senderIsOwner: boolean;
  /** Capability minted only for Gateway-launched CLI backends. */
  nodeExecAllowed?: boolean;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides;
  bashElevated?: ExecElevatedDefaults;
  trigger?: string;
  approvalReviewerDeviceId?: string;
  channelContext?: PluginHookChannelContext;
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
};

export interface McpAttachGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** The openclaw session this grant is bound to; tool scope is resolved for this key. */
  readonly sessionKey: string;
  /** Absolute expiry (ms epoch). */
  readonly expiresAtMs: number;
  /** Absolute mint time (ms epoch). */
  readonly issuedAtMs: number;
}

export interface McpLoopbackClientGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Gateway-selected request context; child-process headers cannot widen it. */
  readonly context: McpLoopbackRequestContext;
}

type StoredMcpLoopbackClientGrant = McpLoopbackClientGrant & {
  runtimeOwnerToken: string;
  activeCaptureKey?: string;
};

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_TTL_MS = 12 * 60 * 60 * 1000;

const grantsByToken = new Map<string, McpAttachGrant>();
const clientGrantsByToken = new Map<string, StoredMcpLoopbackClientGrant>();

function clampTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(ttlMs as number, MAX_TTL_MS);
}

export function mintAttachGrant(params: {
  sessionKey: string;
  ttlMs?: number;
  nowMs?: number;
}): McpAttachGrant {
  const sessionKey = params.sessionKey?.trim() ?? "";
  if (!sessionKey) {
    throw new Error("mintAttachGrant: sessionKey is required");
  }
  const nowMs = params.nowMs ?? Date.now();
  // Mint sweeps stale entries so abandoned grants do not accumulate.
  sweepExpiredAttachGrants(nowMs);
  const grant: McpAttachGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    sessionKey,
    issuedAtMs: nowMs,
    expiresAtMs: nowMs + clampTtlMs(params.ttlMs),
  };
  grantsByToken.set(grant.token, grant);
  return grant;
}

export function resolveAttachGrant(
  token: string,
  nowMs: number = Date.now(),
): McpAttachGrant | undefined {
  const grant = grantsByToken.get(token);
  if (!grant) {
    return undefined;
  }
  if (nowMs >= grant.expiresAtMs) {
    grantsByToken.delete(token);
    return undefined;
  }
  return grant;
}

export function revokeAttachGrant(token: string): boolean {
  return grantsByToken.delete(token);
}

export function revokeAttachGrantsForSession(sessionKey: string): number {
  const key = sessionKey.trim();
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (grant.sessionKey === key) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function sweepExpiredAttachGrants(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (nowMs >= grant.expiresAtMs) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function attachGrantStoreSize(): number {
  return grantsByToken.size;
}

export function resetAttachGrantsForTest(): void {
  grantsByToken.clear();
}

export function mintMcpLoopbackClientGrant(params: {
  context: McpLoopbackRequestContext;
  runtimeOwnerToken: string;
}): McpLoopbackClientGrant {
  const sessionKey = params.context.sessionKey.trim();
  if (!sessionKey) {
    throw new Error("mintMcpLoopbackClientGrant: context.sessionKey is required");
  }
  const runtimeOwnerToken = params.runtimeOwnerToken.trim();
  if (!runtimeOwnerToken) {
    throw new Error("mintMcpLoopbackClientGrant: runtimeOwnerToken is required");
  }
  const grant: StoredMcpLoopbackClientGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    context: structuredClone({ ...params.context, sessionKey }),
    runtimeOwnerToken,
  };
  clientGrantsByToken.set(grant.token, grant);
  return structuredClone({
    token: grant.token,
    context: grant.context,
  });
}

/** Bind the active execution attempt's capture before its child process starts. */
export function activateMcpLoopbackClientGrantCapture(params: {
  token: string;
  runtimeOwnerToken: string;
  captureKey: string;
}): boolean {
  const captureKey = params.captureKey.trim();
  if (!captureKey) {
    throw new Error("activateMcpLoopbackClientGrantCapture: captureKey is required");
  }
  const grant = clientGrantsByToken.get(params.token);
  if (!grant || grant.runtimeOwnerToken !== params.runtimeOwnerToken) {
    return false;
  }
  clientGrantsByToken.set(params.token, { ...grant, activeCaptureKey: captureKey });
  return true;
}

/** Release only the attempt that still owns this grant's active capture. */
export function deactivateMcpLoopbackClientGrantCapture(params: {
  token: string;
  runtimeOwnerToken: string;
  captureKey: string;
}): boolean {
  const grant = clientGrantsByToken.get(params.token);
  if (
    !grant ||
    grant.runtimeOwnerToken !== params.runtimeOwnerToken ||
    grant.activeCaptureKey !== params.captureKey
  ) {
    return false;
  }
  const { activeCaptureKey: _activeCaptureKey, ...inactiveGrant } = grant;
  clientGrantsByToken.set(params.token, inactiveGrant);
  return true;
}

export function resolveMcpLoopbackClientGrant(params: {
  token: string;
  runtimeOwnerToken: string;
  captureKey: string;
}): { context: McpLoopbackRequestContext; captureKey: string } | undefined {
  const grant = clientGrantsByToken.get(params.token);
  if (
    !grant ||
    grant.runtimeOwnerToken !== params.runtimeOwnerToken ||
    !grant.activeCaptureKey ||
    grant.activeCaptureKey !== params.captureKey
  ) {
    return undefined;
  }
  return structuredClone({ context: grant.context, captureKey: grant.activeCaptureKey });
}

export function revokeMcpLoopbackClientGrant(token: string): boolean {
  return clientGrantsByToken.delete(token);
}

export function revokeMcpLoopbackClientGrantsForRuntime(runtimeOwnerToken: string): number {
  let removed = 0;
  for (const [token, grant] of clientGrantsByToken) {
    if (grant.runtimeOwnerToken === runtimeOwnerToken) {
      clientGrantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function mcpLoopbackClientGrantStoreSize(): number {
  return clientGrantsByToken.size;
}

export function resetMcpLoopbackClientGrantsForTest(): void {
  clientGrantsByToken.clear();
}
