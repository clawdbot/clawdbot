/** Implements ACP subagent/session spawning, binding, limits, and parent-stream setup. */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import {
  resolveAcpSessionCwd,
  resolveAcpThreadSessionDetailLines,
} from "@openclaw/acp-core/runtime/session-identifiers";
import type { AcpRuntimeSessionMode } from "@openclaw/acp-core/runtime/types";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getAcpSessionManager } from "../acp/control-plane/manager.js";
import type { AcpTurnAttachment } from "../acp/control-plane/manager.types.js";
import {
  cleanupFailedAcpSpawn,
  type AcpSpawnRuntimeCloseHandle,
} from "../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../acp/policy.js";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { DEFAULT_HEARTBEAT_EVERY } from "../auto-reply/heartbeat.js";
import { formatThinkingLevels } from "../auto-reply/thinking.js";
import {
  formatConversationTarget,
  routeFromBindingRecord,
  routeToDeliveryFields,
} from "../channels/route-projection.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
} from "../channels/thread-bindings-policy.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import {
  listSessionEntries,
  loadSessionEntry,
  resolveSessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.js";
import type { SessionAcpMeta, SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway } from "../gateway/call.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveEventSessionRoutingPolicy } from "../infra/event-session-routing.js";
import { areHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingRecord,
} from "../infra/outbound/session-binding-service.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import {
  isSubagentSessionKey,
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";
import { recordSubagentSpawned } from "../sessions/session-state-events.js";
import { listTasksForOwnerKey } from "../tasks/runtime-internal.js";
import { deliveryContextFromSession, normalizeDeliveryContext } from "../utils/delivery-context.js";
import {
  type AcpSpawnParentRelayHandle,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import { listAgentIds, resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
} from "./inherited-tool-deny.js";
import { AGENT_LANE_SUBAGENT } from "./lanes.js";
import {
  resolveConfiguredSubagentSpawnModelSelection,
  resolveThinkingDefault,
} from "./model-selection.js";
import { resolveSandboxRuntimeStatus } from "./sandbox/runtime-status.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "./spawn-pipeline.js";
import {
  mintSpawnSessionKey,
  prepareSpawnThreadBinding,
  resolveConversationRefForThreadBinding,
  resolveSpawnAdmission,
  resolveSpawnChannelAccountId,
  resolveSpawnMode,
  resolveSpawnSandboxError,
  type PreparedSpawnThreadBinding,
} from "./spawn-plan.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";
import { resolveSpawnedWorkspaceInheritance } from "./spawned-context.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
  type SessionCapabilityStore,
} from "./subagent-capabilities.js";
import { getSubagentRunByChildSessionKey } from "./subagent-registry.js";
import { resolveSubagentSpawnOwnership } from "./subagent-spawn-ownership.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  splitModelRef,
} from "./subagent-spawn-plan.js";
import { resolveSubagentThinkingOverride } from "./subagent-spawn-thinking.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./tools/sessions-helpers.js";

const log = createSubsystemLogger("agents/acp-spawn");

const ACP_RUNTIME_TIMEOUT_MAX_SECONDS = 24 * 60 * 60;

export const ACP_SPAWN_MODES = ["run", "session"] as const;
type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];
export const ACP_SPAWN_STREAM_TARGETS = ["parent"] as const;
type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];

type SpawnAcpParams = {
  task: string;
  taskName?: string;
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
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  streamTo?: SpawnAcpStreamTarget;
  attachments?: AcpTurnAttachment[];
};

type GatewayImageAttachmentInput = {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
};

function toGatewayImageAttachments(
  attachments: AcpTurnAttachment[] | undefined,
): GatewayImageAttachmentInput[] | undefined {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }
  return attachments.map((attachment) => ({
    type: "image",
    source: {
      type: "base64",
      media_type: attachment.mediaType,
      data: attachment.data,
    },
  }));
}

export type SpawnAcpContext = {
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  completionOwnerKey?: string;
  requesterAgentIdOverride?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
  agentGroupId?: string;
  /** Group space label (guild/team id) from the originating channel context. */
  agentGroupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  agentMemberRoleIds?: string[];
  sandboxed?: boolean;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};

const ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "resume_forbidden",
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
type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];

