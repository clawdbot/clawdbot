import os from "node:os";
import {
  resolveAgentConfig,
  resolveAgentDir,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
  resolveAgentModelFallbacksOverride,
} from "../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import { resolveModelAuthLabel } from "../agents/model-auth-label.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { listOpenAIAuthProfileProvidersForAgentRuntime } from "../agents/openai-codex-routing.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../agents/tools/sessions-helpers.js";
import { normalizeGroupActivation } from "../auto-reply/group-activation.js";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import type { ThinkLevel } from "../auto-reply/thinking.js";
import { toAgentModelListLike } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.ts";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../infra/provider-usage.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import {
  listTasksForAgentIdForStatus,
  listTasksForSessionKeyForStatus,
} from "../tasks/task-status-access.js";
import {
  buildTaskStatusSnapshot,
  formatTaskStatusDetail,
  formatTaskStatusTitle,
} from "../tasks/task-status.js";
import type { BuildStatusTextParams } from "./status-text.types.js";
export type { BuildStatusTextParams } from "./status-text.types.js";

const USAGE_OAUTH_ONLY_PROVIDERS = new Set([
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "openai-codex",
]);

let statusMessageRuntimePromise: Promise<typeof import("../auto-reply/status.runtime.js")> | null =
  null;
let agentHarnessSelectionRuntimePromise: Promise<
  typeof import("../agents/harness/selection.js")
> | null = null;
let statusQueueRuntimePromise: Promise<typeof import("./status-queue.runtime.js")> | null = null;
let statusSubagentsRuntimePromise: Promise<typeof import("./status-subagents.runtime.js")> | null =
  null;

function loadStatusMessageRuntime(): Promise<typeof import("../auto-reply/status.runtime.js")> {
  const runtimePromise = (statusMessageRuntimePromise ??=
    import("./status-message.runtime.js").then((module) =>
      module.loadStatusMessageRuntimeModule(),
    ));
  return runtimePromise;
}

function loadAgentHarnessSelectionRuntime(): Promise<
  typeof import("../agents/harness/selection.js")
> {
  const runtimePromise = (agentHarnessSelectionRuntimePromise ??=
    import("../agents/harness/selection.js"));
  return runtimePromise;
}

function loadStatusSubagentsRuntime(): Promise<typeof import("./status-subagents.runtime.js")> {
  const runtimePromise = (statusSubagentsRuntimePromise ??=
    import("./status-subagents.runtime.js"));
  return runtimePromise;
}

function loadStatusQueueRuntime(): Promise<typeof import("./status-queue.runtime.js")> {
  const runtimePromise = (statusQueueRuntimePromise ??= import("./status-queue.runtime.js"));
  return runtimePromise;
}

function resolveStatusRuntimeContextTokens(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): number | undefined {
  return resolveContextTokensForModel({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    allowAsyncLoad: false,
  });
}

function shouldLoadUsageSummary(params: {
  provider?: string;
  selectedModelAuth?: string;
}): boolean {
  if (!params.provider) {
    return false;
  }
  if (!USAGE_OAUTH_ONLY_PROVIDERS.has(params.provider)) {
    return true;
  }
  const auth = normalizeOptionalLowercaseString(params.selectedModelAuth);
  return Boolean(auth?.startsWith("oauth") || auth?.startsWith("token"));
}

function formatSessionTaskLine(sessionKey: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForSessionKeyForStatus(sessionKey));
  const task = snapshot.focus;
  if (!task) {
    return undefined;
  }
  const headline =
    snapshot.activeCount > 0
      ? `${snapshot.activeCount} active · ${snapshot.totalCount} total`
      : snapshot.recentFailureCount > 0
        ? `${snapshot.recentFailureCount} recent failure${snapshot.recentFailureCount === 1 ? "" : "s"}`
        : "recently finished";
  const title = formatTaskStatusTitle(task);
  const detail = formatTaskStatusDetail(task);
  const parts = [headline, task.runtime, title, detail].filter(Boolean);
  return parts.length ? `📌 Tasks: ${parts.join(" · ")}` : undefined;
}

async function resolveStatusHarnessId(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  agentId: string;
  sessionKey: string;
  sessionEntry?: SessionEntry;
}): Promise<string | undefined> {
  try {
    const { selectAgentHarness } = await loadAgentHarnessSelectionRuntime();
    const selected = selectAgentHarness({
      provider: params.provider,
      modelId: params.model,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentHarnessId: params.sessionEntry?.agentHarnessId,
    });
    const id = normalizeOptionalLowercaseString(selected.id);
    return id || undefined;
  } catch {
    return undefined;
  }
}

