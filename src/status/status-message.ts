// Status message helpers read and format stored status messages.
import {
  type FastMode,
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { resolveAuthoredModelContextTokens } from "../agents/context-resolution.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { resolveCronStyleNow } from "../agents/current-time.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveExtraParams } from "../agents/embedded-agent-runner/extra-params.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import { resolveModelAuthMode } from "../agents/model-auth.js";
import {
  areRuntimeModelRefsEquivalent,
  shouldPreferActiveRuntimeAliasAuthLabel,
} from "../agents/model-runtime-aliases.js";
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../agents/model-selection.js";
import { resolveOpenAITextVerbosity } from "../agents/openai-text-verbosity.js";
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
  resolveFreshSessionTotalTokens,
  resolveProjectedSessionContextTokens,
  resolveSessionPluginStatusLines,
  resolveSessionPluginTraceLines,
  type SessionEntry,
  type SessionScope,
} from "../config/sessions.js";
import { resolveSessionLifecycleTimestamps } from "../config/sessions/lifecycle.js";
import {
  hasSessionActiveAutoModelFallback,
  hasSessionAutoModelFallbackProvenance,
  hasUserPinnedModelSelection,
} from "../config/sessions/model-override-provenance.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRecentSessionUsageFromTranscript } from "../gateway/session-transcript-readers.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import { formatTimeAgo } from "../infra/format-time/format-relative.ts";
import type {
  MessagePresentation,
  MessagePresentationBlock,
  MessagePresentationTableCell,
} from "../interactive/payload.js";
import {
  findDecisionReason,
  summarizeDecisionReason,
} from "../media-understanding/runner.entries.js";
import type { MediaUnderstandingDecision } from "../media-understanding/types.js";
import { resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import { formatFastModeStatusValue } from "../shared/fast-mode.js";
import { resolveStatusTtsSnapshot } from "../tts/status-config.js";
import { sessionDeliveryChannel, sessionDeliveryOrigin } from "../utils/delivery-context.shared.js";
import {
  estimateUsageCost,
  formatTokenCount,
  formatUsd,
  resolveModelCostConfig,
} from "../utils/usage-format.js";
import { resolveRuntimeServiceCommit, VERSION } from "../version.js";
import { resolveAgentRuntimeLabel } from "./agent-runtime-label.js";
import { resolveActiveFallbackState } from "./fallback-notice-state.js";

type AgentDefaults = NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>;
type AgentConfig = Partial<AgentDefaults> & {
  model?: AgentDefaults["model"] | string;
};

type QueueStatus = {
  mode?: string;
  depth?: number;
  debounceMs?: number;
  cap?: number;
  dropPolicy?: string;
  showDetails?: boolean;
};

type StatusArgs = {
  config?: OpenClawConfig;
  agent: AgentConfig;
  agentId?: string;
  configuredDefaultModelLabel?: string;
  runtimeContextTokens?: number;
  sessionEntry?: SessionEntry;
  sessionKey?: string;
  parentSessionKey?: string;
  sessionScope?: SessionScope;
  sessionStorePath?: string;
  groupActivation?: "mention" | "always";
  resolvedThink?: ThinkLevel;
  resolvedFast?: FastMode;
  resolvedHarness?: string;
  resolvedVerbose?: VerboseLevel;
  resolvedReasoning?: ReasoningLevel;
  resolvedElevated?: ElevatedLevel;
  modelAuth?: string;
  activeModelAuth?: string;
  usageLine?: string;
  timeLine?: string;
  uptimeValue?: string;
  queue?: QueueStatus;
  mediaDecisions?: ReadonlyArray<MediaUnderstandingDecision>;
  subagentsLine?: string;
  taskLine?: string;
  pluginHealthLine?: string;
  channelFeatureLine?: string;
  includeTranscriptUsage?: boolean;
  now?: number;
};

type NormalizedAuthMode =
  | "api-key"
  | "oauth"
  | "token"
  | "aws-sdk"
  | "native"
  | "mixed"
  | "unknown";

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
  if (normalized === "native" || normalized.startsWith("native ")) {
    return "native";
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
  if (!provider || !model || provider !== "openai") {
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

const formatEstimatedContextBudgetTokens = (
  status: SessionEntry["contextBudgetStatus"] | undefined,
  contextTokens: number | null | undefined,
) => {
  if (!status || status.source !== "pre-prompt-estimate") {
    return null;
  }
  const estimatedPromptTokens =
    typeof status.estimatedPromptTokens === "number" &&
    Number.isFinite(status.estimatedPromptTokens) &&
    status.estimatedPromptTokens >= 0
      ? Math.floor(status.estimatedPromptTokens)
      : undefined;
  if (estimatedPromptTokens === undefined) {
    return null;
  }
  const ctx =
    typeof contextTokens === "number" && Number.isFinite(contextTokens) && contextTokens > 0
      ? contextTokens
      : typeof status.contextTokenBudget === "number" &&
          Number.isFinite(status.contextTokenBudget) &&
          status.contextTokenBudget > 0
        ? status.contextTokenBudget
        : undefined;
  const pct = ctx ? Math.min(999, Math.round((estimatedPromptTokens / ctx) * 100)) : null;
  const totalLabel = formatTokenCount(estimatedPromptTokens);
  const ctxLabel = ctx ? formatTokenCount(ctx) : "?";
  return `~${totalLabel}/${ctxLabel}${pct !== null ? ` (${pct}% est)` : " (est)"}`;
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
      totalTokensFresh: boolean;
      model?: string;
    }
  | undefined => {
  // Transcripts are stored at the session file path (fallback: ~/.openclaw/sessions/<SessionId>.jsonl)
  if (!sessionId) {
    return undefined;
  }
  try {
    const resolvedAgentId =
      agentId ?? (sessionKey ? resolveAgentIdFromSessionKey(sessionKey) : undefined);
    const snapshot = readRecentSessionUsageFromTranscript(
      {
        agentId: resolvedAgentId,
        sessionEntry,
        sessionId,
        sessionKey,
        storePath,
      },
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
      totalTokensFresh: snapshot.totalTokensFresh === true,
      model,
    };
  } catch {
    return undefined;
  }
};

const formatTokensPairValue = (input?: number | null, output?: number | null) => {
  if (input == null && output == null) {
    return null;
  }
  const inputLabel = typeof input === "number" ? formatTokenCount(input) : "?";
  const outputLabel = typeof output === "number" ? formatTokenCount(output) : "?";
  return `${inputLabel} in / ${outputLabel} out`;
};

const formatCacheHitValue = (
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

  return `${hitRate}% hit · ${cachedLabel} cached, ${newLabel} new`;
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
        const modelLabel = provider
          ? model && model !== provider
            ? `${provider}/${model}`
            : provider
          : null;
        const backendLabel = chosen?.observedBackend
          ? ` observed=${chosen.observedBackend}`
          : chosen?.requestedBackend
            ? ` requested=${chosen.requestedBackend}`
            : "";
        return `${decision.capability}${countLabel} ok${
          modelLabel ? ` (${modelLabel}${backendLabel})` : ""
        }`;
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
    channel: sessionDeliveryChannel(params.entry),
    groupId: params.entry.groupId,
    groupChatType: params.entry.chatType ?? sessionDeliveryOrigin(params.entry)?.chatType,
    groupChannel: params.entry.groupChannel,
    groupSubject: params.entry.subject,
    parentSessionKey: params.parentSessionKey,
    directUserIds: [
      sessionDeliveryOrigin(params.entry)?.nativeDirectUserId,
      sessionDeliveryOrigin(params.entry)?.from,
      sessionDeliveryOrigin(params.entry)?.to,
    ],
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

export type StatusMessageParts = {
  text: string;
  /** Structured mirror of the text body for channels with native table rendering. */
  presentation: MessagePresentation;
};

export function buildStatusMessage(args: StatusArgs): string {
  return buildStatusMessageParts(args).text;
}

export function buildStatusMessageParts(args: StatusArgs): StatusMessageParts {
  const now = args.now ?? Date.now();
  // Derive the live wall clock here so both /status and session_status expose
  // the same configured timezone without duplicating formatting at each caller.
  const cronNow = args.config ? resolveCronStyleNow(args.config, now) : undefined;
  const timeLine = args.timeLine ?? cronNow?.timeLine;
  const uptimeLine = args.uptimeValue ? `⏱️ Uptime: ${args.uptimeValue}` : undefined;
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
  const parseSelectedProvider = Boolean(
    entry?.modelOverride?.trim() && !entry?.providerOverride?.trim(),
  );
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider,
    selectedModel,
    sessionEntry: entry,
    parseSelectedProvider,
  });
  const selectedLookupProvider = modelRefs.selected.provider || selectedProvider;
  const selectedLookupModel = modelRefs.selected.model || selectedModel;
  const initialFallbackState = resolveActiveFallbackState({
    selectedModelRef: modelRefs.selected.label || "unknown",
    activeModelRef: modelRefs.active.label || "unknown",
    config: args.config,
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
          normalizeOptionalString(entry?.fallbackNotice?.activeModel ?? "") ?? "",
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
  const allowTranscriptContextUsage =
    entry?.totalTokensFresh !== false && freshTotalTokens === undefined;
  let totalTokens = freshTotalTokens;

  // Explicitly stale session/cache usage can still hydrate Tokens/Cache lines
  // but must not become Context.
  if (args.includeTranscriptUsage) {
    const logUsage = readUsageFromSessionLog(
      entry?.sessionId,
      entry,
      args.agentId,
      args.sessionKey,
      args.sessionStorePath,
    );
    if (logUsage) {
      const candidate = logUsage.totalTokensFresh
        ? logUsage.promptTokens || logUsage.total
        : undefined;
      if (
        allowTranscriptContextUsage &&
        candidate !== undefined &&
        candidate > 0 &&
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
    provider: selectedLookupProvider,
    model: selectedLookupModel,
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
    selectedProvider: selectedLookupProvider,
    selectedModel: selectedLookupModel,
    parentSessionKey: args.parentSessionKey,
  });
  const projectedActiveContextTokens = resolveProjectedSessionContextTokens({
    entry,
    provider: contextLookupProvider,
    model: contextLookupModel,
    agentHarnessId: args.resolvedHarness,
    resolvedContextTokens: activeContextTokens,
    authoredContextTokens: resolveAuthoredModelContextTokens({
      cfg: contextConfig,
      provider: contextLookupProvider,
      model: contextLookupModel,
    }),
  });
  const runtimeSnapshotHasFallbackProvenance =
    initialFallbackState.active ||
    hasSessionAutoModelFallbackProvenance(entry) ||
    areRuntimeModelRefsEquivalent(activeModelLabel, modelRefs.selected.label || "unknown", {
      config: args.config,
    });
  // A transcript-derived previous model must not pin a newly selected model to
  // its old window. Once fallback provenance is established, the shared
  // projector owns authored caps, runtime telemetry, and locked-session state.
  const useSelectedContext =
    entry?.modelSelectionLocked !== true &&
    runtimeDiffersFromSelected &&
    !runtimeSnapshotHasFallbackProvenance;
  const contextTokens = useSelectedContext
    ? (selectedContextTokens ?? DEFAULT_CONTEXT_TOKENS)
    : (projectedActiveContextTokens ?? DEFAULT_CONTEXT_TOKENS);

  const thinkLevel =
    args.resolvedThink ?? args.sessionEntry?.thinkingLevel ?? args.agent?.thinkingDefault ?? "off";
  const verboseLevel =
    args.resolvedVerbose ?? args.sessionEntry?.verboseLevel ?? args.agent?.verboseDefault ?? "off";
  const fastMode = args.resolvedFast ?? args.sessionEntry?.fastMode ?? false;
  const fastModeState = resolveFastModeState({
    cfg: args.config,
    provider: activeProvider,
    model: activeModel,
    agentId: args.agentId,
    sessionEntry: args.sessionEntry,
  });
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
  const sessionStartedAt = resolveSessionLifecycleTimestamps({
    entry,
    agentId: args.agentId,
    sessionKey: args.sessionKey,
    storePath: args.sessionStorePath,
  }).sessionStartedAt;
  const sessionDuration =
    typeof sessionStartedAt === "number"
      ? formatDurationCompact(now - sessionStartedAt, { spaced: true })
      : undefined;
  const sessionValue = [
    args.sessionKey ?? "unknown",
    sessionDuration ? `duration ${sessionDuration}` : null,
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

  const contextUsageLabel =
    totalTokens == null || totalTokens === 0
      ? (formatEstimatedContextBudgetTokens(entry?.contextBudgetStatus, contextTokens) ??
        formatTokens(totalTokens, contextTokens ?? null))
      : formatTokens(totalTokens, contextTokens ?? null);
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
  const fastModeValue = formatFastModeStatusValue({
    mode: fastMode,
    fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
  });
  const optionFlagsValue = [verboseLabel, traceLabel, elevatedLabel].filter(Boolean).join(" · ");
  // Mode switches are individually tiny; one shared line keeps them scannable
  // in both the plain body and the presentation table.
  const modesValue = [
    `think ${thinkLevel}`,
    `fast ${fastModeValue}`,
    textVerbosity ? `text ${textVerbosity}` : null,
    reasoningLevel !== "off" ? `reasoning ${reasoningLevel}` : null,
    optionFlagsValue || null,
  ]
    .filter(Boolean)
    .join(" · ");

  const selectedModelLabel = modelRefs.selected.label || "unknown";
  const runtimeAliasModelEquivalent = areRuntimeModelRefsEquivalent(
    selectedModelLabel,
    activeModelLabel,
    { config: args.config },
  );
  const selectedAuthMode =
    normalizeAuthMode(args.modelAuth) ?? resolveModelAuthMode(selectedLookupProvider, args.config);
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
  const preferActiveAuthLabel = shouldPreferActiveRuntimeAliasAuthLabel({
    runtimeAliasModelEquivalent,
    selectedAuthLabel: rawSelectedAuthLabelValue,
    activeAuthLabel: activeAuthLabelValue,
  });
  const selectedAuthLabelValue = preferActiveAuthLabel
    ? activeAuthLabelValue
    : (rawSelectedAuthLabelValue ??
      (runtimeAliasModelEquivalent ? activeAuthLabelValue : undefined));
  const fallbackState = resolveActiveFallbackState({
    selectedModelRef: selectedModelLabel,
    activeModelRef: activeModelLabel,
    config: args.config,
    state: entry,
  });
  const hasUsage =
    typeof inputTokens === "number" ||
    typeof outputTokens === "number" ||
    typeof cacheRead === "number" ||
    typeof cacheWrite === "number";
  const costConfig = hasUsage
    ? resolveModelCostConfig({
        provider: activeProvider,
        model: activeModel,
        config: args.config,
        allowPluginNormalization: false,
      })
    : undefined;
  const cost = hasUsage
    ? estimateUsageCost({
        usage: {
          input: inputTokens ?? undefined,
          output: outputTokens ?? undefined,
          cacheRead: cacheRead ?? undefined,
          cacheWrite: cacheWrite ?? undefined,
        },
        cost: costConfig,
      })
    : undefined;
  const costLabel = hasUsage ? formatUsd(cost) : undefined;

  const modelNote = channelModelNote ? ` · ${channelModelNote}` : "";
  const configuredDefaultModelLabel = normalizeOptionalString(args.configuredDefaultModelLabel);
  const sessionHasPersistedModelSelection = hasUserPinnedModelSelection(entry);
  const sessionHasAutoFallback = hasSessionActiveAutoModelFallback(entry);
  const configDefaultDiffersFromSession =
    (sessionHasPersistedModelSelection || sessionHasAutoFallback) &&
    configuredDefaultModelLabel &&
    selectedModelLabel !== configuredDefaultModelLabel &&
    !areRuntimeModelRefsEquivalent(selectedModelLabel, configuredDefaultModelLabel, {
      config: args.config,
    });
  const overrideLabel = configDefaultDiffersFromSession
    ? sessionHasPersistedModelSelection
      ? ` · pinned session; config primary ${configuredDefaultModelLabel} · clear /model default`
      : ` · auto fallback; config primary ${configuredDefaultModelLabel} · check provider`
    : "";
  // A user-driven live switch that no completed turn has applied yet: surface
  // it so /status does not imply the new selection is already running.
  const liveSwitchNote = entry?.liveModelSwitchPending ? " · ⏳ live switch pending" : "";
  // Auth gets its own line below; keeping it inline here duplicated the value.
  const modelLines = [
    `🧠 Model: ${selectedModelLabel}${modelNote}${overrideLabel}${liveSwitchNote}`,
  ];

  // Show configured fallback models (from agent model config)
  const configuredFallbacks = (() => {
    const modelConfig = args.agent?.model;
    if (typeof modelConfig === "object" && modelConfig && Array.isArray(modelConfig.fallbacks)) {
      return sessionHasPersistedModelSelection ? undefined : modelConfig.fallbacks;
    }
    return undefined;
  })();
  const configuredFallbacksLine = configuredFallbacks?.length
    ? `🔄 Fallbacks: ${configuredFallbacks.join(", ")}`
    : null;

  const showFallbackAuth = activeAuthLabelValue && activeAuthLabelValue !== selectedAuthLabelValue;
  const fallbackValue = fallbackState.active
    ? `${activeModelLabel}${
        showFallbackAuth ? ` · 🔑 ${activeAuthLabelValue}` : ""
      } (${fallbackState.reason ?? "selected model unavailable"})`
    : null;
  const fallbackLine = fallbackValue ? `↪️ Fallback: ${fallbackValue}` : null;
  const commit = resolveRuntimeServiceCommit();
  const versionLine = `🦞 OpenClaw ${VERSION}${commit ? ` (${commit})` : ""}`;
  const tokensValue = formatTokensPairValue(inputTokens, outputTokens);
  const usagePair = tokensValue ? `🧮 Tokens: ${tokensValue}` : null;
  const cacheValue = formatCacheHitValue(inputTokens, cacheRead, cacheWrite);
  const cacheLine = cacheValue ? `🗄️ Cache: ${cacheValue}` : null;
  const costLine = costLabel ? `💵 Cost: ${costLabel}` : null;
  // Depth 0 is the boring default; the queue row keeps details only when the
  // queue is non-empty or the session carries queue overrides.
  const queueHasSignal = (args.queue?.depth ?? 0) > 0 || args.queue?.showDetails === true;
  const compactionCount = entry?.compactionCount ?? 0;
  const contextPct =
    typeof totalTokens === "number" && totalTokens > 0 && contextTokens > 0
      ? Math.min(999, Math.round((totalTokens / contextTokens) * 100))
      : null;
  const contextMeter =
    contextPct !== null
      ? (() => {
          const filled = Math.min(10, Math.max(0, Math.round(contextPct / 10)));
          return `${"▰".repeat(filled)}${"▱".repeat(10 - filled)} `;
        })()
      : "";
  const mediaLine = formatMediaUnderstandingLine(args.mediaDecisions);
  const voiceLine = formatVoiceModeLine(args.config, args.sessionEntry, args.agentId);

  // One fact per line: chat clients wrap long lines mid-fact, so joining
  // several facts with separators reads as a wall rather than a summary.
  // Grouped sections with blank lines between them: a flat list of ~15 facts
  // reads as a wall, and chat clients give no other visual grouping.
  const text = [
    [versionLine, timeLine, uptimeLine],
    [
      ...modelLines,
      selectedAuthLabelValue ? `🔑 Auth: ${selectedAuthLabelValue}` : null,
      configuredFallbacksLine,
      fallbackLine,
    ],
    [
      usagePair,
      costLine,
      cacheLine,
      `📚 Context: ${contextUsageLabel}`,
      compactionCount > 0 ? `🧹 Compactions: ${compactionCount}` : null,
      mediaLine,
      args.usageLine,
    ],
    [`🧵 Session: ${sessionValue}`, args.subagentsLine, args.taskLine],
    [
      `⚙️ Execution: ${execution.label}`,
      `🤖 Runtime: ${agentRuntimeLabel}`,
      modesValue ? `🎛️ Modes: ${modesValue}` : null,
      groupActivationValue ? `👥 Activation: ${groupActivationValue}` : null,
      `🪢 Queue: ${queueMode}${queueHasSignal ? queueDetails : ""}`,
    ],
    [
      args.channelFeatureLine,
      args.pluginHealthLine,
      pluginStatusLine ? `🧩 ${pluginStatusLine}` : null,
      voiceLine,
    ],
  ]
    .map((section) => section.filter((line): line is string => Boolean(line)).join("\n"))
    .filter(Boolean)
    .join("\n\n");

  const statusRows: MessagePresentationTableCell[][] = [];
  const pushStatusRow = (label: string, value: string | number | null | undefined) => {
    const cell = typeof value === "number" ? String(value) : (value?.trim() ?? "");
    if (cell) {
      statusRows.push([label, cell]);
    }
  };
  pushStatusRow("🧠 Model", `${selectedModelLabel}${modelNote}${overrideLabel}${liveSwitchNote}`);
  pushStatusRow("🔑 Auth", selectedAuthLabelValue);
  pushStatusRow("🔄 Fallbacks", configuredFallbacks?.join(", "));
  pushStatusRow("↪️ Fallback", fallbackValue);
  pushStatusRow("🧮 Tokens", tokensValue);
  pushStatusRow("💵 Cost", costLabel);
  pushStatusRow("🗄️ Cache", cacheValue);
  pushStatusRow("📚 Context", `${contextMeter}${contextUsageLabel}`);
  pushStatusRow("🧹 Compactions", compactionCount > 0 ? compactionCount : null);
  pushStatusRow("🧵 Session", sessionValue);
  pushStatusRow("⚙️ Execution", execution.label);
  pushStatusRow("Runtime", agentRuntimeLabel);
  pushStatusRow("🎛️ Modes", modesValue);
  pushStatusRow("👥 Activation", groupActivationValue);
  pushStatusRow("🪢 Queue", queueHasSignal ? `${queueMode}${queueDetails}` : queueMode);

  const contextBlock = (value: string | null | undefined): MessagePresentationBlock[] =>
    value?.trim() ? [{ type: "context", text: value }] : [];
  // Presentation-only curation: the reference-UTC line and the rich-messages
  // feature hint stay in the plain text body, where they are diagnostic; native
  // renders keep one compact time-and-uptime line under the table.
  const presentationClockValue = cronNow
    ? `${cronNow.formattedTime} (${cronNow.userTimezone})`
    : args.timeLine;
  const clockUptimeValue = [
    presentationClockValue,
    args.uptimeValue ? `⏱️ ${args.uptimeValue}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  // Silence means nominal: the pressure line renders only when the context
  // window is running hot, so its presence alone is the signal.
  const contextPressureLine =
    contextPct !== null && contextPct >= 80 ? `⚠️ Context ${contextPct}% full` : null;
  // Lead with the product/version title and the clock so the card does not open
  // straight into a table; the header row then just labels the two columns.
  const presentation: MessagePresentation = {
    title: versionLine,
    blocks: [
      ...contextBlock(clockUptimeValue),
      {
        type: "table",
        caption: "Session status",
        headers: ["Item", "Value"],
        rows: statusRows,
        rowHeaderColumnIndex: 0,
      },
      // A warning is not low-emphasis context; keep it a plain text block.
      ...(contextPressureLine ? [{ type: "text", text: contextPressureLine } as const] : []),
      ...contextBlock(mediaLine),
      ...contextBlock(args.usageLine),
      ...contextBlock(args.subagentsLine),
      ...contextBlock(args.taskLine),
      ...contextBlock(args.pluginHealthLine),
      ...contextBlock(pluginStatusLine ? `🧩 ${pluginStatusLine}` : null),
      ...contextBlock(voiceLine),
    ],
  };

  return { text, presentation };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