type SpawnAcpResultFields = {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  runTimeoutSeconds?: number;
  inlineDelivery?: boolean;
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

const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
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
  return resolveSpawnSandboxError({
    backend: "acp",
    requesterSandboxed,
    sandbox: sandboxMode,
  });
}

type AcpSpawnInitializedSession = Awaited<
  ReturnType<ReturnType<typeof getAcpSessionManager>["initializeSession"]>
>;

type AcpSpawnInitializedRuntime = {
  initialized: AcpSpawnInitializedSession;
  runtimeCloseHandle: AcpSpawnRuntimeCloseHandle;
  sessionId?: string;
  sessionEntry: SessionEntry | undefined;
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

  const agentEntries = Array.isArray(params.cfg.agents?.list) ? params.cfg.agents.list : [];
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
  const parentEntry = loadSessionEntry({
    storePath,
    sessionKey: params.parentSessionKey,
    clone: false,
  });
  const parentDeliveryContext = deliveryContextFromSession(parentEntry);
  return Boolean(parentDeliveryContext?.channel && parentDeliveryContext.to);
}

function resolveTargetAcpAgentId(params: {
  requestedAgentId?: string;
  cfg: OpenClawConfig;
}): { ok: true; agentId: string; configAgentId?: string } | { ok: false; error: string } {
  const requested = normalizeOptionalAgentId(params.requestedAgentId);
  if (requested) {
    const configuredAgent = params.cfg.agents?.list?.find(
      (agent) => normalizeOptionalAgentId(agent.id) === requested,
    );
    if (configuredAgent?.runtime?.type === "acp") {
      return {
        ok: true,
        agentId: normalizeOptionalAgentId(configuredAgent.runtime.acp?.agent) ?? requested,
        configAgentId: requested,
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
    return {
      ok: true,
      agentId: requested,
      ...(configuredAgent ? { configAgentId: requested } : {}),
    };
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
    if (entry.trim() === "*") {
      return true;
    }
    const normalized = normalizeOptionalAgentId(entry);
    return normalized === agentId;
  });
}

function resolveConfiguredAcpSubagentTargetIds(cfg: OpenClawConfig): string[] {
  const ids = new Set<string>(listAgentIds(cfg));
  for (const agent of cfg.agents?.list ?? []) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const acpAgent = normalizeOptionalAgentId(agent.runtime.acp?.agent);
    if (acpAgent) {
      ids.add(acpAgent);
    }
  }
  const defaultAgent = normalizeOptionalAgentId(cfg.acp?.defaultAgent);
  if (defaultAgent) {
    ids.add(defaultAgent);
  }
  for (const entry of cfg.acp?.allowedAgents ?? []) {
    if (entry.trim() === "*") {
      continue;
    }
    const id = normalizeOptionalAgentId(entry);
    if (id) {
      ids.add(id);
    }
  }
  return Array.from(ids);
}

function summarizeError(err: unknown): string {
  return formatErrorMessage(err);
}

