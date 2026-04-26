import crypto from "node:crypto";
import fs from "node:fs/promises";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "../acp/runtime/session-identifiers.js";
import type { AcpRuntimeSessionMode } from "../acp/runtime/types.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import {
  resolveChannelDefaultBindingPlacement,
  resolveInboundConversationResolution,
} from "../channels/conversation-resolution.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  formatThreadBindingDisabledError,
  formatThreadBindingSpawnDisabledError,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../config/agent-limits.js";
import { loadConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store.js";
import { resolveSessionTranscriptFile } from "../config/sessions/transcript.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { areHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { createRunningTaskRun } from "../tasks/detached-task-runtime.js";
import { listTasksForOwnerKey } from "../tasks/runtime-internal.js";
import {
  deliveryContextFromSession,
  formatConversationTarget,
  normalizeDeliveryContext,
  resolveConversationDeliveryTarget,
} from "../utils/delivery-context.js";
import {
  type AcpSpawnParentRelayHandle,
  resolveAcpSpawnStreamLogPath,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";
import { resolveSpawnedWorkspaceInheritance } from "./spawned-context.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilities,
  resolveSubagentCapabilityStore,
  type SessionCapabilityStore,
} from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { countActiveRunsForSession, getSubagentRunByChildSessionKey } from "./subagent-registry.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

const log = createSubsystemLogger("agents/acp-spawn");

export const ACP_SPAWN_MODES = ["run", "session"] as const;
export type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
export const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];
export const ACP_SPAWN_STREAM_TARGETS = ["parent"] as const;
export type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];

export type SpawnAcpParams = {
  task: string;
  label?: string;
  agentId?: string;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  streamTo?: SpawnAcpStreamTarget;
};

export type SpawnAcpContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
  agentGroupId?: string;
  /** Group space label (guild/team id) from the originating channel context. */
  agentGroupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  agentMemberRoleIds?: string[];
  sandboxed?: boolean;
};

export const ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "subagent_policy",
  "thread_required",
  "target_agent_required",
  "runtime_agent_mismatch",
  "agent_forbidden",
  "cwd_resolution_failed",
  "thread_binding_invalid",
  "spawn_failed",
  "dispatch_failed",
] as const;
export type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];

type SpawnAcpResultFields = {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  streamLogPath?: string;
  note?: string;
};

type SpawnAcpAcceptedResult = SpawnAcpResultFields & {
  status: "accepted";
  childSessionKey: string;
  runId: string;
  mode: SpawnAcpMode;
};

type SpawnAcpFailedResult = SpawnAcpResultFields & {
  status: "forbidden" | "error";
  error: string;
  errorCode: SpawnAcpErrorCode;
};

export type SpawnAcpResult = SpawnAcpAcceptedResult | SpawnAcpFailedResult;

export function isSpawnAcpAcceptedResult(result: SpawnAcpResult): result is SpawnAcpAcceptedResult {
  return result.status === "accepted";
}

export const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
export const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: SpawnAcpSandboxMode;
}): string | undefined {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  if (requesterSandboxed) {
    return 'Sandboxed sessions cannot spawn ACP sessions because runtime="acp" runs on the host. Use runtime="subagent" from sandboxed sessions.';
  }
  if (sandboxMode === "require") {
    return 'sessions_spawn sandbox="require" is unsupported for runtime="acp" because ACP sessions run outside the sandbox. Use runtime="subagent" or sandbox="inherit".';
  }
  return undefined;
}

type PreparedAcpThreadBinding = {
  channel: string;
  accountId: string;
  placement: "current" | "child";
  conversationId: string;
  parentConversationId?: string;
};

type AcpSpawnInitializedSession = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

type AcpSpawnInitializedRuntime = {
  initialized: AcpSpawnInitializedSession;
  runtimeCloseHandle: AcpSpawnRuntimeCloseHandle;
  sessionId?: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
};

type AcpSpawnRequesterState = {
  parentSessionKey?: string;
  isSubagentSession: boolean;
  hasActiveSubagentBinding: boolean;
  hasThreadContext: boolean;
  heartbeatEnabled: boolean;
  heartbeatRelayRouteUsable: boolean;
  origin: ReturnType<typeof normalizeDeliveryContext>;
};

type AcpSpawnStreamPlan = {
  implicitStreamToParent: boolean;
  effectiveStreamToParent: boolean;
};

type AcpSubagentEnvelopeState = {
  childSessionPatch?: {
    spawnDepth: number;
    subagentRole: "orchestrator" | "leaf" | null;
    subagentControlScope: "children" | "none";
  };
  error?: string;
};

function isActiveTaskStatus(status: string | undefined): boolean {
  return status === "queued" || status === "running";
}

