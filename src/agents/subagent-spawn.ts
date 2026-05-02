import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isAcpRuntimeSpawnAvailable } from "../acp/runtime/availability.js";
import { resolveThreadBindingSpawnPolicy } from "../channels/thread-bindings-policy.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { listRegisteredPluginAgentPromptGuidance } from "../plugins/command-registry-state.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { isValidAgentId, normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { resolveAgentDir } from "./agent-scope-config.js";
import type { BootstrapContextMode } from "./bootstrap-files.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import {
  decodeStrictBase64,
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";
import { countActiveRunsForSession, registerSubagentRun } from "./subagent-registry.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import { resolveSubagentTargetPolicy } from "./subagent-target-policy.js";
export {
  SUBAGENT_SPAWN_ACCEPTED_NOTE,
  SUBAGENT_SPAWN_SESSION_ACCEPTED_NOTE,
} from "./subagent-spawn-accepted-note.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagent-spawn-plan.js";
import {
  ADMIN_SCOPE,
  AGENT_LANE_SUBAGENT,
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
  buildSubagentSystemPrompt,
  callGateway,
  emitSessionLifecycleEvent,
  forkSessionFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  mergeSessionEntry,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  pruneLegacyStoreKeys,
  ensureContextEnginesInitialized,
  resolveParentForkDecision,
  resolveAgentConfig,
  resolveContextEngine,
  resolveDisplaySessionKey,
  resolveGatewaySessionStoreTarget,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSandboxRuntimeStatus,
  updateSessionStore,
  isAdminOnlyMethod,
} from "./subagent-spawn.runtime.js";
import {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  SUBAGENT_SPAWN_SANDBOX_MODES,
  type SpawnSubagentContextMode,
  type SpawnSubagentMode,
  type SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export {
  SUBAGENT_SPAWN_CONTEXT_MODES,
  SUBAGENT_SPAWN_MODES,
  SUBAGENT_SPAWN_SANDBOX_MODES,
} from "./subagent-spawn.types.js";
export type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";

export { decodeStrictBase64 };

type SubagentSpawnDeps = {
  callGateway: typeof callGateway;
  forkSessionFromParent: typeof forkSessionFromParent;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  getRuntimeConfig: typeof getRuntimeConfig;
  ensureContextEnginesInitialized: typeof ensureContextEnginesInitialized;
  resolveContextEngine: typeof resolveContextEngine;
  resolveParentForkDecision: typeof resolveParentForkDecision;
  updateSessionStore: typeof updateSessionStore;
};

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  forkSessionFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  ensureContextEnginesInitialized,
  resolveContextEngine,
  resolveParentForkDecision,
  updateSessionStore,
};

let subagentSpawnDeps: SubagentSpawnDeps = defaultSubagentSpawnDeps;
const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
const DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 300_000;

export type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  thread?: boolean;
  mode?: SpawnSubagentMode;
  cleanup?: "delete" | "keep";
  sandbox?: SpawnSubagentSandboxMode;
  context?: SpawnSubagentContextMode;
  lightContext?: boolean;
  expectsCompletionMessage?: boolean;
  attachments?: Array<{
    name: string;
    content: string;
    encoding?: "utf8" | "base64";
    mimeType?: string;
  }>;
  attachMountPath?: string;
};

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  requesterAgentIdOverride?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
};

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  note?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
};

export { splitModelRef } from "./subagent-spawn-plan.js";

async function updateSubagentSessionStore(
  storePath: string,
  mutator: Parameters<typeof updateSessionStore>[1],
) {
  return await subagentSpawnDeps.updateSessionStore(storePath, mutator);
}

async function callSubagentGateway(
  params: Parameters<typeof callGateway>[0],
): Promise<Awaited<ReturnType<typeof callGateway>>> {
  // Subagent lifecycle requires methods spanning multiple scope tiers
  // (sessions.patch / sessions.delete → admin, agent → write).  When each call
  // independently negotiates least-privilege scopes the first connection pairs
  // at a lower tier and every subsequent higher-tier call triggers a
  // scope-upgrade handshake that headless gateway-client connections cannot
  // complete interactively, causing close(1008) "pairing required" (#59428).
  //
  // Only admin-only methods are pinned to ADMIN_SCOPE; other methods (e.g.
  // "agent" → write) keep their least-privilege scope so that the gateway does
  // not treat the caller as owner (senderIsOwner) and expose owner-only tools.
  const scopes = params.scopes ?? (isAdminOnlyMethod(params.method) ? [ADMIN_SCOPE] : undefined);
  return await subagentSpawnDeps.callGateway({
    ...params,
    ...(scopes != null ? { scopes } : {}),
  });
}

