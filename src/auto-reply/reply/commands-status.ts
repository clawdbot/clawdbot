import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import { listSubagentRunsForRequester } from "../../agents/subagent-registry.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "../../agents/tools/sessions-helpers.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { buildStatusMessage } from "../status.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";
import type { MediaUnderstandingDecision } from "../../media-understanding/types.js";
import { resolveSubagentLabel } from "./subagents-utils.js";

function formatApiKeySnippet(apiKey: string): string {
  const compact = apiKey.replace(/\s+/g, "");
  if (!compact) return "unknown";
  const edge = compact.length >= 12 ? 6 : 4;
  const head = compact.slice(0, edge);
  const tail = compact.slice(-edge);
  return `${head}…${tail}`;
}

function resolveModelAuthLabel(
  provider?: string,
  cfg?: MoltbotConfig,
  sessionEntry?: SessionEntry,
  agentDir?: string,
): string | undefined {
  const resolved = provider?.trim();
  if (!resolved) return undefined;

  const providerKey = normalizeProviderId(resolved);
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOverride = sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: providerKey,
    preferredProfile: profileOverride,
  });
  const candidates = [profileOverride, ...order].filter(Boolean) as string[];

  for (const profileId of candidates) {
    const profile = store.profiles[profileId];
    if (!profile || normalizeProviderId(profile.provider) !== providerKey) {
      continue;
    }
    const label = resolveAuthProfileDisplayLabel({ cfg, store, profileId });
    if (profile.type === "oauth") {
      return `oauth${label ? ` (${label})` : ""}`;
    }
    if (profile.type === "token") {
      const snippet = formatApiKeySnippet(profile.token);
      return `token ${snippet}${label ? ` (${label})` : ""}`;
    }
    const snippet = formatApiKeySnippet(profile.key);
    return `api-key ${snippet}${label ? ` (${label})` : ""}`;
  }

  const envKey = resolveEnvApiKey(providerKey);
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key ${formatApiKeySnippet(envKey.apiKey)} (${envKey.source})`;
  }

  const customKey = getCustomProviderApiKey(cfg, providerKey);
  if (customKey) {
    return `api-key ${formatApiKeySnippet(customKey)} (models.json)`;
  }

  return "unknown";
}

export async function buildStatusReply(params: {
  cfg: MoltbotConfig;
  command: CommandContext;
  sessionEntry?: SessionEntry;
  sessionKey: string;
  sessionScope?: SessionScope;
  provider: string;
  model: string;
  contextTokens: number;
  resolvedThinkLevel?: ThinkLevel;
  resolvedVerboseLevel: VerboseLevel;
  resolvedReasoningLevel: ReasoningLevel;
  resolvedElevatedLevel?: ElevatedLevel;
  resolveDefaultThinkingLevel: () => Promise<ThinkLevel | undefined>;
  isGroup: boolean;
  defaultGroupActivation: () => "always" | "mention";
  mediaDecisions?: MediaUnderstandingDecision[];
}): Promise<ReplyPayload | undefined> {
  const {
    cfg,
    command,
    sessionEntry,
    sessionKey,
    sessionScope,
    provider,
    model,
    contextTokens,
    resolvedThinkLevel,
    resolvedVerboseLevel,
    resolvedReasoningLevel,
    resolvedElevatedLevel,
    resolveDefaultThinkingLevel,
    isGroup,
    defaultGroupActivation,
  } = params;
  if (!command.isAuthorizedSender) {
    logVerbose(`Ignoring /status from unauthorized sender: ${command.senderId || "<unknown>"}`);
    return undefined;
  }
  const statusAgentId = sessionKey
    ? resolveSessionAgentId({ sessionKey, config: cfg })
    : resolveDefaultAgentId(cfg);
  const statusAgentDir = resolveAgentDir(cfg, statusAgentId);
  const currentUsageProvider = (() => {
    try {
      return resolveUsageProviderId(provider);
    } catch {
      return undefined;
    }
  })();
  let usageLine: string | null = null;
  if (currentUsageProvider) {
    try {
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: 3500,
        providers: [currentUsageProvider],
        agentDir: statusAgentDir,
      });
      const usageEntry = usageSummary.providers[0];
      if (usageEntry && !usageEntry.error && usageEntry.windows.length > 0) {
        const summaryLine = formatUsageWindowSummary(usageEntry, {
          now: Date.now(),
          maxWindows: 2,
          includeResets: true,
        });
        if (summaryLine) usageLine = `📊 Usage: ${summaryLine}`;
      }
    } catch {
      usageLine = null;
    }
  }
  const queueSettings = resolveQueueSettings({
    cfg,
    channel: command.channel,
    sessionEntry,
  });
  const queueKey = sessionKey ?? sessionEntry?.sessionId;
  const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
  const queueOverrides = Boolean(
    sessionEntry?.queueDebounceMs ?? sessionEntry?.queueCap ?? sessionEntry?.queueDrop,
  );

  let subagentsLine: string | undefined;
  if (sessionKey) {
    const { mainKey, alias } = resolveMainSessionAlias(cfg);
    const requesterKey = resolveInternalSessionKey({ key: sessionKey, alias, mainKey });
    const runs = listSubagentRunsForRequester(requesterKey);
    const verboseEnabled = resolvedVerboseLevel && resolvedVerboseLevel !== "off";
    if (runs.length > 0) {
      const active = runs.filter((entry) => !entry.endedAt);
      const done = runs.length - active.length;
      if (verboseEnabled) {
        const labels = active
          .map((entry) => resolveSubagentLabel(entry, ""))
          .filter(Boolean)
          .slice(0, 3);
        const labelText = labels.length ? ` (${labels.join(", ")})` : "";
        subagentsLine = `🤖 Subagents: ${active.length} active${labelText} · ${done} done`;
      } else if (active.length > 0) {
        subagentsLine = `🤖 Subagents: ${active.length} active`;
      }
    }
  }
  const groupActivation = isGroup
    ? (normalizeGroupActivation(sessionEntry?.groupActivation) ?? defaultGroupActivation())
    : undefined;
  const agentDefaults = cfg.agents?.defaults ?? {};
  const statusText = buildStatusMessage({
    config: cfg,
    agent: {
      ...agentDefaults,
      model: {
        ...agentDefaults.model,
        primary: `${provider}/${model}`,
      },
      contextTokens,
      thinkingDefault: agentDefaults.thinkingDefault,
      verboseDefault: agentDefaults.verboseDefault,
      elevatedDefault: agentDefaults.elevatedDefault,
    },
    sessionEntry,
    sessionKey,
    sessionScope,
    groupActivation,
    resolvedThink: resolvedThinkLevel ?? (await resolveDefaultThinkingLevel()),
    resolvedVerbose: resolvedVerboseLevel,
    resolvedReasoning: resolvedReasoningLevel,
    resolvedElevated: resolvedElevatedLevel,
    modelAuth: resolveModelAuthLabel(provider, cfg, sessionEntry, statusAgentDir),
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
    mediaDecisions: params.mediaDecisions,
    includeTranscriptUsage: false,
  });

  return { text: statusText };
}