function countUntrackedActiveAcpRunsForOwner(ownerKey: string | undefined): number {
  const normalizedOwnerKey = normalizeOptionalString(ownerKey);
  if (!normalizedOwnerKey) {
    return 0;
  }
  const tasks = listTasksForOwnerKey(normalizedOwnerKey);
  const trackedChildSessionKeys = new Set(
    tasks
      .filter(
        (task) =>
          task.runtime === "subagent" &&
          isActiveTaskStatus(task.status) &&
          normalizeOptionalString(task.childSessionKey),
      )
      .map((task) => normalizeOptionalString(task.childSessionKey) as string),
  );
  const activeAcpChildSessionKeys = new Set(
    tasks.flatMap((task) => {
      const childSessionKey = normalizeOptionalString(task.childSessionKey);
      const trackedRun = childSessionKey ? getSubagentRunByChildSessionKey(childSessionKey) : null;
      const hasActiveRegistryRun = Boolean(trackedRun && typeof trackedRun.endedAt !== "number");
      return task.runtime === "acp" &&
        isActiveTaskStatus(task.status) &&
        childSessionKey !== undefined &&
        !hasActiveRegistryRun &&
        !trackedChildSessionKeys.has(childSessionKey)
        ? [childSessionKey]
        : [];
    }),
  );
  return activeAcpChildSessionKeys.size;
}

type AcpSpawnBootstrapDeliveryPlan = {
  useInlineDelivery: boolean;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string;
};

function resolvePlacementWithoutChannelPlugin(params: {
  capabilities: { placements: Array<"current" | "child"> };
}): "current" | "child" {
  return params.capabilities.placements.includes("child") ? "child" : "current";
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnAcpMode;
  threadRequested: boolean;
}): SpawnAcpMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function resolveAcpSessionMode(mode: SpawnAcpMode): AcpRuntimeSessionMode {
  return mode === "session" ? "persistent" : "oneshot";
}

