import { Type } from "@sinclair/typebox";
import { resolveAgentDir } from "../../agents/agent-scope.js";
import {
  ensureAuthProfileStore,
  resolveAuthProfileDisplayLabel,
  resolveAuthProfileOrder,
} from "../../agents/auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../../agents/defaults.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { loadModelCatalog } from "../../agents/model-catalog.js";
import {
  buildAllowedModelSet,
  buildModelAliasIndex,
  modelKey,
  normalizeProviderId,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { normalizeGroupActivation } from "../../auto-reply/group-activation.js";
import {
  getFollowupQueueDepth,
  resolveQueueSettings,
} from "../../auto-reply/reply/queue.js";
import { buildStatusMessage } from "../../auto-reply/status.js";
import type { ClawdbotConfig } from "../../config/config.js";
import { loadConfig } from "../../config/config.js";
import {
  loadSessionStore,
  resolveStorePath,
  type SessionEntry,
  saveSessionStore,
} from "../../config/sessions.js";
import {
  formatUsageSummaryLine,
  loadProviderUsageSummary,
  resolveUsageProviderId,
} from "../../infra/provider-usage.js";
import {
  buildAgentMainSessionKey,
  DEFAULT_AGENT_ID,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type { AnyAgentTool } from "./common.js";
import { readStringParam } from "./common.js";
import {
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-helpers.js";

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
  cfg: ClawdbotConfig;
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

async function resolveModelOverride(params: {
  cfg: ClawdbotConfig;
  raw: string;
  sessionEntry?: SessionEntry;
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

  const configDefault = resolveConfiguredModelRef({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const currentProvider =
    params.sessionEntry?.providerOverride?.trim() || configDefault.provider;
  const currentModel =
    params.sessionEntry?.modelOverride?.trim() || configDefault.model;

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
    resolved.ref.provider === configDefault.provider &&
    resolved.ref.model === configDefault.model;
  return {
    kind: "set",
    provider: resolved.ref.provider,
    model: resolved.ref.model,
    isDefault,
  };
}

export function createSessionStatusTool(opts?: {
  agentSessionKey?: string;
  config?: ClawdbotConfig;
}): AnyAgentTool {
  return {
    label: "Session Status",
    name: "session_status",
    description:
      "Show a /status-equivalent session status card. Optional: set per-session model override (model=default resets overrides). Includes usage + cost when available.",
    parameters: SessionStatusToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const cfg = opts?.config ?? loadConfig();
      const { mainKey, alias } = resolveMainSessionAlias(cfg);

      const requestedKeyRaw =
        readStringParam(params, "sessionKey") ?? opts?.agentSessionKey;
      if (!requestedKeyRaw?.trim()) {
        throw new Error("sessionKey required");
      }

      const agentId = resolveAgentIdFromSessionKey(
        opts?.agentSessionKey ?? requestedKeyRaw,
      );
      const storePath = resolveStorePath(cfg.session?.store, { agentId });
      const store = loadSessionStore(storePath);

      const resolved = resolveSessionEntry({
        store,
        keyRaw: requestedKeyRaw,
        alias,
        mainKey,
      });
      if (!resolved) {
        throw new Error(`Unknown sessionKey: ${requestedKeyRaw}`);
      }

      const modelRaw = readStringParam(params, "model");
      let changedModel = false;
      if (typeof modelRaw === "string") {
        const selection = await resolveModelOverride({
          cfg,
          raw: modelRaw,
          sessionEntry: resolved.entry,
        });
        const nextEntry: SessionEntry = {
          ...resolved.entry,
          updatedAt: Date.now(),
        };
        if (selection.kind === "reset" || selection.isDefault) {
          delete nextEntry.providerOverride;
          delete nextEntry.modelOverride;
          delete nextEntry.authProfileOverride;
        } else {
          nextEntry.providerOverride = selection.provider;
          nextEntry.modelOverride = selection.model;
          delete nextEntry.authProfileOverride;
        }
        store[resolved.key] = nextEntry;
        await saveSessionStore(storePath, store);
        resolved.entry = nextEntry;
        changedModel = true;
      }

      const agentDir = resolveAgentDir(cfg, agentId);
      const configured = resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      });
      const providerForCard =
        resolved.entry.providerOverride?.trim() || configured.provider;
      const usageProvider = resolveUsageProviderId(providerForCard);
      let usageLine: string | undefined;
      if (usageProvider) {
        try {
          const usageSummary = await loadProviderUsageSummary({
            timeoutMs: 3500,
            providers: [usageProvider],
            agentDir,
          });
          const formatted = formatUsageSummaryLine(usageSummary, {
            now: Date.now(),
          });
          if (formatted) usageLine = formatted;
        } catch {
          // ignore
        }
      }

      const isGroup =
        resolved.entry.chatType === "group" ||
        resolved.entry.chatType === "room" ||
        resolved.key.startsWith("group:") ||
        resolved.key.includes(":group:") ||
        resolved.key.includes(":channel:");
      const groupActivation = isGroup
        ? (normalizeGroupActivation(resolved.entry.groupActivation) ??
          "mention")
        : undefined;

      const queueSettings = resolveQueueSettings({
        cfg,
        channel:
          resolved.entry.channel ?? resolved.entry.lastChannel ?? "unknown",
        sessionEntry: resolved.entry,
      });
      const queueKey = resolved.key ?? resolved.entry.sessionId;
      const queueDepth = queueKey ? getFollowupQueueDepth(queueKey) : 0;
      const queueOverrides = Boolean(
        resolved.entry.queueDebounceMs ??
          resolved.entry.queueCap ??
          resolved.entry.queueDrop,
      );

      const statusText = buildStatusMessage({
        config: cfg,
        agent: cfg.agents?.defaults ?? {},
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
