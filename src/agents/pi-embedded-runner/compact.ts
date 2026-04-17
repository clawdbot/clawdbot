import fs from "node:fs/promises";
import os from "node:os";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import {
  createAgentSession,
  DefaultResourceLoader,
  estimateTokens,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { resolveChannelCapabilities } from "../../config/channel-capabilities.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureCompactionCheckpointSnapshot,
  cleanupCompactionCheckpointSnapshot,
  persistSessionCompactionCheckpoint,
  resolveSessionCompactionCheckpointReason,
  type CapturedCompactionCheckpointSnapshot,
} from "../../gateway/session-compaction-checkpoints.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../infra/heartbeat-summary.js";
import { getMachineDisplayName } from "../../infra/machine-name.js";
import { generateSecureToken } from "../../infra/secure-random.js";
import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  prepareProviderRuntimeAuth,
  resolveProviderSystemPromptContribution,
  resolveProviderTextTransforms,
  transformProviderSystemPrompt,
} from "../../plugins/provider-runtime.js";
import { isCronSessionKey, isSubagentSessionKey } from "../../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { buildTtsSystemPromptHint } from "../../tts/tts.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeMessageChannel } from "../../utils/message-channel.js";
import { isReasoningTagProvider } from "../../utils/provider-utils.js";
import { resolveOpenClawAgentDir } from "../agent-paths.js";
import { resolveSessionAgentIds } from "../agent-scope.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import {
  listChannelSupportedActions,
  resolveChannelMessageToolCapabilities,
  resolveChannelMessageToolHints,
  resolveChannelReactionGuidance,
} from "../channel-tools.js";
import {
  hasMeaningfulConversationContent,
  isRealConversationMessage,
} from "../compaction-real-conversation.js";
import { resolveContextWindowInfo } from "../context-window-guard.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { resolveOpenClawDocsPath } from "../docs-path.js";
import { resolveHeartbeatPromptForSystemPrompt } from "../heartbeat-system-prompt.js";
import {
  applyAuthHeaderOverride,
  applyLocalNoAuthHeaderOverride,
  getApiKeyForModel,
  resolveModelAuthMode,
} from "../model-auth.js";
import { supportsModelTools } from "../model-tool-support.js";
import { ensureOpenClawModelsJson } from "../models-config.js";
import { resolveOwnerDisplaySetting } from "../owner-display.js";
import { createBundleLspToolRuntime } from "../pi-bundle-lsp-runtime.js";
import { createBundleMcpToolRuntime } from "../pi-bundle-mcp-tools.js";
import { ensureSessionHeader } from "../pi-embedded-helpers.js";
import { pickFallbackThinkingLevel } from "../pi-embedded-helpers.js";
import {
  consumeCompactionSafeguardCancelReason,
  setCompactionSafeguardCancelReason,
} from "../pi-hooks/compaction-safeguard-runtime.js";
import { createPreparedEmbeddedPiSettingsManager } from "../pi-project-settings.js";
import { createOpenClawCodingTools } from "../pi-tools.js";
import { wrapStreamFnTextTransforms } from "../plugin-text-transforms.js";
import { registerProviderStreamForModel } from "../provider-stream.js";
import { ensureRuntimePluginsLoaded } from "../runtime-plugins.js";
import { resolveSandboxContext } from "../sandbox.js";
import { repairSessionFileIfNeeded } from "../session-file-repair.js";
import { guardSessionManager } from "../session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "../session-transcript-repair.js";
import {
  acquireSessionWriteLock,
  resolveSessionLockMaxHoldFromTimeout,
} from "../session-write-lock.js";
import { detectRuntimeShell } from "../shell-utils.js";
import {
  applySkillEnvOverrides,
  applySkillEnvOverridesFromSnapshot,
  resolveSkillsPromptForRun,
} from "../skills.js";
import { resolveSystemPromptOverride } from "../system-prompt-override.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import { classifyCompactionReason, resolveCompactionFailureReason } from "./compact-reasons.js";
import type { CompactEmbeddedPiSessionParams, CompactionMessageMetrics } from "./compact.types.js";
import {
  asCompactionHookRunner,
  buildBeforeCompactionHookMetrics,
  estimateTokensAfterCompaction,
  runAfterCompactionHooks,
  runBeforeCompactionHooks,
  runPostCompactionSideEffects,
} from "./compaction-hooks.js";
import { resolveEmbeddedCompactionTarget } from "./compaction-runtime-context.js";
import {
  compactWithSafetyTimeout,
  resolveCompactionTimeoutMs,
} from "./compaction-safety-timeout.js";
import { buildEmbeddedExtensionFactories } from "./extensions.js";
import { applyExtraParamsToAgent } from "./extra-params.js";
import { getDmHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import { log } from "./logger.js";
import { hardenManualCompactionBoundary } from "./manual-compaction-boundary.js";
import { buildEmbeddedMessageActionDiscoveryInput } from "./message-action-discovery-input.js";
import { readPiModelContextTokens } from "./model-context-tokens.js";
import { buildModelAliasLines, resolveModelAsync } from "./model.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";
import { shouldUseOpenAIWebSocketTransport } from "./run/attempt.thread-helpers.js";
import { buildEmbeddedSandboxInfo } from "./sandbox-info.js";
import { prewarmSessionFile, trackSessionManagerAccess } from "./session-manager-cache.js";
import { truncateSessionAfterCompaction } from "./session-truncation.js";
import { resolveEmbeddedRunSkillEntries } from "./skills-runtime.js";
import {
  resolveEmbeddedAgentApiKey,
  resolveEmbeddedAgentBaseStreamFn,
  resolveEmbeddedAgentStreamFn,
} from "./stream-resolution.js";
import {
  applySystemPromptOverrideToSession,
  buildEmbeddedSystemPrompt,
  createSystemPromptOverride,
} from "./system-prompt.js";
import { collectAllowedToolNames } from "./tool-name-allowlist.js";
import {
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
} from "./tool-schema-runtime.js";
import { splitSdkTools } from "./tool-split.js";
import type { EmbeddedPiCompactResult } from "./types.js";
import { mapThinkingLevel } from "./utils.js";
import { flushPendingToolResultsAfterIdle } from "./wait-for-idle-before-flush.js";
export type { CompactEmbeddedPiSessionParams } from "./compact.types.js";

function hasRealConversationContent(
  msg: AgentMessage,
  messages: AgentMessage[],
  index: number,
): boolean {
  return isRealConversationMessage(msg, messages, index);
}

function createCompactionDiagId(): string {
  return `cmp-${Date.now().toString(36)}-${generateSecureToken(4)}`;
}

function prepareCompactionSessionAgent(params: {
  session: { agent: { streamFn?: unknown } };
  providerStreamFn: unknown;
  shouldUseWebSocketTransport: boolean;
  wsApiKey?: string;
  sessionId: string;
  signal: AbortSignal;
  effectiveModel: ProviderRuntimeModel;
  resolvedApiKey?: string;
  authStorage: unknown;
  config?: OpenClawConfig;
  provider: string;
  modelId: string;
  thinkLevel: ThinkLevel;
  sessionAgentId: string;
  effectiveWorkspace: string;
  agentDir: string;
}) {
  params.session.agent.streamFn = resolveEmbeddedAgentStreamFn({
    currentStreamFn: resolveEmbeddedAgentBaseStreamFn({ session: params.session as never }),
    providerStreamFn: params.providerStreamFn as never,
    shouldUseWebSocketTransport: params.shouldUseWebSocketTransport,
    wsApiKey: params.wsApiKey,
    sessionId: params.sessionId,
    signal: params.signal,
    model: params.effectiveModel,
    resolvedApiKey: params.resolvedApiKey,
    authStorage: params.authStorage as never,
  });
  const providerTextTransforms = resolveProviderTextTransforms({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.effectiveWorkspace,
  });
  if (providerTextTransforms) {
    params.session.agent.streamFn = wrapStreamFnTextTransforms({
      streamFn: params.session.agent.streamFn as never,
      input: providerTextTransforms.input,
      output: providerTextTransforms.output,
      transformSystemPrompt: false,
    }) as never;
  }
  return applyExtraParamsToAgent(
    params.session.agent as never,
    params.config,
    params.provider,
    params.modelId,
    undefined,
    params.thinkLevel,
    params.sessionAgentId,
    params.effectiveWorkspace,
    params.effectiveModel,
    params.agentDir,
  );
}

function resolveCompactionProviderStream(params: {
  effectiveModel: ProviderRuntimeModel;
  config?: OpenClawConfig;
  agentDir: string;
  effectiveWorkspace: string;
}) {
  return registerProviderStreamForModel({
    model: params.effectiveModel,
    cfg: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.effectiveWorkspace,
  });
}

function normalizeObservedTokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function getMessageTextChars(msg: AgentMessage): number {
  const content = (msg as { content?: unknown }).content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  let total = 0;
  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const text = (block as { text?: unknown }).text;
    if (typeof text === "string") {
      total += text.length;
    }
  }
  return total;
}

