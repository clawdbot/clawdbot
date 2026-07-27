// Runtime helpers for building status summaries.
// Kept behind a lazy surface because status summary imports model/session/runtime metadata helpers.

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { readAcpSessionMeta } from "../acp/runtime/session-meta.js";
import { resolveModelAgentRuntimeMetadata } from "../agents/agent-runtime-metadata.js";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveConfiguredProviderFallback } from "../agents/configured-provider-fallback.js";
import { resolveContextTokensForModelFromCache as resolveContextTokensForModel } from "../agents/context-resolution.js";
import { waitForContextWindowCacheLoad } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
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
        allowManifestNormalization: false,
        allowPluginNormalization: false,
      });
      if (parsed) {
        return parsed;
      }
    }
    return { provider: params.defaultProvider, model: trimmed };
  }
  return parseModelRef(trimmed, params.defaultProvider, {
    allowManifestNormalization: false,
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
    ? resolveAgentModelPrimaryValue(resolveAgentConfig(params.cfg, params.agentId)?.model)
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

function resolveProviderlessPersistedStatusModelRef(params: {
  defaultProvider: string;
  provider?: unknown;
  model?: unknown;
}): { provider: string; model: string } | null {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (
    !model ||
    provider ||
    model.includes("/") ||
    normalizeLowercaseStringOrEmpty(model) === "openrouter:auto"
  ) {
    return null;
  }
  // Status rows report the persisted session text. Shared ref parsing still
  // canonicalizes provider-local aliases, which would rewrite this display.
  return { provider: params.defaultProvider, model };
}

function resolveStatusModelLookupRef(params: {
  provider?: unknown;
  model?: unknown;
  defaultProvider?: unknown;
}): { provider: string; model: string } | null {
  const provider = normalizeOptionalString(params.provider);
  const model = normalizeOptionalString(params.model);
  if (!model) {
    return null;
  }
  const defaultProvider =
    normalizeOptionalString(params.defaultProvider) ?? provider ?? DEFAULT_PROVIDER;
  const raw = provider ? `${provider}/${model}` : model;
  const parsed = parseModelRef(raw, defaultProvider, {
    allowManifestNormalization: false,
    allowPluginNormalization: false,
  });
  return parsed ?? { provider: provider ?? defaultProvider, model };
}

function resolveStatusModelComparisonLabel(params: {
  provider?: unknown;
  model?: unknown;
  defaultProvider?: unknown;
}): string | null {
  const ref = resolveStatusModelLookupRef(params);
  return ref ? `${ref.provider}/${ref.model}` : null;
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
  const defaultProvider = resolved.provider || DEFAULT_PROVIDER;
  const providerlessPersisted =
    resolveProviderlessPersistedStatusModelRef({
      defaultProvider,
      provider: entry?.providerOverride,
      model: entry?.modelOverride,
    }) ??
    resolveProviderlessPersistedStatusModelRef({
      defaultProvider,
      provider: entry?.modelProvider,
      model: entry?.model,
    });
  if (providerlessPersisted) {
    return providerlessPersisted;
  }
  return (
    // Persisted selected model or overrides describe the active session, not just current config.
    resolvePersistedSelectedModelRef({
      defaultProvider,
      runtimeProvider: entry?.modelProvider,
      runtimeModel: entry?.model,
      overrideProvider: entry?.providerOverride,
      overrideModel: entry?.modelOverride,
      allowManifestNormalization: false,
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
    sessionEntry: params.entry,
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

export const statusSummaryRuntime = {
  waitForContextWindowCacheLoad,
  resolveContextTokensForModel,
  classifySessionKey: classifySessionKind,
  resolveSessionModelRef,
  resolveSessionRuntimeLabel,
  resolveConfiguredStatusModelRef,
  resolveStatusModelLookupRef,
  resolveStatusModelComparisonLabel,
};
