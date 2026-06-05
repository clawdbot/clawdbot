// Runtime helpers for building status summaries.
// Kept behind a lazy surface because status summary imports model/session/runtime metadata helpers.

import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { parseModelRef, resolvePersistedSelectedModelRef } from "../agents/model-selection.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveStoredSessionKeyForAgentStore } from "../gateway/session-store-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
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
    // Bare model names may be aliases from agents.defaults.models before falling back to default provider.
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
    // Agent-specific primary model wins over global defaults for session status rows.
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
    // Persisted selected model or overrides describe the active session, not just current config.
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
  const acpSessionKey = params.agentId
    ? resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      })
    : params.sessionKey;
  const acpMeta = readAcpSessionMeta({ sessionKey: acpSessionKey });
  const runtime = resolveModelAgentRuntimeMetadata({
    cfg: params.cfg,
    agentId: params.agentId ?? "",
    provider: params.provider,
    model: params.model,
    sessionKey: acpSessionKey,
    acpRuntime: acpMeta != null,
    acpBackend: acpMeta?.backend,
  });
  const id = normalizeOptionalLowercaseString(runtime.id);
  // OpenClaw/auto are generic labels; concrete harness ids give better operator signal.
  const resolvedHarness = id && id !== "openclaw" && id !== "auto" ? id : undefined;
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
  // Status summaries are synchronous/read-only; caller passes allowAsyncLoad for interface parity only.
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
  classifySessionKey: classifySessionKind,
  resolveSessionModelRef,
  resolveSessionRuntimeLabel,
  resolveConfiguredStatusModelRef,
};
