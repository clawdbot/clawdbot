import type { AuthProfileCredential, OAuthCredential } from "../agents/auth-profiles/types.js";
import { resolveGpt5SystemPromptContribution } from "../agents/gpt5-prompt-overlay.js";
import {
  applyPluginTextReplacements,
  mergePluginTextTransforms,
} from "../agents/plugin-text-transforms.js";
import type { ProviderSystemPromptContribution } from "../agents/system-prompt-contribution.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import { resolvePluginDiscoveryProvidersRuntime } from "./provider-discovery.runtime.js";
import {
  __testing as providerHookRuntimeTesting,
  clearProviderRuntimeHookCache,
  prepareProviderExtraParams,
  resetProviderRuntimeHookCacheForTest,
  resolveProviderAuthProfileId,
  resolveProviderExtraParamsForTransport,
  resolveProviderFollowupFallbackRoute,
  resolveProviderHookPlugin,
  resolveProviderPluginsForHooks,
  resolveProviderRuntimePlugin,
  wrapProviderStreamFn,
} from "./provider-hook-runtime.js";
import { resolveBundledProviderPolicySurface } from "./provider-public-artifacts.js";
import type { ProviderRuntimeModel } from "./provider-runtime-model.types.js";
import type { ProviderThinkingProfile } from "./provider-thinking.types.js";
import {
  resolveCatalogHookProviderPluginIds,
  resolveExternalAuthProfileCompatFallbackPluginIds,
  resolveExternalAuthProfileProviderPluginIds,
} from "./providers.js";
import { getActivePluginRegistryWorkspaceDirFromState } from "./runtime-state.js";
import { resolveRuntimeTextTransforms } from "./text-transforms.runtime.js";
import type {
  ProviderAuthDoctorHintContext,
  ProviderAugmentModelCatalogContext,
  ProviderExternalAuthProfile,
  ProviderBuildMissingAuthMessageContext,
  ProviderBuildUnknownModelHintContext,
  ProviderBuiltInModelSuppressionContext,
  ProviderCacheTtlEligibilityContext,
  ProviderCreateEmbeddingProviderContext,
  ProviderDeferSyntheticProfileAuthContext,
  ProviderResolveSyntheticAuthContext,
  ProviderCreateStreamFnContext,
  ProviderDefaultThinkingPolicyContext,
  ProviderFetchUsageSnapshotContext,
  ProviderFailoverErrorContext,
  ProviderNormalizeToolSchemasContext,
  ProviderNormalizeConfigContext,
  ProviderNormalizeModelIdContext,
  ProviderReasoningOutputMode,
  ProviderReasoningOutputModeContext,
  ProviderReplayPolicy,
  ProviderReplayPolicyContext,
  ProviderNormalizeResolvedModelContext,
  ProviderNormalizeTransportContext,
  ProviderModernModelPolicyContext,
  ProviderPrepareDynamicModelContext,
  ProviderPreferRuntimeResolvedModelContext,
  ProviderResolveExternalAuthProfilesContext,
  ProviderResolveExternalOAuthProfilesContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderApplyConfigDefaultsContext,
  ProviderResolveConfigApiKeyContext,
  ProviderSanitizeReplayHistoryContext,
  ProviderResolveUsageAuthContext,
  ProviderPlugin,
  ProviderResolveDynamicModelContext,
  ProviderResolveTransportTurnStateContext,
  ProviderResolveWebSocketSessionPolicyContext,
  ProviderSystemPromptContributionContext,
  ProviderTransformSystemPromptContext,
  ProviderThinkingPolicyContext,
  ProviderTransportTurnState,
  ProviderValidateReplayTurnsContext,
  ProviderWebSocketSessionPolicy,
  PluginTextTransforms,
} from "./types.js";

const log = createSubsystemLogger("plugins/provider-runtime");
const warnedExternalAuthFallbackPluginIds = new Set<string>();

function resetExternalAuthFallbackWarningCacheForTest(): void {
  warnedExternalAuthFallbackPluginIds.clear();
}

export {
  clearProviderRuntimeHookCache,
  prepareProviderExtraParams,
  resolveProviderAuthProfileId,
  resolveProviderExtraParamsForTransport,
  resolveProviderFollowupFallbackRoute,
  resetProviderRuntimeHookCacheForTest,
  resolveProviderRuntimePlugin,
  wrapProviderStreamFn,
};

export const __testing = {
  ...providerHookRuntimeTesting,
  resetExternalAuthFallbackWarningCacheForTest,
} as const;

