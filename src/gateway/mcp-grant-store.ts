import crypto from "node:crypto";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "../agents/exec-defaults.js";
import type { ScheduledToolPolicyContext } from "../agents/scheduled-tool-policy.js";
import type {
  SourceReplyDeliveryMode,
  TaskSuggestionDeliveryMode,
} from "../auto-reply/get-reply-options.types.js";
import type { InboundEventKind } from "../channels/inbound-event/kind.js";
import type { CronScheduledToolCallerOrigin } from "../cron/scheduled-tool-policy.js";
import type { ExecMode } from "../infra/exec-approvals.js";
import type { PluginHookChannelContext } from "../plugins/hook-types.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type { SkillWorkshopRunOptions } from "../skills/workshop/types.js";

export type McpLoopbackRequestContext = {
  sessionKey: string;
  runtimePolicySessionKey?: string;
  /** Agent whose execution policy applies when it differs from the durable session owner. */
  runtimePolicyAgentId?: string;
  agentId?: string;
  sessionId?: string;
  runId?: string;
  /** Server-selected roots for mediated coding tools in this CLI run. */
  workspaceDir?: string;
  cwd?: string;
  modelProvider?: string;
  modelId?: string;
  modelHasVision?: boolean;
  messageProvider?: string;
  clientCaps?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  currentInboundAudio?: boolean;
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
  /** Hold exact-source message-tool delivery for the source final gate. */
  deferSourceMessageToolDelivery?: boolean;
  /** Immutable completion-only authority; never sourced from MCP request headers. */
  sourceReplyOnly?: boolean;
  taskSuggestionDeliveryMode?: TaskSuggestionDeliveryMode;
  requireExplicitMessageTarget?: boolean;
  /**
   * Per-run allowlist of gateway tool names for this grant. When set, the
   * loopback surface lists and executes only these tools; CLI-side flags such
   * as `--allowedTools` are advisory under bypass permission modes, so the
   * grant is where restricted one-shot runs (e.g. active-memory recall) get
   * hard enforcement. Unset keeps the full session-scoped surface.
   */
  toolsAllow?: string[];
  skillWorkshop?: SkillWorkshopRunOptions;
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  /** Host-owned creator origin; child MCP request fields cannot widen it. */
  cronCreatorCallerOrigin?: CronScheduledToolCallerOrigin;
  senderIsOwner: boolean;
  /** Capability minted only for Gateway-launched CLI backends. */
  nodeExecAllowed?: boolean;
  execSession?: ExecSessionDefaults;
  execOverrides?: ExecPolicyOverrides & { mode?: ExecMode };
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

interface McpAttachGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** The openclaw session this grant is bound to; tool scope is resolved for this key. */
  readonly sessionKey: string;
  /** Explicit agent owner for canonical global sessions, whose key cannot encode one. */
  readonly agentId?: string;
  /** Absolute expiry (ms epoch). */
  readonly expiresAtMs: number;
  /** Absolute mint time (ms epoch). */
  readonly issuedAtMs: number;
}

interface McpLoopbackClientGrant {
  /** Opaque bearer presented as `Authorization: Bearer <token>`. */
  readonly token: string;
  /** Gateway-selected request context; child-process headers cannot widen it. */
  readonly context: McpLoopbackRequestContext;
}

type McpLoopbackToolAuth = {
  agentDir?: string;
  store: AuthProfileStore;
};

type StoredMcpLoopbackClientGrant = McpLoopbackClientGrant & {
  runtimeOwnerToken: string;
  /** Exact host admission retained outside the child-visible request context. */
  admittedRunContext?: AdmittedRunContext;
  activeCaptureKey?: string;
  toolAuth?: McpLoopbackToolAuth;
};

type McpLoopbackClientGrantRevocation = {
  token: string;
  runtimeOwnerToken: string;
};

const clientGrantRevocationListeners = new Set<(event: McpLoopbackClientGrantRevocation) => void>();

