import { Type } from "@sinclair/typebox";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { getCustomProviderApiKey, resolveEnvApiKey } from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveDefaultModelForAgent,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { formatUserTime, resolveUserTimeFormat, resolveUserTimezone } from "../date-time.js";
import { normalizeGroupActivation } from "../../auto-reply/group-activation.js";
import { getFollowupQueueDepth, resolveQueueSettings } from "../../auto-reply/reply/queue.js";
import { buildStatusMessage } from "../../auto-reply/status.js";
import type { MoltbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  updateSessionStore,
} from "../../config/sessions.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import { applyModelOverrideToSessionEntry } from "../../sessions/model-overrides.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import {
  shouldResolveSessionIdInput,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
  createAgentToAgentPolicy,
} from "./sessions-helpers.js";
import { loadCombinedSessionStoreForGateway } from "../../gateway/session-utils.js";

const SessionStatusToolSchema = Type.Object({
  sessionKey: Type.Optional(Type.String()),
  model: Type.Optional(Type.String()),
});

function formatApiKeySnippet(apiKey: string): string {
  const compact = apiKey.replace(/\s+/g, "");
  if (!compact) return "unknown";
  const edge = compact.length >= 12 ? 6 : 4;
  const head = compact.slice(0, edge);
  const tail = compact.slice(-edge);
  return `${head}…${tail}`;
}

function resolveModelAuthLabel(params: {
  provider?: string;
  cfg: MoltbotConfig;
  sessionEntry?: SessionEntry;
  agentDir?: string;
}): string | undefined {
  const resolvedProvider = params.provider?.trim();
  if (!resolvedProvider) return undefined;

  const providerKey = normalizeProviderId(resolvedProvider);
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileOverride = params.sessionEntry?.authProfileOverride?.trim();
  const order = resolveAuthProfileOrder({
    cfg: params.cfg,
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
    const label = resolveAuthProfileDisplayLabel({
      cfg: params.cfg,
      store,
      profileId,
    });
    if (profile.type === "oauth") {
      return `oauth${label ? ` (${label})` : ""}`;
    }
    if (profile.type === "token") {
      return `token ${formatApiKeySnippet(profile.token)}${label ? ` (${label})` : ""}`;
    }
    return `api-key ${formatApiKeySnippet(profile.key)}${label ? ` (${label})` : ""}`;
  }

  const envKey = resolveEnvApiKey(providerKey);
  if (envKey?.apiKey) {
    if (envKey.source.includes("OAUTH_TOKEN")) {
      return `oauth (${envKey.source})`;
    }
    return `api-key ${formatApiKeySnippet(envKey.apiKey)} (${envKey.source})`;
  }

  const customKey = getCustomProviderApiKey(params.cfg, providerKey);
  if (customKey) {
    return `api-key ${formatApiKeySnippet(customKey)} (models.json)`;
  }

  return "unknown";
}

function resolveSessionEntry(params: {
  store: Record<string, SessionEntry>;
  keyRaw: string;
  alias: string;
  mainKey: string;
}): { key: string; entry: SessionEntry } | null {
  const keyRaw = params.keyRaw.trim();
  if (!keyRaw) return null;
  const internal = resolveInternalSessionKey({
    key: keyRaw,
    alias: params.alias,
    mainKey: params.mainKey,
  });

  const candidates = new Set<string>([keyRaw, internal]);
  if (!keyRaw.startsWith("agent:")) {
    candidates.add(`agent:${DEFAULT_AGENT_ID}:${keyRaw}`);
    candidates.add(`agent:${DEFAULT_AGENT_ID}:${internal}`);
  }
  if (keyRaw === "main") {
    candidates.add(
      buildAgentMainSessionKey({
        agentId: DEFAULT_AGENT_ID,
        mainKey: params.mainKey,
      }),
    );
  }

  for (const key of candidates) {
    const entry = params.store[key];
    if (entry) return { key, entry };
  }

  return null;
}

function resolveSessionKeyFromSessionId(params: {
  cfg: MoltbotConfig;
  sessionId: string;
  agentId?: string;
}): string | null {
  const trimmed = params.sessionId.trim();
  if (!trimmed) return null;
  const { store } = loadCombinedSessionStoreForGateway(params.cfg);
  const match = Object.entries(store).find(([key, entry]) => {
    if (entry?.sessionId !== trimmed) return false;
    if (!params.agentId) return true;
    return resolveAgentIdFromSessionKey(key) === params.agentId;
  });
  return match?.[0] ?? null;
}

async function resolveModelOverride(params: {
  cfg: MoltbotConfig;
  raw: string;
  sessionEntry?: SessionEntry;
  agentId: string;
}): Promise<
  | { kind: "reset" }
  | {
      kind: "set";
      provider: string;
      model: string;
      isDefault: boolean;
    }
> {
  const raw = params.raw.trim();
  if (!raw) return { kind: "reset" };
  if (raw.toLowerCase() === "default") return { kind: "reset" };

  const configDefault = resolveDefaultModelForAgent({
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const currentProvider = params.sessionEntry?.providerOverride?.trim() || configDefault.provider;
  const currentModel = params.sessionEntry?.modelOverride?.trim() || configDefault.model;

  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg,
    defaultProvider: currentProvider,
  });
  const catalog = await loadModelCatalog({ config: params.cfg });
  const allowed = buildAllowedModelSet({
    cfg: params.cfg,
    catalog,
    defaultProvider: currentProvider,
    defaultModel: currentModel,
  });

  const resolved = resolveModelRefFromString({
    raw,
    defaultProvider: currentProvider,
    aliasIndex,
  });
  if (!resolved) {
    throw new Error(`Unrecognized model "${raw}".`);
  }
  const key = modelKey(resolved.ref.provider, resolved.ref.model);
  if (allowed.allowedKeys.size > 0 && !allowed.allowedKeys.has(key)) {
    throw new Error(`Model "${key}" is not allowed.`);
  }
  const isDefault =
    resolved.ref.provider === configDefault.provider && resolved.ref.model === configDefault.model;
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
  };
}