function resolveStatusRuntimeProvider(params: {
  provider: string;
  effectiveHarness?: string;
}): string {
  const harness = normalizeOptionalLowercaseString(params.effectiveHarness);
  const provider = normalizeOptionalLowercaseString(params.provider);
  if (harness === "codex" && provider === "openai") {
    return "openai-codex";
  }
  if (harness === "claude-cli" && provider === "anthropic") {
    return "claude-cli";
  }
  return params.provider;
}

function formatAgentTaskCountsLine(agentId: string): string | undefined {
  const snapshot = buildTaskStatusSnapshot(listTasksForAgentIdForStatus(agentId));
  if (snapshot.totalCount === 0) {
    return undefined;
  }
  return `📌 Tasks: ${snapshot.activeCount} active · ${snapshot.totalCount} total · agent-local`;
}

function formatStatusUptimeDuration(ms: number): string {
  return formatDurationCompact(ms, { spaced: true }) ?? "0s";
}

export function buildStatusUptimeLine(): string {
  const gatewayUptimeMs = Math.max(0, Math.round(process.uptime() * 1000));
  const systemUptimeMs = Math.max(0, Math.round(os.uptime() * 1000));
  return `⏱️ Uptime: gateway ${formatStatusUptimeDuration(gatewayUptimeMs)} · system ${formatStatusUptimeDuration(systemUptimeMs)}`;
}