function resolveProviderPluginsForCatalogHooks(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const onlyPluginIds = resolveCatalogHookProviderPluginIds({
    config: params.config,
    workspaceDir,
    env: params.env,
  });
  if (onlyPluginIds.length === 0) {
    return [];
  }
  return resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    onlyPluginIds,
  });
}

export function runProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveDynamicModelContext;
}): ProviderRuntimeModel | undefined {
  return resolveProviderRuntimePlugin(params)?.resolveDynamicModel?.(params.context) ?? undefined;
}

export function resolveProviderSystemPromptContribution(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderSystemPromptContributionContext;
}): ProviderSystemPromptContribution | undefined {
  const plugin = resolveProviderRuntimePlugin(params);
  const baseOverlay = resolveGpt5SystemPromptContribution({
    config: params.context.config ?? params.config,
    providerId: params.context.provider ?? params.provider,
    modelId: params.context.modelId,
  });
  const providerOverlay =
    plugin?.resolvePromptOverlay?.({
      ...params.context,
      baseOverlay,
    }) ?? undefined;
  return mergeProviderSystemPromptContributions(
    mergeProviderSystemPromptContributions(baseOverlay, providerOverlay),
    plugin?.resolveSystemPromptContribution?.(params.context) ?? undefined,
  );
}

function mergeProviderSystemPromptContributions(
  base?: ProviderSystemPromptContribution,
  override?: ProviderSystemPromptContribution,
): ProviderSystemPromptContribution | undefined {
  if (!base) {
    return override;
  }
  if (!override) {
    return base;
  }
  const stablePrefix = mergeUniquePromptSections(base.stablePrefix, override.stablePrefix);
  const dynamicSuffix = mergeUniquePromptSections(base.dynamicSuffix, override.dynamicSuffix);
  return {
    ...(stablePrefix ? { stablePrefix } : {}),
    ...(dynamicSuffix ? { dynamicSuffix } : {}),
    sectionOverrides: {
      ...base.sectionOverrides,
      ...override.sectionOverrides,
    },
  };
}

function mergeUniquePromptSections(...sections: Array<string | undefined>): string | undefined {
  const uniqueSections = [...new Set(sections.filter((section) => section?.trim()))];
  return uniqueSections.length > 0 ? uniqueSections.join("\n\n") : undefined;
}

export function transformProviderSystemPrompt(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderTransformSystemPromptContext;
}): string {
  const plugin = resolveProviderRuntimePlugin(params);
  const textTransforms = mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    plugin?.textTransforms,
  );
  const transformed =
    plugin?.transformSystemPrompt?.(params.context) ?? params.context.systemPrompt;
  return applyPluginTextReplacements(transformed, textTransforms?.input);
}

export function resolveProviderTextTransforms(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): PluginTextTransforms | undefined {
  return mergePluginTextTransforms(
    resolveRuntimeTextTransforms(),
    resolveProviderRuntimePlugin(params)?.textTransforms,
  );
}

export async function prepareProviderDynamicModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareDynamicModelContext;
}): Promise<void> {
  await resolveProviderRuntimePlugin(params)?.prepareDynamicModel?.(params.context);
}

export function shouldPreferProviderRuntimeResolvedModel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPreferRuntimeResolvedModelContext;
}): boolean {
  return (
    resolveProviderRuntimePlugin(params)?.preferRuntimeResolvedModel?.(params.context) ?? false
  );
}

export function normalizeProviderResolvedModelWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: {
    config?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    provider: string;
    modelId: string;
    model: ProviderRuntimeModel;
  };
}): ProviderRuntimeModel | undefined {
  return (
    resolveProviderRuntimePlugin(params)?.normalizeResolvedModel?.(params.context) ?? undefined
  );
}

function resolveProviderCompatHookPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): ProviderPlugin[] {
  const candidates = resolveProviderPluginsForHooks(params);
  const owner = resolveProviderRuntimePlugin(params);
  if (!owner) {
    return candidates;
  }

  const ordered = [owner, ...candidates];
  const seen = new Set<string>();
  return ordered.filter((candidate) => {
    const key = `${candidate.pluginId ?? ""}:${candidate.id}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function applyCompatPatchToModel(
  model: ProviderRuntimeModel,
  patch: Record<string, unknown>,
): ProviderRuntimeModel {
  const compat =
    model.compat && typeof model.compat === "object"
      ? (model.compat as Record<string, unknown>)
      : undefined;
  if (Object.entries(patch).every(([key, value]) => compat?.[key] === value)) {
    return model;
  }
  return {
    ...model,
    compat: {
      ...compat,
      ...patch,
    },
  };
}

export function applyProviderResolvedModelCompatWithPlugins(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined {
  let nextModel = params.context.model;
  let changed = false;

  for (const plugin of resolveProviderCompatHookPlugins(params)) {
    const patch = plugin.contributeResolvedModelCompat?.({
      ...params.context,
      model: nextModel,
    });
    if (!patch || typeof patch !== "object") {
      continue;
    }
    const patchedModel = applyCompatPatchToModel(nextModel, patch as Record<string, unknown>);
    if (patchedModel === nextModel) {
      continue;
    }
    nextModel = patchedModel;
    changed = true;
  }

  return changed ? nextModel : undefined;
}

export function applyProviderResolvedTransportWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeResolvedModelContext;
}): ProviderRuntimeModel | undefined {
  const normalized = normalizeProviderTransportWithPlugin({
    provider: params.provider,
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    context: {
      provider: params.context.provider,
      api: params.context.model.api,
      baseUrl: params.context.model.baseUrl,
    },
  });
  if (!normalized) {
    return undefined;
  }

  const nextApi = normalized.api ?? params.context.model.api;
  const nextBaseUrl = normalized.baseUrl ?? params.context.model.baseUrl;
  if (nextApi === params.context.model.api && nextBaseUrl === params.context.model.baseUrl) {
    return undefined;
  }

  return {
    ...params.context.model,
    api: nextApi as ProviderRuntimeModel["api"],
    baseUrl: nextBaseUrl,
  };
}

export function normalizeProviderModelIdWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeModelIdContext;
}): string | undefined {
  const plugin = resolveProviderHookPlugin(params);
  return normalizeOptionalString(plugin?.normalizeModelId?.(params.context));
}

export function normalizeProviderTransportWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeTransportContext;
}): { api?: string | null; baseUrl?: string } | undefined {
  const hasTransportChange = (normalized: { api?: string | null; baseUrl?: string }) =>
    (normalized.api ?? params.context.api) !== params.context.api ||
    (normalized.baseUrl ?? params.context.baseUrl) !== params.context.baseUrl;
  const matchedPlugin = resolveProviderHookPlugin(params);
  const normalizedMatched = matchedPlugin?.normalizeTransport?.(params.context);
  if (normalizedMatched && hasTransportChange(normalizedMatched)) {
    return normalizedMatched;
  }

  for (const candidate of resolveProviderPluginsForHooks(params)) {
    if (!candidate.normalizeTransport || candidate === matchedPlugin) {
      continue;
    }
    const normalized = candidate.normalizeTransport(params.context);
    if (normalized && hasTransportChange(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

export function normalizeProviderConfigWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeConfigContext;
}): ModelProviderConfig | undefined {
  const hasConfigChange = (normalized: ModelProviderConfig) =>
    normalized !== params.context.providerConfig;
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.normalizeConfig) {
    const normalized = bundledSurface.normalizeConfig(params.context);
    return normalized && hasConfigChange(normalized) ? normalized : undefined;
  }
  const matchedPlugin = resolveProviderHookPlugin(params);
  const normalizedMatched = matchedPlugin?.normalizeConfig?.(params.context);
  if (normalizedMatched && hasConfigChange(normalizedMatched)) {
    return normalizedMatched;
  }

  for (const candidate of resolveProviderPluginsForHooks(params)) {
    if (!candidate.normalizeConfig || candidate === matchedPlugin) {
      continue;
    }
    const normalized = candidate.normalizeConfig(params.context);
    if (normalized && hasConfigChange(normalized)) {
      return normalized;
    }
  }

  return undefined;
}

export function applyProviderNativeStreamingUsageCompatWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeConfigContext;
}): ModelProviderConfig | undefined {
  return (
    resolveProviderHookPlugin(params)?.applyNativeStreamingUsageCompat?.(params.context) ??
    undefined
  );
}

export function resolveProviderConfigApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveConfigApiKeyContext;
}): string | undefined {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.resolveConfigApiKey) {
    return normalizeOptionalString(bundledSurface.resolveConfigApiKey(params.context));
  }
  return normalizeOptionalString(
    resolveProviderHookPlugin(params)?.resolveConfigApiKey?.(params.context),
  );
}

export function resolveProviderReplayPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderReplayPolicyContext;
}): ProviderReplayPolicy | undefined {
  return resolveProviderHookPlugin(params)?.buildReplayPolicy?.(params.context) ?? undefined;
}

export async function sanitizeProviderReplayHistoryWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderSanitizeReplayHistoryContext;
}) {
  return await resolveProviderHookPlugin(params)?.sanitizeReplayHistory?.(params.context);
}

export async function validateProviderReplayTurnsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderValidateReplayTurnsContext;
}) {
  return await resolveProviderHookPlugin(params)?.validateReplayTurns?.(params.context);
}

export function normalizeProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeToolSchemasContext;
}) {
  return resolveProviderHookPlugin(params)?.normalizeToolSchemas?.(params.context) ?? undefined;
}

export function inspectProviderToolSchemasWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderNormalizeToolSchemasContext;
}) {
  return resolveProviderHookPlugin(params)?.inspectToolSchemas?.(params.context) ?? undefined;
}

export function resolveProviderReasoningOutputModeWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderReasoningOutputModeContext;
}): ProviderReasoningOutputMode | undefined {
  const mode = resolveProviderHookPlugin(params)?.resolveReasoningOutputMode?.(params.context);
  return mode === "native" || mode === "tagged" ? mode : undefined;
}

export function resolveProviderStreamFn(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCreateStreamFnContext;
}) {
  return resolveProviderRuntimePlugin(params)?.createStreamFn?.(params.context) ?? undefined;
}

export function resolveProviderTransportTurnStateWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveTransportTurnStateContext;
}): ProviderTransportTurnState | undefined {
  return (
    resolveProviderHookPlugin(params)?.resolveTransportTurnState?.(params.context) ?? undefined
  );
}

export function resolveProviderWebSocketSessionPolicyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveWebSocketSessionPolicyContext;
}): ProviderWebSocketSessionPolicy | undefined {
  return (
    resolveProviderHookPlugin(params)?.resolveWebSocketSessionPolicy?.(params.context) ?? undefined
  );
}

export async function createProviderEmbeddingProvider(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCreateEmbeddingProviderContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.createEmbeddingProvider?.(params.context);
}

export async function prepareProviderRuntimeAuth(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderPrepareRuntimeAuthContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.prepareRuntimeAuth?.(params.context);
}

export async function resolveProviderUsageAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveUsageAuthContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.resolveUsageAuth?.(params.context);
}

export async function resolveProviderUsageSnapshotWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFetchUsageSnapshotContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.fetchUsageSnapshot?.(params.context);
}

export function matchesProviderContextOverflowWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}): boolean {
  const plugins = params.provider
    ? [resolveProviderHookPlugin({ ...params, provider: params.provider })].filter(
        (plugin): plugin is ProviderPlugin => Boolean(plugin),
      )
    : resolveProviderPluginsForHooks(params);
  for (const plugin of plugins) {
    if (plugin.matchesContextOverflowError?.(params.context)) {
      return true;
    }
  }
  return false;
}

export function classifyProviderFailoverReasonWithPlugin(params: {
  provider?: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderFailoverErrorContext;
}) {
  const plugins = params.provider
    ? [resolveProviderHookPlugin({ ...params, provider: params.provider })].filter(
        (plugin): plugin is ProviderPlugin => Boolean(plugin),
      )
    : resolveProviderPluginsForHooks(params);
  for (const plugin of plugins) {
    const reason = plugin.classifyFailoverReason?.(params.context);
    if (reason) {
      return reason;
    }
  }
  return undefined;
}

export function formatProviderAuthProfileApiKeyWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: AuthProfileCredential;
}) {
  return resolveProviderRuntimePlugin(params)?.formatApiKey?.(params.context);
}

export async function refreshProviderOAuthCredentialWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: OAuthCredential;
}) {
  return await resolveProviderRuntimePlugin(params)?.refreshOAuth?.(params.context);
}

export async function buildProviderAuthDoctorHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAuthDoctorHintContext;
}) {
  return await resolveProviderRuntimePlugin(params)?.buildAuthDoctorHint?.(params.context);
}

export function resolveProviderCacheTtlEligibility(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderCacheTtlEligibilityContext;
}) {
  return resolveProviderRuntimePlugin(params)?.isCacheTtlEligible?.(params.context);
}

export function resolveProviderBinaryThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.isBinaryThinking?.(params.context);
}

export function resolveProviderXHighThinking(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderThinkingPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.supportsXHighThinking?.(params.context);
}

export function resolveProviderThinkingProfile(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDefaultThinkingPolicyContext;
}): ProviderThinkingProfile | null | undefined {
  return resolveProviderRuntimePlugin(params)?.resolveThinkingProfile?.(params.context);
}

export function resolveProviderDefaultThinkingLevel(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDefaultThinkingPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.resolveDefaultThinkingLevel?.(params.context);
}

export function applyProviderConfigDefaultsWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderApplyConfigDefaultsContext;
}) {
  const bundledSurface = resolveBundledProviderPolicySurface(params.provider);
  if (bundledSurface?.applyConfigDefaults) {
    return bundledSurface.applyConfigDefaults(params.context) ?? undefined;
  }
  return resolveProviderRuntimePlugin(params)?.applyConfigDefaults?.(params.context) ?? undefined;
}

export function resolveProviderModernModelRef(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderModernModelPolicyContext;
}) {
  return resolveProviderRuntimePlugin(params)?.isModernModelRef?.(params.context);
}

export function buildProviderMissingAuthMessageWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuildMissingAuthMessageContext;
}) {
  return (
    resolveProviderRuntimePlugin(params)?.buildMissingAuthMessage?.(params.context) ?? undefined
  );
}

export function buildProviderUnknownModelHintWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuildUnknownModelHintContext;
}) {
  return resolveProviderRuntimePlugin(params)?.buildUnknownModelHint?.(params.context) ?? undefined;
}

export function resolveProviderSyntheticAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveSyntheticAuthContext;
}) {
  const runtimeResolved = resolveProviderRuntimePlugin(params)?.resolveSyntheticAuth?.(
    params.context,
  );
  if (runtimeResolved) {
    return runtimeResolved;
  }
  return resolvePluginDiscoveryProvidersRuntime({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })
    .find((provider) => provider.id === params.provider)
    ?.resolveSyntheticAuth?.(params.context);
}

export function resolveExternalAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveExternalAuthProfilesContext;
}): ProviderExternalAuthProfile[] {
  const workspaceDir = params.workspaceDir ?? getActivePluginRegistryWorkspaceDirFromState();
  const env = params.env ?? process.env;
  const externalAuthPluginIds = resolveExternalAuthProfileProviderPluginIds({
    config: params.config,
    workspaceDir,
    env,
  });
  const declaredPluginIds = new Set(externalAuthPluginIds);
  const fallbackPluginIds = resolveExternalAuthProfileCompatFallbackPluginIds({
    config: params.config,
    workspaceDir,
    env,
    declaredPluginIds,
  });
  const pluginIds = [...new Set([...externalAuthPluginIds, ...fallbackPluginIds])].toSorted(
    (left, right) => left.localeCompare(right),
  );
  if (pluginIds.length === 0) {
    return [];
  }
  const matches: ProviderExternalAuthProfile[] = [];
  for (const plugin of resolveProviderPluginsForHooks({
    ...params,
    workspaceDir,
    env,
    onlyPluginIds: pluginIds,
  })) {
    const profiles =
      plugin.resolveExternalAuthProfiles?.(params.context) ??
      plugin.resolveExternalOAuthProfiles?.(params.context);
    if (!profiles || profiles.length === 0) {
      continue;
    }
    const pluginId = plugin.pluginId ?? plugin.id;
    if (!declaredPluginIds.has(pluginId) && !warnedExternalAuthFallbackPluginIds.has(pluginId)) {
      warnedExternalAuthFallbackPluginIds.add(pluginId);
      // Deprecated compatibility path for plugins that still implement
      // resolveExternalOAuthProfiles or omit contracts.externalAuthProviders.
      // Remove this warning with the fallback resolver after the migration window.
      log.warn(
        `Provider plugin "${sanitizeForLog(pluginId)}" uses external auth hooks without declaring contracts.externalAuthProviders. This compatibility fallback is deprecated and will be removed in a future release.`,
      );
    }
    matches.push(...profiles);
  }
  return matches;
}

export function resolveExternalOAuthProfilesWithPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderResolveExternalOAuthProfilesContext;
}): ProviderExternalAuthProfile[] {
  return resolveExternalAuthProfilesWithPlugins(params);
}

export function shouldDeferProviderSyntheticProfileAuthWithPlugin(params: {
  provider: string;
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderDeferSyntheticProfileAuthContext;
}) {
  return (
    resolveProviderRuntimePlugin(params)?.shouldDeferSyntheticProfileAuth?.(params.context) ??
    undefined
  );
}

export function resolveProviderBuiltInModelSuppression(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderBuiltInModelSuppressionContext;
}) {
  for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
    const result = plugin.suppressBuiltInModel?.(params.context);
    if (result?.suppress) {
      return result;
    }
  }
  return undefined;
}

export async function augmentModelCatalogWithProviderPlugins(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  context: ProviderAugmentModelCatalogContext;
}) {
  const supplemental = [] as ProviderAugmentModelCatalogContext["entries"];
  for (const plugin of resolveProviderPluginsForCatalogHooks(params)) {
    const next = await plugin.augmentModelCatalog?.(params.context);
    if (!next || next.length === 0) {
      continue;
    }
    supplemental.push(...next);
  }
  return supplemental;
}
