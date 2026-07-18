import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  formatThinkingLevels,
  normalizeThinkLevel,
  normalizeVerboseLevel,
} from "../../auto-reply/thinking.js";
import { formatCliCommand } from "../../cli/command-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentExplicitRecipientSession } from "../../infra/outbound/agent-delivery.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { parseStrictNonNegativeInteger } from "../../infra/parse-finite-number.js";
import { normalizePluginsConfig } from "../../plugins/config-state.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import {
  classifySessionKeyShape,
  isUnscopedSessionKeySentinel,
  normalizeAgentId,
  resolveAgentIdFromSessionKey,
  scopeLegacySessionKeyToAgent,
} from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE,
  resolveAgentHarnessSessionContextError,
} from "../../sessions/agent-harness-session-key.js";
import { resolveUserPath } from "../../utils.js";
import { isDeliverableMessageChannel, resolveMessageChannel } from "../../utils/message-channel.js";
import { resolveAgentRuntimeConfig } from "../agent-runtime-config.js";
import {
  listAgentIds,
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
  resolveAgentWorkspaceDir,
} from "../agent-scope.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { AGENT_LANE_SUBAGENT } from "../lanes.js";
import type { ModelManifestNormalizationContext } from "../model-selection-normalize.js";
import { buildConfiguredModelCatalog, resolveConfiguredModelRef } from "../model-selection.js";
import { normalizeSpawnedRunMetadata } from "../spawned-context.js";
import { resolveEffectiveAgentRuntime } from "../thinking-runtime.js";
import { resolveAgentTimeoutMs } from "../timeout.js";
import { ensureAgentWorkspace } from "../workspace.js";
import { acquireWorktreeRunLease, resolveWorktreeIdForPath } from "../worktrees/run-lease.js";
import {
  resolveAcpPromptBody,
  prependInternalEventContext,
  resolveInternalEventTranscriptBody,
} from "./attempt-execution.shared.js";
import { loadAcpManagerRuntime } from "./runtime-loaders.js";
import { createAgentCommandSessionWorkingCopy } from "./session-helpers.js";
import { resolveSession } from "./session.js";
import type { AgentCommandOpts } from "./types.js";

const OVERRIDE_VALUE_MAX_LENGTH = 256;

function containsControlCharacters(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) {
      return true;
    }
  }
  return false;
}

export function normalizeExplicitOverrideInput(raw: string, kind: "provider" | "model"): string {
  const trimmed = raw.trim();
  const label = kind === "provider" ? "Provider" : "Model";
  if (!trimmed) {
    throw new Error(`${label} override must be non-empty.`);
  }
  if (trimmed.length > OVERRIDE_VALUE_MAX_LENGTH) {
    throw new Error(`${label} override exceeds ${String(OVERRIDE_VALUE_MAX_LENGTH)} characters.`);
  }
  if (containsControlCharacters(trimmed)) {
    throw new Error(`${label} override contains invalid control characters.`);
  }
  return trimmed;
}

export function resolveExplicitAgentCommandSessionKey(params: {
  rawExplicitSessionKey?: string;
  agentIdOverride?: string;
  shouldScopeDefaultAgentKey?: boolean;
  cfg: OpenClawConfig;
}): string | undefined {
  if (
    isUnscopedSessionKeySentinel(params.rawExplicitSessionKey) &&
    !params.agentIdOverride &&
    !params.shouldScopeDefaultAgentKey
  ) {
    return params.rawExplicitSessionKey;
  }
  return scopeLegacySessionKeyToAgent({
    agentId:
      params.agentIdOverride ??
      (params.shouldScopeDefaultAgentKey ? resolveDefaultAgentId(params.cfg) : undefined),
    sessionKey: params.rawExplicitSessionKey,
    mainKey: params.cfg.session?.mainKey,
  });
}