function isHeartbeatEnabledForSessionAgent(params: {
  cfg: OpenClawConfig;
  sessionKey?: string;
}): boolean {
  if (!areHeartbeatsEnabled()) {
    return false;
  }
  const requesterAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (!requesterAgentId) {
    return true;
  }

  const agentEntries = params.cfg.agents?.list ?? [];
  const hasExplicitHeartbeatAgents = agentEntries.some((entry) => Boolean(entry?.heartbeat));
  const enabledByPolicy = hasExplicitHeartbeatAgents
    ? agentEntries.some(
        (entry) => Boolean(entry?.heartbeat) && normalizeAgentId(entry?.id) === requesterAgentId,
      )
    : requesterAgentId === resolveDefaultAgentId(params.cfg);
  if (!enabledByPolicy) {
    return false;
  }

  const heartbeatEvery =
    resolveAgentConfig(params.cfg, requesterAgentId)?.heartbeat?.every ??
    params.cfg.agents?.defaults?.heartbeat?.every ??
    DEFAULT_HEARTBEAT_EVERY;
  const trimmedEvery = normalizeOptionalString(heartbeatEvery) ?? "";
  if (!trimmedEvery) {
    return false;
  }
  try {
    return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

function resolveHeartbeatConfigForAgent(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["heartbeat"] {
  const defaults = params.cfg.agents?.defaults?.heartbeat;
  const overrides = resolveAgentConfig(params.cfg, params.agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return undefined;
  }
  return {
    ...defaults,
    ...overrides,
  };
}

function hasSessionLocalHeartbeatRelayRoute(params: {
  cfg: OpenClawConfig;
  parentSessionKey: string;
  requesterAgentId: string;
}): boolean {
  const scope = params.cfg.session?.scope ?? "per-sender";
  if (scope === "global") {
    return false;
  }

  const heartbeat = resolveHeartbeatConfigForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  if ((heartbeat?.target ?? "none") !== "last") {
    return false;
  }

  // Explicit delivery overrides are not session-local and can route updates
  // to unrelated destinations (for example a pinned ops channel).
  if (normalizeOptionalString(heartbeat?.to)) {
    return false;
  }
  if (normalizeOptionalString(heartbeat?.accountId)) {
    return false;
  }

  const storePath = resolveStorePath(params.cfg.session?.store, {
    agentId: params.requesterAgentId,
  });
  const sessionStore = loadSessionStore(storePath);
  const parentEntry = sessionStore[params.parentSessionKey];
  const parentDeliveryContext = deliveryContextFromSession(parentEntry);
  return Boolean(parentDeliveryContext?.channel && parentDeliveryContext.to);
}

function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): { ok: true; agentId: string } | { ok: false; error: string } {
  const requested = normalizeOptionalAgentId(params.requestedAgentId);
  if (requested) {
    const configuredAgent = params.cfg.agents?.list?.find(
      (agent) => normalizeOptionalAgentId(agent.id) === requested,
    );
    if (configuredAgent?.runtime?.type === "acp") {
      return {
        ok: true,
        agentId: normalizeOptionalAgentId(configuredAgent.runtime.acp?.agent) ?? requested,
      };
    }
    if (configuredAgent && !isExplicitlyAllowedAcpAgent(params.cfg, requested)) {
      return {
        ok: false,
        error:
          `agentId "${requested}" is an OpenClaw config agent, not an ACP harness. ` +
          'Use runtime="subagent" or omit runtime for OpenClaw config agents. ' +
          'Use runtime="acp" only with external ACP harness ids such as codex, claude, droid, gemini, or opencode, or configure agents.list[].runtime.type="acp" with runtime.acp.agent.',
      };
    }
    return { ok: true, agentId: requested };
  }

  const configuredDefault = normalizeOptionalAgentId(params.cfg.acp?.defaultAgent);
  if (configuredDefault) {
    return { ok: true, agentId: configuredDefault };
  }

  return {
    ok: false,
    error:
      "ACP target agent is not configured. Pass `agentId` in `sessions_spawn` or set `acp.defaultAgent` in config.",
  };
}

function isExplicitlyAllowedAcpAgent(cfg: OpenClawConfig, agentId: string): boolean {
  return (cfg.acp?.allowedAgents ?? []).some((entry) => {
    const normalized = normalizeOptionalAgentId(entry);
    return normalized === "*" || normalized === agentId;
  });
}

function normalizeOptionalAgentId(value: string | undefined | null): string | undefined {
  const trimmed = normalizeOptionalString(value) ?? "";
  if (!trimmed) {
    return undefined;
  }
  return normalizeAgentId(trimmed);
}

function summarizeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  return "error";
}

function createAcpSpawnFailure(params: {
  status: "forbidden" | "error";
  errorCode: SpawnAcpErrorCode;
  error: string;
  childSessionKey?: string;
}): SpawnAcpFailedResult {
  return {
    status: params.status,
    errorCode: params.errorCode,
    error: params.error,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
  };
}

function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

async function resolveRuntimeCwdForAcpSpawn(params: {
  resolvedCwd?: string;
  explicitCwd?: string;
}): Promise<string | undefined> {
  if (!params.resolvedCwd) {
    return undefined;
  }
  if (normalizeOptionalString(params.explicitCwd)) {
    return params.resolvedCwd;
  }
  try {
    await fs.access(params.resolvedCwd);
    return params.resolvedCwd;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function resolveRequesterInternalSessionKey(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
}): string {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  return requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
}

async function persistAcpSpawnSessionFileBestEffort(params: {
  sessionId: string;
  sessionKey: string;
  sessionEntry: SessionEntry | undefined;
  sessionStore: Record<string, SessionEntry>;
  storePath: string;
  agentId: string;
  threadId?: string | number;
  stage: "spawn" | "thread-bind";
}): Promise<SessionEntry | undefined> {
  try {
    const resolvedSessionFile = await resolveSessionTranscriptFile({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      sessionEntry: params.sessionEntry,
      sessionStore: params.sessionStore,
      storePath: params.storePath,
      agentId: params.agentId,
      threadId: params.threadId,
    });
    return resolvedSessionFile.sessionEntry;
  } catch (error) {
    log.warn(
      `ACP session-file persistence failed during ${params.stage} for ${params.sessionKey}: ${summarizeError(error)}`,
    );
    return params.sessionEntry;
  }
}

function resolveConversationRefForThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): { conversationId: string; parentConversationId?: string } | null {
  const resolution = resolveInboundConversationResolution({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    to: params.to,
    threadId: params.threadId,
    groupId: params.groupId,
    isGroup: true,
  });
  return resolution?.canonical ?? null;
}

function resolveAcpSpawnChannelAccountId(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
}): string | undefined {
  const channel = normalizeOptionalLowercaseString(params.channel);
  const explicitAccountId = normalizeOptionalString(params.accountId);
  if (explicitAccountId) {
    return explicitAccountId;
  }
  if (!channel) {
    return undefined;
  }
  const channels = params.cfg.channels as Record<string, { defaultAccount?: unknown } | undefined>;
  const configuredDefaultAccountId = channels?.[channel]?.defaultAccount;
  return normalizeOptionalString(configuredDefaultAccountId) ?? "default";
}

function prepareAcpThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
  groupId?: string;
}): { ok: true; binding: PreparedAcpThreadBinding } | { ok: false; error: string } {
  const channel = normalizeOptionalLowercaseString(params.channel);
  if (!channel) {
    return {
      ok: false,
      error: "thread=true for ACP sessions requires a channel context.",
    };
  }

  const accountId = resolveAcpSpawnChannelAccountId({
    cfg: params.cfg,
    channel,
    accountId: params.accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel,
    accountId,
    kind: "acp",
  });
  if (!policy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "acp",
      }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "acp",
      }),
    };
  }
  const bindingService = getSessionBindingService();
  const capabilities = bindingService.getCapabilities({
    channel: policy.channel,
    accountId: policy.accountId,
  });
  if (!capabilities.adapterAvailable) {
    return {
      ok: false,
      error: `Thread bindings are unavailable for ${policy.channel}.`,
    };
  }
  const pluginPlacement = resolveChannelDefaultBindingPlacement(policy.channel);
  const placementToUse =
    pluginPlacement ??
    resolvePlacementWithoutChannelPlugin({
      capabilities,
    });
  if (!capabilities.bindSupported || !capabilities.placements.includes(placementToUse)) {
    return {
      ok: false,
      error: `Thread bindings do not support ${placementToUse} placement for ${policy.channel}.`,
    };
  }
  const conversationRef = resolveConversationRefForThreadBinding({
    cfg: params.cfg,
    channel: policy.channel,
    accountId: policy.accountId,
    to: params.to,
    threadId: params.threadId,
    groupId: params.groupId,
  });
  if (!conversationRef?.conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${policy.channel} conversation for ACP thread spawn.`,
    };
  }

  return {
    ok: true,
    binding: {
      channel: policy.channel,
      accountId: policy.accountId,
      placement: placementToUse,
      conversationId: conversationRef.conversationId,
      ...(conversationRef.parentConversationId
        ? { parentConversationId: conversationRef.parentConversationId }
        : {}),
    },
  };
}

function resolveAcpSpawnRequesterState(params: {
  cfg: OpenClawConfig;
  parentSessionKey?: string;
  targetAgentId: string;
  ctx: SpawnAcpContext;
  subagentStore?: SessionCapabilityStore;
}): AcpSpawnRequesterState {
  const bindingService = getSessionBindingService();
  const requesterParsedSession = parseAgentSessionKey(params.parentSessionKey);
  const isSubagentSession =
    Boolean(requesterParsedSession) && isSubagentSessionKey(params.parentSessionKey);
  const hasActiveSubagentBinding =
    isSubagentSession && params.parentSessionKey
      ? bindingService
          .listBySession(params.parentSessionKey)
          .some((record) => record.targetKind === "subagent" && record.status !== "ended")
      : false;
  const hasThreadContext =
    typeof params.ctx.agentThreadId === "string"
      ? Boolean(normalizeOptionalString(params.ctx.agentThreadId))
      : params.ctx.agentThreadId != null;
  const requesterAgentId = requesterParsedSession?.agentId;

  return {
    parentSessionKey: params.parentSessionKey,
    isSubagentSession,
    hasActiveSubagentBinding,
    hasThreadContext,
    heartbeatEnabled: isHeartbeatEnabledForSessionAgent({
      cfg: params.cfg,
      sessionKey: params.parentSessionKey,
    }),
    heartbeatRelayRouteUsable:
      params.parentSessionKey && requesterAgentId
        ? hasSessionLocalHeartbeatRelayRoute({
            cfg: params.cfg,
            parentSessionKey: params.parentSessionKey,
            requesterAgentId,
          })
        : false,
    origin: resolveRequesterOriginForChild({
      cfg: params.cfg,
      targetAgentId: params.targetAgentId,
      requesterAgentId: normalizeAgentId(requesterAgentId),
      requesterChannel: params.ctx.agentChannel,
      requesterAccountId: params.ctx.agentAccountId,
      requesterTo: params.ctx.agentTo,
      requesterThreadId: params.ctx.agentThreadId,
      requesterGroupSpace: params.ctx.agentGroupSpace,
      requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
    }),
  };
}

function resolveAcpSubagentEnvelopeState(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  targetAgentId: string;
  requestedAgentId?: string;
  subagentStore?: SessionCapabilityStore;
}): AcpSubagentEnvelopeState {
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return {};
  }
  if (
    !isSubagentEnvelopeSession(requesterSessionKey, {
      cfg: params.cfg,
      store: params.subagentStore,
    })
  ) {
    return {};
  }

  const callerDepth = getSubagentDepthFromSessionStore(requesterSessionKey, {
    cfg: params.cfg,
  });
  const maxSpawnDepth =
    params.cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxSpawnDepth) {
    return {
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren =
    params.cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ??
    DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT;
  const activeChildren =
    countActiveRunsForSession(requesterSessionKey) +
    countUntrackedActiveAcpRunsForOwner(requesterSessionKey);
  if (activeChildren >= maxChildren) {
    return {
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  const requesterAgentId = normalizeAgentId(parseAgentSessionKey(requesterSessionKey)?.agentId);
  const requireAgentId =
    resolveAgentConfig(params.cfg, requesterAgentId)?.subagents?.requireAgentId ??
    params.cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !params.requestedAgentId?.trim()) {
    return {
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Use agents_list to see allowed agent ids.",
    };
  }

  if (params.targetAgentId !== requesterAgentId) {
    const allowAgents =
      resolveAgentConfig(params.cfg, requesterAgentId)?.subagents?.allowAgents ??
      params.cfg.agents?.defaults?.subagents?.allowAgents ??
      [];
    const allowAny = allowAgents.some((value) => value.trim() === "*");
    const normalizedTargetId = normalizeOptionalLowercaseString(params.targetAgentId) ?? "";
    const allowSet = new Set(
      allowAgents
        .filter((value) => value.trim() && value.trim() !== "*")
        .map((value) => normalizeOptionalLowercaseString(normalizeAgentId(value)) ?? ""),
    );
    if (!allowAny && !allowSet.has(normalizedTargetId)) {
      const allowedText = allowSet.size > 0 ? Array.from(allowSet).join(", ") : "none";
      return {
        error: `agentId is not allowed for sessions_spawn (allowed: ${allowedText})`,
      };
    }
  }

  const childCapabilities = resolveSubagentCapabilities({
    depth: callerDepth + 1,
    maxSpawnDepth,
  });
  return {
    childSessionPatch: {
      spawnDepth: childCapabilities.depth,
      subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
      subagentControlScope: childCapabilities.controlScope,
    },
  };
}

function resolveAcpSpawnStreamPlan(params: {
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  streamToParentRequested: boolean;
  requester: AcpSpawnRequesterState;
}): AcpSpawnStreamPlan {
  // For mode=run without thread binding, implicitly route output to parent
  // only for spawned subagent orchestrator sessions with heartbeat enabled
  // AND a session-local heartbeat delivery route (target=last + usable last route).
  // Skip requester sessions that are thread-bound (or carrying thread context)
  // so user-facing threads do not receive unsolicited ACP progress chatter
  // unless streamTo="parent" is explicitly requested. Use resolved spawnMode
  // (not params.mode) so default mode selection works.
  const implicitStreamToParent =
    !params.streamToParentRequested &&
    params.spawnMode === "run" &&
    !params.requestThreadBinding &&
    params.requester.isSubagentSession &&
    !params.requester.hasActiveSubagentBinding &&
    !params.requester.hasThreadContext &&
    params.requester.heartbeatEnabled &&
    params.requester.heartbeatRelayRouteUsable;

  return {
    implicitStreamToParent,
    effectiveStreamToParent: params.streamToParentRequested || implicitStreamToParent,
  };
}

async function initializeAcpSpawnRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  runtimeMode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cwd?: string;
}): Promise<AcpSpawnInitializedRuntime> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.targetAgentId });
  const sessionStore = loadSessionStore(storePath);
  let sessionEntry: SessionEntry | undefined = sessionStore[params.sessionKey];
  const sessionId = sessionEntry?.sessionId;
  if (sessionId) {
    sessionEntry = await persistAcpSpawnSessionFileBestEffort({
      sessionId,
      sessionKey: params.sessionKey,
      sessionStore,
      storePath,
      sessionEntry,
      agentId: params.targetAgentId,
      stage: "spawn",
    });
  }

  const initialized = await getAcpSessionManager().initializeSession({
    cfg: params.cfg,
    sessionKey: params.sessionKey,
    agent: params.targetAgentId,
    mode: params.runtimeMode,
    resumeSessionId: params.resumeSessionId,
    runtimeOptions:
      params.model || params.thinking || params.runTimeoutSeconds
        ? {
            ...(params.model ? { model: params.model } : {}),
            ...(params.thinking ? { thinking: params.thinking } : {}),
            ...(params.runTimeoutSeconds ? { timeoutSeconds: params.runTimeoutSeconds } : {}),
          }
        : undefined,
    cwd: params.cwd,
    backendId: params.cfg.acp?.backend,
  });

  return {
    initialized,
    runtimeCloseHandle: {
      runtime: initialized.runtime,
      handle: initialized.handle,
    },
    sessionId,
    sessionEntry,
    sessionStore,
    storePath,
  };
}

async function bindPreparedAcpThread(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  label?: string;
  preparedBinding: PreparedAcpThreadBinding;
  initializedRuntime: AcpSpawnInitializedRuntime;
}): Promise<{
  binding: SessionBindingRecord;
  sessionEntry: SessionEntry | undefined;
}> {
  const binding = await getSessionBindingService().bind({
    targetSessionKey: params.sessionKey,
    targetKind: "session",
    conversation: {
      channel: params.preparedBinding.channel,
      accountId: params.preparedBinding.accountId,
      conversationId: params.preparedBinding.conversationId,
      ...(params.preparedBinding.parentConversationId
        ? { parentConversationId: params.preparedBinding.parentConversationId }
        : {}),
    },
    placement: params.preparedBinding.placement,
    metadata: {
      threadName: resolveThreadBindingThreadName({
        agentId: params.targetAgentId,
        label: params.label || params.targetAgentId,
      }),
      agentId: params.targetAgentId,
      label: params.label || undefined,
      boundBy: "system",
      introText: resolveThreadBindingIntroText({
        agentId: params.targetAgentId,
        label: params.label || undefined,
        idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
          cfg: params.cfg,
          channel: params.preparedBinding.channel,
          accountId: params.preparedBinding.accountId,
        }),
        sessionCwd: resolveAcpSessionCwd(params.initializedRuntime.initialized.meta),
        sessionDetails: resolveAcpThreadSessionDetailLines({
          sessionKey: params.sessionKey,
          meta: params.initializedRuntime.initialized.meta,
        }),
      }),
    },
  });
  if (!binding.conversation.conversationId) {
    throw new Error(
      params.preparedBinding.placement === "child"
        ? `Failed to create and bind a ${params.preparedBinding.channel} thread for this ACP session.`
        : `Failed to bind the current ${params.preparedBinding.channel} conversation for this ACP session.`,
    );
  }

  let sessionEntry = params.initializedRuntime.sessionEntry;
  if (params.initializedRuntime.sessionId && params.preparedBinding.placement === "child") {
    const boundThreadId = normalizeOptionalString(binding.conversation.conversationId);
    if (boundThreadId) {
      sessionEntry = await persistAcpSpawnSessionFileBestEffort({
        sessionId: params.initializedRuntime.sessionId,
        sessionKey: params.sessionKey,
        sessionStore: params.initializedRuntime.sessionStore,
        storePath: params.initializedRuntime.storePath,
        sessionEntry,
        agentId: params.targetAgentId,
        threadId: boundThreadId,
        stage: "thread-bind",
      });
    }
  }

  return { binding, sessionEntry };
}

function resolveAcpSpawnBootstrapDeliveryPlan(params: {
  cfg: OpenClawConfig;
  spawnMode: SpawnAcpMode;
  requestThreadBinding: boolean;
  effectiveStreamToParent: boolean;
  requester: AcpSpawnRequesterState;
  binding: SessionBindingRecord | null;
}): AcpSpawnBootstrapDeliveryPlan {
  // Child-thread ACP spawns deliver bootstrap output to the new thread; current-conversation
  // binds deliver back to the originating target.
  const boundThreadIdRaw = params.binding?.conversation.conversationId;
  const boundThreadId = boundThreadIdRaw ? normalizeOptionalString(boundThreadIdRaw) : undefined;
  const fallbackThreadIdRaw = params.requester.origin?.threadId;
  const fallbackThreadId =
    fallbackThreadIdRaw != null ? normalizeOptionalString(String(fallbackThreadIdRaw)) : undefined;
  const deliveryThreadId = boundThreadId ?? fallbackThreadId;
  const requesterConversationRef = resolveConversationRefForThreadBinding({
    cfg: params.cfg,
    channel: params.requester.origin?.channel,
    accountId: params.requester.origin?.accountId,
    threadId: fallbackThreadId,
    to: params.requester.origin?.to,
  });
  const requesterAccountId = resolveAcpSpawnChannelAccountId({
    cfg: params.cfg,
    channel: params.requester.origin?.channel,
    accountId: params.requester.origin?.accountId,
  });
  const bindingMatchesRequesterConversation = Boolean(
    params.requester.origin?.channel &&
    params.binding?.conversation.channel === params.requester.origin.channel &&
    params.binding?.conversation.accountId === requesterAccountId &&
    requesterConversationRef?.conversationId &&
    params.binding?.conversation.conversationId === requesterConversationRef.conversationId &&
    (params.binding?.conversation.parentConversationId ?? undefined) ===
      (requesterConversationRef.parentConversationId ?? undefined),
  );
  const boundDeliveryTarget = resolveConversationDeliveryTarget({
    channel: params.requester.origin?.channel ?? params.binding?.conversation.channel,
    conversationId: params.binding?.conversation.conversationId,
    parentConversationId: params.binding?.conversation.parentConversationId,
  });
  const inferredDeliveryTo =
    (bindingMatchesRequesterConversation
      ? normalizeOptionalString(params.requester.origin?.to)
      : undefined) ??
    boundDeliveryTarget.to ??
    normalizeOptionalString(params.requester.origin?.to) ??
    formatConversationTarget({
      channel: params.requester.origin?.channel,
      conversationId: deliveryThreadId,
    });
  const resolvedDeliveryThreadId = bindingMatchesRequesterConversation
    ? fallbackThreadId
    : (boundDeliveryTarget.threadId ?? deliveryThreadId);
  const hasDeliveryTarget = Boolean(params.requester.origin?.channel && inferredDeliveryTo);

  // Thread-bound session spawns always deliver inline to their bound thread.
  // Background run-mode spawns should stay internal and report back through
  // the parent task lifecycle notifier instead of letting the child ACP
  // session write raw output directly into the originating channel.
  const useInlineDelivery =
    hasDeliveryTarget && !params.effectiveStreamToParent && params.spawnMode === "session";

  return {
    useInlineDelivery,
    channel: useInlineDelivery ? params.requester.origin?.channel : undefined,
    accountId: useInlineDelivery ? requesterAccountId : undefined,
    to: useInlineDelivery ? inferredDeliveryTo : undefined,
    threadId: useInlineDelivery ? resolvedDeliveryThreadId : undefined,
  };
}

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = loadConfig();
  const requesterInternalKey = resolveRequesterInternalSessionKey({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
  });
  if (!isAcpEnabledByPolicy(cfg)) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "acp_disabled",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
    });
  }
  const streamToParentRequested = params.streamTo === "parent";
  const parentSessionKey = normalizeOptionalString(ctx.agentSessionKey);
  if (streamToParentRequested && !parentSessionKey) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "requester_session_required",
      error: 'sessions_spawn streamTo="parent" requires an active requester session context.',
    });
  }

  let requestThreadBinding = params.thread === true;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
    requesterSandboxed: ctx.sandboxed,
    sandbox: params.sandbox,
  });
  if (runtimePolicyError) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: runtimePolicyError,
    });
  }

  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "thread_required",
      error:
        'sessions_spawn(runtime="acp", mode="session") requires thread=true so the ACP session can stay bound to a channel thread. ' +
        'Retry with { mode: "session", thread: true } on a channel that exposes threads (e.g. Discord, Slack, Telegram topics), or use mode="run" for one-shot work.',
    });
  }

  const targetAgentResult = resolveTargetAcpAgentId({
    requestedAgentId: params.agentId,
    cfg,
  });
  if (!targetAgentResult.ok) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode:
        params.agentId && normalizeOptionalAgentId(params.agentId)
          ? "runtime_agent_mismatch"
          : "target_agent_required",
      error: targetAgentResult.error,
    });
  }
  const targetAgentId = targetAgentResult.agentId;
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "agent_forbidden",
      error: agentPolicyError.message,
    });
  }
  const subagentStore = resolveSubagentCapabilityStore(parentSessionKey, {
    cfg,
  });
  const requesterState = resolveAcpSpawnRequesterState({
    cfg,
    parentSessionKey,
    targetAgentId,
    ctx,
    subagentStore,
  });
  const subagentEnvelopeState = resolveAcpSubagentEnvelopeState({
    cfg,
    requesterSessionKey: requesterInternalKey,
    targetAgentId,
    requestedAgentId: params.agentId,
    subagentStore,
  });
  if (subagentEnvelopeState.error) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "subagent_policy",
      error: subagentEnvelopeState.error,
    });
  }
  const { effectiveStreamToParent } = resolveAcpSpawnStreamPlan({
    spawnMode,
    requestThreadBinding,
    streamToParentRequested,
    requester: requesterState,
  });

  const sessionKey = `agent:${targetAgentId}:acp:${crypto.randomUUID()}`;
  const runtimeMode = resolveAcpSessionMode(spawnMode);
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId,
    requesterSessionKey: ctx.agentSessionKey,
    explicitWorkspaceDir: params.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd,
      explicitCwd: params.cwd,
    });
  } catch (error) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "cwd_resolution_failed",
      error: summarizeError(error),
    });
  }

  let preparedBinding: PreparedAcpThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = prepareAcpThreadBinding({
      cfg,
      channel: requesterState.origin?.channel,
      accountId: requesterState.origin?.accountId,
      to: requesterState.origin?.to,
      threadId: requesterState.origin?.threadId,
      groupId: ctx.agentGroupId,
    });
    if (!prepared.ok) {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: "thread_binding_invalid",
        error: prepared.error,
      });
    }
    preparedBinding = prepared.binding;
  }

  let binding: SessionBindingRecord | null = null;
  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  try {
    await callGateway({
      method: "sessions.patch",
      params: {
        key: sessionKey,
        spawnedBy: requesterInternalKey,
        ...subagentEnvelopeState.childSessionPatch,
        ...(params.label ? { label: params.label } : {}),
      },
      timeoutMs: 10_000,
    });
    sessionCreated = true;
    const initializedSession = await initializeAcpSpawnRuntime({
      cfg,
      sessionKey,
      targetAgentId,
      runtimeMode,
      resumeSessionId: params.resumeSessionId,
      model: params.model,
      thinking: params.thinking,
      runTimeoutSeconds: params.runTimeoutSeconds,
      cwd: runtimeCwd,
    });
    initializedRuntime = initializedSession.runtimeCloseHandle;

    if (preparedBinding) {
      ({ binding } = await bindPreparedAcpThread({
        cfg,
        sessionKey,
        targetAgentId,
        label: params.label,
        preparedBinding,
        initializedRuntime: initializedSession,
      }));
    }
  } catch (err) {
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: sessionCreated,
      deleteTranscript: true,
      runtimeCloseHandle: initializedRuntime,
    });
    return createAcpSpawnFailure({
      status: "error",
      errorCode: isSessionBindingError(err) ? "thread_binding_invalid" : "spawn_failed",
      error: isSessionBindingError(err) ? err.message : summarizeError(err),
    });
  }

  const deliveryPlan = resolveAcpSpawnBootstrapDeliveryPlan({
    cfg,
    spawnMode,
    requestThreadBinding,
    effectiveStreamToParent,
    requester: requesterState,
    binding,
  });
  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  const streamLogPath =
    effectiveStreamToParent && parentSessionKey
      ? resolveAcpSpawnStreamLogPath({
          childSessionKey: sessionKey,
        })
      : undefined;
  // Resolve parent session delivery context so system events route to the
  // correct thread/topic instead of falling back to the main DM.
  const parentDeliveryCtx =
    effectiveStreamToParent && parentSessionKey
      ? deliveryContextFromSession(
          loadSessionStore(
            resolveStorePath(cfg.session?.store, {
              agentId: resolveAgentIdFromSessionKey(parentSessionKey),
            }),
          )[parentSessionKey],
        )
      : undefined;

  let parentRelay: AcpSpawnParentRelayHandle | undefined;
  if (effectiveStreamToParent && parentSessionKey) {
    // Register relay before dispatch so fast lifecycle failures are not missed.
    parentRelay = startAcpSpawnParentStreamRelay({
      runId: childIdem,
      parentSessionKey,
      childSessionKey: sessionKey,
      agentId: targetAgentId,
      logPath: streamLogPath,
      deliveryContext: parentDeliveryCtx,
      emitStartNotice: false,
    });
  }
  try {
    const response = await callGateway({
      method: "agent",
      params: {
        message: params.task,
        sessionKey,
        channel: deliveryPlan.channel,
        to: deliveryPlan.to,
        accountId: deliveryPlan.accountId,
        threadId: deliveryPlan.threadId,
        idempotencyKey: childIdem,
        deliver: deliveryPlan.useInlineDelivery,
        lane: AGENT_LANE_SUBAGENT,
        ...(params.runTimeoutSeconds != null ? { timeout: params.runTimeoutSeconds } : {}),
        label: params.label || undefined,
      },
      timeoutMs: 10_000,
    });
    const responseRunId = normalizeOptionalString(response?.runId);
    if (responseRunId) {
      childRunId = responseRunId;
    }
  } catch (err) {
    parentRelay?.dispose();
    await cleanupFailedAcpSpawn({
      cfg,
      sessionKey,
      shouldDeleteSession: true,
      deleteTranscript: true,
    });
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "dispatch_failed",
      error: summarizeError(err),
      childSessionKey: sessionKey,
    });
  }

  if (effectiveStreamToParent && parentSessionKey) {
    if (parentRelay && childRunId !== childIdem) {
      parentRelay.dispose();
      // Defensive fallback if gateway returns a runId that differs from idempotency key.
      parentRelay = startAcpSpawnParentStreamRelay({
        runId: childRunId,
        parentSessionKey,
        childSessionKey: sessionKey,
        agentId: targetAgentId,
        logPath: streamLogPath,
        deliveryContext: parentDeliveryCtx,
        emitStartNotice: false,
      });
    }
    parentRelay?.notifyStarted();
    try {
      createRunningTaskRun({
        runtime: "acp",
        sourceId: childRunId,
        ownerKey: requesterInternalKey,
        scopeKind: "session",
        requesterOrigin: requesterState.origin,
        childSessionKey: sessionKey,
        runId: childRunId,
        label: params.label,
        task: params.task,
        preferMetadata: true,
        deliveryStatus: requesterInternalKey ? "pending" : "parent_missing",
        startedAt: Date.now(),
      });
    } catch (error) {
      log.warn("Failed to create background task for ACP spawn", {
        sessionKey,
        runId: childRunId,
        error,
      });
    }
    return {
      status: "accepted",
      childSessionKey: sessionKey,
      runId: childRunId,
      mode: spawnMode,
      ...(streamLogPath ? { streamLogPath } : {}),
      note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
    };
  }

  try {
    createRunningTaskRun({
      runtime: "acp",
      sourceId: childRunId,
      ownerKey: requesterInternalKey,
      scopeKind: "session",
      requesterOrigin: requesterState.origin,
      childSessionKey: sessionKey,
      runId: childRunId,
      label: params.label,
      task: params.task,
      preferMetadata: true,
      deliveryStatus: requesterInternalKey ? "pending" : "parent_missing",
      startedAt: Date.now(),
    });
  } catch (error) {
    log.warn("Failed to create background task for ACP spawn", {
      sessionKey,
      runId: childRunId,
      error,
    });
  }

  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: childRunId,
    mode: spawnMode,
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
  };
}
