import fs from "node:fs";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveModelAuthMode } from "../agents/model-auth.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveOpenAITextVerbosity } from "../agents/openai-text-verbosity.js";
import { resolveExtraParams } from "../agents/pi-embedded-runner/extra-params.js";
import { resolveSandboxRuntimeStatus } from "../agents/sandbox.js";
import {
  formatProviderModelRef,
  resolveSelectedAndActiveModel,
} from "../auto-reply/model-runtime.js";
import type {
  ElevatedLevel,
  ReasoningLevel,
  ThinkLevel,
  VerboseLevel,
} from "../auto-reply/thinking.js";
import { resolveChannelModelOverride } from "../channels/model-overrides.js";
import {
  resolveMainSessionKey,
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionPluginStatusLines,
  resolveSessionPluginTraceLines,
  resolveFreshSessionTotalTokens,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRecentSessionUsageFromTranscript } from "../gateway/session-utils.fs.js";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import { resolveCommitHash } from "../infra/git-commit.js";
import {
  findDecisionReason,
  summarizeDecisionReason,
} from "../media-understanding/runner.entries.js";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../shared/string-coerce.js";
import { resolveStatusTtsSnapshot } from "../tts/status-config.js";
import {
  estimateUsageCost,
  formatTokenCount as formatTokenCountShared,
  formatUsd,
  resolveModelCostConfig,
} from "../utils/usage-format.js";
import { VERSION } from "../version.js";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";
import { formatFastModeLabel } from "./status-labels.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentConfig = Partial<AgentDefaults> & {
  model?: AgentDefaults["model"] | string;
};

export const formatTokenCount = formatTokenCountShared;

type QueueStatus = {
  mode?: string;
  depth?: number;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: string;
  showDetails?: boolean;
};

export type StatusArgs = {
  config?: OpenClawConfig;
  agent: AgentConfig;
  agentId?: string;
  runtimeContextTokens?: number;
  explicitConfiguredContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  sessionStorePath?: string;
  groupActivation?: "mention" | "always";
  resolvedThink?: ThinkLevel;
  resolvedFast?: boolean;
  resolvedHarness?: string;
  resolvedVerbose?: VerboseLevel;
  resolvedReasoning?: ReasoningLevel;
  resolvedElevated?: ElevatedLevel;
  modelAuth?: string;
  activeModelAuth?: string;
  usageLine?: string;
  timeLine?: string;
  uptimeLine?: string;
  queue?: QueueStatus;
  mediaDecisions?: ReadonlyArray<MediaUnderstandingDecision>;
  subagentsLine?: string;
  taskLine?: string;
  includeTranscriptUsage?: boolean;
  now?: number;
};

type NormalizedAuthMode = "api-key" | "oauth" | "token" | "aws-sdk" | "mixed" | "unknown";

function normalizeAuthMode(value?: string): NormalizedAuthMode | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "api-key" || normalized.startsWith("api-key ")) {
    return "api-key";
  }
  if (normalized === "oauth" || normalized.startsWith("oauth ")) {
    return "oauth";
  }
  if (normalized === "token" || normalized.startsWith("token ")) {
    return "token";
  }
  if (normalized === "aws-sdk" || normalized.startsWith("aws-sdk ")) {
    return "aws-sdk";
  }
  if (normalized === "mixed" || normalized.startsWith("mixed ")) {
    return "mixed";
  }
  if (normalized === "unknown") {
    return "unknown";
  }
  return undefined;
}

function resolveConfiguredTextVerbosity(params: {
  config?: OpenClawConfig;
  agentId?: string;
  provider?: string | null;
  model?: string | null;
}): "low" | "medium" | "high" | undefined {
  const provider = params.provider?.trim();
  const model = params.model?.trim();
  if (!provider || !model || (provider !== "openai" && provider !== "openai-codex")) {
    return undefined;
  }
  return resolveOpenAITextVerbosity(
    resolveExtraParams({
      cfg: params.config,
      provider,
      modelId: model,
      agentId: params.agentId,
    }),
  );
}