function resolveMessageToolLabel(msg: AgentMessage): string | undefined {
  const candidate =
    (msg as { toolName?: unknown }).toolName ??
    (msg as { name?: unknown }).name ??
    (msg as { tool?: unknown }).tool;
  return typeof candidate === "string" && candidate.trim().length > 0 ? candidate : undefined;
}

function summarizeCompactionMessages(messages: AgentMessage[]): CompactionMessageMetrics {
  let historyTextChars = 0;
  let toolResultChars = 0;
  const contributors: Array<{ role: string; chars: number; tool?: string }> = [];
  let estTokens = 0;
  let tokenEstimationFailed = false;

  for (const msg of messages) {
    const role = typeof msg.role === "string" ? msg.role : "unknown";
    const chars = getMessageTextChars(msg);
    historyTextChars += chars;
    if (role === "toolResult") {
      toolResultChars += chars;
    }
    contributors.push({ role, chars, tool: resolveMessageToolLabel(msg) });
    if (!tokenEstimationFailed) {
      try {
        estTokens += estimateTokens(msg);
      } catch {
        tokenEstimationFailed = true;
      }
    }
  }

  return {
    messages: messages.length,
    historyTextChars,
    toolResultChars,
    estTokens: tokenEstimationFailed ? undefined : estTokens,
    contributors: contributors.toSorted((a, b) => b.chars - a.chars).slice(0, 3),
  };
}