function readGatewayRunId(response: Awaited<ReturnType<typeof callGateway>>): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { runId } = response as { runId?: unknown };
  return typeof runId === "string" && runId ? runId : undefined;
}

function resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds: number): number {
  const runTimeoutMs =
    Number.isFinite(runTimeoutSeconds) && runTimeoutSeconds > 0
      ? Math.floor(runTimeoutSeconds * 1000)
      : 0;
  if (runTimeoutMs <= 0) {
    return DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS;
  }
  return Math.min(
    MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS,
    Math.max(DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS, runTimeoutMs + 5_000),
  );
}

function buildDirectChildSessionPatch(patch: Record<string, unknown>): Partial<SessionEntry> {
  const entry: Partial<SessionEntry> = {};
  const spawnDepth = patch.spawnDepth;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth) && spawnDepth >= 0) {
    entry.spawnDepth = Math.floor(spawnDepth);
  }
  if (patch.subagentRole === "orchestrator" || patch.subagentRole === "leaf") {
    entry.subagentRole = patch.subagentRole;
  }
  if (patch.subagentControlScope === "children" || patch.subagentControlScope === "none") {
    entry.subagentControlScope = patch.subagentControlScope;
  }
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) {
    entry.spawnedBy = patch.spawnedBy.trim();
  }
  if (typeof patch.spawnedWorkspaceDir === "string" && patch.spawnedWorkspaceDir.trim()) {
    entry.spawnedWorkspaceDir = patch.spawnedWorkspaceDir.trim();
  }
  if (typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()) {
    entry.thinkingLevel = patch.thinkingLevel.trim();
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    const { provider, model } = splitModelRef(patch.model.trim());
    if (model) {
      entry.model = model;
      entry.modelOverride = model;
      entry.modelOverrideSource = patch.modelOverrideSource === "auto" ? "auto" : "user";
      if (provider) {
        entry.modelProvider = provider;
        entry.providerOverride = provider;
      }
    }
  }
  return entry;
}

function loadSubagentConfig() {
  return subagentSpawnDeps.getRuntimeConfig();
}

async function persistInitialChildSessionRuntimeModel(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const { provider, model } = splitModelRef(params.resolvedModel);
  if (!model) {
    return undefined;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.childSessionKey,
    });
    await updateSubagentSessionStore(target.storePath, (store) => {
      pruneLegacyStoreKeys({
        store,
        canonicalKey: target.canonicalKey,
        candidates: target.storeKeys,
      });
      store[target.canonicalKey] = mergeSessionEntry(store[target.canonicalKey], {
        model,
        ...(provider ? { modelProvider: provider } : {}),
      });
    });
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  }
}

function resolveStoreEntryByKeys(
  store: Record<string, SessionEntry>,
  keys: readonly string[],
): SessionEntry | undefined {
  for (const key of keys) {
    const entry = store[key];
    if (entry) {
      return entry;
    }
  }
  return undefined;
}

type PreparedSpawnContext =
  | {
      status: "ok";
      mode: "isolated";
      parentEntry?: SessionEntry;
      childEntry?: SessionEntry;
      forkFallbackNote?: string;
    }
  | {
      status: "ok";
      mode: "fork";
      parentEntry: SessionEntry;
      childEntry?: SessionEntry;
      forked: { sessionId: string; sessionFile: string };
      forkFallbackNote?: never;
    }
  | { status: "error"; error: string };