export async function buildStatusText(params: BuildStatusTextParams): Promise<string> {
  const {
    cfg,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    storePath,
    statusChannel,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedFastMode,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const statusWorkspaceDir =
    params.workspaceDir ??
    sessionEntry?.spawnedWorkspaceDir ??
    resolveAgentWorkspaceDir(cfg, statusAgentId);
  const modelRefs = resolveSelectedAndActiveModel({
    selectedProvider: provider,
    selectedModel: model,
    sessionEntry,
  });
  const effectiveHarness =
    params.resolvedHarness ??
    (await resolveStatusHarnessId({
      cfg,
      provider,
      model,
      agentId: statusAgentId,
      sessionKey,
      sessionEntry,
    }));
  const selectedStatusProvider = resolveStatusRuntimeProvider({
    provider,
    effectiveHarness,
  });
  const selectedAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider,
    harnessRuntime: effectiveHarness,
    config: cfg,
  });
  const activeProvider = modelRefs.active.provider || provider;
  const activeStatusProvider = resolveStatusRuntimeProvider({
    provider: activeProvider,
    effectiveHarness,
  });
  const activeAuthProviders = listOpenAIAuthProfileProvidersForAgentRuntime({
    provider: activeProvider,
    harnessRuntime: effectiveHarness,
    config: cfg,
  });
  let selectedModelAuth = Object.hasOwn(params, "modelAuthOverride")
    ? params.modelAuthOverride
    : resolveModelAuthLabel({
        provider: selectedStatusProvider,
        acceptedProviderIds: selectedAuthProviders,
        cfg,
        sessionEntry,
        agentDir: statusAgentDir,
        workspaceDir: statusWorkspaceDir,
        includeExternalProfiles: false,
      });
  const activeModelAuth = Object.hasOwn(params, "activeModelAuthOverride")
    ? params.activeModelAuthOverride
    : modelRefs.activeDiffers
      ? resolveModelAuthLabel({
          provider: activeStatusProvider,
          acceptedProviderIds: activeAuthProviders,
          cfg,
          sessionEntry,
          agentDir: statusAgentDir,
          workspaceDir: statusWorkspaceDir,
          includeExternalProfiles: false,
        })
      : selectedModelAuth;
  const runtimeAliasModelEquivalent = areRuntimeModelRefsEquivalent(
    modelRefs.selected.label,
    modelRefs.active.label,
  );
  if (
    runtimeAliasModelEquivalent &&
    normalizeOptionalLowercaseString(selectedModelAuth) === "unknown" &&
    activeModelAuth &&
    normalizeOptionalLowercaseString(activeModelAuth) !== "unknown"
  ) {
    selectedModelAuth = activeModelAuth;
  }
  const usageAuthLabel = modelRefs.activeDiffers ? activeModelAuth : selectedModelAuth;
  const currentUsageProvider =
    resolveUsageProviderId(activeStatusProvider) ?? resolveUsageProviderId(activeProvider);
  let usageLine: string | null = null;
  if (
    currentUsageProvider &&
    shouldLoadUsageSummary({
      provider: currentUsageProvider,
      selectedModelAuth: usageAuthLabel,
    })
  ) {
    try {
      const usageSummaryTimeoutMs = 3500;
      let usageTimeout: NodeJS.Timeout | undefined;
      const usageSummary = await Promise.race([
        loadProviderUsageSummary({
          timeoutMs: usageSummaryTimeoutMs,
          providers: [currentUsageProvider],
          agentDir: statusAgentDir,
        }),
        new Promise<never>((_, reject) => {
          usageTimeout = setTimeout(
            () => reject(new Error("usage summary timeout")),
            usageSummaryTimeoutMs,
          );
        }),
      ]).finally(() => {
        if (usageTimeout) {
          clearTimeout(usageTimeout);
        }
      });
      const usageEntry = usageSummary.providers[0];
      if (usageEntry && !usageEntry.error && usageEntry.windows.length > 0) {
        const summaryLine = formatUsageWindowSummary(usageEntry, {
          now: Date.now(),
          maxWindows: 2,
          includeResets: true,
        });
        if (summaryLine) {
          usageLine = `📊 Usage: ${summaryLine}`;
        }
      }
    } catch {
      usageLine = null;
    }
  }
  const { getFollowupQueueDepth, resolveQueueSettings } = await loadStatusQueueRuntime();
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: statusChannel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  let taskLine: string | undefined;
  if (sessionKey) {
    const { mainKey, alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
    taskLine = params.skipDefaultTaskLookup
      ? params.taskLineOverride
      : (params.taskLineOverride ?? formatSessionTaskLine(requesterKey));
    if (!taskLine && !params.skipDefaultTaskLookup) {
      taskLine = formatAgentTaskCountsLine(statusAgentId);
    }
    const { buildSubagentsStatusLine, countPendingDescendantRuns, listControlledSubagentRuns } =
      await loadStatusSubagentsRuntime();
    const runs = listControlledSubagentRuns(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    subagentsLine = buildSubagentsStatusLine({
      runs,
      verboseEnabled,
      pendingDescendantsForRun: (entry) => countPendingDescendantRuns(entry.childSessionKey),
    });
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const agentConfig = resolveAgentConfig(cfg, statusAgentId);
  const effectiveFastMode =
    resolvedFastMode ??
    resolveFastModeState({
      cfg,
      provider,
      model,
      agentId: statusAgentId,
      sessionEntry,
    }).enabled;
  const agentFallbacksOverride = resolveAgentModelFallbacksOverride(cfg, statusAgentId);
  const { buildStatusMessage } = await loadStatusMessageRuntime();
  const explicitThinkingDefault =
    (agentConfig?.thinkingDefault as ThinkLevel | undefined) ??
    (agentDefaults.thinkingDefault as ThinkLevel | undefined);
  const runtimeContextTokens = resolveStatusRuntimeContextTokens({
    cfg,
    provider: activeStatusProvider,
    model: modelRefs.active.model || model,
  });
  return buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...toAgentModelListLike(agentDefaults.model),
        primary: params.primaryModelLabelOverride ?? `${provider}/${model}`,
        ...(agentFallbacksOverride === undefined ? {} : { fallbacks: agentFallbacksOverride }),
      },
      ...(typeof contextTokens === "number" && contextTokens > 0 ? { contextTokens } : {}),
      thinkingDefault: explicitThinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      reasoningDefault: agentConfig?.reasoningDefault ?? agentDefaults.reasoningDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    agentId: statusAgentId,
    explicitConfiguredContextTokens:
      typeof agentDefaults.contextTokens === "number" && agentDefaults.contextTokens > 0
        ? agentDefaults.contextTokens
        : undefined,
    runtimeContextTokens,
    sessionEntry,
    sessionKey,
    parentSessionKey,
    sessionScope,
    sessionStorePath: storePath,
    groupActivation,
    resolvedThink:
      resolvedThinkLevel ?? explicitThinkingDefault ?? (await resolveDefaultThinkingLevel()),
    resolvedFast: effectiveFastMode,
    resolvedHarness: effectiveHarness,
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: selectedModelAuth,
    activeModelAuth,
    uptimeLine: buildStatusUptimeLine(),
    usageLine: usageLine ?? undefined,
    queue: {
      mode: queueSettings.mode,
      depth: queueDepth,
      debounceMs: queueSettings.debounceMs,
      cap: queueSettings.cap,
      dropPolicy: queueSettings.dropPolicy,
      showDetails: queueOverrides,
    },
    subagentsLine,
    taskLine,
    mediaDecisions: params.mediaDecisions,
    includeTranscriptUsage: params.includeTranscriptUsage ?? true,
  });
}