function notifyMcpLoopbackClientGrantRevoked(event: McpLoopbackClientGrantRevocation): void {
  for (const listener of clientGrantRevocationListeners) {
    listener(event);
  }
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1h
const MAX_TTL_MS = 12 * 60 * 60 * 1000;

const grantsByToken = resolveGlobalMap<string, McpAttachGrant>(
  Symbol.for("openclaw.mcpAttachGrants"),
  "close-and-restart",
);
const clientGrantsByToken = resolveGlobalMap<string, StoredMcpLoopbackClientGrant>(
  Symbol.for("openclaw.mcpLoopbackClientGrants"),
  "close-and-restart",
);

function clampTtlMs(ttlMs: number | undefined): number {
  if (!Number.isFinite(ttlMs) || (ttlMs as number) <= 0) {
    return DEFAULT_TTL_MS;
  }
  return Math.min(ttlMs as number, MAX_TTL_MS);
}

export function mintAttachGrant(params: {
  sessionKey: string;
  agentId?: string;
  ttlMs?: number;
  nowMs?: number;
}): McpAttachGrant {
  const sessionKey = params.sessionKey?.trim() ?? "";
  if (!sessionKey) {
    throw new Error("mintAttachGrant: sessionKey is required");
  }
  const agentId = sessionKey === "global" ? params.agentId?.trim() || undefined : undefined;
  const nowMs = params.nowMs ?? Date.now();
  // Mint sweeps stale entries so abandoned grants do not accumulate.
  sweepExpiredAttachGrants(nowMs);
  const grant: McpAttachGrant = {
    token: crypto.randomBytes(32).toString("hex"),
    sessionKey,
    ...(agentId ? { agentId } : {}),
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

/** Revokes every attach grant minted for one session. Returns the count removed. */
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

function sweepExpiredAttachGrants(nowMs: number = Date.now()): number {
  let removed = 0;
  for (const [token, grant] of grantsByToken) {
    if (nowMs >= grant.expiresAtMs) {
      grantsByToken.delete(token);
      removed += 1;
    }
  }
  return removed;
}

export function mintMcpLoopbackClientGrant(params: {
  context: McpLoopbackRequestContext;
  runtimeOwnerToken: string;
  admittedRunContext?: AdmittedRunContext;
  toolAuth?: McpLoopbackToolAuth;
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
    ...(params.admittedRunContext ? { admittedRunContext: params.admittedRunContext } : {}),
    ...(params.toolAuth ? { toolAuth: structuredClone(params.toolAuth) } : {}),
  };
  clientGrantsByToken.set(grant.token, grant);
  return structuredClone({
    token: grant.token,
    context: grant.context,
  });
}

/** Attaches the exact late CLI admission before the grant can execute tools. */
export function bindMcpLoopbackClientGrantAdmission(params: {
  token: string;
  runtimeOwnerToken: string;
  admittedRunContext: AdmittedRunContext;
}): boolean {
  const grant = clientGrantsByToken.get(params.token);
  if (
    !grant ||
    grant.runtimeOwnerToken !== params.runtimeOwnerToken ||
    (grant.admittedRunContext && grant.admittedRunContext !== params.admittedRunContext)
  ) {
    return false;
  }
  clientGrantsByToken.set(params.token, {
    ...grant,
    admittedRunContext: params.admittedRunContext,
  });
  return true;
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

/** Move one prepared turn onto the bearer already held by a warm CLI child. */
export function transferMcpLoopbackClientGrant(params: {
  sourceToken: string;
  targetToken: string;
  runtimeOwnerToken: string;
}): boolean {
  const source = clientGrantsByToken.get(params.sourceToken);
  const target = clientGrantsByToken.get(params.targetToken);
  if (
    !source ||
    source.runtimeOwnerToken !== params.runtimeOwnerToken ||
    (target && target.runtimeOwnerToken !== params.runtimeOwnerToken)
  ) {
    return false;
  }
  if (params.sourceToken === params.targetToken) {
    return true;
  }
  // The child cannot replace its bearer after launch. Turn cleanup may already
  // have revoked that bearer, so recreate it only from this fresh admitted grant.
  // An existing bearer owned by another runtime is never replaceable.
  const { activeCaptureKey: _activeCaptureKey, ...inactiveSource } = source;
  clientGrantsByToken.set(params.targetToken, {
    ...inactiveSource,
    token: params.targetToken,
  });
  clientGrantsByToken.delete(params.sourceToken);
  // Both tokens may own cached server projections. Evict them only after the
  // map swap so a request can observe either the old grant or the new grant,
  // never a partially updated authority.
  notifyMcpLoopbackClientGrantRevoked({
    token: params.targetToken,
    runtimeOwnerToken: params.runtimeOwnerToken,
  });
  notifyMcpLoopbackClientGrantRevoked({
    token: params.sourceToken,
    runtimeOwnerToken: params.runtimeOwnerToken,
  });
  return true;
}

export function resolveMcpLoopbackClientGrant(params: {
  token: string;
  runtimeOwnerToken: string;
  captureKey: string;
}):
  | {
      context: McpLoopbackRequestContext;
      captureKey: string;
      admittedRunContext?: AdmittedRunContext;
      toolAuth?: McpLoopbackToolAuth;
    }
  | undefined {
  const grant = clientGrantsByToken.get(params.token);
  if (
    !grant ||
    grant.runtimeOwnerToken !== params.runtimeOwnerToken ||
    !grant.admittedRunContext ||
    !getAdmittedRunDelegatedAuthority(grant.admittedRunContext) ||
    !grant.activeCaptureKey ||
    grant.activeCaptureKey !== params.captureKey
  ) {
    return undefined;
  }
  // Cached tools and OAuth refreshes must share the prepared store for this
  // grant; cloning on each request would discard refreshed credentials.
  return {
    context: structuredClone(grant.context),
    captureKey: grant.activeCaptureKey,
    ...(grant.admittedRunContext ? { admittedRunContext: grant.admittedRunContext } : {}),
    ...(grant.toolAuth ? { toolAuth: grant.toolAuth } : {}),
  };
}

/** Registers cleanup tied to the exact lifetime of loopback client grants. */
export function registerMcpLoopbackClientGrantRevocationListener(
  listener: (event: McpLoopbackClientGrantRevocation) => void,
): () => void {
  clientGrantRevocationListeners.add(listener);
  return () => clientGrantRevocationListeners.delete(listener);
}

export function revokeMcpLoopbackClientGrant(token: string): boolean {
  const grant = clientGrantsByToken.get(token);
  if (!grant || !clientGrantsByToken.delete(token)) {
    return false;
  }
  // Revocation must also release server-owned projections whose closures retain
  // this grant's prepared credentials.
  notifyMcpLoopbackClientGrantRevoked({ token, runtimeOwnerToken: grant.runtimeOwnerToken });
  return true;
}

export function revokeMcpLoopbackClientGrantsForRuntime(runtimeOwnerToken: string): number {
  let removed = 0;
  for (const [token, grant] of clientGrantsByToken) {
    if (grant.runtimeOwnerToken === runtimeOwnerToken) {
      removed += revokeMcpLoopbackClientGrant(token) ? 1 : 0;
    }
  }
  return removed;
}
