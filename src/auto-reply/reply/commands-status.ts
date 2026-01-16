import {
  resolveAgentDir,
  resolveDefaultAgentId,
  resolveSessionAgentId,
} from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { buildAuthHealthSummary, formatRemainingShort } from "../../agents/auth-health.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { ClawdbotConfig } from "../../config/config.js";
import type { SessionEntry, SessionScope } from "../../config/sessions.js";
import { logVerbose } from "../../globals.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
  type UsageProviderId,
} from "../../infra/provider-usage.js";
import { normalizeGroupActivation } from "../group-activation.js";
import { buildStatusMessage } from "../status.js";
import type { ElevatedLevel, ReasoningLevel, ThinkLevel, VerboseLevel } from "../thinking.js";
import type { ReplyPayload } from "../types.js";
import type { CommandContext } from "./commands-types.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "./queue.js";

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
  cfg?: ClawdbotConfig,
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
  cfg: ClawdbotConfig;
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
  const authStore = ensureAuthProfileStore(statusAgentDir, { allowKeychainPrompt: false });
  const authHealth = buildAuthHealthSummary({ store: authStore, cfg });
  const oauthProfiles = authHealth.profiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );

  const usageProviders = Array.from(
    new Set(
      oauthProfiles
        .map((profile) => resolveUsageProviderId(profile.provider))
        .filter((entry): entry is UsageProviderId => Boolean(entry)),
    ),
  );
  const usageByProvider = new Map<string, string>();
  if (usageProviders.length > 0) {
    try {
      const usageSummary = await loadProviderUsageSummary({
        timeoutMs: 3500,
        providers: usageProviders,
        agentDir: statusAgentDir,
      });
      for (const snapshot of usageSummary.providers) {
        const formatted = formatUsageWindowSummary(snapshot, {
          now: Date.now(),
          maxWindows: 2,
        });
        if (formatted) usageByProvider.set(snapshot.provider, formatted);
      }
    } catch {
      // ignore
    }
  }

  let usageLine: string | null = null;
  try {
    const usageProvider = resolveUsageProviderId(provider);
    if (oauthProfiles.length === 0 && usageProvider) {
      const usage = usageByProvider.get(usageProvider);
      if (usage) usageLine = `📊 Usage: ${usage}`;
    }
  } catch {
    usageLine = null;
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
    includeTranscriptUsage: false,
  });

  const authStatusLines = (() => {
    if (oauthProfiles.length === 0) return [];
    const formatStatus = (status: string) => {
      if (status === "ok") return "ok";
      if (status === "static") return "static";
      if (status === "expiring") return "expiring";
      if (status === "missing") return "unknown";
      return "expired";
    };
    const profilesByProvider = new Map<string, typeof oauthProfiles>();
    for (const profile of oauthProfiles) {
      const current = profilesByProvider.get(profile.provider);
      if (current) current.push(profile);
      else profilesByProvider.set(profile.provider, [profile]);
    }
    const lines: string[] = ["OAuth/token status"];
    for (const [provider, profiles] of profilesByProvider) {
      const usageKey = resolveUsageProviderId(provider);
      const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
      const usageSuffix = usage ? ` — usage: ${usage}` : "";
      lines.push(`- ${provider}${usageSuffix}`);
      for (const profile of profiles) {
        const labelText = profile.label || profile.profileId;
        const status = formatStatus(profile.status);
        const expiry =
          profile.status === "static"
            ? ""
            : profile.expiresAt
              ? ` expires in ${formatRemainingShort(profile.remainingMs)}`
              : " expires unknown";
        const source = profile.source !== "store" ? ` (${profile.source})` : "";
        lines.push(`  - ${labelText} ${status}${expiry}${source}`);
      }
    }
    return lines;
  })();

  const fullStatusText =
    authStatusLines.length > 0 ? `${statusText}\n\n${authStatusLines.join("\n")}` : statusText;
  return { text: fullStatusText };
}