export function createSessionStatusTool(opts?: {
  agentSessionKey?: string;
  config?: MoltbotConfig;
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    description:
      "Show a /status-equivalent session status card (usage + time + cost when available). Use for model-use questions (📊 session_status). Optional: set per-session model override (model=default resets overrides).",
    parameters: SessionStatusToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);
      const a2aPolicy = createAgentToAgentPolicy(cfg);

      const requestedKeyParam = readStringParam(params, "sessionKey");
      let requestedKeyRaw = requestedKeyParam ?? opts?.agentSessionKey;
      if (!requestedKeyRaw?.trim()) {
        throw new Error("sessionKey required");
      }

      const requesterAgentId = resolveAgentIdFromSessionKey(
        opts?.agentSessionKey ?? requestedKeyRaw,
      );
      const ensureAgentAccess = (targetAgentId: string) => {
        if (targetAgentId === requesterAgentId) return;
        // Gate cross-agent access behind tools.agentToAgent settings.
        if (!a2aPolicy.enabled) {
          throw new Error(
            "Agent-to-agent status is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.",
          );
        }
        if (!a2aPolicy.isAllowed(requesterAgentId, targetAgentId)) {
          throw new Error("Agent-to-agent session status denied by tools.agentToAgent.allow.");
        }
      };

      if (requestedKeyRaw.startsWith("agent:")) {
        ensureAgentAccess(resolveAgentIdFromSessionKey(requestedKeyRaw));
      }

      const isExplicitAgentKey = requestedKeyRaw.startsWith("agent:");
      let agentId = isExplicitAgentKey
        ? resolveAgentIdFromSessionKey(requestedKeyRaw)
        : requesterAgentId;
      let storePath = resolveStorePath(cfg.session?.store, { agentId });
      let store = loadSessionStore(storePath);

      // Resolve against the requester-scoped store first to avoid leaking default agent data.
      let resolved = resolveSessionEntry({
        store,
        keyRaw: requestedKeyRaw,
        alias,
        mainKey,
      });

      if (!resolved && shouldResolveSessionIdInput(requestedKeyRaw)) {
        const resolvedKey = resolveSessionKeyFromSessionId({
          cfg,
          sessionId: requestedKeyRaw,
          agentId: a2aPolicy.enabled ? undefined : requesterAgentId,
        });
        if (resolvedKey) {
          // If resolution points at another agent, enforce A2A policy before switching stores.
          ensureAgentAccess(resolveAgentIdFromSessionKey(resolvedKey));
          requestedKeyRaw = resolvedKey;
          agentId = resolveAgentIdFromSessionKey(resolvedKey);
          storePath = resolveStorePath(cfg.session?.store, { agentId });
          store = loadSessionStore(storePath);
          resolved = resolveSessionEntry({
            store,
            keyRaw: requestedKeyRaw,
            alias,
            mainKey,
          });
        }
      }

      if (!resolved) {
        const kind = shouldResolveSessionIdInput(requestedKeyRaw) ? "sessionId" : "sessionKey";
        throw new Error(`Unknown ${kind}: ${requestedKeyRaw}`);
      }

      const configured = resolveDefaultModelForAgent({ cfg, agentId });
      const modelRaw = readStringParam(params, "model");
      let changedModel = false;
      if (typeof modelRaw === "string") {
        const selection = await resolveModelOverride({
          cfg,
          raw: modelRaw,
          sessionEntry: resolved.entry,
          agentId,
        });
        const nextEntry: SessionEntry = { ...resolved.entry };
        const applied = applyModelOverrideToSessionEntry({
          entry: nextEntry,
          selection:
            selection.kind === "reset"
              ? {
                  provider: configured.provider,
                  model: configured.model,
                  isDefault: true,
                }
              : {
                  provider: selection.provider,
                  model: selection.model,
                  isDefault: selection.isDefault,
                },
        });
        if (applied.updated) {
          store[resolved.key] = nextEntry;
          await updateSessionStore(storePath, (nextStore) => {
            nextStore[resolved.key] = nextEntry;
          });
          resolved.entry = nextEntry;
          changedModel = true;
        }
      }

      const agentDir = resolveAgentDir(cfg, agentId);
      const providerForCard = resolved.entry.providerOverride?.trim() || configured.provider;
      const usageProvider = resolveUsageProviderId(providerForCard);
      let usageLine: string | undefined;
      if (usageProvider) {
        try {
          const usageSummary = await loadProviderUsageSummary({
            timeoutMs: 3500,
            providers: [usageProvider],
            agentDir,
          });
          const snapshot = usageSummary.providers.find((entry) => entry.provider === usageProvider);
          if (snapshot) {
            const formatted = formatUsageWindowSummary(snapshot, {
              now: Date.now(),
              maxWindows: 2,
              includeResets: true,
            });
            if (formatted && !formatted.startsWith("error:")) {
              usageLine = `📊 Usage: ${formatted}`;
            }
          }
        } catch {
          // ignore
        }
      }

      const isGroup =
        resolved.entry.chatType === "group" ||
        resolved.entry.chatType === "channel" ||
        resolved.key.includes(":group:") ||
        resolved.key.includes(":channel:");
      const groupActivation = isGroup
        ? (normalizeGroupActivation(resolved.entry.groupActivation) ?? "mention")
        : undefined;

      const queueSettings = resolveQueueSettings({
        cfg,
        channel: resolved.entry.channel ?? resolved.entry.lastChannel ?? "unknown",
        sessionEntry: resolved.entry,
      });
      const queueKey = resolved.key ?? resolved.entry.sessionId;
      const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
      const queueOverrides = Boolean(
        resolved.entry.queueDebounceMs ?? resolved.entry.queueCap ?? resolved.entry.queueDrop,
      );

      const userTimezone = resolveUserTimezone(cfg.agents?.defaults?.userTimezone);
      const userTimeFormat = resolveUserTimeFormat(cfg.agents?.defaults?.timeFormat);
      const userTime = formatUserTime(new Date(), userTimezone, userTimeFormat);
      const timeLine = userTime
        ? `🕒 Time: ${userTime} (${userTimezone})`
        : `🕒 Time zone: ${userTimezone}`;

      const agentDefaults = cfg.agents?.defaults ?? {};
      const defaultLabel = `${configured.provider}/${configured.model}`;
      const agentModel =
        typeof agentDefaults.model === "object" && agentDefaults.model
          ? { ...agentDefaults.model, primary: defaultLabel }
          : { primary: defaultLabel };
      const statusText = buildStatusMessage({
        config: cfg,
        agent: {
          ...agentDefaults,
          model: agentModel,
        },
        sessionEntry: resolved.entry,
        sessionKey: resolved.key,
        groupActivation,
        modelAuth: resolveModelAuthLabel({
          provider: providerForCard,
          cfg,
          sessionEntry: resolved.entry,
          agentDir,
        }),
        usageLine,
        timeLine,
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

      return {
        content: [{ type: "text", text: statusText }],
        details: {
          ok: true,
          sessionKey: resolved.key,
          changedModel,
          statusText,
        },
      };
    },
  };
}
