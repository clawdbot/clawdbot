import crypto from "node:crypto";
import {
  getAdmittedRunDelegatedAuthority,
  type AdmittedRunContext,
} from "../agents/admitted-run-context.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { ExecElevatedDefaults } from "../agents/bash-tools.exec-types.js";
import type { DelegationCapability } from "../agents/delegation-capability.js";
import type { ExecPolicyOverrides, ExecSessionDefaults } from "../agents/exec-defaults.js";
import type { PreparedQuestionAnswerAuthority } from "../agents/harness/host-private-capabilities.js";
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
import type { SkillLibraryAuthoringCapability } from "../skills/library/authoring.js";
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
  /** Host-selected pinned authoring capability; never sourced from MCP request headers. */
  pinnedWidgetAuthoring?: boolean;
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string;
  replyToMode?: "off" | "first" | "all" | "batched";
  currentInboundAudio?: boolean;
  accountId?: string;
  inboundEventKind?: InboundEventKind;
  sourceReplyDeliveryMode?: SourceReplyDeliveryMode;
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
  /** Canonical observed native authority; null awaits this turn's initialization. */
  nativeCronCreatorToolAllowlist?: string[] | null;
  skillWorkshop?: Pick<SkillWorkshopRunOptions, "proposalRevision">;
  /**
   * Attempt-local authority to start or redirect delegated work, stamped into
   * the grant so a fallback completion-report turn running on a CLI backend
   * gets the same gate as an embedded attempt. The loopback surface enforces
   * it on both tools/list and tools/call, so CLI-side advisory flags cannot
   * reopen it. Unset keeps the full delegation surface.
   */
  delegationCapability?: DelegationCapability;
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
  /** Original CLI policy, rebound only to this stored row's exact lifetime. */
  bindQuestionAnswerAuthority?: (assertActive: () => void) => PreparedQuestionAnswerAuthority;
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
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
  bindQuestionAnswerAuthority?: StoredMcpLoopbackClientGrant["bindQuestionAnswerAuthority"];
  skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
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
    bindQuestionAnswerAuthority: params.bindQuestionAnswerAuthority,
    ...(params.skillLibraryAuthoring
      ? { skillLibraryAuthoring: params.skillLibraryAuthoring }
      : {}),
    ...(params.toolAuth ? { toolAuth: structuredClone(params.toolAuth) } : {}),
  };
  clientGrantsByToken.set(grant.token, grant);
  return structuredClone({
    token: grant.token,
    context: grant.context,
  });
}

function replaceMcpLoopbackClientGrant(grant: StoredMcpLoopbackClientGrant): void {
  clientGrantsByToken.set(grant.token, grant);
  // Cached tools capture a row's authority even when token and capture strings stay unchanged.
  notifyMcpLoopbackClientGrantRevoked({
    token: grant.token,
    runtimeOwnerToken: grant.runtimeOwnerToken,
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
  replaceMcpLoopbackClientGrant({ ...grant, admittedRunContext: params.admittedRunContext });
  return true;
}

/** Bind the active execution attempt's capture before its child process starts. */
export function activateMcpLoopbackClientGrantCapture(params: {
  token: string;
  runtimeOwnerToken: string;
  captureKey: string;
}): false | { captureNativeToolAuthority: (toolNames: readonly string[] | null) => boolean } {
  const captureKey = params.captureKey.trim();
  if (!captureKey) {
    throw new Error("activateMcpLoopbackClientGrantCapture: captureKey is required");
  }
  const grant = clientGrantsByToken.get(params.token);
  if (!grant || grant.runtimeOwnerToken !== params.runtimeOwnerToken) {
    return false;
  }
  let activeGrant = {
    ...grant,
    activeCaptureKey: captureKey,
    context: {
      ...grant.context,
      ...(grant.context.nativeCronCreatorToolAllowlist !== undefined
        ? { nativeCronCreatorToolAllowlist: null }
        : {}),
    },
  };
  replaceMcpLoopbackClientGrant(activeGrant);
  const admission = grant.admittedRunContext;
  const authority = admission && getAdmittedRunDelegatedAuthority(admission);
  return {
    captureNativeToolAuthority: (toolNames) => {
      // The closure owns this exact activation, including across warm-process turns.
      // Rebinding, deactivation, or admission closure fences retained observers.
      if (
        !authority ||
        !admission ||
        clientGrantsByToken.get(params.token) !== activeGrant ||
        getAdmittedRunDelegatedAuthority(admission) !== authority ||
        activeGrant.context.nativeCronCreatorToolAllowlist === undefined
      ) {
        return false;
      }
      activeGrant = {
        ...activeGrant,
        context: {
          ...activeGrant.context,
          nativeCronCreatorToolAllowlist: toolNames === null ? null : [...toolNames],
        },
      };
      // Discovery can precede native initialization; discard its earlier cap snapshot.
      replaceMcpLoopbackClientGrant(activeGrant);
      return true;
    },
  };
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
  replaceMcpLoopbackClientGrant(inactiveGrant);
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
      admittedRunContext: AdmittedRunContext;
      questionAnswerAuthority?: PreparedQuestionAnswerAuthority;
      skillLibraryAuthoring?: SkillLibraryAuthoringCapability;
      isCurrent: () => boolean;
      toolAuth?: McpLoopbackToolAuth;
    }
  | undefined {
  const { token, runtimeOwnerToken, captureKey } = params;
  const grant = clientGrantsByToken.get(token);
  const admittedRunContext = grant?.admittedRunContext;
  const delegatedAuthority =
    admittedRunContext && getAdmittedRunDelegatedAuthority(admittedRunContext);
  if (
    !grant ||
    grant.runtimeOwnerToken !== runtimeOwnerToken ||
    !admittedRunContext ||
    !delegatedAuthority ||
    !grant.activeCaptureKey ||
    grant.activeCaptureKey !== captureKey
  ) {
    return undefined;
  }
  // Every bind, capture change, and transfer replaces the row, fencing even same-reference reuse.
  const isCurrent = () =>
    clientGrantsByToken.get(token) === grant &&
    getAdmittedRunDelegatedAuthority(admittedRunContext) === delegatedAuthority;
  const questionAnswerAuthority = grant.bindQuestionAnswerAuthority?.(() => {
    if (!isCurrent()) {
      throw new Error("question creator MCP grant is no longer active");
    }
  });
  // Cached tools and OAuth refreshes must share the prepared store for this
  // grant; cloning on each request would discard refreshed credentials.
  return {
    context: structuredClone(grant.context),
    captureKey: grant.activeCaptureKey,
    admittedRunContext,
    questionAnswerAuthority,
    ...(grant.skillLibraryAuthoring ? { skillLibraryAuthoring: grant.skillLibraryAuthoring } : {}),
    isCurrent,
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