async function prepareSubagentSessionContext(params: {
  cfg: OpenClawConfig;
  contextMode: SpawnSubagentContextMode;
  requesterAgentId: string;
  targetAgentId: string;
  requesterInternalKey: string;
  childSessionKey: string;
}): Promise<PreparedSpawnContext> {
  if (params.contextMode === "isolated") {
    return { status: "ok", mode: "isolated" };
  }
  const childTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.childSessionKey,
  });
  const parentTarget = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.requesterInternalKey,
  });

  let parentEntry: SessionEntry | undefined;
  let childEntry: SessionEntry | undefined;
  let forkFallbackNote: string | undefined;
  const sessionsDir = path.dirname(parentTarget.storePath);

  try {
    const forked = (await updateSubagentSessionStore(childTarget.storePath, async (store) => {
      parentEntry = resolveStoreEntryByKeys(store, parentTarget.storeKeys);
      childEntry = resolveStoreEntryByKeys(store, childTarget.storeKeys);

      if (params.targetAgentId !== params.requesterAgentId) {
        throw new Error(
          'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
        );
      }
      if (!parentEntry?.sessionId) {
        throw new Error(
          'context="fork" requested but the requester session transcript is not available.',
        );
      }
      const forkDecision = await subagentSpawnDeps.resolveParentForkDecision({
        parentEntry,
        storePath: parentTarget.storePath,
      });
      if (forkDecision.status === "skip") {
        forkFallbackNote = forkDecision.message;
        return null;
      }

      const fork = await subagentSpawnDeps.forkSessionFromParent({
        parentEntry,
        agentId: params.requesterAgentId,
        sessionsDir,
      });
      if (!fork) {
        throw new Error(
          'context="fork" requested but OpenClaw could not fork the requester transcript.',
        );
      }
      pruneLegacyStoreKeys({
        store,
        canonicalKey: childTarget.canonicalKey,
        candidates: childTarget.storeKeys,
      });
      store[childTarget.canonicalKey] = mergeSessionEntry(store[childTarget.canonicalKey], {
        sessionId: fork.sessionId,
        sessionFile: fork.sessionFile,
        forkedFromParent: true,
      });
      childEntry = store[childTarget.canonicalKey];
      return fork;
    })) as { sessionId: string; sessionFile: string } | null;

    if (params.contextMode === "fork") {
      if (!parentEntry || !forked) {
        if (forkFallbackNote) {
          return {
            status: "ok",
            mode: "isolated",
            parentEntry,
            childEntry,
            forkFallbackNote,
          };
        }
        return {
          status: "error",
          error: 'context="fork" requested but OpenClaw could not prepare forked context.',
        };
      }
      return {
        status: "ok",
        mode: "fork",
        parentEntry,
        childEntry,
        forked,
      };
    }
    return {
      status: "ok",
      mode: "isolated",
      parentEntry,
      childEntry,
      ...(forkFallbackNote ? { forkFallbackNote } : {}),
    };
  } catch (err) {
    return { status: "error", error: summarizeError(err) };
  }
}

async function prepareContextEngineSubagentSpawn(params: {
  cfg: OpenClawConfig;
  context: PreparedSpawnContext & { status: "ok" };
  requesterInternalKey: string;
  childSessionKey: string;
  runTimeoutSeconds: number;
}): Promise<
  { status: "ok"; preparation?: SubagentSpawnPreparation } | { status: "error"; error: string }
> {
  try {
    subagentSpawnDeps.ensureContextEnginesInitialized();
    const engine = await subagentSpawnDeps.resolveContextEngine(params.cfg);
    const preparation = await engine.prepareSubagentSpawn?.({
      parentSessionKey: params.requesterInternalKey,
      childSessionKey: params.childSessionKey,
      contextMode: params.context.mode,
      parentSessionId: params.context.parentEntry?.sessionId,
      parentSessionFile: params.context.parentEntry?.sessionFile,
      childSessionId:
        params.context.mode === "fork"
          ? params.context.forked.sessionId
          : params.context.childEntry?.sessionId,
      childSessionFile:
        params.context.mode === "fork"
          ? params.context.forked.sessionFile
          : params.context.childEntry?.sessionFile,
      ttlMs: params.runTimeoutSeconds > 0 ? params.runTimeoutSeconds * 1000 : undefined,
    });
    return { status: "ok", preparation };
  } catch (err) {
    return {
      status: "error",
      error: `Context engine subagent preparation failed: ${summarizeError(err)}`,
    };
  }
}

async function rollbackPreparedContextEngine(
  preparation?: SubagentSpawnPreparation,
): Promise<void> {
  try {
    await preparation?.rollback();
  } catch {
    // Best-effort cleanup only.
  }
}

