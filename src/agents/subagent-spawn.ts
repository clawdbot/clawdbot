/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../acp/runtime/availability.js";
import { routeFromBindingRecord, routeToDeliveryFields } from "../channels/route-projection.js";
import {
  resolveThreadBindingIntroText,
  resolveThreadBindingThreadName,
} from "../channels/thread-bindings-messages.js";
import {
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
} from "../channels/thread-bindings-policy.js";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { listRegisteredPluginAgentPromptGuidance } from "../plugins/command-registry-state.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import {
  GatewayDrainingError,
  runWithGatewayIndependentRootWorkContinuation,
} from "../process/gateway-work-admission.js";
import {
  isIncognitoSessionKey,
  isValidAgentId,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { recordSessionCreated, recordSubagentSpawned } from "../sessions/session-state-events.js";
import type { FastMode } from "../shared/fast-mode.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import { resolveUserPath } from "../utils.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { listAgentIds, resolveAgentDir } from "./agent-scope-config.js";
import type { BootstrapContextMode } from "./bootstrap-files.js";
import { resolveFastModeState } from "./fast-mode.js";
import {
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import { findModelCatalogEntry } from "./model-catalog-lookup.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";
import { supportsModelTools } from "./model-tool-support.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "./spawn-pipeline.js";
import {
  mintSpawnSessionKey,
  prepareSpawnThreadBinding,
  resolveSpawnAdmission,
  resolveSpawnMode,
  resolveSpawnSandboxError,
} from "./spawn-plan.js";
import { resolveRequesterOriginForChild } from "./spawn-requester-origin.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import {
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";
import {
  applySubagentLaunchAuthorization,
  type SubagentLaunchAuthorization,
} from "./subagent-launch-authorization.js";
import {
  completeCollectorLaunchCleanup,
  listSwarmRunsForGroup,
  settleFailedQueuedSubagentLaunch,
  startQueuedSubagentRun,
} from "./subagent-registry.js";
import { resolveSubagentRunTimerDelayMs } from "./subagent-run-timeout.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import { resolveSubagentSpawnOwnership } from "./subagent-spawn-ownership.js";
import {
  resolveConfiguredSubagentRunTimeoutSeconds,
  resolveSubagentModelAndThinkingPlan,
  splitModelRef,
} from "./subagent-spawn-plan.js";
import {
  ADMIN_SCOPE,
  AGENT_LANE_SUBAGENT,
  buildSubagentSystemPrompt,
  callGateway,
  dispatchGatewayMethodInProcess,
  emitSessionLifecycleEvent,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getSessionBindingService,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  mergeDeliveryContext,
  normalizeDeliveryContext,
  ensureContextEnginesInitialized,
  loadPreparedModelCatalog,
  resolveAgentConfig,
  resolveContextEngine,
  resolveGatewaySessionStoreTarget,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  resolveSandboxRuntimeStatus,
  loadSessionEntry,
  upsertSessionEntry,
  resolveLeastPrivilegeOperatorScopesForMethod,
} from "./subagent-spawn.runtime.js";
import type {
  SpawnSubagentContextMode,
  SpawnSubagentMode,
  SpawnSubagentSandboxMode,
} from "./subagent-spawn.types.js";
import { normalizeSubagentTaskName } from "./subagent-task-name.js";
import { resolveSwarmConfig } from "./swarm-config.js";
import { validateStructuredOutputSchema } from "./swarm-output-schema.js";
import { activateSwarmRun, removeQueuedSwarmRun, reserveSwarmRun } from "./swarm-scheduler.js";

export { SUBAGENT_SPAWN_CONTEXT_MODES, SUBAGENT_SPAWN_MODES } from "./subagent-spawn.types.js";

function resolveConfiguredAgentIds(cfg: OpenClawConfig): string[] {
  return listAgentIds(cfg);
}

type SubagentSpawnDeps = {
  callGateway: typeof callGateway;
  dispatchGatewayMethodInProcess: typeof dispatchGatewayMethodInProcess;
  forkSessionEntryFromParent: typeof forkSessionEntryFromParent;
  getGlobalHookRunner: () => SubagentLifecycleHookRunner | null;
  getRuntimeConfig: typeof getRuntimeConfig;
  hasInProcessGatewayContext: typeof hasInProcessGatewayContext;
  ensureContextEnginesInitialized: typeof ensureContextEnginesInitialized;
  loadPreparedModelCatalog: typeof loadPreparedModelCatalog;
  resolveContextEngine: typeof resolveContextEngine;
};

const defaultSubagentSpawnDeps: SubagentSpawnDeps = {
  callGateway,
  dispatchGatewayMethodInProcess,
  forkSessionEntryFromParent,
  getGlobalHookRunner,
  getRuntimeConfig,
  hasInProcessGatewayContext,
  ensureContextEnginesInitialized,
  loadPreparedModelCatalog,
  resolveContextEngine,
};

let subagentSpawnDeps: SubagentSpawnDeps = defaultSubagentSpawnDeps;
const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
const DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 300_000;

type SpawnSubagentParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  taskName?: string;
  thinking?: string;
  fastMode?: FastMode;
  collect?: boolean;
  outputSchema?: Record<string, unknown>;
  groupId?: string;
  /** Host bridge identity used to recover a replay-safe collector launch. */
  swarmLaunchReplayKey?: string;
  /** Canonical request hash checked before reusing a host-reserved collector. */
  swarmLaunchRequestFingerprint?: string;
  cwd?: string;
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

type SpawnSubagentContext = {
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  /** Separate key used only for completion routing, not sandbox policy. */
  completionOwnerKey?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  agentGroupId?: string | null;
  agentGroupChannel?: string | null;
  agentGroupSpace?: string | null;
  agentMemberRoleIds?: string[];
  requesterAgentIdOverride?: string;
  /** Explicit workspace directory for subagent to inherit (optional). */
  workspaceDir?: string;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  requesterRunId?: string;
};

type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
  sessionKey?: string;
  runId?: string;
  mode?: SpawnSubagentMode;
  taskName?: string;
  note?: string;
  /** Fully resolved model ref applied to the spawned child session. */
  resolvedModel?: string;
  /** Provider prefix parsed from resolvedModel when the ref includes one. */
  resolvedProvider?: string;
  modelApplied?: boolean;
  error?: string;
  attachments?: {
    count: number;
    totalBytes: number;
    files: Array<{ name: string; bytes: number; sha256: string }>;
    relDir: string;
  };
};

async function callSubagentGateway(
  params: Parameters<typeof callGateway>[0],
  authorization?: SubagentLaunchAuthorization,
): Promise<Awaited<ReturnType<typeof callGateway>>> {
  // Subagent lifecycle requires methods spanning multiple scope tiers
  // (sessions.delete → admin, agent → write). When each call
  // independently negotiates least-privilege scopes the first connection pairs
  // at a lower tier and every subsequent higher-tier call triggers a
  // scope-upgrade handshake that headless gateway-client connections cannot
  // complete interactively, causing close(1008) "pairing required" (#59428).
  //
  // Only admin-requiring calls are pinned to ADMIN_SCOPE; other methods (e.g.
  // "agent" -> write) keep their least-privilege scope. Apply the trusted
  // launch authorization before resolving the request's required scope.
  const authorizedParams =
    params.params != null && typeof params.params === "object" && !Array.isArray(params.params)
      ? applySubagentLaunchAuthorization(params.params as Record<string, unknown>, authorization)
      : params.params;
  const leastPrivilegeScopes = resolveLeastPrivilegeOperatorScopesForMethod(
    params.method,
    authorizedParams,
  );
  const allowModelOverride = authorization !== undefined;
  const hasInProcessGateway = subagentSpawnDeps.hasInProcessGatewayContext();
  const needsOutOfProcessModelOverrideAuth = allowModelOverride && !hasInProcessGateway;
  const scopes =
    params.scopes ??
    (leastPrivilegeScopes.includes(ADMIN_SCOPE) || needsOutOfProcessModelOverrideAuth
      ? [ADMIN_SCOPE]
      : undefined);
  const request = {
    ...params,
    params: authorizedParams,
    ...(scopes != null ? { scopes } : {}),
  };
  if (
    hasInProcessGateway &&
    request.params != null &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  ) {
    // Spawn is already running in the gateway process for channel/tool calls.
    // Direct dispatch avoids self-connecting over WS while the same event loop is busy.
    // Agent launches are host-owned even when the parent request came from CLI/HTTP.
    // Reusing that external identity makes collector preflight treat the launch as spoofed.
    const forceSyntheticClient = request.method === "agent" || scopes != null;
    return await subagentSpawnDeps.dispatchGatewayMethodInProcess(
      request.method,
      request.params as Record<string, unknown>,
      {
        expectFinal: request.expectFinal,
        ...(allowModelOverride ? { allowSyntheticModelOverride: true } : {}),
        ...(forceSyntheticClient ? { forceSyntheticClient: true } : {}),
        ...(typeof request.timeoutMs === "number" ? { timeoutMs: request.timeoutMs } : {}),
        ...(scopes != null ? { syntheticScopes: scopes } : {}),
      },
    );
  }
  return await subagentSpawnDeps.callGateway(request);
}

function readGatewayRunId(response: Awaited<ReturnType<typeof callGateway>>): string | undefined {
  if (!response || typeof response !== "object") {
    return undefined;
  }
  const { runId } = response as { runId?: unknown };
  return typeof runId === "string" && runId ? runId : undefined;
}

function buildResolvedSubagentModelMetadata(
  resolvedModel?: string,
): Pick<SpawnSubagentResult, "resolvedModel" | "resolvedProvider"> {
  const modelRef = resolvedModel?.trim();
  if (!modelRef) {
    return {};
  }
  const { provider } = splitModelRef(modelRef);
  return {
    resolvedModel: modelRef,
    ...(provider ? { resolvedProvider: provider } : {}),
  };
}

async function resolveCollectorOutputModelError(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  targetAgentDir: string;
  workspaceDir?: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const selected = splitModelRef(params.resolvedModel);
  const fallback = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.targetAgentId,
  });
  const provider = selected.provider ?? fallback.provider;
  const model = selected.model ?? fallback.model;
  if (!provider || !model) {
    return undefined;
  }
  let catalog: Awaited<ReturnType<typeof loadPreparedModelCatalog>>;
  try {
    catalog = await subagentSpawnDeps.loadPreparedModelCatalog({
      config: params.cfg,
      agentDir: params.targetAgentDir,
      workspaceDir: params.workspaceDir,
    });
  } catch (error) {
    return `sessions_spawn could not verify outputSchema model capabilities: ${summarizeError(error)}`;
  }
  const entry = findModelCatalogEntry(catalog, { provider, modelId: model });
  if (!entry || supportsModelTools(entry)) {
    return undefined;
  }
  return `sessions_spawn outputSchema requires a tool-capable target model; "${provider}/${model}" declares compat.supportsTools=false.`;
}

function resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds: number): number {
  const runTimeoutMs = resolveSubagentRunTimerDelayMs(runTimeoutSeconds) ?? 0;
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
  if (patch.inheritedToolPolicyVersion === 1) {
    entry.inheritedToolPolicyVersion = 1;
  }
  if (patch.incognito === true) {
    entry.incognito = true;
  }
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) {
    entry.spawnedBy = patch.spawnedBy.trim();
  }
  if (
    typeof patch.completionOwnerSessionKey === "string" &&
    patch.completionOwnerSessionKey.trim()
  ) {
    entry.completionOwnerSessionKey = patch.completionOwnerSessionKey.trim();
  }
  if (typeof patch.parentSessionKey === "string" && patch.parentSessionKey.trim()) {
    entry.parentSessionKey = patch.parentSessionKey.trim();
  }
  if (typeof patch.spawnedWorkspaceDir === "string" && patch.spawnedWorkspaceDir.trim()) {
    entry.spawnedWorkspaceDir = patch.spawnedWorkspaceDir.trim();
  }
  if (typeof patch.spawnedCwd === "string" && patch.spawnedCwd.trim()) {
    entry.spawnedCwd = patch.spawnedCwd.trim();
  }
  const inheritedToolDeny = normalizeInheritedToolDenylist(patch.inheritedToolDeny);
  if (inheritedToolDeny.length > 0) {
    entry.inheritedToolDeny = inheritedToolDeny;
  }
  const inheritedToolAllow = normalizeInheritedToolAllowlist(patch.inheritedToolAllow);
  if (inheritedToolAllow.length > 0) {
    entry.inheritedToolAllow = inheritedToolAllow;
  }
  if (typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()) {
    entry.thinkingLevel = patch.thinkingLevel.trim();
  }
  if (patch.fastMode === true || patch.fastMode === false || patch.fastMode === "auto") {
    entry.fastMode = patch.fastMode;
  }
  if (typeof patch.swarmGroupId === "string" && patch.swarmGroupId.trim()) {
    entry.swarmGroupId = patch.swarmGroupId.trim();
  }
  if (patch.swarmCollector === true) {
    entry.swarmCollector = true;
  }
  if (patch.swarmOutputSchema && typeof patch.swarmOutputSchema === "object") {
    entry.swarmOutputSchema = patch.swarmOutputSchema as Record<string, unknown>;
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    const { provider, model } = splitModelRef(patch.model.trim());
    if (model) {
      entry.model = model;
      entry.modelOverride = model;
      entry.modelOverrideSource = patch.modelOverrideSource === "auto" ? "auto" : "user";
      const fallbackOriginProvider = normalizeOptionalString(
        patch.modelOverrideFallbackOriginProvider,
      );
      const fallbackOriginModel = normalizeOptionalString(patch.modelOverrideFallbackOriginModel);
      if (fallbackOriginProvider && fallbackOriginModel) {
        entry.modelOverrideFallbackOriginProvider = fallbackOriginProvider;
        entry.modelOverrideFallbackOriginModel = fallbackOriginModel;
      }
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
    await upsertSessionEntry(
      {
        storePath: target.storePath,
        sessionKey: target.canonicalKey,
      },
      {
        model,
        ...(provider ? { modelProvider: provider } : {}),
      },
    );
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  }
}