export async function prepareAgentCommandExecution(opts: AgentCommandOpts, runtime: RuntimeEnv) {
  const isRawModelRun = opts.modelRun === true || opts.promptMode === "none";
  const message = opts.message ?? "";
  if (!message.trim()) {
    throw new Error("Message (--message) is required");
  }
  const rawExplicitSessionKey = opts.sessionKey?.trim();
  const requestedSessionId = opts.sessionId?.trim() || undefined;
  const rawTo = opts.to?.trim();
  const toSessionKey =
    !rawExplicitSessionKey && !requestedSessionId && classifySessionKeyShape(rawTo) === "agent"
      ? rawTo
      : undefined;
  const recipientChannel = resolveMessageChannel(opts.channel);
  const shouldResolveExplicitRecipientSession = Boolean(
    !rawExplicitSessionKey &&
    !requestedSessionId &&
    !toSessionKey &&
    opts.agentId?.trim() &&
    recipientChannel &&
    isDeliverableMessageChannel(recipientChannel) &&
    rawTo,
  );
  if (!opts.to && !requestedSessionId && !rawExplicitSessionKey && !opts.agentId) {
    throw new Error(
      "Pass --to <E.164>, --session-key, --session-id, or --agent to choose a session",
    );
  }

  const { cfg } = await resolveAgentRuntimeConfig(runtime, {
    runtimeTargetsChannelSecrets: opts.deliver === true,
    runtimeChannelSecretScope:
      opts.deliver !== true && shouldResolveExplicitRecipientSession && recipientChannel
        ? { channel: recipientChannel, accountId: opts.accountId }
        : undefined,
  });
  const normalizedSpawned = normalizeSpawnedRunMetadata({
    spawnedBy: opts.spawnedBy,
    groupId: opts.groupId,
    groupChannel: opts.groupChannel,
    groupSpace: opts.groupSpace,
    workspaceDir: opts.workspaceDir,
  });
  const agentIdOverrideRaw = opts.agentId?.trim();
  const agentIdOverride = agentIdOverrideRaw ? normalizeAgentId(agentIdOverrideRaw) : undefined;
  if (agentIdOverride) {
    const knownAgents = listAgentIds(cfg);
    if (!knownAgents.includes(agentIdOverride)) {
      throw new Error(
        `Unknown agent id "${agentIdOverrideRaw}". Use "${formatCliCommand("openclaw agents list")}" to see configured agents.`,
      );
    }
  }
  const shouldScopeDefaultAgentKey = Boolean(
    rawExplicitSessionKey &&
    !agentIdOverride &&
    classifySessionKeyShape(rawExplicitSessionKey) === "legacy_or_alias" &&
    !isUnscopedSessionKeySentinel(rawExplicitSessionKey),
  );
  const explicitSessionKey =
    toSessionKey ??
    resolveExplicitAgentCommandSessionKey({
      rawExplicitSessionKey,
      agentIdOverride,
      shouldScopeDefaultAgentKey,
      cfg,
    });
  if (explicitSessionKey && classifySessionKeyShape(explicitSessionKey) === "malformed_agent") {
    throw new Error(
      `Invalid --session-key "${explicitSessionKey}". Agent-prefixed session keys must use agent:<agent-id>:<session-key>.`,
    );
  }
  if (
    agentIdOverride &&
    explicitSessionKey &&
    classifySessionKeyShape(explicitSessionKey) === "agent"
  ) {
    const sessionAgentId = resolveAgentIdFromSessionKey(explicitSessionKey);
    if (sessionAgentId !== agentIdOverride) {
      throw new Error(
        `Agent id "${agentIdOverrideRaw}" does not match session key agent "${sessionAgentId}".`,
      );
    }
  }
  const agentCfg = cfg.agents?.defaults;

  const verboseOverride = normalizeVerboseLevel(opts.verbose);
  if (opts.verbose && !verboseOverride) {
    throw new Error('Invalid verbose level. Use "on", "full", or "off".');
  }

  const laneRaw = normalizeOptionalString(opts.lane) ?? "";
  const subagentLane: string = AGENT_LANE_SUBAGENT;
  const isSubagentLane = laneRaw === subagentLane;
  const hasExplicitTimeoutOption = opts.timeout !== undefined;
  const timeoutSecondsRaw = hasExplicitTimeoutOption
    ? (parseStrictNonNegativeInteger(opts.timeout) ?? Number.NaN)
    : isSubagentLane
      ? 0
      : undefined;
  if (
    timeoutSecondsRaw !== undefined &&
    (Number.isNaN(timeoutSecondsRaw) || timeoutSecondsRaw < 0)
  ) {
    throw new Error("--timeout must be a non-negative integer (seconds; 0 means no timeout)");
  }
  const timeoutMs = resolveAgentTimeoutMs({ cfg, overrideSeconds: timeoutSecondsRaw });
  const runTimeoutOverrideMs = hasExplicitTimeoutOption ? timeoutMs : undefined;

  const selectedCommandOpts = toSessionKey
    ? { ...opts, to: undefined, sessionKey: explicitSessionKey }
    : opts;
  const explicitRecipientSession =
    shouldResolveExplicitRecipientSession && agentIdOverride && recipientChannel && rawTo
      ? await resolveAgentExplicitRecipientSession({
          cfg,
          agentId: agentIdOverride,
          channel: recipientChannel,
          to: rawTo,
          accountId: selectedCommandOpts.accountId,
          threadId: selectedCommandOpts.threadId,
        })
      : undefined;
  if (explicitRecipientSession?.error) {
    throw explicitRecipientSession.error;
  }
  const commandOpts = explicitRecipientSession?.sessionKey
    ? {
        ...selectedCommandOpts,
        channel: explicitRecipientSession.channel,
        to: explicitRecipientSession.to,
        accountId: explicitRecipientSession.accountId,
        threadId: explicitRecipientSession.threadId,
      }
    : selectedCommandOpts;
  const sessionResolution = resolveSession({
    cfg,
    to: commandOpts.to,
    sessionId: commandOpts.sessionId,
    sessionKey: explicitSessionKey ?? explicitRecipientSession?.sessionKey,
    agentId: agentIdOverride,
    clone: false,
  });
  const {
    sessionId,
    sessionKey,
    storePath,
    isNewSession,
    previousSessionId,
    persistedThinking,
    persistedVerbose,
  } = sessionResolution;
  const harnessSessionError = sessionKey
    ? resolveAgentHarnessSessionContextError(sessionKey, sessionResolution.sessionEntry)
    : undefined;
  if (harnessSessionError) {
    throw new Error(harnessSessionError);
  }
  const isOneShotModelRun = opts.modelRun === true || opts.promptMode === "none";
  if (
    isOneShotModelRun &&
    sessionKey &&
    sessionResolution.sessionEntry?.modelSelectionLocked === true
  ) {
    throw new Error(AGENT_HARNESS_MODEL_RUN_FORBIDDEN_MESSAGE);
  }
  const { sessionEntry: sessionEntryRaw, sessionStore } = createAgentCommandSessionWorkingCopy({
    sessionKey,
    sessionEntry: sessionResolution.sessionEntry,
    sessionStore: sessionResolution.sessionStore,
  });
  const sessionAgentId =
    agentIdOverride ??
    resolveSessionAgentId({ sessionKey: sessionKey ?? explicitSessionKey, config: cfg });
  const outboundSession = buildOutboundSessionContext({
    cfg,
    agentId: sessionAgentId,
    sessionKey,
  });
  const workspaceDirRaw =
    normalizedSpawned.workspaceDir ?? resolveAgentWorkspaceDir(cfg, sessionAgentId);
  const workspaceDir = resolveUserPath(workspaceDirRaw);
  const cwd =
    normalizeOptionalString(opts.cwd) ?? normalizeOptionalString(sessionEntryRaw?.spawnedCwd);
  const agentDir = resolveAgentDir(cfg, sessionAgentId);
  const pluginsEnabled = normalizePluginsConfig(cfg.plugins).enabled;
  const manifestMetadataSnapshot = pluginsEnabled
    ? loadManifestMetadataSnapshot({ config: cfg, workspaceDir, env: process.env })
    : undefined;
  const modelManifestContext = {
    manifestPlugins: manifestMetadataSnapshot?.plugins ?? [],
  } satisfies ModelManifestNormalizationContext;
  const configuredModel = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: pluginsEnabled,
    ...modelManifestContext,
  });
  const configuredThinkingCatalog = buildConfiguredModelCatalog({
    cfg,
    workspaceDir,
    ...modelManifestContext,
  });
  const configuredThinkingRuntime = resolveEffectiveAgentRuntime({
    cfg,
    provider: configuredModel.provider,
    modelId: configuredModel.model,
    agentId: sessionAgentId,
    sessionKey,
    sessionEntry: sessionEntryRaw,
  });
  const thinkingLevelsHint = formatThinkingLevels(
    configuredModel.provider,
    configuredModel.model,
    ", ",
    configuredThinkingCatalog.length > 0 ? configuredThinkingCatalog : undefined,
    configuredThinkingRuntime,
  );
  const thinkOverride = normalizeThinkLevel(opts.thinking);
  const thinkOnce = normalizeThinkLevel(opts.thinkingOnce);
  if (opts.thinking && !thinkOverride) {
    throw new Error(`Invalid thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  if (opts.thinkingOnce && !thinkOnce) {
    throw new Error(`Invalid one-shot thinking level. Use one of: ${thinkingLevelsHint}.`);
  }
  const resolvedCwd = cwd ? resolveUserPath(cwd) : undefined;
  const worktreeId = await resolveWorktreeIdForPath({
    sessionEntry: sessionEntryRaw,
    candidatePaths: [resolvedCwd ?? workspaceDir, workspaceDir],
  });
  const runLease = worktreeId ? await acquireWorktreeRunLease(worktreeId) : undefined;
  try {
    await ensureAgentWorkspace({
      dir: workspaceDirRaw,
      ensureBootstrapFiles: !agentCfg?.skipBootstrap,
      skipOptionalBootstrapFiles: agentCfg?.skipOptionalBootstrapFiles,
    });
    const runId = opts.runId?.trim() || sessionId;
    const { getAcpSessionManager } = await loadAcpManagerRuntime();
    const acpManager = getAcpSessionManager();
    const acpResolution = sessionKey ? acpManager.resolveSession({ cfg, sessionKey }) : null;
    const body =
      !isRawModelRun && acpResolution?.kind === "ready"
        ? resolveAcpPromptBody(message, opts.internalEvents)
        : prependInternalEventContext(message, opts.internalEvents);
    const transcriptBody =
      opts.transcriptMessage ?? resolveInternalEventTranscriptBody(message, opts.internalEvents);

    const prepared = {
      opts: commandOpts,
      body,
      transcriptBody,
      cfg,
      configuredThinkingCatalog,
      normalizedSpawned,
      agentCfg,
      thinkOverride,
      thinkOnce,
      verboseOverride,
      timeoutMs,
      runTimeoutOverrideMs,
      sessionId,
      sessionKey,
      sessionEntry: sessionEntryRaw,
      sessionStore,
      storePath,
      isNewSession,
      previousSessionId,
      persistedThinking,
      persistedVerbose,
      sessionAgentId,
      outboundSession,
      workspaceDir,
      cwd: resolvedCwd,
      agentDir,
      pluginsEnabled,
      manifestMetadataSnapshot,
      modelManifestContext,
      runId,
      isSubagentLane,
      acpManager,
      acpResolution,
      runLease,
    };
    return prepared;
  } catch (error) {
    await runLease?.release();
    throw error;
  }
}

export type PreparedAgentCommandExecution = Awaited<
  ReturnType<typeof prepareAgentCommandExecution>
>;
