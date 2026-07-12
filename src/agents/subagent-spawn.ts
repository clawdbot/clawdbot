// "RFC §" references herein cite docs/design/continue-work-signal-v2.md (Agent Self-Elected Turn Continuation / CONTINUE_WORK).
/**
 * Subagent spawn executor.
 *
 * Validates spawn requests, prepares child sessions, stages attachments, binds delivery context, and registers runs.
 */
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { finiteSecondsToTimerSafeMilliseconds } from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isAcpRuntimeSpawnAvailable } from "../acp/runtime/availability.js";
import {
  resolveChannelDefaultBindingPlacement,
  resolveInboundConversationResolution,
} from "../channels/conversation-resolution.js";
import { routeFromBindingRecord, routeToDeliveryFields } from "../channels/route-projection.js";
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
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentSpawnPreparation } from "../context-engine/types.js";
import { normalizeDiagnosticTraceparent } from "../infra/diagnostic-trace-context-pure.js";
import { stringifyRouteThreadId } from "../plugin-sdk/channel-route.js";
import { listRegisteredPluginAgentPromptGuidance } from "../plugins/command-registry-state.js";
import type { SubagentLifecycleHookRunner } from "../plugins/hooks.js";
import { isValidAgentId, normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { recordSubagentSpawned } from "../sessions/session-state-events.js";
import { resolveUserPath } from "../utils.js";
import type { DeliveryContext } from "../utils/delivery-context.types.js";
import { listAgentIds, resolveAgentDir } from "./agent-scope-config.js";
import type { BootstrapContextMode } from "./bootstrap-files.js";
import {
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import {
  normalizeStoredOverrideModel,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";
import { resolveThinkingDefault } from "./model-thinking-default.js";
import {
  mapToolContextToSpawnedRunMetadata,
  normalizeSpawnedRunMetadata,
  resolveSpawnedWorkspaceInheritance,
} from "./spawned-context.js";
import {
  materializeSubagentAttachments,
  type SubagentAttachmentReceiptFile,
} from "./subagent-attachments.js";
import { resolveSubagentCapabilities } from "./subagent-capabilities.js";
import {
  deriveContinuationDelegateChildRunId,
  deriveContinuationDelegateChildSessionKey,
} from "./subagent-continuation-ids.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { buildSubagentInitialUserMessage } from "./subagent-initial-user-message.js";
import {
  countActiveRunsForSession,
  registerSubagentRun,
} from "./subagent-registry-spawn-runtime.js";
import { resolveSubagentRunTimerDelayMs } from "./subagent-run-timeout.js";
import { resolveSubagentSpawnAcceptedNote } from "./subagent-spawn-accepted-note.js";
import { resolveSubagentSpawnOwnership } from "./subagent-spawn-ownership.js";
import { resolveSubagentTargetPolicy } from "./subagent-target-policy.js";
import { normalizeSubagentTaskName } from "./subagent-task-name.js";
import { registerSubagentTraceparentHandoff } from "./subagent-traceparent-handoff.js";
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
  resolveContextEngine,
};

let subagentSpawnDeps: SubagentSpawnDeps = defaultSubagentSpawnDeps;
const SUBAGENT_CONTROL_GATEWAY_TIMEOUT_MS = 60_000;
const DEFAULT_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 60_000;
const MAX_SUBAGENT_AGENT_GATEWAY_TIMEOUT_MS = 300_000;

type ContinuationChainSpawnState = {
  count: number;
  startedAt: number;
  tokens: number;
  chainId?: string;
};

type SpawnSubagentBaseParams = {
  task: string;
  label?: string;
  agentId?: string;
  model?: string;
  taskName?: string;
  thinking?: string;
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
  /** When true, sub-agent completion is delivered as a silent system event
   *  instead of a visible channel message. Used for ambient enrichment shards. */
  silentAnnounce?: boolean;
  /** When true (with silentAnnounce), the parent session is woken after the
   *  enrichment is enqueued. Enables autonomous cognition loops where the agent
   *  acts on shard returns without external nudge. */
  wakeOnReturn?: boolean;
  /** Continuation return targeting for cross-session delegate enrichment. */
  continuationTargetSessionKey?: string;
  continuationTargetSessionKeys?: string[];
  continuationFanoutMode?: "tree" | "all";
  traceparent?: string;
  /** Durable continuation delegate flow id; used to derive idempotent child session/run keys. */
  continuationDelegateFlowId?: string;
};

type SpawnSubagentContinuationDrainParams = {
  /** When true, the spawned sub-agent's run drains the continuation delegate queue,
   *  enabling the continue_delegate tool for chain-hop delegates. */
  drainsContinuationDelegateQueue: true;
  /** Initial continuation chain basis for a child that can drain continuation delegates. */
  continuationChainState: ContinuationChainSpawnState;
};

type SpawnSubagentNonContinuationDrainParams = {
  drainsContinuationDelegateQueue?: false;
  continuationChainState?: never;
};

export type SpawnSubagentParams = SpawnSubagentBaseParams &
  (SpawnSubagentContinuationDrainParams | SpawnSubagentNonContinuationDrainParams);

export type SpawnSubagentContext = {
  agentSessionKey?: string;
  /** Separate key used only for completion routing, not sandbox policy. */
  completionOwnerKey?: string;
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
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};

export type SpawnSubagentResult = {
  status: "accepted" | "forbidden" | "error";
  childSessionKey?: string;
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

export { splitModelRef } from "./subagent-spawn-plan.js";

function hasRequestModelOverride(params: unknown): boolean {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    return false;
  }
  const record = params as Record<string, unknown>;
  return typeof record.provider === "string" || typeof record.model === "string";
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
  // Only admin-requiring calls are pinned to ADMIN_SCOPE; other methods (e.g.
  // "agent" → write) keep their least-privilege scope so the gateway does not
  // treat the caller as owner. The params-aware resolver keeps spawn-metadata
  // sessions.patch calls on the admin tier.
  const leastPrivilegeScopes = resolveLeastPrivilegeOperatorScopesForMethod(
    params.method,
    params.params,
  );
  const scopes =
    params.scopes ?? (leastPrivilegeScopes.includes(ADMIN_SCOPE) ? [ADMIN_SCOPE] : undefined);
  const request = {
    ...params,
    ...(scopes != null ? { scopes } : {}),
  };
  if (
    subagentSpawnDeps.hasInProcessGatewayContext() &&
    request.params != null &&
    typeof request.params === "object" &&
    !Array.isArray(request.params)
  ) {
    const agentModelOverride =
      request.method === "agent" && hasRequestModelOverride(request.params);
    // Spawn is already running in the gateway process for channel/tool calls.
    // Direct dispatch avoids self-connecting over WS while the same event loop is busy.
    return await subagentSpawnDeps.dispatchGatewayMethodInProcess(
      request.method,
      request.params as Record<string, unknown>,
      {
        expectFinal: request.expectFinal,
        ...(scopes != null || agentModelOverride ? { forceSyntheticClient: true } : {}),
        ...(agentModelOverride ? { allowSyntheticModelOverride: true } : {}),
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
  const { runId } = response as Record<string, unknown>;
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
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) {
    entry.spawnedBy = patch.spawnedBy.trim();
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
  const continuationTraceparent = normalizeDiagnosticTraceparent(
    typeof patch.continuationTraceparent === "string" ? patch.continuationTraceparent : undefined,
  );
  if (continuationTraceparent) {
    entry.continuationTraceparent = continuationTraceparent;
  }
  const continuationChainCount = normalizeNonNegativeInteger(patch.continuationChainCount);
  if (continuationChainCount !== undefined) {
    entry.continuationChainCount = continuationChainCount;
  }
  const continuationChainStartedAt = normalizeNonNegativeInteger(patch.continuationChainStartedAt);
  if (continuationChainStartedAt !== undefined) {
    entry.continuationChainStartedAt = continuationChainStartedAt;
  }
  const continuationChainTokens = normalizeNonNegativeInteger(patch.continuationChainTokens);
  if (continuationChainTokens !== undefined) {
    entry.continuationChainTokens = continuationChainTokens;
  }
  const continuationChainId =
    typeof patch.continuationChainId === "string" ? patch.continuationChainId.trim() : "";
  if (continuationChainId) {
    entry.continuationChainId = continuationChainId;
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

function normalizeNonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return Math.floor(value);
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

type PreparedSubagentThreadBinding = {
  channel: string;
  accountId: string;
  placement: "current" | "child";
  conversationId: string;
  parentConversationId?: string;
};

function resolvePlacementWithoutChannelPlugin(params: {
  capabilities: { placements: Array<"current" | "child"> };
}): "current" | "child" {
  return params.capabilities.placements.includes("child") ? "child" : "current";
}

function resolveSubagentSpawnChannelAccountId(params: {
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
  return normalizeOptionalString(channels?.[channel]?.defaultAccount) ?? "default";
}

function resolveConversationRefForThreadBinding(params: {
  cfg: OpenClawConfig;
  channel?: string;
  accountId?: string;
  to?: string;
  threadId?: string | number;
}): { conversationId: string; parentConversationId?: string } | null {
  const resolution = resolveInboundConversationResolution({
    cfg: params.cfg,
    channel: params.channel,
    accountId: params.accountId,
    to: params.to,
    threadId: params.threadId,
    isGroup: true,
  });
  return resolution?.canonical ?? null;
}

function resolveRequesterBoundConversationRef(params: {
  requesterSessionKey?: string;
  channel: string;
  accountId: string;
  fallback?: { conversationId: string; parentConversationId?: string } | null;
}): { conversationId: string; parentConversationId?: string } | null | undefined {
  const requesterSessionKey = normalizeOptionalString(params.requesterSessionKey);
  if (!requesterSessionKey) {
    return undefined;
  }
  const activeBindings = getSessionBindingService()
    .listBySession(requesterSessionKey)
    .filter(
      (record) =>
        record.status !== "ended" &&
        record.conversation.channel === params.channel &&
        (record.conversation.accountId ?? params.accountId) === params.accountId,
    );
  if (activeBindings.length === 0) {
    return undefined;
  }
  if (activeBindings.length === 1) {
    const conversation = activeBindings.at(0)?.conversation;
    if (!conversation) {
      return undefined;
    }
    return {
      conversationId: conversation.conversationId,
      ...(conversation.parentConversationId
        ? { parentConversationId: conversation.parentConversationId }
        : {}),
    };
  }
  if (params.fallback?.conversationId) {
    const matched = activeBindings.filter(
      (record) =>
        record.conversation.conversationId === params.fallback?.conversationId &&
        normalizeOptionalString(record.conversation.parentConversationId) ===
          normalizeOptionalString(params.fallback?.parentConversationId),
    );
    if (matched.length === 1) {
      const conversation = matched.at(0)?.conversation;
      if (!conversation) {
        return undefined;
      }
      return {
        conversationId: conversation.conversationId,
        ...(conversation.parentConversationId
          ? { parentConversationId: conversation.parentConversationId }
          : {}),
      };
    }
  }
  return null;
}

function prepareSubagentThreadBinding(params: {
  cfg: OpenClawConfig;
  mode: SpawnSubagentMode;
  requesterSessionKey?: string;
  requester: {
    channel?: string;
    accountId?: string;
    to?: string;
    threadId?: string | number;
  };
}): { ok: true; binding: PreparedSubagentThreadBinding } | { ok: false; error: string } {
  const channel = normalizeOptionalLowercaseString(params.requester.channel);
  if (!channel) {
    return {
      ok: false,
      error: buildThreadBindingUnavailableError(params.mode),
    };
  }

  const accountId = resolveSubagentSpawnChannelAccountId({
    cfg: params.cfg,
    channel,
    accountId: params.requester.accountId,
  });
  const policy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel,
    accountId,
    kind: "subagent",
  });
  if (!policy.enabled) {
    return {
      ok: false,
      error: formatThreadBindingDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "subagent",
      }),
    };
  }
  if (!policy.spawnEnabled) {
    return {
      ok: false,
      error: formatThreadBindingSpawnDisabledError({
        channel: policy.channel,
        accountId: policy.accountId,
        kind: "subagent",
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
      error: buildThreadBindingUnavailableError(params.mode),
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

  const fallbackConversationRef = resolveConversationRefForThreadBinding({
    cfg: params.cfg,
    channel: policy.channel,
    accountId: policy.accountId,
    to: params.requester.to,
    threadId: params.requester.threadId,
  });
  const requesterConversationRef = resolveRequesterBoundConversationRef({
    requesterSessionKey: params.requesterSessionKey,
    channel: policy.channel,
    accountId: policy.accountId,
    fallback: fallbackConversationRef,
  });
  if (requesterConversationRef === null) {
    return {
      ok: false,
      error: `Could not resolve a unique ${policy.channel} requester conversation for subagent thread spawn.`,
    };
  }
  const conversationRef = requesterConversationRef ?? fallbackConversationRef;
  if (!conversationRef?.conversationId) {
    return {
      ok: false,
      error: `Could not resolve a ${policy.channel} conversation for subagent thread spawn.`,
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
  const prepared = prepareSubagentThreadBinding({
    cfg: params.cfg,
    mode: params.mode,
    requesterSessionKey: params.requesterSessionKey,
    requester: params.requester,
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
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: ctx.agentSessionKey,
    completionOwnerKey: ctx.completionOwnerKey,
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
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId,
    targetAgentId,
    requestedAgentId,
    allowAgents:
      resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
      cfg?.agents?.defaults?.subagents?.allowAgents,
    configuredAgentIds: resolveConfiguredAgentIds(cfg),
  });
  if (!targetPolicy.ok) {
    return {
      status: "forbidden",
      error: targetPolicy.error,
    };
  }
  if (params.drainsContinuationDelegateQueue && !params.continuationChainState) {
    return {
      status: "error",
      error: "continuationChainState is required when drainsContinuationDelegateQueue is true",
    };
  }
  const childSessionKey = params.continuationDelegateFlowId
    ? deriveContinuationDelegateChildSessionKey(targetAgentId, params.continuationDelegateFlowId)
    : `agent:${targetAgentId}:subagent:${crypto.randomUUID()}`;
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
  const childDepth = callerDepth + 1;
  const spawnedByKey = requesterInternalKey;
  const childCapabilities = resolveSubagentCapabilities({
    depth: childDepth,
    maxSpawnDepth,
  });
  const targetAgentDir = resolveAgentDir(cfg, targetAgentId);
  const requesterAgentConfig = resolveAgentConfig(cfg, requesterAgentId);
  const targetAgentConfig = resolveAgentConfig(cfg, targetAgentId);
  const callerThinkingRaw = readRequesterThinkingLevel({
    cfg,
    requesterInternalKey,
    requesterAgentId,
  });
  const plan = resolveSubagentModelAndThinkingPlan({
    cfg,
    targetAgentId,
    requesterAgentConfig,
    targetAgentConfig,
    modelOverride,
    thinkingOverrideRaw,
    callerThinkingRaw,
  });
  if (plan.status === "error") {
    return {
      status: "error",
      error: plan.error,
    };
  }
  const { resolvedModel, thinkingOverride } = plan;
  const resolvedModelMetadata = buildResolvedSubagentModelMetadata(resolvedModel);
  const patchChildSession = async (patch: Record<string, unknown>): Promise<string | undefined> => {
    try {
      const target = resolveGatewaySessionStoreTarget({
        cfg,
        key: childSessionKey,
      });
      await upsertSessionEntry(
        {
          storePath: target.storePath,
          sessionKey: target.canonicalKey,
        },
        buildDirectChildSessionPatch(patch),
      );
      return undefined;
    } catch (err) {
      const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
      return `child session patch failed: ${message}`;
    }
  };

  // Continuation chain-hop delegates get orchestrator role regardless of depth,
  // so they can continue_delegate further within the chain. (RFC §3.4)
  const effectiveRole = params.drainsContinuationDelegateQueue
    ? "orchestrator"
    : childCapabilities.role;
  const effectiveControlScope = params.drainsContinuationDelegateQueue
    ? "children"
    : childCapabilities.controlScope;

  const initialChildSessionPatch: Record<string, unknown> = {
    spawnDepth: childDepth,
    subagentRole: effectiveRole === "main" ? null : effectiveRole,
    subagentControlScope: effectiveControlScope,
    ...inheritedToolAllowPatch(ctx.inheritedToolAllowlist),
    ...inheritedToolDenyPatch(ctx.inheritedToolDenylist),
    ...plan.initialSessionPatch,
    ...(params.traceparent ? { continuationTraceparent: params.traceparent } : {}),
    ...(params.continuationChainState
      ? {
          continuationChainCount: params.continuationChainState.count,
          continuationChainStartedAt: params.continuationChainState.startedAt,
          continuationChainTokens: params.continuationChainState.tokens,
          ...(params.continuationChainState.chainId
            ? { continuationChainId: params.continuationChainState.chainId }
            : {}),
        }
      : {}),
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
    // Hint tool availability so the subagent prompt teaches tool-primary vs bracket-only.
    // continue_work is always available when continuation is enabled (not in any deny list).
    // continue_delegate requires drainsContinuationDelegateQueue + non-leaf depth + no explicit deny.
    toolNames: (() => {
      const names: string[] = [];
      if (cfg.agents?.defaults?.continuation?.enabled === true) {
        names.push("continue_work");
      }
      if (
        params.drainsContinuationDelegateQueue === true &&
        childDepth < maxSpawnDepth &&
        !cfg.tools?.subagents?.tools?.deny?.includes("continue_delegate")
      ) {
        names.push("continue_delegate");
      }
      return names.length > 0 ? names : undefined;
    })(),
    // Without this, `buildSubagentSystemPrompt` falls through the continuation
    // chaining gate (#715) and subagents never see the guidance even when
    // `agents.defaults.continuation.enabled === true`.
    continuationEnabled: cfg.agents?.defaults?.continuation?.enabled === true,
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

  const childIdem = params.continuationDelegateFlowId
    ? deriveContinuationDelegateChildRunId(params.continuationDelegateFlowId)
    : crypto.randomUUID();
  let childRunId: string = childIdem;
  const spawnedMetadata = normalizeSpawnedRunMetadata({
    spawnedBy: spawnedByKey,
    ...toolSpawnMetadata,
    workspaceDir: spawnedWorkspaceDir,
  });
  const spawnLineagePatchError = await patchChildSession({
    spawnedBy: spawnedByKey,
    ...(spawnedMetadata.workspaceDir ? { spawnedWorkspaceDir: spawnedMetadata.workspaceDir } : {}),
    ...(spawnedCwd ? { spawnedCwd } : {}),
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
  recordSubagentSpawned({
    childSessionKey,
    childRunId,
    requesterSessionKey: requesterInternalKey,
    agentId: targetAgentId,
  });
  const contextEnginePrepareResult =
    params.lightContext && preparedSpawnContext.mode === "isolated"
      ? ({ status: "ok", preparation: undefined } as const)
      : await prepareContextEngineSubagentSpawn({
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
    registerSubagentTraceparentHandoff({
      idempotencyKey: childIdem,
      sessionKey: childSessionKey,
      traceparent: params.traceparent,
    });
    const childRunModelRef = subagentSpawnDeps.hasInProcessGatewayContext()
      ? splitModelRef(resolvedModel)
      : undefined;
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
        disableMessageTool: true,
        cleanupBundleMcpOnRunEnd: spawnMode !== "session",
        extraSystemPrompt: childSystemPrompt,
        ...(childRunModelRef?.provider ? { provider: childRunModelRef.provider } : {}),
        ...(childRunModelRef?.model ? { model: childRunModelRef.model } : {}),
        thinking: thinkingOverride,
        timeout: runTimeoutSeconds,
        label: label || undefined,
        ...(params.drainsContinuationDelegateQueue
          ? { drainsContinuationDelegateQueue: true }
          : {}),
        ...(params.traceparent ? { traceparent: params.traceparent } : {}),
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
      controllerSessionKey: ownership.controllerSessionKey,
      requesterSessionKey: ownership.completionRequesterSessionKey,
      requesterOrigin,
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
      attachmentsDir: attachmentAbsDir,
      attachmentsRootDir: attachmentRootDir,
      retainAttachmentsOnKeep: retainOnSessionKeep,
      ...(params.silentAnnounce ? { silentAnnounce: true } : {}),
      ...(params.wakeOnReturn ? { wakeOnReturn: true } : {}),
      ...(params.drainsContinuationDelegateQueue ? { drainsContinuationDelegateQueue: true } : {}),
      ...(params.continuationTargetSessionKey
        ? { continuationTargetSessionKey: params.continuationTargetSessionKey }
        : {}),
      ...(params.continuationTargetSessionKeys && params.continuationTargetSessionKeys.length > 0
        ? { continuationTargetSessionKeys: params.continuationTargetSessionKeys }
        : {}),
      ...(params.continuationFanoutMode
        ? { continuationFanoutMode: params.continuationFanoutMode }
        : {}),
      ...(params.traceparent ? { traceparent: params.traceparent } : {}),
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
          ...resolvedModelMetadata,
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
    taskName,
    note: preparedSpawnContext.forkFallbackNote
      ? `${acceptedNote} ${preparedSpawnContext.forkFallbackNote}`
      : acceptedNote,
    ...resolvedModelMetadata,
    modelApplied: resolvedModel ? modelApplied : undefined,
    attachments: attachmentsReceipt,
  };
}

export const testing = {
  setDepsForTest(overrides?: Partial<SubagentSpawnDeps>) {
    subagentSpawnDeps = overrides
      ? {
          ...defaultSubagentSpawnDeps,
          ...overrides,
        }
      : defaultSubagentSpawnDeps;
  },
};