function readRequesterThinkingLevel(params: {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
}): string | undefined {
  let entry: SessionEntry | undefined;
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
    });
    entry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    entry = undefined;
  }
  if (typeof entry?.thinkingLevel === "string" && entry.thinkingLevel.trim()) {
    return entry.thinkingLevel.trim();
  }
  const requesterAgentThinking = params.requesterAgentId
    ? resolveAgentConfig(params.cfg, params.requesterAgentId)?.thinkingDefault
    : undefined;
  if (requesterAgentThinking) {
    return requesterAgentThinking;
  }
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  if (entry) {
    const normalizedOverride = normalizeStoredOverrideModel({
      providerOverride: entry.providerOverride,
      modelOverride: entry.modelOverride,
    });
    const persistedModel = resolvePersistedSelectedModelRef({
      defaultProvider: defaultModel.provider,
      runtimeProvider: entry.modelProvider,
      runtimeModel: entry.model,
      overrideProvider: normalizedOverride.providerOverride,
      overrideModel: normalizedOverride.modelOverride,
    });
    if (persistedModel) {
      return resolveThinkingDefault({
        cfg: params.cfg,
        provider: persistedModel.provider,
        model: persistedModel.model,
      });
    }
  }
  return resolveThinkingDefault({
    cfg: params.cfg,
    provider: defaultModel.provider,
    model: defaultModel.model,
  });
}

function readRequesterFastMode(params: {
  cfg: OpenClawConfig;
  requesterInternalKey: string;
  requesterAgentId?: string;
}): FastMode {
  let entry: SessionEntry | undefined;
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.requesterInternalKey,
    });
    entry = loadSessionEntry({
      storePath: target.storePath,
      sessionKey: target.canonicalKey,
      clone: false,
    });
  } catch {
    entry = undefined;
  }
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.requesterAgentId,
  });
  const normalizedOverride = entry
    ? normalizeStoredOverrideModel({
        providerOverride: entry.providerOverride,
        modelOverride: entry.modelOverride,
      })
    : {};
  const selectedModel = entry
    ? resolvePersistedSelectedModelRef({
        defaultProvider: defaultModel.provider,
        runtimeProvider: entry.modelProvider,
        runtimeModel: entry.model,
        overrideProvider: normalizedOverride.providerOverride,
        overrideModel: normalizedOverride.modelOverride,
      })
    : undefined;
  return resolveFastModeState({
    cfg: params.cfg,
    provider: selectedModel?.provider ?? defaultModel.provider,
    model: selectedModel?.model ?? defaultModel.model,
    agentId: params.requesterAgentId,
    sessionEntry: entry,
  }).mode;
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

  try {
    if (params.targetAgentId !== params.requesterAgentId) {
      throw new Error(
        'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
      );
    }

    const forkedResult = await subagentSpawnDeps.forkSessionEntryFromParent({
      storePath: childTarget.storePath,
      parentSessionKey: parentTarget.canonicalKey,
      parentStoreKeys: parentTarget.storeKeys,
      sessionKey: childTarget.canonicalKey,
      sessionStoreKeys: childTarget.storeKeys,
      fallbackEntry: { sessionId: "", updatedAt: Date.now() },
      agentId: params.requesterAgentId,
    });
    if (forkedResult.status === "missing-parent") {
      throw new Error(
        'context="fork" requested but the requester session transcript is not available.',
      );
    }
    if (forkedResult.status === "failed" || forkedResult.status === "missing-entry") {
      throw new Error(
        'context="fork" requested but OpenClaw could not fork the requester transcript.',
      );
    }
    parentEntry = forkedResult.parentEntry;
    childEntry = forkedResult.sessionEntry;
    if (forkedResult.status === "skipped") {
      forkFallbackNote =
        forkedResult.decision?.status === "skip" ? forkedResult.decision.message : undefined;
    }
    const forked =
      forkedResult.status === "forked"
        ? {
            sessionId: forkedResult.fork.sessionId,
            sessionFile: forkedResult.fork.sessionFile,
          }
        : null;

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
      ttlMs: finiteSecondsToTimerSafeMilliseconds(params.runTimeoutSeconds, {
        floorSeconds: true,
      }),
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
): Promise<boolean> {
  try {
    await preparation?.rollback();
    return true;
  } catch {
    // Best-effort cleanup only.
    return false;
  }
}