function createAcpSpawnFailure(params: {
  status: "forbidden" | "error";
  errorCode: SpawnAcpErrorCode;
  error: string;
  childSessionKey?: string;
  runId?: string;
}): SpawnAcpFailedResult {
  return {
    status: params.status,
    errorCode: params.errorCode,
    error: params.error,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

function isMissingPathError(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function resolveRuntimeCwdForAcpSpawn(params: {
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
  storePath: string;
  agentId: string;
  threadId?: string | number;
  stage: "spawn" | "thread-bind";
}): Promise<SessionEntry | undefined> {
  try {
    const resolvedSessionFile = await resolveSessionTranscriptRuntimeTarget({
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: params.storePath,
      agentId: params.agentId,
      threadId: params.threadId,
    });
    return (
      loadSessionEntry({
        storePath: params.storePath,
        sessionKey: resolvedSessionFile.sessionKey,
        clone: false,
      }) ?? params.sessionEntry
    );
  } catch (error) {
    log.warn(
      `ACP session-file persistence failed during ${params.stage} for ${params.sessionKey}: ${summarizeError(error)}`,
    );
    return params.sessionEntry;
  }
}

function resolveAcpSpawnRequesterState(params: {
  cfg: OpenClawConfig;
  parentSessionKey?: string;
  requesterAgentId: string;
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
      params.parentSessionKey && params.requesterAgentId
        ? hasSessionLocalHeartbeatRelayRoute({
            cfg: params.cfg,
            parentSessionKey: params.parentSessionKey,
            requesterAgentId: params.requesterAgentId,
          })
        : false,
    origin: resolveRequesterOriginForChild({
      cfg: params.cfg,
      targetAgentId: params.targetAgentId,
      requesterAgentId: params.requesterAgentId,
      requesterChannel: params.ctx.agentChannel,
      requesterAccountId: params.ctx.agentAccountId,
      requesterTo: params.ctx.agentTo,
      requesterThreadId: params.ctx.agentThreadId,
      requesterGroupSpace: params.ctx.agentGroupSpace,
      requesterMemberRoleIds: params.ctx.agentMemberRoleIds,
    }),
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

function sessionEntryMatchesAcpResumeSessionId(
  acp: SessionAcpMeta | undefined,
  resumeSessionId: string,
): boolean {
  const identity = acp?.identity;
  return (
    normalizeOptionalString(identity?.agentSessionId) === resumeSessionId ||
    normalizeOptionalString(identity?.acpxSessionId) === resumeSessionId
  );
}

function sessionEntryIsOwnedByRequester(params: {
  sessionKey: string;
  entry: SessionEntry | undefined;
  requesterSessionKey: string;
}): boolean {
  return (
    params.sessionKey === params.requesterSessionKey ||
    normalizeOptionalString(params.entry?.spawnedBy) === params.requesterSessionKey ||
    normalizeOptionalString(params.entry?.parentSessionKey) === params.requesterSessionKey
  );
}

function validateAcpResumeSessionOwnership(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  requesterSessionKey?: string;
  resumeSessionId?: string;
}): { ok: true } | { ok: false; error: string } {
  const resumeSessionId = normalizeOptionalString(params.resumeSessionId);
  if (!resumeSessionId) {
    return { ok: true };
  }
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return {
      ok: false,
      error: "sessions_spawn resumeSessionId requires an active requester session context.",
    };
  }

  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.targetAgentId });
  for (const { sessionKey, entry } of listSessionEntries({ storePath, clone: false })) {
    const acp = readAcpSessionMeta({ sessionKey, cfg: params.cfg });
    if (!sessionEntryMatchesAcpResumeSessionId(acp, resumeSessionId)) {
      continue;
    }
    if (
      sessionEntryIsOwnedByRequester({
        sessionKey,
        entry,
        requesterSessionKey,
      })
    ) {
      return { ok: true };
    }
    break;
  }

  return {
    ok: false,
    error:
      "sessions_spawn resumeSessionId is only allowed for ACP sessions previously recorded for this requester. Omit resumeSessionId to start a fresh ACP session.",
  };
}

type AcpSpawnRuntimeOptions = {
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
};

function resolveAcpRuntimeTimeoutSeconds(runTimeoutSeconds?: number): number | undefined {
  if (!runTimeoutSeconds) {
    return undefined;
  }
  return Math.min(runTimeoutSeconds, ACP_RUNTIME_TIMEOUT_MAX_SECONDS);
}

function resolveAcpSpawnRuntimeOptions(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  configAgentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
}):
  | { ok: true; runtimeOptions?: AcpSpawnRuntimeOptions; modelExplicit: boolean }
  | { ok: false; error: string } {
  const policyAgentId = params.configAgentId ?? params.targetAgentId;
  const modelExplicit = normalizeOptionalString(params.model) !== undefined;
  const model = resolveConfiguredSubagentSpawnModelSelection({
    cfg: params.cfg,
    agentId: policyAgentId,
    modelOverride: params.model,
  });
  const targetAgentConfig = resolveAgentConfig(params.cfg, policyAgentId);
  const thinkingPlan = resolveSubagentThinkingOverride({
    cfg: params.cfg,
    targetAgentConfig,
    thinkingOverrideRaw: params.thinking,
  });
  if (thinkingPlan.status === "error") {
    const { provider, model: modelId } = splitModelRef(model);
    return {
      ok: false,
      error: `Invalid thinking level "${thinkingPlan.thinkingCandidateRaw}". Use one of: ${formatThinkingLevels(provider, modelId)}.`,
    };
  }

  let thinking = thinkingPlan.thinkingOverride;
  if (!thinking && model) {
    const { provider, model: modelId } = splitModelRef(model);
    if (provider && modelId) {
      thinking = resolveThinkingDefault({
        cfg: params.cfg,
        provider,
        model: modelId,
      });
    }
  }

  const timeoutSeconds = resolveAcpRuntimeTimeoutSeconds(params.runTimeoutSeconds);
  const runtimeOptions =
    model || thinking || timeoutSeconds
      ? {
          ...(model ? { model } : {}),
          ...(thinking ? { thinking } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
        }
      : undefined;
  return { ok: true, runtimeOptions, modelExplicit };
}

async function initializeAcpSpawnRuntime(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  runtimeMode: AcpRuntimeSessionMode;
  resumeSessionId?: string;
  runtimeOptions?: AcpSpawnRuntimeOptions;
  modelExplicit?: boolean;
  cwd?: string;
}): Promise<AcpSpawnInitializedRuntime> {
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: params.targetAgentId });
  let sessionEntry = loadSessionEntry({
    storePath,
    sessionKey: params.sessionKey,
    clone: false,
  });
  const sessionId = sessionEntry?.sessionId;
  if (sessionId) {
    sessionEntry = await persistAcpSpawnSessionFileBestEffort({
      sessionId,
      sessionKey: params.sessionKey,
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
    runtimeOptions: params.runtimeOptions,
    modelExplicit: params.modelExplicit,
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
    storePath,
  };
}

async function bindPreparedAcpThread(params: {
  cfg: OpenClawConfig;
  sessionKey: string;
  targetAgentId: string;
  label?: string;
  preparedBinding: PreparedSpawnThreadBinding;
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
  const requesterAccountId = resolveSpawnChannelAccountId({
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
  const boundDeliveryTarget = routeToDeliveryFields(routeFromBindingRecord(params.binding));
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
    threadId:
      useInlineDelivery && resolvedDeliveryThreadId != null
        ? normalizeOptionalString(String(resolvedDeliveryThreadId))
        : undefined,
  };
}

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = getRuntimeConfig();
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const requesterInternalKey = resolveRequesterInternalSessionKey({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
  });
  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
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

  const requestThreadBinding = params.thread === true;
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
  const acpUnsupportedInheritedTool = findAcpUnsupportedInheritedToolDeny(
    ctx.inheritedToolDenylist,
  );
  if (acpUnsupportedInheritedTool) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
    });
  }
  const acpUnsupportedInheritedAllow = findAcpUnsupportedInheritedToolAllow(
    ctx.inheritedToolAllowlist,
  );
  if (acpUnsupportedInheritedAllow) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
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
    requesterAgentId,
    targetAgentId,
    ctx,
    subagentStore,
  });
  const hasSubagentEnvelope = isSubagentEnvelopeSession(requesterInternalKey, {
    cfg,
    store: subagentStore,
  });
  const admission = resolveSpawnAdmission({
    cfg,
    enabled: hasSubagentEnvelope,
    requesterSessionKey: requesterInternalKey,
    requesterAgentId,
    targetAgentId,
    requestedAgentId: params.agentId,
    configuredAgentIds: resolveConfiguredAcpSubagentTargetIds(cfg),
    additionalActiveChildren: hasSubagentEnvelope
      ? countUntrackedActiveAcpRunsForOwner(requesterInternalKey)
      : 0,
  });
  if (!admission.ok) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "subagent_policy",
      error: admission.error,
    });
  }
  const resumeAuthorization = validateAcpResumeSessionOwnership({
    cfg,
    targetAgentId,
    requesterSessionKey: requesterInternalKey,
    resumeSessionId: params.resumeSessionId,
  });
  if (!resumeAuthorization.ok) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "resume_forbidden",
      error: resumeAuthorization.error,
    });
  }
  const runtimeOptionsResult = resolveAcpSpawnRuntimeOptions({
    cfg,
    targetAgentId,
    configAgentId: targetAgentResult.configAgentId,
    model: params.model,
    thinking: params.thinking,
    runTimeoutSeconds,
  });
  if (!runtimeOptionsResult.ok) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "spawn_failed",
      error: runtimeOptionsResult.error,
    });
  }
  const { effectiveStreamToParent } = resolveAcpSpawnStreamPlan({
    spawnMode,
    requestThreadBinding,
    streamToParentRequested,
    requester: requesterState,
  });

  const sessionKey = mintSpawnSessionKey({ targetAgentId, backend: "acp" });
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

  let preparedBinding: PreparedSpawnThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = prepareSpawnThreadBinding({
      cfg,
      kind: "acp",
      mode: spawnMode,
      bindingService: getSessionBindingService(),
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

  let sessionCreated = false;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  const childIdem = crypto.randomUUID();
  const parentAgentId = parentSessionKey
    ? resolveAgentIdFromSessionKey(parentSessionKey)
    : undefined;
  // Resolve parent session delivery context so system events route to the
  // correct thread/topic instead of falling back to the main DM.
  const parentDeliveryCtx =
    effectiveStreamToParent && parentSessionKey
      ? deliveryContextFromSession(
          loadSessionEntry({
            sessionKey: parentSessionKey,
            ...(parentAgentId ? { agentId: parentAgentId } : {}),
            clone: false,
          }),
        )
      : undefined;

  const parentRelayStateEnv = { ...process.env };
  const parentEventRouting = parentSessionKey
    ? resolveEventSessionRoutingPolicy({ cfg, sessionKey: parentSessionKey })
    : undefined;
  const gatewayAttachments = toGatewayImageAttachments(params.attachments);
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: ctx.agentSessionKey,
    completionOwnerKey: ctx.completionOwnerKey,
  });
  const requesterOrigin = requesterState.origin;
  const progressOrigin = {
    channel: requesterOrigin?.channel,
    accountId: requesterOrigin?.accountId,
    to: ctx.currentMessagingTarget ?? ctx.currentChannelId ?? requesterOrigin?.to,
    threadId: requesterOrigin?.threadId,
    channelId: ctx.currentChannelId,
    messageId: ctx.currentMessageId,
  };
  type AcpBackendState = {
    initializedSession: AcpSpawnInitializedRuntime;
    binding: SessionBindingRecord | null;
    deliveryPlan?: AcpSpawnBootstrapDeliveryPlan;
    parentRelay?: AcpSpawnParentRelayHandle;
  };
  const adapter: SpawnBackendAdapter<AcpBackendState> = {
    async initialize() {
      await callGateway({
        method: "sessions.patch",
        params: {
          key: sessionKey,
          spawnedBy: requesterInternalKey,
          ...admission.childSessionPatch,
          ...inheritedToolAllowPatch(ctx.inheritedToolAllowlist),
          ...inheritedToolDenyPatch(ctx.inheritedToolDenylist),
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
        runtimeOptions: runtimeOptionsResult.runtimeOptions,
        modelExplicit: runtimeOptionsResult.modelExplicit,
        cwd: runtimeCwd,
      });
      initializedRuntime = initializedSession.runtimeCloseHandle;
      const binding = preparedBinding
        ? (
            await bindPreparedAcpThread({
              cfg,
              sessionKey,
              targetAgentId,
              label: params.label,
              preparedBinding,
              initializedRuntime: initializedSession,
            })
          ).binding
        : null;
      return { initializedSession, binding };
    },
    async dispatchTurn(state) {
      state.deliveryPlan = resolveAcpSpawnBootstrapDeliveryPlan({
        cfg,
        spawnMode,
        requestThreadBinding,
        effectiveStreamToParent,
        requester: requesterState,
        binding: state.binding,
      });
      // ACP bypasses the native adapter, so seed the same child lineage before dispatch.
      recordSubagentSpawned({
        childSessionKey: sessionKey,
        childRunId: childIdem,
        requesterSessionKey: requesterInternalKey,
        agentId: targetAgentId,
      });
      if (effectiveStreamToParent && parentSessionKey) {
        state.parentRelay = startAcpSpawnParentStreamRelay({
          runId: childIdem,
          parentSessionKey,
          childSessionKey: sessionKey,
          childSessionId: state.initializedSession.sessionId,
          agentId: targetAgentId,
          env: parentRelayStateEnv,
          mainKey: cfg.session?.mainKey,
          sessionScope: cfg.session?.scope,
          eventRouting: parentEventRouting,
          deliveryContext: parentDeliveryCtx,
          emitStartNotice: false,
          cfg,
        });
      }
      const response = await callGateway({
        method: "agent",
        params: {
          message: params.task,
          sessionKey,
          channel: state.deliveryPlan.channel,
          to: state.deliveryPlan.to,
          accountId: state.deliveryPlan.accountId,
          threadId: state.deliveryPlan.threadId,
          idempotencyKey: childIdem,
          deliver: state.deliveryPlan.useInlineDelivery,
          lane: AGENT_LANE_SUBAGENT,
          acpTurnSource: "manual_spawn",
          timeout: runTimeoutSeconds,
          label: params.label || undefined,
          ...(gatewayAttachments ? { attachments: gatewayAttachments } : {}),
        },
        timeoutMs: 10_000,
      });
      const runId = normalizeOptionalString(response?.runId) ?? childIdem;
      if (state.parentRelay && runId !== childIdem && parentSessionKey) {
        state.parentRelay.dispose();
        state.parentRelay = startAcpSpawnParentStreamRelay({
          runId,
          parentSessionKey,
          childSessionKey: sessionKey,
          childSessionId: state.initializedSession.sessionId,
          agentId: targetAgentId,
          env: parentRelayStateEnv,
          mainKey: cfg.session?.mainKey,
          sessionScope: cfg.session?.scope,
          eventRouting: parentEventRouting,
          deliveryContext: parentDeliveryCtx,
          emitStartNotice: false,
          cfg,
        });
      }
      state.parentRelay?.notifyStarted();
      return { runId };
    },
    async cleanupOnFailure({ state }) {
      state?.parentRelay?.dispose();
      await cleanupFailedAcpSpawn({
        cfg,
        sessionKey,
        shouldDeleteSession: sessionCreated,
        deleteTranscript: true,
        runtimeCloseHandle: initializedRuntime,
      });
    },
  };
  const pipelineResult = await runSpawnPipeline({
    adapter,
    hookRunner: getGlobalHookRunner(),
    progressOrigin,
    progressSessionKey: ownership.completionRequesterSessionKey,
    buildRegistration: (state, runId) => {
      const inlineDelivery = state.deliveryPlan?.useInlineDelivery === true;
      return {
        runId,
        requesterTurnRunId: ctx.requesterTurnRunId,
        childSessionKey: sessionKey,
        controllerSessionKey: ownership.controllerSessionKey,
        requesterSessionKey: ownership.completionRequesterSessionKey,
        requesterOrigin,
        progressOrigin,
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task: params.task,
        taskName: params.taskName,
        agentId: targetAgentId,
        requesterAgentId,
        cleanup: spawnMode === "session" ? "keep" : params.cleanup === "delete" ? "delete" : "keep",
        label: params.label,
        runTimeoutSeconds,
        expectsCompletionMessage: inlineDelivery
          ? false
          : params.expectsCompletionMessage !== false,
        spawnMode,
      };
    },
  });
  if (!pipelineResult.ok) {
    if (pipelineResult.phase === "initialize") {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: isSessionBindingError(pipelineResult.error)
          ? "thread_binding_invalid"
          : "spawn_failed",
        error: isSessionBindingError(pipelineResult.error)
          ? pipelineResult.error.message
          : summarizeSpawnError(pipelineResult.error),
      });
    }
    if (pipelineResult.phase === "dispatch") {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: "dispatch_failed",
        error: summarizeSpawnError(pipelineResult.error),
        childSessionKey: sessionKey,
      });
    }
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "spawn_failed",
      error: `Failed to register ACP run: ${summarizeSpawnError(pipelineResult.error)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
      childSessionKey: sessionKey,
      runId: pipelineResult.runId,
    });
  }
  const childRunId = pipelineResult.runId;
  const deliveryPlan = pipelineResult.state.deliveryPlan;

  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: childRunId,
    mode: spawnMode,
    runTimeoutSeconds,
    ...(deliveryPlan?.useInlineDelivery ? { inlineDelivery: true } : {}),
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