function resolveExecutionLabel(
  args: Pick<StatusArgs, "config" | "agent" | "sessionKey" | "sessionScope">,
): string {
  const sessionKey = args.sessionKey?.trim();
  if (args.config && sessionKey) {
    const runtimeStatus = resolveSandboxRuntimeStatus({
      cfg: args.config,
      sessionKey,
    });
    const sandboxMode = runtimeStatus.mode ?? "off";
    if (sandboxMode === "off") {
      return "direct";
    }
    const runtime = runtimeStatus.sandboxed ? "docker" : sessionKey ? "direct" : "unknown";
    return `${runtime}/${sandboxMode}`;
  }

  const sandboxMode = args.agent?.sandbox?.mode ?? "off";
  if (sandboxMode === "off") {
    return "direct";
  }
  const sandboxed = (() => {
    if (!sessionKey) {
      return false;
    }
    if (sandboxMode === "all") {
      return true;
    }
    if (args.config) {
      return resolveSandboxRuntimeStatus({
        cfg: args.config,
        sessionKey,
      }).sandboxed;
    }
    const sessionScope = args.sessionScope ?? "per-sender";
    const mainKey = resolveMainSessionKey({
      session: { scope: sessionScope },
    });
    return sessionKey !== mainKey.trim();
  })();
  const runtime = sandboxed ? "docker" : sessionKey ? "direct" : "unknown";
  return `${runtime}/${sandboxMode}`;
}