function sanitizeMountPathHint(value?: string): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (hasPromptUnsafeControlCharacter(trimmed)) {
    return undefined;
  }
  if (!/^[A-Za-z0-9._\-/:]+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
}

function hasPromptUnsafeControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f || code === 0x85 || code === 0x2028 || code === 0x2029) {
      return true;
    }
  }
  return false;
}

async function cleanupProvisionalSession(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<boolean> {
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
    return true;
  } catch {
    // Best-effort cleanup only.
    return false;
  }
}

async function waitForProvisionalSessionDeletion(
  childSessionKey: string,
  options?: {
    emitLifecycleHooks?: boolean;
    deleteTranscript?: boolean;
  },
): Promise<void> {
  for (;;) {
    if (await cleanupProvisionalSession(childSessionKey, options)) {
      return;
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
  }
}

async function cleanupFailedSpawnBeforeAgentStart(params: {
  childSessionKey: string;
  attachmentAbsDir?: string;
  emitLifecycleHooks?: boolean;
  deleteTranscript?: boolean;
  waitForSessionDeletion?: boolean;
}): Promise<{ attachmentsRemoved: boolean; sessionDeleted: boolean }> {
  let attachmentsRemoved = true;
  if (params.attachmentAbsDir) {
    try {
      await fs.rm(params.attachmentAbsDir, { recursive: true, force: true });
    } catch {
      attachmentsRemoved = false;
    }
  }
  const sessionCleanupOptions = {
    emitLifecycleHooks: params.emitLifecycleHooks,
    deleteTranscript: params.deleteTranscript,
  };
  if (params.waitForSessionDeletion) {
    await waitForProvisionalSessionDeletion(params.childSessionKey, sessionCleanupOptions);
    return { attachmentsRemoved, sessionDeleted: true };
  }
  return {
    attachmentsRemoved,
    sessionDeleted: await cleanupProvisionalSession(params.childSessionKey, sessionCleanupOptions),
  };
}

async function terminateAcceptedCollectorRun(params: {
  childSessionKey: string;
  gatewayRunId: string;
}): Promise<void> {
  for (;;) {
    try {
      await callSubagentGateway({
        method: "chat.abort",
        params: { sessionKey: params.childSessionKey, runId: params.gatewayRunId },
        timeoutMs: SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS,
      });
      return;
    } catch {
      if (
        await cleanupProvisionalSession(params.childSessionKey, {
          deleteTranscript: true,
        })
      ) {
        return;
      }
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
      timer.unref?.();
    });
  }
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

async function bindThreadForSubagentSpawn(params: {
  cfg: OpenClawConfig;
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
  | { status: "ok"; deliveryOrigin?: DeliveryContext }
  | {
      status: "error";
      error: string;
    }
> {
  const prepared = prepareSpawnThreadBinding({
    cfg: params.cfg,
    kind: "subagent",
    mode: params.mode,
    bindingService: getSessionBindingService(),
    requesterSessionKey: params.requesterSessionKey,
    channel: params.requester.channel,
    accountId: params.requester.accountId,
    to: params.requester.to,
    threadId: params.requester.threadId,
  });
  if (!prepared.ok) {
    return {
      status: "error",
      error: prepared.error,
    };
  }

  try {
    const binding = await getSessionBindingService().bind({
      targetSessionKey: params.childSessionKey,
      targetKind: "subagent",
      conversation: {
        channel: prepared.binding.channel,
        accountId: prepared.binding.accountId,
        conversationId: prepared.binding.conversationId,
        ...(prepared.binding.parentConversationId
          ? { parentConversationId: prepared.binding.parentConversationId }
          : {}),
      },
      placement: prepared.binding.placement,
      metadata: {
        threadName: resolveThreadBindingThreadName({
          agentId: params.agentId,
          label: params.label || params.agentId,
        }),
        agentId: params.agentId,
        label: params.label || undefined,
        boundBy: "system",
        introText: resolveThreadBindingIntroText({
          agentId: params.agentId,
          label: params.label || undefined,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
            cfg: params.cfg,
            channel: prepared.binding.channel,
            accountId: prepared.binding.accountId,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
            cfg: params.cfg,
            channel: prepared.binding.channel,
            accountId: prepared.binding.accountId,
          }),
        }),
      },
    });
    if (!binding.conversation.conversationId) {
      return {
        status: "error",
        error:
          "Unable to create or bind a thread for this subagent session. Session mode is unavailable for this target.",
      };
    }
    const deliveryOrigin = routeToDeliveryFields(routeFromBindingRecord(binding)).deliveryContext;
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
  const taskNameResult = normalizeSubagentTaskName(params.taskName);
  if (taskNameResult.error) {
    return {
      status: "error",
      error: taskNameResult.error,
    };
  }
  const taskName = taskNameResult.taskName;
  const label = params.label?.trim() || "";
  let requestedAgentId = params.agentId?.trim();

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
  if (params.collect && (requestThreadBinding || spawnMode === "session")) {
    return {
      status: "error",
      error: "sessions_spawn collect=true requires mode=run and thread=false.",
    };
  }
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
  const expectsCompletionMessage = params.collect
    ? false
    : params.expectsCompletionMessage !== false;
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
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: ctx.agentSessionKey,
    completionOwnerKey: ctx.completionOwnerKey,
  });

  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  const swarmConfig = resolveSwarmConfig(cfg, requesterAgentId);
  const hasSwarmParams =
    params.collect !== undefined ||
    params.outputSchema !== undefined ||
    params.fastMode !== undefined ||
    params.groupId !== undefined;
  if (hasSwarmParams && !swarmConfig.enabled) {
    return {
      status: "forbidden",
      error: "sessions_spawn swarm parameters require tools.swarm.enabled=true.",
    };
  }
  if (params.outputSchema && !params.collect) {
    return { status: "error", error: "sessions_spawn outputSchema requires collect=true." };
  }
  if (params.groupId !== undefined && !params.collect) {
    return { status: "error", error: "sessions_spawn groupId requires collect=true." };
  }
  if (params.outputSchema) {
    const schemaError = validateStructuredOutputSchema(params.outputSchema);
    if (schemaError) {
      return { status: "error", error: schemaError };
    }
  }

  const usingDefaultAgentId =
    params.collect === true && !requestedAgentId && Boolean(swarmConfig.defaultAgentId);
  if (usingDefaultAgentId) {
    requestedAgentId = swarmConfig.defaultAgentId;
    if (!isValidAgentId(requestedAgentId)) {
      return {
        status: "error",
        error: `tools.swarm.defaultAgentId contains invalid agentId "${requestedAgentId}".`,
      };
    }
  }
  const targetAgentId = requestedAgentId ? normalizeAgentId(requestedAgentId) : requesterAgentId;
  const configuredAgentIds = resolveConfiguredAgentIds(cfg);
  const explicitSwarmGroupId = normalizeOptionalString(params.groupId);
  const requesterRunId = normalizeOptionalString(ctx.requesterRunId);
  const swarmGroupId = params.collect
    ? (explicitSwarmGroupId ??
      (requesterRunId ? `swarm:${requesterInternalKey}:${requesterRunId}` : undefined))
    : undefined;
  const swarmSchedulerGroupKey = swarmGroupId
    ? JSON.stringify([requesterInternalKey, swarmGroupId])
    : undefined;
  const resolveAdmission = () => {
    const collectorRuns = params.collect
      ? swarmGroupId
        ? listSwarmRunsForGroup(swarmGroupId, requesterInternalKey)
        : []
      : undefined;
    return resolveSpawnAdmission({
      cfg,
      collector: collectorRuns
        ? {
            liveChildren: collectorRuns.filter((entry) => !entry.collectorCompletion).length,
            totalChildren: collectorRuns.length,
            maxChildrenPerGroup: swarmConfig.maxChildrenPerGroup,
            maxTotalPerGroup: swarmConfig.maxTotalPerGroup,
          }
        : undefined,
      requesterSessionKey: requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      requestedAgentId,
      configuredAgentIds,
    });
  };
  const admission = resolveAdmission();
  if (!admission.ok) {
    return {
      status: "forbidden",
      error:
        usingDefaultAgentId && !admission.governingCap?.startsWith("tools.swarm.")
          ? `tools.swarm.defaultAgentId is unavailable: ${admission.error}`
          : admission.error,
    };
  }
  if (params.collect && !swarmGroupId) {
    return {
      status: "error",
      error: "sessions_spawn collect=true requires a requesting run id when groupId is omitted.",
    };
  }
  const childDepth = admission.childSessionPatch?.spawnDepth ?? 1;
  const maxSpawnDepth = admission.maxSpawnDepth ?? childDepth;
  const swarmLaunchReplayKey = normalizeOptionalString(params.swarmLaunchReplayKey);
  // Registry and Gateway identities are global, while host replay keys are requester-scoped.
  const childIdem = swarmLaunchReplayKey
    ? `swarm_${crypto
        .createHash("sha256")
        .update(JSON.stringify([requesterInternalKey, swarmLaunchReplayKey]))
        .digest("hex")
        .slice(0, 32)}`
    : crypto.randomUUID();
  let childRunId: string = childIdem;
  let swarmReservationPending = false;
  if (params.collect && swarmGroupId && swarmSchedulerGroupKey) {
    const groupRuns = listSwarmRunsForGroup(swarmGroupId, requesterInternalKey);
    if (
      !reserveSwarmRun({
        groupId: swarmSchedulerGroupKey,
        runId: childRunId,
        maxConcurrent: swarmConfig.maxConcurrent,
        activeRunIds: groupRuns
          .filter((entry) => entry.execution?.status === "running")
          .map((entry) => entry.schedulerSlotId ?? entry.runId),
      })
    ) {
      return { status: "error", error: "sessions_spawn could not reserve swarm FIFO order." };
    }
    swarmReservationPending = true;
  }
  try {
    const requestedCwd = normalizeOptionalString(params.cwd);
    const spawnedCwd = requestedCwd ? resolveUserPath(requestedCwd) : undefined;
    const toolSpawnMetadata = mapToolContextToSpawnedRunMetadata({
      agentGroupId: ctx.agentGroupId,
      agentGroupChannel: ctx.agentGroupChannel,
      agentGroupSpace: ctx.agentGroupSpace,
      workspaceDir: ctx.workspaceDir,
    });
    const inheritedWorkspaceDir =
      targetAgentId !== requesterAgentId ? undefined : toolSpawnMetadata.workspaceDir;
    const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
      config: cfg,
      targetAgentId,
      explicitWorkspaceDir: inheritedWorkspaceDir,
    });
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
    const incognito = isIncognitoSessionKey(requesterInternalKey);
    const mintedChildSessionKey = mintSpawnSessionKey({ targetAgentId, backend: "subagent" });
    const childSessionKey = incognito
      ? mintedChildSessionKey.replace(":subagent:", ":subagent:incognito-")
      : mintedChildSessionKey;
    const requesterRuntime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: requesterInternalKey,
    });
    const childRuntime = resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: childSessionKey,
    });
    const sandboxError = resolveSpawnSandboxError({
      backend: "subagent",
      requesterSandboxed: requesterRuntime.sandboxed,
      childSandboxed: childRuntime.sandboxed,
      sandbox: sandboxMode,
    });
    if (sandboxError) {
      return { status: "forbidden", error: sandboxError };
    }
    const spawnedWorkspaceCwd = spawnedWorkspaceDir
      ? resolveUserPath(spawnedWorkspaceDir)
      : undefined;
    if (childRuntime.sandboxed && spawnedCwd && spawnedCwd !== spawnedWorkspaceCwd) {
      return {
        status: "forbidden",
        error:
          "cwd override is not supported for sandboxed subagent runs; omit cwd or use the target agent workspace as cwd",
      };
    }
    const spawnedByKey = requesterInternalKey;
    const targetAgentDir = resolveAgentDir(cfg, targetAgentId);
    const requesterAgentConfig = resolveAgentConfig(cfg, requesterAgentId);
    const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
    const callerThinkingRaw = readRequesterThinkingLevel({
      cfg,
      requesterInternalKey,
      requesterAgentId,
    });
    const inheritedFastMode =
      swarmConfig.enabled && params.fastMode === undefined
        ? readRequesterFastMode({
            cfg,
            requesterInternalKey,
            requesterAgentId,
          })
        : params.fastMode;
    const plan = resolveSubagentModelAndThinkingPlan({
      cfg,
      targetAgentId,
      requesterAgentConfig,
      targetAgentConfig,
      modelOverride,
      thinkingOverrideRaw,
      callerThinkingRaw,
      fastMode: inheritedFastMode,
    });
    if (plan.status === "error") {
      return {
        status: "error",
        error: plan.error,
      };
    }
    const { resolvedModel, thinkingOverride } = plan;
    const resolvedLaunchModel = splitModelRef(resolvedModel);
    const launchAuthorization: SubagentLaunchAuthorization | undefined =
      modelOverride?.trim() && resolvedLaunchModel.model
        ? {
            modelOverride: {
              ...(resolvedLaunchModel.provider ? { provider: resolvedLaunchModel.provider } : {}),
              model: resolvedLaunchModel.model,
            },
          }
        : undefined;
    if (params.outputSchema) {
      const outputModelError = await resolveCollectorOutputModelError({
        cfg,
        targetAgentId,
        targetAgentDir,
        workspaceDir: spawnedWorkspaceDir,
        resolvedModel,
      });
      if (outputModelError) {
        return { status: "error", error: outputModelError, childSessionKey };
      }
    }
    const resolvedModelMetadata = buildResolvedSubagentModelMetadata(resolvedModel);
    let childCreationEntry: SessionEntry | undefined;
    const patchChildSession = async (
      patch: Record<string, unknown>,
      creationStamp?: ReturnType<typeof buildSessionCreationStamp>,
    ): Promise<string | undefined> => {
      try {
        const target = incognito
          ? {
              agentId: targetAgentId,
              canonicalKey: childSessionKey,
              storeKeys: [childSessionKey],
              storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: targetAgentId }),
            }
          : resolveGatewaySessionStoreTarget({
              cfg,
              key: childSessionKey,
            });
        const updatedEntry = await upsertSessionEntry(
          {
            storePath: target.storePath,
            sessionKey: target.canonicalKey,
          },
          { ...buildDirectChildSessionPatch(patch), ...creationStamp },
        );
        childCreationEntry ??= updatedEntry ?? undefined;
        return undefined;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : typeof err === "string" ? err : "error";
        return `child session patch failed: ${message}`;
      }
    };

    const initialChildSessionPatch: Record<string, unknown> = {
      spawnedBy: spawnedByKey,
      completionOwnerSessionKey: ownership.completionRequesterSessionKey,
      // Navigation and control lineage commit with the creation stamp so a
      // launch failure cannot leave a durable but parentless child row.
      parentSessionKey: spawnedByKey,
      ...(spawnedWorkspaceDir ? { spawnedWorkspaceDir } : {}),
      ...(spawnedCwd ? { spawnedCwd } : {}),
      ...admission.childSessionPatch,
      inheritedToolPolicyVersion: 1,
      ...inheritedToolAllowPatch(ctx.inheritedToolAllowlist),
      ...inheritedToolDenyPatch(ctx.inheritedToolDenylist),
      ...plan.initialSessionPatch,
      ...(swarmGroupId ? { swarmGroupId } : {}),
      ...(params.collect ? { swarmCollector: true } : {}),
      ...(params.outputSchema ? { swarmOutputSchema: params.outputSchema } : {}),
      ...(incognito ? { incognito: true } : {}),
    };

    const initialPatchError = await patchChildSession(
      initialChildSessionPatch,
      buildSessionCreationStamp({
        via: "spawn",
        actor: { type: "agent", id: requesterInternalKey },
      }),
    );
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
      const bindResult = await bindThreadForSubagentSpawn({
        cfg,
        childSessionKey,
        agentId: targetAgentId,
        label: label || undefined,
        mode: spawnMode,
        requesterSessionKey: ownership.threadBindingRequesterSessionKey,
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
      nativeCommandGuidanceLines: listRegisteredPluginAgentPromptGuidance({
        surface: "subagent",
      }),
      childDepth,
      maxSpawnDepth,
    });
    if (params.outputSchema) {
      childSystemPrompt = `${childSystemPrompt}\n\nCall structured_output with {"result": <your final result>} until one payload is accepted, with at most one retry after a rejected attempt. The result value must match the requested JSON Schema. Do not call structured_output again after acceptance.`;
    }

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
      workspaceDir: spawnedCwd ?? spawnedWorkspaceDir,
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
      task,
    });
    const spawnedMetadata = normalizeSpawnedRunMetadata({
      spawnedBy: spawnedByKey,
      ...toolSpawnMetadata,
      workspaceDir: spawnedWorkspaceDir,
    });

    if (childCreationEntry) {
      recordSessionCreated({
        sessionKey: childSessionKey,
        agentId: targetAgentId,
        entry: childCreationEntry,
      });
    }
    recordSubagentSpawned({
      childSessionKey,
      childRunId,
      requesterSessionKey: requesterInternalKey,
      agentId: targetAgentId,
    });
    const deliverInitialChildRunDirectly =
      requestThreadBinding && spawnMode === "session" && hasBoundThreadDeliveryOrigin;
    const shouldAnnounceCompletion = deliverInitialChildRunDirectly
      ? false
      : expectsCompletionMessage;
    const progressOrigin = {
      channel: requesterOrigin?.channel,
      accountId: requesterOrigin?.accountId,
      to: ctx.currentMessagingTarget ?? requesterOrigin?.to,
      threadId: requesterOrigin?.threadId,
      channelId: ctx.currentChannelId,
      messageId: ctx.currentMessageId,
    };
    const {
      spawnedBy: _spawnedBy,
      workspaceDir: _workspaceDir,
      ...publicSpawnedMetadata
    } = spawnedMetadata;
    const childLaunchRequest: Record<string, unknown> = {
      message: childTaskMessage,
      sessionKey: childSessionKey,
      ...(params.collect
        ? {}
        : {
            channel: childSessionOrigin?.channel,
            to: childSessionOrigin?.to ?? undefined,
            accountId: childSessionOrigin?.accountId ?? undefined,
            threadId:
              childSessionOrigin?.threadId != null
                ? stringifyRouteThreadId(childSessionOrigin.threadId)
                : undefined,
          }),
      idempotencyKey: childIdem,
      deliver: deliverInitialChildRunDirectly,
      lane: AGENT_LANE_SUBAGENT,
      disableMessageTool: true,
      swarmCollector: params.collect === true,
      swarmOutputSchema: params.outputSchema,
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
    };
    const childLaunch = {
      request: childLaunchRequest,
      ...(launchAuthorization ? { authorization: launchAuthorization } : {}),
      timeoutMs: resolveSubagentAgentGatewayTimeoutMs(runTimeoutSeconds),
    };
    const queuedLaunch =
      params.collect && swarmSchedulerGroupKey
        ? {
            ...childLaunch,
            schedulerGroupKey: swarmSchedulerGroupKey,
            maxConcurrent: swarmConfig.maxConcurrent,
          }
        : undefined;
    const launchChildRun = async () =>
      await callSubagentGateway(
        {
          method: "agent",
          params: childLaunch.request,
          timeoutMs: childLaunch.timeoutMs,
        },
        childLaunch.authorization,
      );

    // "spawned"/"started" hooks mean an accepted Gateway run. Direct runs emit
    // after the shared pipeline; queued collectors emit from the scheduler start.
    const emitSpawnLifecycleHooks = async (hookRunId: string) => {
      if (hookRunner?.hasHooks("subagent_progress")) {
        try {
          await hookRunner.runSubagentProgress(
            {
              phase: "started",
              runId: hookRunId,
              childSessionKey,
              requester: progressOrigin,
            },
            {
              runId: hookRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
            },
          );
        } catch {
          // Presentation hooks are best-effort after durable registration.
        }
      }
      if (hookRunner?.hasHooks("subagent_spawned")) {
        try {
          await hookRunner.runSubagentSpawned(
            {
              runId: hookRunId,
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
              ...resolvedModelMetadata,
            },
            {
              runId: hookRunId,
              childSessionKey,
              requesterSessionKey: requesterInternalKey,
            },
          );
        } catch {
          // Spawn stays accepted if lifecycle presentation fails.
        }
      }
    };
    type SubagentBackendState = { contextEnginePreparation?: SubagentSpawnPreparation };
    const adapter: SpawnBackendAdapter<SubagentBackendState> = {
      async initialize() {
        const result =
          params.lightContext && preparedSpawnContext.mode === "isolated"
            ? ({ status: "ok", preparation: undefined } as const)
            : await prepareContextEngineSubagentSpawn({
                cfg,
                context: preparedSpawnContext,
                requesterInternalKey,
                childSessionKey,
                runTimeoutSeconds,
              });
        if (result.status === "error") {
          throw new Error(result.error);
        }
        return { contextEnginePreparation: result.preparation };
      },
      async dispatchTurn() {
        if (params.collect) {
          return { runId: childIdem };
        }
        const response = await launchChildRun();
        return { runId: readGatewayRunId(response) ?? childIdem };
      },
      async cleanupOnFailure({ phase, state }) {
        if (phase === "initialize") {
          await cleanupFailedSpawnBeforeAgentStart({
            childSessionKey,
            attachmentAbsDir,
            emitLifecycleHooks: threadBindingReady,
            deleteTranscript: true,
          });
          return;
        }
        await rollbackPreparedContextEngine(state?.contextEnginePreparation);
        if (attachmentAbsDir) {
          try {
            await fs.rm(attachmentAbsDir, { recursive: true, force: true });
          } catch {
            // Best-effort cleanup only.
          }
        }
        let emitLifecycleHooks = threadBindingReady;
        if (phase === "dispatch" && threadBindingReady) {
          let endedHookEmitted = false;
          if (hookRunner?.hasHooks("subagent_ended")) {
            try {
              await hookRunner.runSubagentEnded(
                {
                  targetSessionKey: childSessionKey,
                  targetKind: "subagent",
                  reason: "spawn-failed",
                  sendFarewell: true,
                  accountId: childSessionOrigin?.accountId,
                  runId: childIdem,
                  outcome: "error",
                  error: "Session failed to start",
                },
                {
                  runId: childIdem,
                  childSessionKey,
                  requesterSessionKey: requesterInternalKey,
                },
              );
              endedHookEmitted = true;
            } catch {
              // Spawn cleanup continues even when presentation hooks fail.
            }
          }
          emitLifecycleHooks = !endedHookEmitted;
        }
        await cleanupProvisionalSession(childSessionKey, {
          emitLifecycleHooks,
          deleteTranscript: true,
        });
      },
    };
    const pipelineResult = await runSpawnPipeline({
      adapter,
      progressOrigin,
      progressSessionKey: requesterInternalKey,
      buildRegistration: (_state, runId) => {
        if (params.collect) {
          const latestAdmission = resolveAdmission();
          if (!latestAdmission.ok) {
            throw Object.assign(new Error(latestAdmission.error), {
              spawnStatus: "forbidden" as const,
            });
          }
        }
        return {
          runId,
          requesterTurnRunId: ctx.requesterTurnRunId,
          childSessionKey,
          controllerSessionKey: ownership.controllerSessionKey,
          requesterSessionKey: ownership.completionRequesterSessionKey,
          requesterOrigin,
          progressOrigin,
          requesterDisplayKey: ownership.completionRequesterDisplayKey,
          task,
          taskName,
          agentId: targetAgentId,
          requesterAgentId,
          cleanup,
          label: label || undefined,
          model: resolvedModel,
          agentDir: targetAgentDir,
          workspaceDir: spawnedMetadata.workspaceDir,
          runTimeoutSeconds,
          expectsCompletionMessage: shouldAnnounceCompletion,
          spawnMode,
          collect: params.collect === true,
          swarmRequesterSessionKey: params.collect ? requesterInternalKey : undefined,
          swarmLaunchIdempotencyKey: params.collect ? childIdem : undefined,
          swarmLaunchReplayKey: params.collect ? swarmLaunchReplayKey : undefined,
          swarmLaunchRequestFingerprint: params.collect
            ? params.swarmLaunchRequestFingerprint
            : undefined,
          outputSchema: params.outputSchema,
          groupId: swarmGroupId,
          queuedLaunch,
          queued: params.collect === true,
          attachmentsDir: attachmentAbsDir,
          attachmentsRootDir: attachmentRootDir,
          retainAttachmentsOnKeep: retainOnSessionKeep,
        };
      },
    });
    if (!pipelineResult.ok) {
      const runId = pipelineResult.runId ?? childIdem;
      const spawnStatus =
        pipelineResult.error && typeof pipelineResult.error === "object"
          ? (pipelineResult.error as { spawnStatus?: unknown }).spawnStatus
          : undefined;
      return {
        status: spawnStatus === "forbidden" ? "forbidden" : "error",
        error:
          pipelineResult.phase === "register" && spawnStatus !== "forbidden"
            ? `Failed to register subagent run: ${summarizeSpawnError(pipelineResult.error)}`
            : summarizeSpawnError(pipelineResult.error),
        childSessionKey,
        ...(pipelineResult.phase === "initialize" ? {} : { runId }),
      };
    }
    childRunId = pipelineResult.runId;
    if (params.collect && swarmGroupId && swarmSchedulerGroupKey) {
      let launchTerminationConfirmed = false;
      activateSwarmRun({
        groupId: swarmSchedulerGroupKey,
        runId: childRunId,
        start: async () => {
          await runWithGatewayIndependentRootWorkContinuation(async () => {
            const response = await launchChildRun();
            const gatewayRunId = readGatewayRunId(response) ?? childRunId;
            try {
              if (!startQueuedSubagentRun(childRunId, gatewayRunId)) {
                throw new Error(
                  "collector registry row could not transition from queued to running",
                );
              }
            } catch (error) {
              await terminateAcceptedCollectorRun({ childSessionKey, gatewayRunId });
              launchTerminationConfirmed = true;
              throw error;
            }
            await emitSpawnLifecycleHooks(gatewayRunId);
          });
        },
        onStartFailure: async (error) => {
          if (error instanceof GatewayDrainingError) {
            return false;
          }
          const launchError = summarizeError(error);
          const [contextRollback, sessionCleanup] = await Promise.allSettled([
            rollbackPreparedContextEngine(pipelineResult.state.contextEnginePreparation),
            cleanupFailedSpawnBeforeAgentStart({
              childSessionKey,
              attachmentAbsDir,
              emitLifecycleHooks: threadBindingReady,
              deleteTranscript: true,
              // A launch RPC can fail after acceptance. Keep the FIFO slot until
              // deleting the child session proves no accepted run remains active.
              waitForSessionDeletion: !launchTerminationConfirmed,
            }),
          ]);
          for (;;) {
            try {
              settleFailedQueuedSubagentLaunch(childRunId, launchError);
              break;
            } catch {
              // The child is stopped; retry only the durable terminal write.
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, isFastTestRuntimeEnv() ? 1 : 1_000);
                timer.unref?.();
              });
            }
          }
          const cleanupComplete =
            contextRollback.status === "fulfilled" &&
            contextRollback.value &&
            sessionCleanup.status === "fulfilled" &&
            sessionCleanup.value.attachmentsRemoved &&
            sessionCleanup.value.sessionDeleted;
          if (cleanupComplete) {
            emitSessionLifecycleEvent({
              sessionKey: childSessionKey,
              reason: "delete",
              parentSessionKey: requesterInternalKey,
            });
            completeCollectorLaunchCleanup(childRunId);
          }
          return true;
        },
      });
      swarmReservationPending = false;
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
        sessionKey: childSessionKey,
        runId: childRunId,
        mode: spawnMode,
        taskName,
        note: preparedSpawnContext.forkFallbackNote
          ? `${acceptedNote} ${preparedSpawnContext.forkFallbackNote}`
          : acceptedNote,
        ...resolvedModelMetadata,
        modelApplied: resolvedModel ? modelApplied : undefined,
        attachments: attachmentsReceipt,
      };
    }

    await emitSpawnLifecycleHooks(childRunId);

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
      taskName,
      note: preparedSpawnContext.forkFallbackNote
        ? `${acceptedNote} ${preparedSpawnContext.forkFallbackNote}`
        : acceptedNote,
      ...resolvedModelMetadata,
      modelApplied: resolvedModel ? modelApplied : undefined,
      attachments: attachmentsReceipt,
    };
  } finally {
    if (swarmReservationPending) {
      removeQueuedSwarmRun(childRunId);
    }
  }
}

const testing = {
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    subagentSpawnDeps = overrides
      ? {
          ...defaultSubagentSpawnDeps,
          ...overrides,
        }
      : defaultSubagentSpawnDeps;
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.subagentSpawnTestApi")] =
    testing;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
