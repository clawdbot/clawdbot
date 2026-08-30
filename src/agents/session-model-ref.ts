// Resolves persisted session model metadata without loading Gateway projections.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionModelOverrideRouteResolution } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelManifestNormalizationContext } from "./model-ref-shared.js";
import { createModelManifestPluginContext } from "./model-selection-shared.js";
import {
  inferUniqueProviderFromConfiguredModels,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveDefaultModelForAgent,
  resolvePersistedSelectedModelRef,
} from "./model-selection.js";

type SessionModelEntry =
  | SessionEntry
  | Pick<
      SessionEntry,
      | "model"
      | "modelProvider"
      | "modelOverride"
      | "providerOverride"
      | "modelOverrideRouteResolution"
      | "modelOverrideFallbackOriginProvider"
      | "modelOverrideFallbackOriginModel"
    >;

export function resolveSessionModelRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  options?: { allowPluginNormalization?: boolean } & ModelManifestNormalizationContext,
): { provider: string; model: string } {
  const manifestContext = createModelManifestPluginContext({ cfg, agentId, ...options });
  const overrideProvider = normalizeOptionalString(entry?.providerOverride);
  const overrideModel = normalizeOptionalString(entry?.modelOverride);
  const overrideRouteResolution = resolveSessionModelOverrideRouteResolution(entry);
  if (overrideProvider && overrideModel) {
    return resolvePersistedSelectedModelRef({
      ...manifestContext.getContext(),
      defaultProvider: overrideProvider,
      overrideProvider,
      overrideModel,
      overrideRouteResolution,
      allowPluginNormalization: options?.allowPluginNormalization,
    })!;
  }
  const runtimeProvider = normalizeOptionalString(entry?.modelProvider);
  const runtimeModel = normalizeOptionalString(entry?.model);

  const resolved = agentId
    ? resolveDefaultModelForAgent({
        cfg,
        agentId,
        ...options,
      })
    : resolveConfiguredModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        ...options,
      });

  const persisted = resolvePersistedSelectedModelRef({
    ...(overrideModel || (!agentId && runtimeModel && !runtimeProvider)
      ? manifestContext.getContext()
      : options),
    defaultProvider: resolved.provider || DEFAULT_PROVIDER,
    // Runtime fields record the previous run. Agent-scoped selection must use
    // current config or an explicit override; legacy callers without an agent
    // still use the persisted pair as their fallback selection context.
    runtimeProvider: agentId ? undefined : runtimeProvider,
    runtimeModel: agentId ? undefined : runtimeModel,
    overrideProvider,
    overrideModel,
    overrideRouteResolution,
    allowPluginNormalization: options?.allowPluginNormalization,
  });
  return persisted ?? resolved;
}

export function resolveSessionModelIdentityRef(
  cfg: OpenClawConfig,
  entry?: SessionModelEntry,
  agentId?: string,
  fallbackModelRef?: string,
  options?: { allowPluginNormalization?: boolean } & ModelManifestNormalizationContext,
): { provider?: string; model: string } {
  const manifestContext = createModelManifestPluginContext({ cfg, agentId, ...options });
  const runtimeModel = entry?.model?.trim();
  const runtimeProvider = entry?.modelProvider?.trim();
  if (runtimeModel) {
    if (runtimeProvider) {
      return { provider: runtimeProvider, model: runtimeModel };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: runtimeModel,
      agentId,
      ...options,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: runtimeModel };
    }
    if (runtimeModel.includes("/")) {
      const parsedRuntime = parseModelRef(runtimeModel, DEFAULT_PROVIDER, {
        ...manifestContext.getContext(),
        allowPluginNormalization: options?.allowPluginNormalization,
      });
      if (parsedRuntime) {
        return { provider: parsedRuntime.provider, model: parsedRuntime.model };
      }
      return { model: runtimeModel };
    }
    return { model: runtimeModel };
  }
  const fallbackRef = fallbackModelRef?.trim();
  if (fallbackRef) {
    const parsedFallback = parseModelRef(fallbackRef, DEFAULT_PROVIDER, {
      ...manifestContext.getContext(),
      allowPluginNormalization: options?.allowPluginNormalization,
    });
    if (parsedFallback) {
      return { provider: parsedFallback.provider, model: parsedFallback.model };
    }
    const inferredProvider = inferUniqueProviderFromConfiguredModels({
      cfg,
      model: fallbackRef,
      agentId,
      ...options,
    });
    if (inferredProvider) {
      return { provider: inferredProvider, model: fallbackRef };
    }
    return { model: fallbackRef };
  }
  const resolved = resolveSessionModelRef(cfg, entry, agentId, options);
  return { provider: resolved.provider, model: resolved.model };
}
