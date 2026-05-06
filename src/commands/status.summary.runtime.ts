import { resolveAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { selectAgentHarness } from "../agents/harness/selection.js";
import { parseModelRef, resolvePersistedSelectedModelRef } from "../agents/model-selection.js";
import { normalizeProviderId } from "../agents/provider-id.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";
import { resolveAgentRuntimeLabel } from "../status/agent-runtime-label.js";

function resolveStatusModelRefFromRaw(params: {
  cfg: OpenClawConfig;
  rawModel: string;
  defaultProvider: string;
}): { provider: string; model: string } | null {
  const trimmed = params.rawModel.trim();
  if (!trimmed) {
    return null;
  }
  const configuredModels = params.cfg.agents?.defaults?.models ?? {};
  if (!trimmed.includes("/")) {
    const aliasKey = normalizeLowercaseStringOrEmpty(trimmed);
    for (const [modelKey, entry] of Object.entries(configuredModels)) {
      const aliasValue = (entry as { alias?: unknown } | undefined)?.alias;
      const alias = normalizeOptionalString(aliasValue) ?? "";
      if (!alias || normalizeOptionalLowercaseString(alias) !== aliasKey) {
        continue;
      }
      const parsed = parseModelRef(modelKey, params.defaultProvider, {
        allowPluginNormalization: false,
      });
      if (parsed) {
        return parsed;
      }
    }
    return { provider: params.defaultProvider, model: trimmed };
  }
  return parseModelRef(trimmed, params.defaultProvider, {
    allowPluginNormalization: false,
  });
}

function resolveConfiguredStatusModelRef(params: {
  cfg: OpenClawConfig;
  defaultProvider: string;
  defaultModel: string;
  agentId?: string;
}): { provider: string; model: string } {
  const agentRawModel = params.agentId
    ? resolveAgentModelPrimaryValue(
        params.cfg.agents?.list?.find((entry) => entry?.id === params.agentId)?.model,
      )
    : undefined;
  if (agentRawModel) {
    const parsed = resolveStatusModelRefFromRaw({
      cfg: params.cfg,
      rawModel: agentRawModel,
      defaultProvider: params.defaultProvider,
    });
    if (parsed) {
      return parsed;
    }
  }

  const defaultsRawModel = resolveAgentModelPrimaryValue(params.cfg.agents?.defaults?.model);
  if (defaultsRawModel) {
    const parsed = resolveStatusModelRefFromRaw({
      cfg: params.cfg,
      rawModel: defaultsRawModel,
      defaultProvider: params.defaultProvider,
    });
    if (parsed) {
      return parsed;
    }
  }

  const fallbackProvider = resolveConfiguredProviderFallback({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  if (fallbackProvider) {
    return fallbackProvider;
  }

  return { provider: params.defaultProvider, model: params.defaultModel };
}

function resolveConfiguredProviderContextTokens(
  cfg: OpenClawConfig | undefined,
  provider: string,
  model: string,
): number | undefined {
  const providers = cfg?.models?.providers;
  if (!providers || typeof providers !== "object") {
    return undefined;
  }
  const providerKey = normalizeProviderId(provider);
  for (const [id, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(id) !== providerKey || !Array.isArray(providerConfig?.models)) {
      continue;
    }
    for (const entry of providerConfig.models) {
      const contextTokens =
        typeof entry?.contextTokens === "number"
          ? entry.contextTokens
          : typeof entry?.contextWindow === "number"
            ? entry.contextWindow
            : undefined;
      if (
        typeof entry?.id === "string" &&
        entry.id === model &&
        typeof contextTokens === "number" &&
        contextTokens > 0
      ) {
        return contextTokens;
      }
    }
  }
  return undefined;
}

function classifySessionKey(key: string, entry?: SessionEntry) {
  if (key === "global") {
    return "global";
  }
  if (key === "unknown") {
    return "unknown";
  }
  if (isCronSessionKey(key)) {
    return "cron";
  }
  if (entry?.chatType === "group" || entry?.chatType === "channel") {
    return "group";
  }
  if (key.includes(":group:") || key.includes(":channel:")) {
    return "group";
  }
  return "direct";
}

function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?:
    | SessionEntry
    | Pick<SessionEntry, "model" | "modelProvider" | "modelOverride" | "providerOverride">,
  agentId?: string,
): { provider: string; model: string } {
  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    agentId,
  });
  return (
    resolvePersistedSelectedModelRef({
      defaultProvider: resolved.provider || DEFAULT_PROVIDER,
      runtimeProvider: entry?.modelProvider,
      runtimeModel: entry?.model,
      overrideProvider: entry?.providerOverride,
      overrideModel: entry?.modelOverride,
      allowPluginNormalization: false,
    }) ?? resolved
  );
}

function resolveSessionRuntimeLabel(params: {
  cfg: OpenClawConfig;
  entry?: SessionEntry;
  provider: string;
  model: string;
  agentId?: string;
  sessionKey: string;
}): string {
  const agentRuntime = resolveAgentRuntimeMetadata(params.cfg, params.agentId ?? "");
  const explicitRuntime =
    normalizeOptionalLowercaseString(params.entry?.agentRuntimeOverride) ??
    normalizeOptionalLowercaseString(params.entry?.agentHarnessId) ??
    (agentRuntime.source === "implicit"
      ? undefined
      : normalizeOptionalLowercaseString(agentRuntime.id));
  if (explicitRuntime && explicitRuntime !== "auto" && explicitRuntime !== "default") {
    return resolveAgentRuntimeLabel({
      config: params.cfg,
      sessionEntry: params.entry,
      resolvedHarness: explicitRuntime,
      fallbackProvider: params.provider,
    });
  }

  let resolvedHarness: string | undefined;
  try {
    const selected = selectAgentHarness({
      provider: params.provider,
      modelId: params.model,
      config: params.cfg,
      agentId: params.agentId,
      sessionKey: params.sessionKey,
      agentHarnessId: params.entry?.agentHarnessId,
    });
    const id = normalizeOptionalLowercaseString(selected.id);
    resolvedHarness = id && id !== "pi" ? id : undefined;
  } catch {
    resolvedHarness = undefined;
  }
  return resolveAgentRuntimeLabel({
    config: params.cfg,
    sessionEntry: params.entry,
    resolvedHarness,
    fallbackProvider: params.provider,
  });
}

function resolveContextTokensForModel(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  contextTokensOverride?: number;
  fallbackContextTokens?: number;
  allowAsyncLoad?: boolean;
}): number | undefined {
  void params.allowAsyncLoad;
  if (typeof params.contextTokensOverride === "number" && params.contextTokensOverride > 0) {
    return params.contextTokensOverride;
  }
  if (params.provider && params.model) {
    const configuredContextTokens = resolveConfiguredProviderContextTokens(
      params.cfg,
      params.provider,
      params.model,
    );
    if (configuredContextTokens !== undefined) {
      return configuredContextTokens;
    }
  }
  return params.fallbackContextTokens ?? DEFAULT_CONTEXT_TOKENS;
}

export const statusSummaryRuntime = {
  resolveContextTokensForModel,
  classifySessionKey,
  resolveSessionModelRef,
  resolveSessionRuntimeLabel,
  resolveConfiguredStatusModelRef,
};