function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  // Prevent prompt injection via control/newline characters in system prompt hints.
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u0000-\u001F\u007F\u0085\u2028\u2029]/.test(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<void> {
  try {
    await callSubagentGateway({
      method: "sessions.delete",
      params: {
        key: childSessionKey,
        emitLifecycleHooks: options?.emitLifecycleHooks === true,
        deleteTranscript: options?.deleteTranscript === true,
      },
      timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
}): Promise<void> {
  if (params.attachmentAbsDir) {
    try {
      await fs.rm(params.attachmentAbsDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup only.
    }
  }
  await cleanupProvisionalSession(params.childSessionKey, {
    emitLifecycleHooks: params.emitLifecycleHooks,
    deleteTranscript: params.deleteTranscript,
  });
}

function resolveSpawnMode(params: {
  requestedMode?: SpawnSubagentMode;
  threadRequested: boolean;
}): SpawnSubagentMode {
  if (params.requestedMode === "run" || params.requestedMode === "session") {
    return params.requestedMode;
  }
  // Thread-bound spawns should default to persistent sessions.
  return params.threadRequested ? "session" : "run";
}

function resolveSubagentContextMode(params: {
  requestedContext?: SpawnSubagentContextMode;
  threadRequested: boolean;
  cfg: OpenClawConfig;
  requester: {
    channel?: string;
    accountId?: string;
  };
}): SpawnSubagentContextMode {
  if (params.requestedContext === "fork" || params.requestedContext === "isolated") {
    return params.requestedContext;
  }
  if (!params.threadRequested || !params.requester.channel) {
    return "isolated";
  }
  return resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: params.requester.channel,
    accountId: params.requester.accountId,
    kind: "subagent",
  }).defaultSpawnContext;
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

function buildThreadBindingUnavailableError(mode: SpawnSubagentMode): string {
  if (mode === "session") {
    return (
      'sessions_spawn(mode="session") is only available on channels that expose thread bindings (e.g. Discord threads, Slack threads, Telegram forum topics). ' +
      "This request is not running on a channel that can bind a subagent thread. " +
      'Use mode="run" for one-shot subagent work, or sessions_send(sessionKey=...) to keep talking to a persistent session without thread binding.'
    );
  }
  return (
    "thread=true is only available on channels that expose thread bindings (e.g. Discord threads, Slack threads, Telegram forum topics). " +
    "This request is not running on a channel that can bind a subagent thread. " +
    "Retry without thread=true, or re-run sessions_spawn from a channel that supports threads."
  );
}

async function ensureThreadBindingForSubagentSpawn(params: {
  hookRunner: SubagentLifecycleHookRunner | null;
  childSessionKey: string;
  agentId: string;
  label?: string;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): Promise<
  { status: "ok"; deliveryOrigin?: DeliveryContext } | { status: "error"; error: string }
> {
  if (!params.hookRunner?.hasHooks("subagent_spawning")) {
    return {
      status: "error",
      error: buildThreadBindingUnavailableError(params.mode),
    };
  }

  try {
    const result = await params.hookRunner.runSubagentSpawning(
      {
        childSessionKey: params.childSessionKey,
        agentId: params.agentId,
        label: params.label,
        mode: params.mode,
        requester: params.requester,
        threadRequested: true,
      },
      {
        childSessionKey: params.childSessionKey,
        requesterSessionKey: params.requesterSessionKey,
      },
    );
    if (result?.status === "error") {
      const error = result.error.trim();
      return {
        status: "error",
        error: error || "Failed to prepare thread binding for this subagent session.",
      };
    }
    if (!result) {
      return {
        status: "error",
        error: buildThreadBindingUnavailableError(params.mode),
      };
    }
    if (result?.status !== "ok" || !result.threadBindingReady) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    const deliveryOrigin = normalizeDeliveryContext(result.deliveryOrigin);
    return {
      status: "ok",
      ...(deliveryOrigin ? { deliveryOrigin } : {}),
    };
  } catch (err) {
    return {
      status: "error",
      error: `Thread bind failed: ${summarizeError(err)}`,
    };
  }
}

function hasRoutableDeliveryOrigin(
  origin?: DeliveryContext,
): origin is DeliveryContext & { channel: string; to: string } {
  return Boolean(origin?.channel && origin.to);
}

export async function spawnSubagentDirect(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): Promise<SpawnSubagentResult> {
  const task = params.task;
  const label = params.label?.trim() || "";
  const requestedAgentId = params.agentId?.trim();

  // Reject malformed agentId before normalizeAgentId can mangle it.
  // Without this gate, error-message strings like "Agent not found: xyz" pass
  // through normalizeAgentId and become "agent-not-found--xyz", which later
  // creates ghost workspace directories and triggers cascading cron loops (#31311).
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return {
      status: "error",
      error: `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}. Use agents_list to discover valid targets.`,
    };
  }
  const modelOverride = params.model;
  const thinkingOverrideRaw = params.thinking;
  const requestThreadBinding = params.thread === true;
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return {
      status: "error",
      error:
        'sessions_spawn(mode="session") requires thread=true so the subagent can stay bound to a channel thread. ' +
        'Retry with { mode: "session", thread: true } on a channel that supports threads, use mode="run" for one-shot work, or use sessions_send(sessionKey=...) to keep talking to a persistent session without thread binding.',
    };
  }
  const cleanup =
    spawnMode === "session"
      ? "keep"
      : params.cleanup === "keep" || params.cleanup === "delete"
        ? params.cleanup
        : "keep";
  const expectsCompletionMessage = params.expectsCompletionMessage !== false;
  const hookRunner = subagentSpawnDeps.getGlobalHookRunner();
  const cfg = loadSubagentConfig();

  // When agent omits runTimeoutSeconds, use the config default.
  // Falls back to 0 (no timeout) if config key is also unset,
  // preserving current behavior for existing deployments.
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  let modelApplied = false;
  let threadBindingReady = false;
  let hasBoundThreadDeliveryOrigin = false;
  const contextMode = resolveSubagentContextMode({
    requestedContext: params.context,
    threadRequested: requestThreadBinding,
    cfg,
    requester: {
      channel: ctx.agentChannel,
      accountId: ctx.agentAccountId,
    },
  });
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const requesterDisplayKey = resolveDisplaySessionKey({
    key: requesterInternalKey,
    alias,
    mainKey,
  });

  const callerDepth = getSubagentDepthFromSessionStore(requesterInternalKey, { cfg });
  const maxSpawnDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxSpawnDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxSpawnDepth})`,
    };
  }

  const maxChildren =
    cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT;
  const activeChildren = countActiveRunsForSession(requesterInternalKey);
  if (activeChildren >= maxChildren) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${activeChildren}/${maxChildren})`,
    };
  }

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const requireAgentId =
    resolveAgentConfig(cfg, requesterAgentId)?.subagents?.requireAgentId ??
    cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !requestedAgentId?.trim()) {
    return {
      status: "forbidden",
      error:
        "sessions_spawn requires explicit agentId when requireAgentId is configured. Use agents_list to see allowed agent ids.",
    };
  }
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  const requesterOrigin = normalizeDeliveryContext({
    channel: ctx.agentChannel,
    accountId: ctx.agentAccountId,
    to: ctx.agentTo,
    ...(ctx.agentThreadId != null && ctx.agentThreadId !== ""
      ? { threadId: ctx.agentThreadId }
      : {}),
  });
  let childSessionOrigin = resolveRequesterOriginForChild({
    cfg,
    targetAgentId,
    requesterAgentId,
    requesterChannel: ctx.agentChannel,
    requesterAccountId: ctx.agentAccountId,
    requesterTo: ctx.agentTo,
    requesterThreadId: ctx.agentThreadId,
    requesterGroupSpace: ctx.agentGroupSpace,
    requesterMemberRoleIds: ctx.agentMemberRoleIds,
  });
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId,
    targetAgentId,
    requestedAgentId,
    allowAgents:
      resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
      cfg?.agents?.defaults?.subagents?.allowAgents,
  });
  if (!targetPolicy.ok) {
    return {
      status: "forbidden",
      error: targetPolicy.error,
    };
  }
  const childSessionKey = `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: requesterInternalKey,
  });
  const childRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: childSessionKey,
  });
  if (!childRuntime.sandboxed && (requesterRuntime.sandboxed || sandboxMode === "require")) {
    if (requesterRuntime.sandboxed) {
      return {
        status: "forbidden",
        error:
          "Sandboxed sessions cannot spawn unsandboxed subagents. Set a sandboxed target agent or use the same agent runtime.",
      };
    }
    return {
      status: "forbidden",
      error:
        'sessions_spawn sandbox="require" needs a sandboxed target runtime. Pick a sandboxed agentId or use sandbox="inherit".',
    };
  }
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const childCapabilities = resolveSubagentCapabilities({
    depth: childDepth,
    maxSpawnDepth,
  });
  const targetAgentDir = resolveAgentDir(cfg, targetAgentId);
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const plan = resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    targetAgentConfig,
    modelOverride,
    thinkingOverrideRaw,
  });
  if (plan.status === "error") {
    return {
      status: "error",
      error: plan.error,
    };
  }
  const { resolvedModel, thinkingOverride } = plan;
  const patchChildSession = async (patch: Record<string, unknown>): Promise<string | undefined> => {
    try {
      const target = resolveGatewaySessionStoreTarget({
        cfg,
        key: childSessionKey,
      });
      await updateSubagentSessionStore(target.storePath, (store) => {
        pruneLegacyStoreKeys({
          store,
          canonicalKey: target.canonicalKey,
          candidates: target.storeKeys,
        });
        store[target.canonicalKey] = mergeSessionEntry(
          store[target.canonicalKey],
          buildDirectChildSessionPatch(patch),
        );
      });
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return `child session patch failed: ${message}`;
    }
  };

  const initialChildSessionPatch: Record<string, unknown> = {
    spawnDepth: childDepth,
    subagentRole: childCapabilities.role === "main" ? null : childCapabilities.role,
    subagentControlScope: childCapabilities.controlScope,
    ...plan.initialSessionPatch,
  };

  const initialPatchError = await patchChildSession(initialChildSessionPatch);
  if (initialPatchError) {
    return {
      status: "error",
      error: initialPatchError,
      childSessionKey,
    };
  }
  const preparedSpawnContext = await prepareSubagentSessionContext({
    cfg,
    contextMode,
    requesterAgentId,
    targetAgentId,
    requesterInternalKey,
    childSessionKey,
  });
  if (preparedSpawnContext.status === "error") {
    await cleanupProvisionalSession(childSessionKey, {
      emitLifecycleHooks: false,
      deleteTranscript: true,
    });
    return {
      status: "error",
      error: preparedSpawnContext.error,
      childSessionKey,
    };
  }
  if (resolvedModel) {
    const runtimeModelPersistError = await persistInitialChildSessionRuntimeModel({
      cfg,
      childSessionKey,
      resolvedModel,
    });
    if (runtimeModelPersistError) {
      try {
        await callSubagentGateway({
          method: "sessions.delete",
          params: { key: childSessionKey, emitLifecycleHooks: false },
          timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
        });
      } catch {
        // Best-effort cleanup only.
      }
      return {
        status: "error",
        error: runtimeModelPersistError,
        childSessionKey,
      };
    }
    modelApplied = true;
  }
  if (requestThreadBinding) {
    const bindResult = await ensureThreadBindingForSubagentSpawn({
      hookRunner,
      childSessionKey,
      agentId: targetAgentId,
      label: label || undefined,
      mode: spawnMode,
      requesterSessionKey: requesterInternalKey,
      requester: {
        channel: childSessionOrigin?.channel,
        accountId: childSessionOrigin?.accountId,
        to: childSessionOrigin?.to,
        threadId: childSessionOrigin?.threadId,
      },
    });
    if (bindResult.status === "error") {
      try {
        await callSubagentGateway({
          method: "sessions.delete",
          params: { key: childSessionKey, deleteTranscript: true, emitLifecycleHooks: false },
          timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
        });
      } catch {
        // Best-effort cleanup only.
      }
      return {
        status: "error",
        error: bindResult.error,
        childSessionKey,
      };
    }
    threadBindingReady = true;
    hasBoundThreadDeliveryOrigin = hasRoutableDeliveryOrigin(bindResult.deliveryOrigin);
    childSessionOrigin =
      mergeDeliveryContext(bindResult.deliveryOrigin, childSessionOrigin) ?? childSessionOrigin;
  }
  const mountPathHint = sanitizeMountPathHint(params.attachMountPath);

  let childSystemPrompt = buildSubagentSystemPrompt({
    requesterSessionKey,
    requesterOrigin: childSessionOrigin,
    childSessionKey,
    label: label || undefined,
    task,
    acpEnabled: isAcpRuntimeSpawnAvailable({
      config: cfg,
      sandboxed: childRuntime.sandboxed,
    }),
    nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance(),
    childDepth,
    maxSpawnDepth,
  });

  let retainOnSessionKeep = false;
  let attachmentsReceipt:
    | {
        count: number;
        totalBytes: number;
        files: SubagentAttachmentReceiptFile[];
        relDir: string;
      }
    | undefined;
  let attachmentAbsDir: string | undefined;
  let attachmentRootDir: string | undefined;
  const materializedAttachments = await materializeSubagentAttachments({
    config: cfg,
    targetAgentId,
    attachments: params.attachments,
    mountPathHint,
  });
  if (materializedAttachments && materializedAttachments.status !== "ok") {
    await cleanupProvisionalSession(childSessionKey, {
      emitLifecycleHooks: threadBindingReady,
      deleteTranscript: true,
    });
    return {
      status: materializedAttachments.status,
      error: materializedAttachments.error,
    };
  }
  if (materializedAttachments?.status === "ok") {
    retainOnSessionKeep = materializedAttachments.retainOnSessionKeep;
    attachmentsReceipt = materializedAttachments.receipt;
    attachmentAbsDir = materializedAttachments.absDir;
    attachmentRootDir = materializedAttachments.rootDir;
    childSystemPrompt = `${childSystemPrompt}\n\n${materializedAttachments.systemPromptSuffix}`;
  }

  const bootstrapContextMode: BootstrapContextMode | undefined = params.lightContext
    ? "lightweight"
    : undefined;

  const childTaskMessage = buildSubagentInitialUserMessage({
    childDepth,
    maxSpawnDepth,
    persistentSession: spawnMode === "session",
  });

  const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
    agentGroupId: ctx.agentGroupId,
    agentGroupChannel: ctx.agentGroupChannel,
    agentGroupSpace: ctx.agentGroupSpace,
    workspaceDir: ctx.workspaceDir,
  });
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: spawnedByKey,
    ...toolSpawnMetadata,
    workspaceDir: resolveSpawnedWorkspaceInheritance({
      config: cfg,
      targetAgentId,
      // For cross-agent spawns, ignore the caller's inherited workspace;
      // let targetAgentId resolve the correct workspace instead.
      explicitWorkspaceDir:
        targetAgentId !== requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir,
    }),
  });
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
    ...(spawnedMetadata.workspaceDir ? { spawnedWorkspaceDir: spawnedMetadata.workspaceDir } : {}),
  });
  if (spawnLineagePatchError) {
    await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey,
      attachmentAbsDir,
      emitLifecycleHooks: threadBindingReady,
      deleteTranscript: true,
    });
    return {
      status: "error",
      error: spawnLineagePatchError,
      childSessionKey,
    };
  }
  const contextEnginePrepareResult = await prepareContextEngineSubagentSpawn({
    cfg,
    context: preparedSpawnContext,
    requesterInternalKey,
    childSessionKey,
    runTimeoutSeconds,
  });
  if (contextEnginePrepareResult.status === "error") {
    await cleanupFailedSpawnBeforeAgentStart({
      childSessionKey,
      attachmentAbsDir,
      emitLifecycleHooks: threadBindingReady,
      deleteTranscript: true,
    });
    return {
      status: "error",
      error: contextEnginePrepareResult.error,
      childSessionKey,
    };
  }
  const contextEnginePreparation = contextEnginePrepareResult.preparation;

  const childIdem = crypto.randomUUID();
  let childRunId: string = childIdem;
  const deliverInitialChildRunDirectly =
    requestThreadBinding && spawnMode === "session" && hasBoundThreadDeliveryOrigin;
  const shouldAnnounceCompletion = deliverInitialChildRunDirectly
    ? false
    : expectsCompletionMessage;
  try {
    const {
      spawnedBy: _spawnedBy,
      workspaceDir: _workspaceDir,
      ...publicSpawnedMetadata
    } = spawnedMetadata;
    const response = await callSubagentGateway({
      method: "agent",
      params: {
        message: childTaskMessage,
        sessionKey: childSessionKey,
        channel: childSessionOrigin?.channel,
        to: childSessionOrigin?.to ?? undefined,
        accountId: childSessionOrigin?.accountId ?? undefined,
        threadId:
          childSessionOrigin?.threadId != null
            ? stringifyRouteThreadId(childSessionOrigin.threadId)
            : undefined,
        idempotencyKey: childIdem,
        deliver: deliverInitialChildRunDirectly,
        lane: AGENT_LANE_SUBAGENT,
        cleanupBundleMcpOnRunEnd: spawnMode !== "session",
        extraSystemPrompt: childSystemPrompt,
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: label || undefined,
        ...(bootstrapContextMode
          ? {
              bootstrapContextMode,
              bootstrapContextRunKind: "default" as const,
            }
          : {}),
        ...publicSpawnedMetadata,
      },
      timeoutMs: resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds),
    });
    const runId = readGatewayRunId(response);
    if (runId) {
      childRunId = runId;
    }
  } catch (err) {
    await rollbackPreparedContextEngine(contextEnginePreparation);
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    let emitLifecycleHooks = false;
    if (threadBindingReady) {
      const hasEndedHook = hookRunner?.hasHooks("subagent_ended") === true;
      let endedHookEmitted = false;
      if (hasEndedHook) {
        try {
          await hookRunner?.runSubagentEnded(
            {
              targetSessionKey: childSessionKey,
              targetKind: "subagent",
              reason: "spawn-failed",
              sendFarewell: true,
              accountId: childSessionOrigin?.accountId,
              runId: childRunId,
              outcome: "error",
              error: "Session failed to start",
            },
            {
              runId: childRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
            },
          );
          endedHookEmitted = true;
        } catch {
          // Spawn should still return an actionable error even if cleanup hooks fail.
        }
      }
      emitLifecycleHooks = !endedHookEmitted;
    }
    // Always delete the provisional child session after a failed spawn attempt.
    // If we already emitted subagent_ended above, suppress a duplicate lifecycle hook.
    try {
      await callSubagentGateway({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks,
        },
        timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
      });
    } catch {
      // Best-effort only.
    }
    const messageText = summarizeError(err);
    return {
      status: "error",
      error: messageText,
      childSessionKey,
      runId: childRunId,
    };
  }

  try {
    registerSubagentRun({
      runId: childRunId,
      childSessionKey,
      controllerSessionKey: requesterInternalKey,
      requesterSessionKey: requesterInternalKey,
      requesterOrigin,
      requesterDisplayKey,
      task,
      cleanup,
      label: label || undefined,
      model: resolvedModel,
      agentDir: targetAgentDir,
      workspaceDir: spawnedMetadata.workspaceDir,
      runTimeoutSeconds,
      expectsCompletionMessage: shouldAnnounceCompletion,
      spawnMode,
      attachmentsDir: attachmentAbsDir,
      attachmentsRootDir: attachmentRootDir,
      retainAttachmentsOnKeep: retainOnSessionKeep,
    });
  } catch (err) {
    await rollbackPreparedContextEngine(contextEnginePreparation);
    if (attachmentAbsDir) {
      try {
        await fs.rm(attachmentAbsDir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup only.
      }
    }
    try {
      await callSubagentGateway({
        method: "sessions.delete",
        params: {
          key: childSessionKey,
          deleteTranscript: true,
          emitLifecycleHooks: threadBindingReady,
        },
        timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
      });
    } catch {
      // Best-effort cleanup only.
    }
    return {
      status: "error",
      error: `Failed to register subagent run: ${summarizeError(err)}`,
      childSessionKey,
      runId: childRunId,
    };
  }

  if (hookRunner?.hasHooks("subagent_spawned")) {
    try {
      await hookRunner.runSubagentSpawned(
        {
          runId: childRunId,
          childSessionKey,
          agentId: targetAgentId,
          label: label || undefined,
          requester: {
            channel: requesterOrigin?.channel,
            accountId: requesterOrigin?.accountId,
            to: requesterOrigin?.to,
            threadId: requesterOrigin?.threadId,
          },
          threadRequested: requestThreadBinding,
          mode: spawnMode,
        },
        {
          runId: childRunId,
          childSessionKey,
          requesterSessionKey: requesterInternalKey,
        },
      );
    } catch {
      // Spawn should still return accepted if spawn lifecycle hooks fail.
    }
  }

  // Emit lifecycle event so the gateway can broadcast sessions.changed to SSE subscribers.
  emitSessionLifecycleEvent({
    sessionKey: childSessionKey,
    reason: "create",
    parentSessionKey: requesterInternalKey,
    label: label || undefined,
  });

  const acceptedNote = resolveSubagentSpawnAcceptedNote({
    spawnMode,
    agentSessionKey: ctx.agentSessionKey,
  });
  return {
    status: "accepted",
    childSessionKey,
    runId: childRunId,
    mode: spawnMode,
    note: preparedSpawnContext.forkFallbackNote
      ? `${acceptedNote} ${preparedSpawnContext.forkFallbackNote}`
      : acceptedNote,
    modelApplied: resolvedModel ? modelApplied : undefined,
    attachments: attachmentsReceipt,
  };
}

export const __testing = {
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    subagentSpawnDeps = overrides
      ? {
          ...defaultSubagentSpawnDeps,
          ...overrides,
        }
      : defaultSubagentSpawnDeps;
  },
};