const formatTokens = (total: number | null | undefined, contextTokens: number | null) => {
  const ctx = contextTokens ?? null;
  if (total == null) {
    const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
    return `?/${ctxLabel}`;
  }
  const pct = ctx ? Math.min(999, Math.round((total / ctx) * 100)) : null;
  const totalLabel = formatTokenCount(total);
  const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
  return `${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}%)` : ""}`;
};

export const formatContextUsageShort = (
  total: number | null | undefined,
  contextTokens: number | null | undefined,
) => `Context ${formatTokens(total, contextTokens ?? null)}`;

const formatQueueDetails = (queue?: QueueStatus) => {
  if (!queue) {
    return "";
  }
  const depth = typeof queue.depth === "number" ? `depth ${queue.depth}` : null;
  if (!queue.showDetails) {
    return depth ? ` (${depth})` : "";
  }
  const detailParts: string[] = [];
  if (depth) {
    detailParts.push(depth);
  }
  if (typeof queue.debounceMs === "number") {
    const ms = Math.max(0, Math.round(queue.debounceMs));
    const label =
      ms >= 1000 ? `${ms % 1000 === 0 ? ms / 1000 : (ms / 1000).toFixed(1)}s` : `${ms}ms`;
    detailParts.push(`debounce ${label}`);
  }
  if (typeof queue.cap === "number") {
    detailParts.push(`cap ${queue.cap}`);
  }
  if (queue.dropPolicy) {
    detailParts.push(`drop ${queue.dropPolicy}`);
  }
  return detailParts.length ? ` (${detailParts.join(" · ")})` : "";
};

const readUsageFromSessionLog = (
  sessionId?: string,
  sessionEntry?: SessionEntry,
  agentId?: string,
  sessionKey?: string,
  storePath?: string,
):
  | {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      promptTokens: number;
      total: number;
      model?: string;
    }
  | undefined => {
  // Transcripts are stored at the session file path (fallback: ~/.openclaw/sessions/<SessionId>.jsonl)
  if (!sessionId) {
    return undefined;
  }
  let logPath: string;
  try {
    const resolvedAgentId =
      agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
    logPath = resolveSessionFilePath(
      sessionId,
      sessionEntry,
      resolveSessionFilePathOptions({ agentId: resolvedAgentId, storePath }),
    );
  } catch {
    return undefined;
  }
  if (!fs.existsSync(logPath)) {
    return undefined;
  }

  try {
    const snapshot = readRecentSessionUsageFromTranscript(
      sessionId,
      storePath,
      sessionEntry?.sessionFile,
      agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined),
      256 * 1024,
    );
    if (!snapshot) {
      return undefined;
    }

    const input = snapshot.inputTokens ?? 0;
    const output = snapshot.outputTokens ?? 0;
    const cacheRead = snapshot.cacheRead ?? 0;
    const cacheWrite = snapshot.cacheWrite ?? 0;
    const promptTokens = snapshot.totalTokens ?? input + cacheRead + cacheWrite;
    const total = promptTokens + output;
    if (promptTokens === 0 && total === 0) {
      return undefined;
    }
    const model = snapshot.modelProvider
      ? snapshot.model
        ? `${snapshot.modelProvider}/${snapshot.model}`
        : snapshot.modelProvider
      : snapshot.model;

    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      promptTokens,
      total,
      model,
    };
  } catch {
    return undefined;
  }
};

const formatUsagePair = (input?: number | null, output?: number | null) => {
  if (input == null && output == null) {
    return null;
  }
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  return `🧮 Tokens: ${inputLabel} in / ${outputLabel} out`;
};

const formatCacheLine = (
  input?: number | null,
  cacheRead?: number | null,
  cacheWrite?: number | null,
) => {
  if (!cacheRead && !cacheWrite) {
    return null;
  }
  if (
    (typeof cacheRead !== "number" || cacheRead <= 0) &&
    (typeof cacheWrite !== "number" || cacheWrite <= 0)
  ) {
    return null;
  }

  const cachedLabel = typeof cacheRead === "number" ? formatTokenCount(cacheRead) : "0";
  const newLabel = typeof cacheWrite === "number" ? formatTokenCount(cacheWrite) : "0";

  const totalInput =
    (typeof cacheRead === "number" ? cacheRead : 0) +
    (typeof cacheWrite === "number" ? cacheWrite : 0) +
    (typeof input === "number" ? input : 0);
  const hitRate =
    totalInput > 0 && typeof cacheRead === "number"
      ? Math.round((cacheRead / totalInput) * 100)
      : 0;

  return `🗄️ Cache: ${hitRate}% hit · ${cachedLabel} cached, ${newLabel} new`;
};

const formatMediaUnderstandingLine = (decisions?: ReadonlyArray<MediaUnderstandingDecision>) => {
  if (!decisions || decisions.length === 0) {
    return null;
  }
  const parts = decisions
    .map((decision) => {
      const count = decision.attachments.length;
      const countLabel = count > 1 ? ` x${count}` : "";
      if (decision.outcome === "success") {
        const chosen = decision.attachments.find((entry) => entry.chosen)?.chosen;
        const provider = chosen?.provider?.trim();
        const model = chosen?.model?.trim();
        const modelLabel = provider ? (model ? `${provider}/${model}` : provider) : null;
        return `${decision.capability}${countLabel} ok${modelLabel ? ` (${modelLabel})` : ""}`;
      }
      if (decision.outcome === "no-attachment") {
        return `${decision.capability} none`;
      }
      if (decision.outcome === "disabled") {
        return `${decision.capability} off`;
      }
      if (decision.outcome === "scope-deny") {
        return `${decision.capability} denied`;
      }
      if (decision.outcome === "skipped") {
        const reason = findDecisionReason(decision);
        const shortReason = summarizeDecisionReason(reason);
        return `${decision.capability} skipped${shortReason ? ` (${shortReason})` : ""}`;
      }
      if (decision.outcome === "failed") {
        const reason = findDecisionReason(decision, "failed");
        const shortReason = summarizeDecisionReason(reason);
        return `${decision.capability} failed${shortReason ? ` (${shortReason})` : ""}`;
      }
      return null;
    })
    .filter((part): part is string => part != null);
  if (parts.length === 0) {
    return null;
  }
  if (parts.every((part) => part.endsWith(" none"))) {
    return null;
  }
  return `📎 Media: ${parts.join(" · ")}`;
};

const formatVoiceModeLine = (
  config?: OpenClawConfig,
  sessionEntry?: SessionEntry,
  agentId?: string,
): string | null => {
  if (!config) {
    return null;
  }
  const snapshot = resolveStatusTtsSnapshot({
    cfg: config,
    sessionAuto: sessionEntry?.ttsAuto,
    agentId,
  });
  if (!snapshot) {
    return null;
  }
  const parts = [`🔊 Voice: ${snapshot.autoMode}`, `provider=${snapshot.provider}`];
  if (snapshot.persona) {
    parts.push(`persona=${snapshot.persona}`);
  }
  if (snapshot.displayName) {
    parts.push(`name=${snapshot.displayName}`);
  }
  if (snapshot.model) {
    parts.push(`model=${snapshot.model}`);
  }
  if (snapshot.voice) {
    parts.push(`voice=${snapshot.voice}`);
  }
  if (snapshot.baseUrl) {
    parts.push(
      snapshot.customBaseUrl
        ? `endpoint=custom(${snapshot.baseUrl})`
        : `endpoint=${snapshot.baseUrl}`,
    );
  }
  parts.push(`limit=${snapshot.maxLength}`, `summary=${snapshot.summarize ? "on" : "off"}`);
  return parts.join(" · ");
};

function resolveChannelModelNote(params: {
  config?: OpenClawConfig;
  entry?: SessionEntry;
  selectedProvider: string;
  selectedModel: string;
  parentSessionKey?: string;
}): string | undefined {
  if (!params.config || !params.entry) {
    return undefined;
  }
  if (
    normalizeOptionalString(params.entry.modelOverride) ||
    normalizeOptionalString(params.entry.providerOverride)
  ) {
    return undefined;
  }
  const channelOverride = resolveChannelModelOverride({
    cfg: params.config,
    channel: params.entry.channel ?? params.entry.origin?.provider,
    groupId: params.entry.groupId,
    groupChatType: params.entry.chatType ?? params.entry.origin?.chatType,
    groupChannel: params.entry.groupChannel,
    groupSubject: params.entry.subject,
    parentSessionKey: params.parentSessionKey,
  });
  if (!channelOverride) {
    return undefined;
  }
  const aliasIndex = buildModelAliasIndex({
    cfg: params.config,
    defaultProvider: DEFAULT_PROVIDER,
    allowPluginNormalization: false,
  });
  const resolvedOverride = resolveModelRefFromString({
    raw: channelOverride.model,
    defaultProvider: DEFAULT_PROVIDER,
    aliasIndex,
    allowPluginNormalization: false,
  });
  if (!resolvedOverride) {
    return undefined;
  }
  if (
    resolvedOverride.ref.provider !== params.selectedProvider ||
    resolvedOverride.ref.model !== params.selectedModel
  ) {
    return undefined;
  }
  return "channel override";
}

export function buildStatusMessage(args: StatusArgs): string {
  const now = args.now ?? Date.now();
  const entry = args.sessionEntry;
  const selectionConfig = {
    agents: {
      defaults: args.agent ?? {},
    },
  } as OpenClawConfig;
  const contextConfig = args.config
    ? ({
        ...args.config,
        agents: {
          ...args.config.agents,
          defaults: {
            ...args.config.agents?.defaults,
            ...args.agent,
          },
        },
      } as OpenClawConfig)
    : ({
        agents: {
          defaults: args.agent ?? {},
        },
      } as OpenClawConfig);
  const resolved = resolveConfiguredModelRef({
    cfg: selectionConfig,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    allowPluginNormalization: false,
  });
  const selectedProvider = entry?.providerOverride ?? resolved.provider ?? DEFAULT_PROVIDER;
  const selectedModel = entry?.modelOverride ?? resolved.model ?? DEFAULT_MODEL;
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider,
    selectedModel,
    sessionEntry: entry,
  });
  const initialFallbackState = resolveActiveFallbackState({
    selectedModelRef: modelRefs.selected.label || "unknown",
    activeModelRef: modelRefs.active.label || "unknown",
    state: entry,
  });
  let activeProvider = modelRefs.active.provider;
  let activeModel = modelRefs.active.model;
  let contextLookupProvider: string | undefined = activeProvider;
  let contextLookupModel = activeModel;
  const runtimeModelRaw = normalizeOptionalString(entry?.model) ?? "";
  const runtimeProviderRaw = normalizeOptionalString(entry?.modelProvider) ?? "";

  if (runtimeModelRaw && !runtimeProviderRaw && runtimeModelRaw.includes("/")) {
    const slashIndex = runtimeModelRaw.indexOf("/");
    const embeddedProvider =
      normalizeOptionalLowercaseString(runtimeModelRaw.slice(0, slashIndex)) ?? "";
    const fallbackMatchesRuntimeModel =
      initialFallbackState.active &&
      normalizeLowercaseStringOrEmpty(runtimeModelRaw) ===
        normalizeLowercaseStringOrEmpty(
          normalizeOptionalString(entry?.fallbackNoticeActiveModel ?? "") ?? "",
        );
    const runtimeMatchesSelectedModel =
      normalizeLowercaseStringOrEmpty(runtimeModelRaw) ===
      normalizeLowercaseStringOrEmpty(modelRefs.selected.label || "unknown");
    // Legacy fallback sessions can persist provider-qualified runtime ids
    // without a separate modelProvider field. Preserve provider-aware lookup
    // when the stored slash id is the selected model or the active fallback
    // target; otherwise keep the raw model-only lookup for OpenRouter-style
    // slash ids.
    if (
      (fallbackMatchesRuntimeModel || runtimeMatchesSelectedModel) &&
      embeddedProvider === normalizeLowercaseStringOrEmpty(activeProvider)
    ) {
      contextLookupProvider = activeProvider;
      contextLookupModel = activeModel;
    } else {
      contextLookupProvider = undefined;
      contextLookupModel = runtimeModelRaw;
    }
  }

  let inputTokens = entry?.inputTokens;
  let outputTokens = entry?.outputTokens;
  let cacheRead = entry?.cacheRead;
  let cacheWrite = entry?.cacheWrite;
  const freshTotalTokens = resolveFreshSessionTotalTokens(entry);
  const allowTranscriptContextUsage = entry?.totalTokensFresh !== false;
  let totalTokens =
    freshTotalTokens ??
    (entry?.totalTokensFresh === false
      ? undefined
      : (entry?.totalTokens ?? (entry?.inputTokens ?? 0) + (entry?.outputTokens ?? 0)));

  // Prefer prompt-size tokens from the session transcript when it looks larger
  // (cached prompt tokens are often missing from agent meta/store).
  if (args.includeTranscriptUsage) {
    const logUsage = readUsageFromSessionLog(
      entry?.sessionId,
      entry,
      args.agentId,
      args.sessionKey,
      args.sessionStorePath,
    );
    if (logUsage) {
      const candidate = logUsage.promptTokens || logUsage.total;
      if (
        allowTranscriptContextUsage &&
        (!totalTokens || totalTokens === 0 || candidate > totalTokens)
      ) {
        totalTokens = candidate;
      }
      if (!entry?.model && logUsage.model) {
        const slashIndex = logUsage.model.indexOf("/");
        if (slashIndex > 0) {
          const provider = logUsage.model.slice(0, slashIndex).trim();
          const model = logUsage.model.slice(slashIndex + 1).trim();
          if (provider && model) {
            activeProvider = provider;
            activeModel = model;
            // Preserve model-only lookup for transcript-derived provider/model IDs
            // like "google/gemini-2.5-pro" that may come from a different upstream
            // provider (for example OpenRouter).
            contextLookupProvider = undefined;
            contextLookupModel = logUsage.model;
          }
        } else {
          activeModel = logUsage.model;
          // Bare transcript model IDs should keep provider-aware lookup when the
          // active provider is already known so shared model names still resolve
          // to the correct provider-specific window.
          contextLookupProvider = activeProvider;
          contextLookupModel = logUsage.model;
        }
      }
      if (!inputTokens || inputTokens === 0) {
        inputTokens = logUsage.input;
      }
      if (!outputTokens || outputTokens === 0) {
        outputTokens = logUsage.output;
      }
      if (typeof cacheRead !== "number" || cacheRead <= 0) {
        cacheRead = logUsage.cacheRead;
      }
      if (typeof cacheWrite !== "number" || cacheWrite <= 0) {
        cacheWrite = logUsage.cacheWrite;
      }
    }
  }

  const activeModelLabel = formatProviderModelRef(activeProvider, activeModel) || "unknown";
  const runtimeDiffersFromSelected = activeModelLabel !== (modelRefs.selected.label || "unknown");
  const selectedContextTokens = resolveContextTokensForModel({
    cfg: contextConfig,
    provider: selectedProvider,
    model: selectedModel,
    allowAsyncLoad: false,
  });
  const explicitRuntimeContextTokens =
    typeof args.runtimeContextTokens === "number" && args.runtimeContextTokens > 0
      ? args.runtimeContextTokens
      : undefined;
  const resolvedActiveContextTokens = resolveContextTokensForModel({
    cfg: contextConfig,
    ...(contextLookupProvider ? { provider: contextLookupProvider } : {}),
    model: contextLookupModel,
    allowAsyncLoad: false,
  });
  const activeContextTokens =
    typeof explicitRuntimeContextTokens === "number" &&
    typeof resolvedActiveContextTokens === "number"
      ? Math.min(explicitRuntimeContextTokens, resolvedActiveContextTokens)
      : (explicitRuntimeContextTokens ?? resolvedActiveContextTokens);
  const channelModelNote = resolveChannelModelNote({
    config: args.config,
    entry,
    selectedProvider,
    selectedModel,
    parentSessionKey: args.parentSessionKey,
  });
  const persistedContextTokens =
    typeof entry?.contextTokens === "number" && entry.contextTokens > 0
      ? entry.contextTokens
      : undefined;
  const cappedPersistedContextTokens =
    typeof persistedContextTokens === "number" && typeof activeContextTokens === "number"
      ? Math.min(persistedContextTokens, activeContextTokens)
      : persistedContextTokens;
  const agentContextTokens =
    typeof args.agent?.contextTokens === "number" && args.agent.contextTokens > 0
      ? args.agent.contextTokens
      : undefined;
  const explicitConfiguredContextTokens =
    typeof args.explicitConfiguredContextTokens === "number" &&
    args.explicitConfiguredContextTokens > 0
      ? args.explicitConfiguredContextTokens
      : undefined;
  const cappedConfiguredContextTokens =
    typeof explicitConfiguredContextTokens === "number"
      ? typeof activeContextTokens === "number"
        ? Math.min(explicitConfiguredContextTokens, activeContextTokens)
        : explicitConfiguredContextTokens
      : undefined;
  const cappedAgentContextTokens =
    typeof agentContextTokens === "number"
      ? typeof activeContextTokens === "number"
        ? Math.min(agentContextTokens, activeContextTokens)
        : agentContextTokens
      : undefined;
  const channelOverrideContextTokens = channelModelNote
    ? (explicitRuntimeContextTokens ??
      cappedConfiguredContextTokens ??
      (typeof activeContextTokens === "number"
        ? (cappedAgentContextTokens ?? activeContextTokens)
        : cappedAgentContextTokens))
    : undefined;
  // When a fallback model is active, the selected-model context limit that
  // callers keep on the agent config is often stale. Prefer an explicit runtime
  // snapshot when available. Separately, callers can pass an explicit configured
  // cap that should still apply on fallback paths, but it cannot exceed the
  // active runtime window when that window is known. Persisted runtime snapshots
  // still take precedence over configured caps so historical fallback sessions
  // keep their last known live limit even if the active model later becomes
  // unresolvable.
  const contextTokens = runtimeDiffersFromSelected
    ? (explicitRuntimeContextTokens ??
      (() => {
        if (persistedContextTokens !== undefined) {
          const persistedLooksSelectedWindow =
            typeof selectedContextTokens === "number" &&
            persistedContextTokens === selectedContextTokens;
          const activeWindowDiffersFromSelected =
            typeof selectedContextTokens === "number" &&
            typeof activeContextTokens === "number" &&
            activeContextTokens !== selectedContextTokens;
          const explicitConfiguredMatchesPersisted =
            typeof explicitConfiguredContextTokens === "number" &&
            explicitConfiguredContextTokens === persistedContextTokens;
          if (
            persistedLooksSelectedWindow &&
            activeWindowDiffersFromSelected &&
            !explicitConfiguredMatchesPersisted
          ) {
            return activeContextTokens;
          }
          if (typeof activeContextTokens === "number") {
            return Math.min(persistedContextTokens, activeContextTokens);
          }
          return persistedContextTokens;
        }
        if (cappedConfiguredContextTokens !== undefined) {
          return cappedConfiguredContextTokens;
        }
        if (typeof activeContextTokens === "number") {
          return activeContextTokens;
        }
        return DEFAULT_CONTEXT_TOKENS;
      })())
    : (resolveContextTokensForModel({
        cfg: contextConfig,
        ...(contextLookupProvider ? { provider: contextLookupProvider } : {}),
        model: contextLookupModel,
        contextTokensOverride:
          channelOverrideContextTokens ??
          cappedPersistedContextTokens ??
          cappedConfiguredContextTokens ??
          cappedAgentContextTokens ??
          explicitRuntimeContextTokens,
        fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
        allowAsyncLoad: false,
      }) ?? DEFAULT_CONTEXT_TOKENS);

  const thinkLevel =
    args.resolvedThink ?? args.sessionEntry?.thinkingLevel ?? args.agent?.thinkingDefault ?? "off";
  const verboseLevel =
    args.resolvedVerbose ?? args.sessionEntry?.verboseLevel ?? args.agent?.verboseDefault ?? "off";
  const fastMode = args.resolvedFast ?? args.sessionEntry?.fastMode ?? false;
  const reasoningLevel =
    args.resolvedReasoning ??
    args.sessionEntry?.reasoningLevel ??
    args.agent?.reasoningDefault ??
    "off";
  const elevatedLevel =
    args.resolvedElevated ??
    args.sessionEntry?.elevatedLevel ??
    args.agent?.elevatedDefault ??
    "on";

  const execution = { label: resolveExecutionLabel(args) };
  const agentRuntimeLabel = resolveAgentRuntimeLabel({
    config: args.config,
    sessionEntry: args.sessionEntry,
    resolvedHarness: args.resolvedHarness,
    fallbackProvider: activeProvider,
  });

  const updatedAt = entry?.updatedAt;
  const sessionLine = [
    `Session: ${args.sessionKey ?? "unknown"}`,
    typeof updatedAt === "number" ? `updated ${formatTimeAgo(now - updatedAt)}` : "no activity",
  ]
    .filter(Boolean)
    .join(" • ");

  const isGroupSession =
    entry?.chatType === "group" ||
    entry?.chatType === "channel" ||
    Boolean(args.sessionKey?.includes(":group:")) ||
    Boolean(args.sessionKey?.includes(":channel:"));
  const groupActivationValue = isGroupSession
    ? (args.groupActivation ?? entry?.groupActivation ?? "mention")
    : undefined;

  const contextLine = [
    `Context: ${formatTokens(totalTokens, contextTokens ?? null)}`,
    `🧹 Compactions: ${entry?.compactionCount ?? 0}`,
  ]
    .filter(Boolean)
    .join(" · ");

  const queueMode = args.queue?.mode ?? "unknown";
  const queueDetails = formatQueueDetails(args.queue);
  const verboseLabel =
    verboseLevel === "full" ? "verbose:full" : verboseLevel === "on" ? "verbose" : null;
  const traceLevel =
    entry?.traceLevel === "raw" ? "raw" : entry?.traceLevel === "on" ? "on" : "off";
  const traceLabel = traceLevel === "raw" ? "trace:raw" : traceLevel === "on" ? "trace" : null;
  const pluginStatusLines = verboseLevel !== "off" ? resolveSessionPluginStatusLines(entry) : [];
  const pluginTraceLines =
    traceLevel === "on" || traceLevel === "raw" ? resolveSessionPluginTraceLines(entry) : [];
  const pluginStatusLine =
    pluginStatusLines.length > 0 || pluginTraceLines.length > 0
      ? [...pluginStatusLines, ...pluginTraceLines].join(" · ")
      : null;
  const elevatedLabel =
    elevatedLevel && elevatedLevel !== "off"
      ? elevatedLevel === "on"
        ? "elevated"
        : `elevated:${elevatedLevel}`
      : null;
  const textVerbosity = resolveConfiguredTextVerbosity({
    config: args.config,
    agentId: args.agentId,
    provider: activeProvider,
    model: activeModel,
  });
  const optionParts = [
    `Execution: ${execution.label}`,
    `Runtime: ${agentRuntimeLabel}`,
    `Think: ${thinkLevel}`,
    formatFastModeLabel(fastMode),
    textVerbosity ? `Text: ${textVerbosity}` : null,
    verboseLabel,
    traceLabel,
    reasoningLevel !== "off" ? `Reasoning: ${reasoningLevel}` : null,
    elevatedLabel,
  ];
  const optionsLine = optionParts.filter(Boolean).join(" · ");
  const activationParts = [
    groupActivationValue ? `👥 Activation: ${groupActivationValue}` : null,
    `🪢 Queue: ${queueMode}${queueDetails}`,
  ];
  const activationLine = activationParts.filter(Boolean).join(" · ");

  const selectedModelLabel = modelRefs.selected.label || "unknown";
  const runtimeAliasModelEquivalent = areRuntimeModelRefsEquivalent(
    selectedModelLabel,
    activeModelLabel,
  );
  const selectedAuthMode =
    normalizeAuthMode(args.modelAuth) ?? resolveModelAuthMode(selectedProvider, args.config);
  const rawSelectedAuthLabelValue =
    selectedAuthMode && selectedAuthMode !== "unknown"
      ? (args.modelAuth ?? selectedAuthMode)
      : undefined;
  const activeAuthMode =
    normalizeAuthMode(args.activeModelAuth) ?? resolveModelAuthMode(activeProvider, args.config);
  const activeAuthLabelValue =
    activeAuthMode && activeAuthMode !== "unknown"
      ? (args.activeModelAuth ?? activeAuthMode)
      : undefined;
  const selectedAuthLabelValue =
    rawSelectedAuthLabelValue ?? (runtimeAliasModelEquivalent ? activeAuthLabelValue : undefined);
  const fallbackState = resolveActiveFallbackState({
    selectedModelRef: selectedModelLabel,
    activeModelRef: activeModelLabel,
    state: entry,
  });
  const effectiveCostAuthMode = fallbackState.active
    ? activeAuthMode
    : (selectedAuthMode ?? activeAuthMode);
  const showCost = effectiveCostAuthMode === "api-key" || effectiveCostAuthMode === "mixed";
  const hasUsage = typeof inputTokens === "number" || typeof outputTokens === "number";
  const costConfig =
    showCost && hasUsage
      ? resolveModelCostConfig({
          provider: activeProvider,
          model: activeModel,
          config: args.config,
          allowPluginNormalization: false,
        })
      : undefined;
  const cost =
    showCost && hasUsage
      ? estimateUsageCost({
          usage: {
            input: inputTokens ?? undefined,
            output: outputTokens ?? undefined,
          },
          cost: costConfig,
        })
      : undefined;
  const costLabel = showCost && hasUsage ? formatUsd(cost) : undefined;

  const selectedAuthLabel = selectedAuthLabelValue ? ` · 🔑 ${selectedAuthLabelValue}` : "";
  const modelNote = channelModelNote ? ` · ${channelModelNote}` : "";
  const modelLine = `🧠 Model: ${selectedModelLabel}${selectedAuthLabel}${modelNote}`;

  // Show configured fallback models (from agent model config)
  const configuredFallbacks = (() => {
    const modelConfig = args.agent?.model;
    if (typeof modelConfig === "object" && modelConfig && Array.isArray(modelConfig.fallbacks)) {
      return modelConfig.fallbacks;
    }
    return undefined;
  })();
  const configuredFallbacksLine = configuredFallbacks?.length
    ? `🔄 Fallbacks: ${configuredFallbacks.join(", ")}`
    : null;

  const showFallbackAuth = activeAuthLabelValue && activeAuthLabelValue !== selectedAuthLabelValue;
  const fallbackLine = fallbackState.active
    ? `↪️ Fallback: ${activeModelLabel}${
        showFallbackAuth ? ` · 🔑 ${activeAuthLabelValue}` : ""
      } (${fallbackState.reason ?? "selected model unavailable"})`
    : null;
  const commit = resolveCommitHash({ moduleUrl: import.meta.url });
  const versionLine = `🦞 OpenClaw ${VERSION}${commit ? ` (${commit})` : ""}`;
  const usagePair = formatUsagePair(inputTokens, outputTokens);
  const cacheLine = formatCacheLine(inputTokens, cacheRead, cacheWrite);
  const costLine = costLabel ? `💵 Cost: ${costLabel}` : null;
  const usageCostLine =
    usagePair && costLine ? `${usagePair} · ${costLine}` : (usagePair ?? costLine);
  const mediaLine = formatMediaUnderstandingLine(args.mediaDecisions);
  const voiceLine = formatVoiceModeLine(args.config, args.sessionEntry, args.agentId);

  return [
    versionLine,
    args.timeLine,
    args.uptimeLine,
    modelLine,
    configuredFallbacksLine,
    fallbackLine,
    usageCostLine,
    cacheLine,
    `📚 ${contextLine}`,
    mediaLine,
    args.usageLine,
    `🧵 ${sessionLine}`,
    args.subagentsLine,
    args.taskLine,
    `⚙️ ${optionsLine}`,
    pluginStatusLine ? `🧩 ${pluginStatusLine}` : null,
    voiceLine,
    activationLine,
  ]
    .filter(Boolean)
    .join("\n");
}