function containsRealConversationMessages(messages: AgentMessage[]): boolean {
  return messages.some((message, index, allMessages) =>
    hasRealConversationContent(message, allMessages, index),
  );
}

/**
 * Core compaction logic without lane queueing.
 * Use this when already inside a session/global lane to avoid deadlocks.
 */
export async function compactEmbeddedPiSessionDirect(
  params: CompactEmbeddedPiSessionParams,
): Promise<EmbeddedPiCompactResult> {
  const startedAt = Date.now();
  const diagId = params.diagId?.trim() || createCompactionDiagId();
  const trigger = params.trigger ?? "manual";
  const attempt = params.attempt ?? 1;
  const maxAttempts = params.maxAttempts ?? 1;
  const runId = params.runId ?? params.sessionId;
  const resolvedWorkspace = resolveUserPath(params.workspaceDir);
  ensureRuntimePluginsLoaded({
    config: params.config,
    workspaceDir: resolvedWorkspace,
    allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
  });
  const resolvedCompactionTarget = resolveEmbeddedCompactionTarget({
    config: params.config,
    provider: params.provider,
    modelId: params.model,
    authProfileId: params.authProfileId,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const provider = resolvedCompactionTarget.provider ?? DEFAULT_PROVIDER;
  const modelId = resolvedCompactionTarget.model ?? DEFAULT_MODEL;
  const authProfileId = resolvedCompactionTarget.authProfileId;
  let thinkLevel: ThinkLevel = params.thinkLevel ?? "off";
  const attemptedThinking = new Set<ThinkLevel>();
  const fail = (reason: string): EmbeddedPiCompactResult => {
    log.warn(
      `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
        `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
        `attempt=${attempt} maxAttempts=${maxAttempts} outcome=failed reason=${classifyCompactionReason(reason)} ` +
        `durationMs=${Date.now() - startedAt}`,
    );
    return {
      ok: false,
      compacted: false,
      reason,
    };
  };
  const agentDir = params.agentDir ?? resolveOpenClawAgentDir();
  await ensureOpenClawModelsJson(params.config, agentDir);
  const { model, error, authStorage, modelRegistry } = await resolveModelAsync(
    provider,
    modelId,
    agentDir,
    params.config,
  );
  if (!model) {
    const reason = error ?? `Unknown model: ${provider}/${modelId}`;
    return fail(reason);
  }
  let runtimeModel = model;
  let apiKeyInfo: Awaited<ReturnType<typeof getApiKeyForModel>> | null = null;
  let hasRuntimeAuthExchange = false;
  try {
    apiKeyInfo = await getApiKeyForModel({
      model: runtimeModel,
      cfg: params.config,
      profileId: authProfileId,
      agentDir,
    });

    if (!apiKeyInfo.apiKey) {
      if (apiKeyInfo.mode !== "aws-sdk") {
        throw new Error(
          `No API key resolved for provider "${runtimeModel.provider}" (auth mode: ${apiKeyInfo.mode}).`,
        );
      }
    } else {
      const preparedAuth = await prepareProviderRuntimeAuth({
        provider: runtimeModel.provider,
        config: params.config,
        workspaceDir: resolvedWorkspace,
        env: process.env,
        context: {
          config: params.config,
          agentDir,
          workspaceDir: resolvedWorkspace,
          env: process.env,
          provider: runtimeModel.provider,
          modelId,
          model: runtimeModel,
          apiKey: apiKeyInfo.apiKey,
          authMode: apiKeyInfo.mode,
          profileId: apiKeyInfo.profileId,
        },
      });
      if (preparedAuth?.baseUrl) {
        runtimeModel = { ...runtimeModel, baseUrl: preparedAuth.baseUrl };
      }
      const runtimeApiKey = preparedAuth?.apiKey ?? apiKeyInfo.apiKey;
      hasRuntimeAuthExchange = Boolean(preparedAuth?.apiKey);
      if (!runtimeApiKey) {
        throw new Error(`Provider "${runtimeModel.provider}" runtime auth returned no apiKey.`);
      }
      authStorage.setRuntimeApiKey(runtimeModel.provider, runtimeApiKey);
    }
  } catch (err) {
    const reason = formatErrorMessage(err);
    return fail(reason);
  }

  await fs.mkdir(resolvedWorkspace, { recursive: true });
  const sandboxSessionKey = params.sessionKey?.trim() || params.sessionId;
  const sandbox = await resolveSandboxContext({
    config: params.config,
    sessionKey: sandboxSessionKey,
    workspaceDir: resolvedWorkspace,
  });
  const effectiveWorkspace = sandbox?.enabled
    ? sandbox.workspaceAccess === "rw"
      ? resolvedWorkspace
      : sandbox.workspaceDir
    : resolvedWorkspace;
  await fs.mkdir(effectiveWorkspace, { recursive: true });
  await ensureSessionHeader({
    sessionFile: params.sessionFile,
    sessionId: params.sessionId,
    cwd: effectiveWorkspace,
  });
  const { sessionAgentId: effectiveSkillAgentId } = resolveSessionAgentIds({
    sessionKey: params.sessionKey,
    config: params.config,
  });

  let restoreSkillEnv: (() => void) | undefined;
  let compactionSessionManager: unknown = null;
  let checkpointSnapshot: CapturedCompactionCheckpointSnapshot | null = null;
  let checkpointSnapshotRetained = false;
  try {
    const { shouldLoadSkillEntries, skillEntries } = resolveEmbeddedRunSkillEntries({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      agentId: effectiveSkillAgentId,
      skillsSnapshot: params.skillsSnapshot,
    });
    restoreSkillEnv = params.skillsSnapshot
      ? applySkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        })
      : applySkillEnvOverrides({
          skills: skillEntries ?? [],
          config: params.config,
        });
    const skillsPrompt = resolveSkillsPromptForRun({
      skillsSnapshot: params.skillsSnapshot,
      entries: shouldLoadSkillEntries ? skillEntries : undefined,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      agentId: effectiveSkillAgentId,
    });

    const sessionLabel = params.sessionKey ?? params.sessionId;
    const resolvedMessageProvider = params.messageChannel ?? params.messageProvider;
    const { contextFiles } = await resolveBootstrapContextForRun({
      workspaceDir: effectiveWorkspace,
      config: params.config,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      warn: makeBootstrapWarn({
        sessionLabel,
        workspaceDir: effectiveWorkspace,
        warn: (message) => log.warn(message),
      }),
    });
    // Apply contextTokens cap to model so pi-coding-agent's auto-compaction
    // threshold uses the effective limit, not the native context window.
    const runtimeModelWithContext = runtimeModel as ProviderRuntimeModel;
    const ctxInfo = resolveContextWindowInfo({
      cfg: params.config,
      provider,
      modelId,
      modelContextTokens: readPiModelContextTokens(runtimeModel),
      modelContextWindow: runtimeModelWithContext.contextWindow,
      defaultTokens: DEFAULT_CONTEXT_TOKENS,
    });
    const effectiveModel = applyAuthHeaderOverride(
      applyLocalNoAuthHeaderOverride(
        ctxInfo.tokens < (runtimeModelWithContext.contextWindow ?? Infinity)
          ? { ...runtimeModelWithContext, contextWindow: ctxInfo.tokens }
          : runtimeModelWithContext,
        apiKeyInfo,
      ),
      // Skip header injection when runtime auth exchange produced a
      // different credential — the SDK reads the exchanged token from
      // authStorage automatically.
      hasRuntimeAuthExchange ? null : apiKeyInfo,
      params.config,
    );

    const runAbortController = new AbortController();
    const toolsRaw = createOpenClawCodingTools({
      exec: {
        elevated: params.bashElevated,
      },
      sandbox,
      messageProvider: resolvedMessageProvider,
      agentAccountId: params.agentAccountId,
      sessionKey: sandboxSessionKey,
      sessionId: params.sessionId,
      runId: params.runId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      senderIsOwner: params.senderIsOwner,
      allowGatewaySubagentBinding: params.allowGatewaySubagentBinding,
      agentDir,
      workspaceDir: effectiveWorkspace,
      config: params.config,
      abortSignal: runAbortController.signal,
      modelProvider: model.provider,
      modelId,
      modelCompat: effectiveModel.compat,
      modelApi: model.api,
      modelContextWindowTokens: ctxInfo.tokens,
      modelAuthMode: resolveModelAuthMode(model.provider, params.config),
    });
    const toolsEnabled = supportsModelTools(runtimeModel);
    const tools = normalizeProviderToolSchemas({
      tools: toolsEnabled ? toolsRaw : [],
      provider,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId,
      modelApi: model.api,
      model,
    });
    const bundleMcpRuntime = toolsEnabled
      ? await createBundleMcpToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: tools.map((tool) => tool.name),
        })
      : undefined;
    const bundleLspRuntime = toolsEnabled
      ? await createBundleLspToolRuntime({
          workspaceDir: effectiveWorkspace,
          cfg: params.config,
          reservedToolNames: [
            ...tools.map((tool) => tool.name),
            ...(bundleMcpRuntime?.tools.map((tool) => tool.name) ?? []),
          ],
        })
      : undefined;
    const effectiveTools = [
      ...tools,
      ...(bundleMcpRuntime?.tools ?? []),
      ...(bundleLspRuntime?.tools ?? []),
    ];
    const allowedToolNames = collectAllowedToolNames({ tools: effectiveTools });
    logProviderToolSchemaDiagnostics({
      tools: effectiveTools,
      provider,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId,
      modelApi: model.api,
      model,
    });
    const machineName = await getMachineDisplayName();
    const runtimeChannel = normalizeMessageChannel(params.messageChannel ?? params.messageProvider);
    let runtimeCapabilities = runtimeChannel
      ? (resolveChannelCapabilities({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        }) ?? [])
      : undefined;
    const promptCapabilities =
      runtimeChannel && params.config
        ? resolveChannelMessageToolCapabilities({
            cfg: params.config,
            channel: runtimeChannel,
            accountId: params.agentAccountId,
          })
        : [];
    if (promptCapabilities.length > 0) {
      runtimeCapabilities ??= [];
      const seenCapabilities = new Set(
        runtimeCapabilities.map((cap) => normalizeOptionalLowercaseString(cap)).filter(Boolean),
      );
      for (const capability of promptCapabilities) {
        const normalizedCapability = normalizeOptionalLowercaseString(capability);
        if (!normalizedCapability || seenCapabilities.has(normalizedCapability)) {
          continue;
        }
        seenCapabilities.add(normalizedCapability);
        runtimeCapabilities.push(capability);
      }
    }
    const reactionGuidance =
      runtimeChannel && params.config
        ? resolveChannelReactionGuidance({
            cfg: params.config,
            channel: runtimeChannel,
            accountId: params.agentAccountId,
          })
        : undefined;
    const { defaultAgentId, sessionAgentId } = resolveSessionAgentIds({
      sessionKey: params.sessionKey,
      config: params.config,
    });
    // Resolve channel-specific message actions for system prompt
    const channelActions = runtimeChannel
      ? listChannelSupportedActions(
          buildEmbeddedMessageActionDiscoveryInput({
            cfg: params.config,
            channel: runtimeChannel,
            currentChannelId: params.currentChannelId,
            currentThreadTs: params.currentThreadTs,
            currentMessageId: params.currentMessageId,
            accountId: params.agentAccountId,
            sessionKey: params.sessionKey,
            sessionId: params.sessionId,
            agentId: sessionAgentId,
            senderId: params.senderId,
            senderIsOwner: params.senderIsOwner,
          }),
        )
      : undefined;
    const messageToolHints = runtimeChannel
      ? resolveChannelMessageToolHints({
          cfg: params.config,
          channel: runtimeChannel,
          accountId: params.agentAccountId,
        })
      : undefined;

    const runtimeInfo = {
      host: machineName,
      os: `${os.type()} ${os.release()}`,
      arch: os.arch(),
      node: process.version,
      model: `${provider}/${modelId}`,
      shell: detectRuntimeShell(),
      channel: runtimeChannel,
      capabilities: runtimeCapabilities,
      channelActions,
    };
    const sandboxInfo = buildEmbeddedSandboxInfo(sandbox, params.bashElevated);
    const reasoningTagHint = isReasoningTagProvider(provider, {
      config: params.config,
      workspaceDir: effectiveWorkspace,
      env: process.env,
      modelId,
      modelApi: model.api,
      model,
    });
    const userTimezone = resolveUserTimezone(params.config?.agents?.defaults?.userTimezone);
    const userTimeFormat = resolveUserTimeFormat(params.config?.agents?.defaults?.timeFormat);
    const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
    const promptMode =
      isSubagentSessionKey(params.sessionKey) || isCronSessionKey(params.sessionKey)
        ? "minimal"
        : "full";
    const docsPath = await resolveOpenClawDocsPath({
      workspaceDir: effectiveWorkspace,
      argv1: process.argv[1],
      cwd: effectiveWorkspace,
      moduleUrl: import.meta.url,
    });
    const ttsHint = params.config ? buildTtsSystemPromptHint(params.config) : undefined;
    const ownerDisplay = resolveOwnerDisplaySetting(params.config);
    const promptContribution = resolveProviderSystemPromptContribution({
      provider,
      config: params.config,
      workspaceDir: effectiveWorkspace,
      context: {
        config: params.config,
        agentDir,
        workspaceDir: effectiveWorkspace,
        provider,
        modelId,
        promptMode,
        runtimeChannel,
        runtimeCapabilities,
        agentId: sessionAgentId,
      },
    });
    const buildSystemPromptOverride = (defaultThinkLevel: ThinkLevel) => {
      const builtSystemPrompt =
        resolveSystemPromptOverride({
          config: params.config,
          agentId: sessionAgentId,
        }) ??
        buildEmbeddedSystemPrompt({
          workspaceDir: effectiveWorkspace,
          defaultThinkLevel,
          reasoningLevel: params.reasoningLevel ?? "off",
          extraSystemPrompt: params.extraSystemPrompt,
          ownerNumbers: params.ownerNumbers,
          ownerDisplay: ownerDisplay.ownerDisplay,
          ownerDisplaySecret: ownerDisplay.ownerDisplaySecret,
          reasoningTagHint,
          heartbeatPrompt: resolveHeartbeatPromptForSystemPrompt({
            config: params.config,
            agentId: sessionAgentId,
            defaultAgentId,
          }),
          skillsPrompt,
          docsPath: docsPath ?? undefined,
          ttsHint,
          promptMode,
          acpEnabled: params.config?.acp?.enabled !== false,
          runtimeInfo,
          reactionGuidance,
          messageToolHints,
          sandboxInfo,
          tools: effectiveTools,
          modelAliasLines: buildModelAliasLines(params.config),
          userTimezone,
          userTime,
          userTimeFormat,
          contextFiles,
          memoryCitationsMode: params.config?.memory?.citations,
          promptContribution,
        });
      return createSystemPromptOverride(
        transformProviderSystemPrompt({
          provider,
          config: params.config,
          workspaceDir: effectiveWorkspace,
          context: {
            config: params.config,
            agentDir,
            workspaceDir: effectiveWorkspace,
            provider,
            modelId,
            promptMode,
            runtimeChannel,
            runtimeCapabilities,
            agentId: sessionAgentId,
            systemPrompt: builtSystemPrompt,
          },
        }),
      );
    };

    const compactionTimeoutMs = resolveCompactionTimeoutMs(params.config);
    const sessionLock = await acquireSessionWriteLock({
      sessionFile: params.sessionFile,
      maxHoldMs: resolveSessionLockMaxHoldFromTimeout({
        timeoutMs: compactionTimeoutMs,
      }),
    });
    try {
      await repairSessionFileIfNeeded({
        sessionFile: params.sessionFile,
        warn: (message) => log.warn(message),
      });
      await prewarmSessionFile(params.sessionFile);
      const transcriptPolicy = resolveTranscriptPolicy({
        modelApi: model.api,
        provider,
        modelId,
        config: params.config,
        workspaceDir: effectiveWorkspace,
        env: process.env,
        model,
      });
      const sessionManager = guardSessionManager(SessionManager.open(params.sessionFile), {
        agentId: sessionAgentId,
        sessionKey: params.sessionKey,
        config: params.config,
        contextWindowTokens: ctxInfo.tokens,
        allowSyntheticToolResults: transcriptPolicy.allowSyntheticToolResults,
        allowedToolNames,
      });
      checkpointSnapshot = captureCompactionCheckpointSnapshot({
        sessionManager,
        sessionFile: params.sessionFile,
      });
      compactionSessionManager = sessionManager;
      trackSessionManagerAccess(params.sessionFile);
      const settingsManager = createPreparedEmbeddedPiSettingsManager({
        cwd: effectiveWorkspace,
        agentDir,
        cfg: params.config,
        contextTokenBudget: ctxInfo.tokens,
      });
      // Sets compaction/pruning runtime state and returns extension factories
      // that must be passed to the resource loader for the safeguard to be active.
      const extensionFactories = buildEmbeddedExtensionFactories({
        cfg: params.config,
        sessionManager,
        provider,
        modelId,
        model,
      });
      // Only create an explicit resource loader when there are extension factories
      // to register; otherwise let createAgentSession use its built-in default.
      let resourceLoader: DefaultResourceLoader | undefined;
      if (extensionFactories.length > 0) {
        resourceLoader = new DefaultResourceLoader({
          cwd: resolvedWorkspace,
          agentDir,
          settingsManager,
          extensionFactories,
        });
        await resourceLoader.reload();
      }

      const { builtInTools, customTools } = splitSdkTools({
        tools: effectiveTools,
        sandboxEnabled: !!sandbox?.enabled,
      });

      const providerStreamFn = resolveCompactionProviderStream({
        effectiveModel,
        config: params.config,
        agentDir,
        effectiveWorkspace,
      });
      const shouldUseWebSocketTransport = shouldUseOpenAIWebSocketTransport({
        provider,
        modelApi: effectiveModel.api,
      });
      const wsApiKey = shouldUseWebSocketTransport
        ? await resolveEmbeddedAgentApiKey({
            provider,
            resolvedApiKey: hasRuntimeAuthExchange ? undefined : apiKeyInfo?.apiKey,
            authStorage,
          })
        : undefined;
      if (shouldUseWebSocketTransport && !wsApiKey) {
        log.warn(
          `[ws-stream] no API key for provider=${provider}; keeping compaction HTTP transport`,
        );
      }
      while (true) {
        // Rebuild the compaction session on retry so provider wrappers, payload
        // shaping, and the embedded system prompt all reflect the fallback level.
        attemptedThinking.add(thinkLevel);
        let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
        try {
          const createdSession = await createAgentSession({
            cwd: effectiveWorkspace,
            agentDir,
            authStorage,
            modelRegistry,
            model: effectiveModel,
            thinkingLevel: mapThinkingLevel(thinkLevel),
            tools: builtInTools,
            customTools,
            sessionManager,
            settingsManager,
            resourceLoader,
          });
          session = createdSession.session;
          applySystemPromptOverrideToSession(session, buildSystemPromptOverride(thinkLevel)());
          // Compaction builds the same embedded system prompt, so it must flow
          // through the same transport/payload shaping stack as normal turns.
          prepareCompactionSessionAgent({
            session,
            providerStreamFn,
            shouldUseWebSocketTransport,
            wsApiKey,
            sessionId: params.sessionId,
            signal: runAbortController.signal,
            effectiveModel,
            resolvedApiKey: hasRuntimeAuthExchange ? undefined : apiKeyInfo?.apiKey,
            authStorage,
            config: params.config,
            provider,
            modelId,
            thinkLevel,
            sessionAgentId,
            effectiveWorkspace,
            agentDir,
          });

          const prior = await sanitizeSessionHistory({
            messages: session.messages,
            modelApi: model.api,
            modelId,
            provider,
            allowedToolNames,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model,
            sessionManager,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
          });
          const validated = await validateReplayTurns({
            messages: prior,
            modelApi: model.api,
            modelId,
            provider,
            config: params.config,
            workspaceDir: effectiveWorkspace,
            env: process.env,
            model,
            sessionId: params.sessionId,
            policy: transcriptPolicy,
          });
          // Apply validated transcript to the live session even when no history limit is configured,
          // so compaction and hook metrics are based on the same message set.
          session.agent.state.messages = validated;
          // "Original" compaction metrics should describe the validated transcript that enters
          // limiting/compaction, not the raw on-disk session snapshot.
          const originalMessages = session.messages.slice();
          const truncated = limitHistoryTurns(
            session.messages,
            getDmHistoryLimitFromSessionKey(params.sessionKey, params.config),
          );
          // Re-run tool_use/tool_result pairing repair after truncation, since
          // limitHistoryTurns can orphan tool_result blocks by removing the
          // assistant message that contained the matching tool_use.
          const limited = transcriptPolicy.repairToolUseResultPairing
            ? sanitizeToolUseResultPairing(truncated, {
                erroredAssistantResultPolicy: "drop",
              })
            : truncated;
          if (limited.length > 0) {
            session.agent.state.messages = limited;
          }
          const hookRunner = asCompactionHookRunner(getGlobalHookRunner());
          const observedTokenCount = normalizeObservedTokenCount(params.currentTokenCount);
          const beforeHookMetrics = buildBeforeCompactionHookMetrics({
            originalMessages,
            currentMessages: session.messages,
            observedTokenCount,
            estimateTokensFn: estimateTokens,
          });
          const { hookSessionKey, missingSessionKey } = await runBeforeCompactionHooks({
            hookRunner,
            sessionId: params.sessionId,
            sessionKey: params.sessionKey,
            sessionAgentId,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            metrics: beforeHookMetrics,
          });
          const { messageCountOriginal } = beforeHookMetrics;
          const diagEnabled = log.isEnabled("debug");
          const preMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics) {
            log.debug(
              `[compaction-diag] start runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} ` +
                `pre.messages=${preMetrics.messages} pre.historyTextChars=${preMetrics.historyTextChars} ` +
                `pre.toolResultChars=${preMetrics.toolResultChars} pre.estTokens=${preMetrics.estTokens ?? "unknown"}`,
            );
            log.debug(
              `[compaction-diag] contributors diagId=${diagId} top=${JSON.stringify(preMetrics.contributors)}`,
            );
          }

          if (!containsRealConversationMessages(session.messages)) {
            log.info(
              `[compaction] skipping — no real conversation messages (sessionKey=${params.sessionKey ?? params.sessionId})`,
            );
            return {
              ok: true,
              compacted: false,
              reason: "no real conversation messages",
            };
          }

          const compactStartedAt = Date.now();
          // Measure compactedCount from the original pre-limiting transcript so compaction
          // lifecycle metrics represent total reduction through the compaction pipeline.
          const messageCountCompactionInput = messageCountOriginal;
          // Estimate full session tokens BEFORE compaction (including system prompt,
          // bootstrap context, workspace files, and all history). This is needed for
          // a correct sanity check — result.tokensBefore only covers the summarizable
          // history subset, not the full session.
          let fullSessionTokensBefore = 0;
          try {
            fullSessionTokensBefore = limited.reduce((sum, msg) => sum + estimateTokens(msg), 0);
          } catch {
            // If token estimation throws on a malformed message, fall back to 0 so
            // the sanity check below becomes a no-op instead of crashing compaction.
          }
          const activeSession = session;
          const result = await compactWithSafetyTimeout(
            () => {
              setCompactionSafeguardCancelReason(compactionSessionManager, undefined);
              return activeSession.compact(params.customInstructions);
            },
            compactionTimeoutMs,
            {
              abortSignal: params.abortSignal,
              onCancel: () => {
                activeSession.abortCompaction();
              },
            },
          );
          await runPostCompactionSideEffects({
            config: params.config,
            sessionKey: params.sessionKey,
            sessionFile: params.sessionFile,
          });
          let effectiveFirstKeptEntryId = result.firstKeptEntryId;
          let postCompactionLeafId =
            typeof sessionManager.getLeafId === "function"
              ? (sessionManager.getLeafId() ?? undefined)
              : undefined;
          if (params.trigger === "manual") {
            try {
              const hardenedBoundary = await hardenManualCompactionBoundary({
                sessionFile: params.sessionFile,
              });
              if (hardenedBoundary.applied) {
                effectiveFirstKeptEntryId =
                  hardenedBoundary.firstKeptEntryId ?? effectiveFirstKeptEntryId;
                postCompactionLeafId = hardenedBoundary.leafId ?? postCompactionLeafId;
                session.agent.state.messages = hardenedBoundary.messages;
              }
            } catch (err) {
              log.warn("[compaction] failed to harden manual compaction boundary", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          // Estimate tokens after compaction by summing token estimates for remaining messages
          const tokensAfter = estimateTokensAfterCompaction({
            messagesAfter: session.messages,
            observedTokenCount,
            fullSessionTokensBefore,
            estimateTokensFn: estimateTokens,
          });
          const messageCountAfter = session.messages.length;
          const compactedCount = Math.max(0, messageCountCompactionInput - messageCountAfter);
          if (params.config && params.sessionKey && checkpointSnapshot) {
            try {
              const storedCheckpoint = await persistSessionCompactionCheckpoint({
                cfg: params.config,
                sessionKey: params.sessionKey,
                sessionId: params.sessionId,
                reason: resolveSessionCompactionCheckpointReason({
                  trigger: params.trigger,
                }),
                snapshot: checkpointSnapshot,
                summary: result.summary,
                firstKeptEntryId: effectiveFirstKeptEntryId,
                tokensBefore: observedTokenCount ?? result.tokensBefore,
                tokensAfter,
                postSessionFile: params.sessionFile,
                postLeafId: postCompactionLeafId,
                postEntryId: postCompactionLeafId,
                createdAt: compactStartedAt,
              });
              checkpointSnapshotRetained = storedCheckpoint !== null;
            } catch (err) {
              log.warn("failed to persist compaction checkpoint", {
                errorMessage: formatErrorMessage(err),
              });
            }
          }
          const postMetrics = diagEnabled
            ? summarizeCompactionMessages(session.messages)
            : undefined;
          if (diagEnabled && preMetrics && postMetrics) {
            log.debug(
              `[compaction-diag] end runId=${runId} sessionKey=${params.sessionKey ?? params.sessionId} ` +
                `diagId=${diagId} trigger=${trigger} provider=${provider}/${modelId} ` +
                `attempt=${attempt} maxAttempts=${maxAttempts} outcome=compacted reason=none ` +
                `durationMs=${Date.now() - compactStartedAt} retrying=false ` +
                `post.messages=${postMetrics.messages} post.historyTextChars=${postMetrics.historyTextChars} ` +
                `post.toolResultChars=${postMetrics.toolResultChars} post.estTokens=${postMetrics.estTokens ?? "unknown"} ` +
                `delta.messages=${postMetrics.messages - preMetrics.messages} ` +
                `delta.historyTextChars=${postMetrics.historyTextChars - preMetrics.historyTextChars} ` +
                `delta.toolResultChars=${postMetrics.toolResultChars - preMetrics.toolResultChars} ` +
                `delta.estTokens=${typeof preMetrics.estTokens === "number" && typeof postMetrics.estTokens === "number" ? postMetrics.estTokens - preMetrics.estTokens : "unknown"}`,
            );
          }
          await runAfterCompactionHooks({
            hookRunner,
            sessionId: params.sessionId,
            sessionAgentId,
            hookSessionKey,
            missingSessionKey,
            workspaceDir: effectiveWorkspace,
            messageProvider: resolvedMessageProvider,
            messageCountAfter,
            tokensAfter,
            compactedCount,
            sessionFile: params.sessionFile,
            summaryLength: typeof result.summary === "string" ? result.summary.length : undefined,
            tokensBefore: result.tokensBefore,
            firstKeptEntryId: effectiveFirstKeptEntryId,
          });
          // Truncate session file to remove compacted entries (#39953)
          if (params.config?.agents?.defaults?.compaction?.truncateAfterCompaction) {
            try {
              const heartbeatSummary = resolveHeartbeatSummaryForAgent(
                params.config,
                sessionAgentId,
              );
              const truncResult = await truncateSessionAfterCompaction({
                sessionFile: params.sessionFile,
                ackMaxChars: heartbeatSummary.ackMaxChars,
                heartbeatPrompt: heartbeatSummary.prompt,
              });
              if (truncResult.truncated) {
                log.info(
                  `[compaction] post-compaction truncation removed ${truncResult.entriesRemoved} entries ` +
                    `(sessionKey=${params.sessionKey ?? params.sessionId})`,
                );
              }
            } catch (err) {
              log.warn("[compaction] post-compaction truncation failed", {
                errorMessage: formatErrorMessage(err),
                errorStack: err instanceof Error ? err.stack : undefined,
              });
            }
          }
          return {
            ok: true,
            compacted: true,
            result: {
              summary: result.summary,
              firstKeptEntryId: effectiveFirstKeptEntryId,
              tokensBefore: observedTokenCount ?? result.tokensBefore,
              tokensAfter,
              details: result.details,
            },
          };
        } catch (err) {
          const fallbackThinking = pickFallbackThinkingLevel({
            message: formatErrorMessage(err),
            attempted: attemptedThinking,
          });
          if (fallbackThinking) {
            // Near-term provider fix: when compaction hits a reasoning-mandatory
            // endpoint with `off`, retry once with `minimal` instead of surfacing
            // a user-visible failure.
            log.warn(
              `[compaction] request rejected for ${provider}/${modelId}; retrying with ${fallbackThinking}`,
            );
            thinkLevel = fallbackThinking;
            continue;
          }
          throw err;
        } finally {
          try {
            await flushPendingToolResultsAfterIdle({
              agent: session?.agent,
              sessionManager,
              clearPendingOnTimeout: true,
            });
          } catch {
            /* best-effort */
          }
          try {
            session?.dispose();
          } catch {
            /* best-effort */
          }
        }
      }
    } finally {
      try {
        await bundleMcpRuntime?.dispose();
      } catch {
        /* best-effort */
      }
      try {
        await bundleLspRuntime?.dispose();
      } catch {
        /* best-effort */
      }
      await sessionLock.release();
    }
  } catch (err) {
    const reason = resolveCompactionFailureReason({
      reason: formatErrorMessage(err),
      safeguardCancelReason: consumeCompactionSafeguardCancelReason(compactionSessionManager),
    });
    return fail(reason);
  } finally {
    if (!checkpointSnapshotRetained) {
      await cleanupCompactionCheckpointSnapshot(checkpointSnapshot);
    }
    restoreSkillEnv?.();
  }
}

export const __testing = {
  hasRealConversationContent,
  hasMeaningfulConversationContent,
  containsRealConversationMessages,
  estimateTokensAfterCompaction,
  buildBeforeCompactionHookMetrics,
  hardenManualCompactionBoundary,
  resolveCompactionProviderStream,
  prepareCompactionSessionAgent,
  runBeforeCompactionHooks,
  runAfterCompactionHooks,
  runPostCompactionSideEffects,
} as const;

export { runPostCompactionSideEffects } from "./compaction-hooks.js";
