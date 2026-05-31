import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { CliBackendConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineHostCapability } from "../context-engine/types.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
} from "../plugins/setup-registry.js";
import { resolveRuntimeTextTransforms } from "../plugins/text-transforms.runtime.js";
import type {
  CliBackendAuthEpochMode,
  CliBackendNormalizeConfigContext,
  CliBundleMcpMode,
  CliBackendPlugin,
  CliBackendNativeToolMode,
  PluginTextTransforms,
} from "../plugins/types.js";
import { mergePluginTextTransforms } from "./plugin-text-transforms.js";

type CliBackendsDeps = {
  resolvePluginSetupCliBackend: typeof resolvePluginSetupCliBackend;
  resolvePluginSetupRegistry: typeof resolvePluginSetupRegistry;
  resolveRuntimeCliBackends: typeof resolveRuntimeCliBackends;
};

const defaultCliBackendsDeps: CliBackendsDeps = {
  resolvePluginSetupCliBackend,
  resolvePluginSetupRegistry,
  resolveRuntimeCliBackends,
};

let cliBackendsDeps: CliBackendsDeps = defaultCliBackendsDeps;

export type ResolvedCliBackend = {
  id: string;
  modelProvider?: string;
  config: CliBackendConfig;
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  pluginId?: string;
  transformSystemPrompt?: CliBackendPlugin["transformSystemPrompt"];
  textTransforms?: PluginTextTransforms;
  defaultAuthProfileId?: string;
  authEpochMode?: CliBackendAuthEpochMode;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  nativeToolMode?: CliBackendNativeToolMode;
};

type ResolvedCliBackendLiveTest = {
  defaultModelRef?: string;
  defaultImageProbe: boolean;
  defaultMcpProbe: boolean;
  dockerNpmPackage?: string;
  dockerBinaryName?: string;
};

export type CliRuntimeModelBackendBinding = {
  provider: string;
  runtime: string;
  pluginId?: string;
};

type FallbackCliBackendPolicy = {
  modelProvider?: string;
  bundleMcp: boolean;
  bundleMcpMode?: CliBundleMcpMode;
  baseConfig?: CliBackendConfig;
  normalizeConfig?: (
    config: CliBackendConfig,
    context?: CliBackendNormalizeConfigContext,
  ) => CliBackendConfig;
  transformSystemPrompt?: CliBackendPlugin["transformSystemPrompt"];
  textTransforms?: PluginTextTransforms;
  defaultAuthProfileId?: string;
  authEpochMode?: CliBackendAuthEpochMode;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  nativeToolMode?: CliBackendNativeToolMode;
};

const FALLBACK_CLI_BACKEND_POLICIES: Record<string, FallbackCliBackendPolicy> = {};

function normalizeBundleMcpMode(
  mode: CliBundleMcpMode | undefined,
  enabled: boolean,
): CliBundleMcpMode | undefined {
  if (!enabled) {
    return undefined;
  }
  return mode ?? "claude-config-file";
}

function resolveSetupCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  const entry = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: provider,
  });
  if (!entry) {
    return undefined;
  }
  return {
    // Setup-registered backends keep narrow CLI paths generic even when the
    // runtime plugin registry has not booted yet.
    bundleMcp: entry.backend.bundleMcp === true,
    modelProvider: resolveCliBackendModelProvider(entry.backend),
    bundleMcpMode: normalizeBundleMcpMode(
      entry.backend.bundleMcpMode,
      entry.backend.bundleMcp === true,
    ),
    baseConfig: entry.backend.config,
    normalizeConfig: entry.backend.normalizeConfig,
    transformSystemPrompt: entry.backend.transformSystemPrompt,
    textTransforms: entry.backend.textTransforms,
    defaultAuthProfileId: entry.backend.defaultAuthProfileId,
    authEpochMode: entry.backend.authEpochMode,
    contextEngineHostCapabilities: entry.backend.contextEngineHostCapabilities,
    prepareExecution: entry.backend.prepareExecution,
    resolveExecutionArgs: entry.backend.resolveExecutionArgs,
    nativeToolMode: entry.backend.nativeToolMode,
  };
}

function resolveFallbackCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  return FALLBACK_CLI_BACKEND_POLICIES[provider] ?? resolveSetupCliBackendPolicy(provider);
}

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
}

function pickBackendConfig(
  config: Record<string, CliBackendConfig>,
  normalizedId: string,
): CliBackendConfig | undefined {
  const directKey = Object.keys(config).find(
    (key) => normalizeOptionalLowercaseString(key) === normalizedId,
  );
  if (directKey) {
    return config[directKey];
  }
  for (const [key, entry] of Object.entries(config)) {
    if (normalizeBackendKey(key) === normalizedId) {
      return entry;
    }
  }
  return undefined;
}

function resolveRegisteredBackend(provider: string) {
  const normalized = normalizeBackendKey(provider);
  return cliBackendsDeps
    .resolveRuntimeCliBackends()
    .find((entry) => normalizeBackendKey(entry.id) === normalized);
}

function resolveCliBackendModelProvider(
  backend: Pick<CliBackendPlugin, "modelProvider">,
): string | undefined {
  const provider = backend.modelProvider?.trim();
  return provider ? normalizeProviderId(provider) : undefined;
}

function addCliRuntimeModelBinding(
  bindings: Map<string, CliRuntimeModelBackendBinding>,
  params: { backend: CliBackendPlugin; pluginId?: string },
): void {
  const provider = resolveCliBackendModelProvider(params.backend);
  const runtime = normalizeBackendKey(params.backend.id);
  if (!provider || !runtime) {
    return;
  }
  bindings.set(`${provider}:${runtime}`, {
    provider,
    runtime,
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
  });
}

export function listCliRuntimeModelBackendBindings(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): CliRuntimeModelBackendBinding[] {
  const bindings = new Map<string, CliRuntimeModelBackendBinding>();
  for (const backend of cliBackendsDeps.resolveRuntimeCliBackends()) {
    addCliRuntimeModelBinding(bindings, {
      backend,
      ...(backend.pluginId ? { pluginId: backend.pluginId } : {}),
    });
  }
  if (params.includeSetupRegistry === true) {
    for (const entry of cliBackendsDeps.resolvePluginSetupRegistry({
      config: params.config,
      env: params.env,
    }).cliBackends) {
      addCliRuntimeModelBinding(bindings, {
        backend: entry.backend,
        pluginId: entry.pluginId,
      });
    }
  }
  return [...bindings.values()].toSorted((left, right) =>
    left.provider === right.provider
      ? left.runtime.localeCompare(right.runtime)
      : left.provider.localeCompare(right.provider),
  );
}

export function listCliRuntimeProviderIds(
  params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    includeSetupRegistry?: boolean;
  } = {},
): string[] {
  // Only CLI backends with a canonical modelProvider are runtime aliases that
  // should be hidden from model-provider pickers. Standalone CLI backends own
  // direct refs such as acme-cli/model and must remain selectable.
  return [
    ...new Set(
      listCliRuntimeModelBackendBindings(params)
        .map((binding) => normalizeBackendKey(binding.runtime))
        .filter(Boolean),
    ),
  ].toSorted();
}

export function resolveCliRuntimeModelBackendBinding(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): CliRuntimeModelBackendBinding | undefined {
  const provider = normalizeProviderId(params.provider ?? "");
  const runtime = normalizeBackendKey(params.runtime ?? "");
  if (!provider || !runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) => binding.provider === provider && binding.runtime === runtime,
  );
  if (runtimeBinding) {
    return runtimeBinding;
  }
  const includeSetupRegistry = params.config !== undefined || params.env !== undefined;
  if (!includeSetupRegistry) {
    return undefined;
  }
  return listCliRuntimeModelBackendBindings({
    config: params.config,
    env: params.env,
    includeSetupRegistry: true,
  }).find((binding) => binding.provider === provider && binding.runtime === runtime);
}

export function isCliRuntimeModelBackendForProvider(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCliRuntimeModelBackendBinding(params) !== undefined;
}

function mergeBackendConfig(base: CliBackendConfig, override?: CliBackendConfig): CliBackendConfig {
  if (!override) {
    return { ...base };
  }
  const baseFresh = base.reliability?.watchdog?.fresh ?? {};
  const baseResume = base.reliability?.watchdog?.resume ?? {};
  const baseOutputLimits = base.reliability?.outputLimits ?? {};
  const overrideFresh = override.reliability?.watchdog?.fresh ?? {};
  const overrideResume = override.reliability?.watchdog?.resume ?? {};
  const overrideOutputLimits = override.reliability?.outputLimits ?? {};
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    modelAliases: { ...base.modelAliases, ...override.modelAliases },
    clearEnv: uniqueStrings([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])]),
    sessionIdFields: override.sessionIdFields ?? base.sessionIdFields,
    sessionArgs: override.sessionArgs ?? base.sessionArgs,
    resumeArgs: override.resumeArgs ?? base.resumeArgs,
    reliability: {
      ...base.reliability,
      ...override.reliability,
      outputLimits: {
        ...baseOutputLimits,
        ...overrideOutputLimits,
      },
      watchdog: {
        ...base.reliability?.watchdog,
        ...override.reliability?.watchdog,
        fresh: {
          ...baseFresh,
          ...overrideFresh,
        },
        resume: {
          ...baseResume,
          ...overrideResume,
        },
      },
    },
  };
}

export function resolveCliBackendLiveTest(provider: string): ResolvedCliBackendLiveTest | null {
  const normalized = normalizeBackendKey(provider);
  const entry =
    cliBackendsDeps.resolvePluginSetupCliBackend({ backend: normalized }) ??
    cliBackendsDeps
      .resolveRuntimeCliBackends()
      .find((backend) => normalizeBackendKey(backend.id) === normalized);
  if (!entry) {
    return null;
  }
  const backend = "backend" in entry ? entry.backend : entry;
  return {
    defaultModelRef: backend.liveTest?.defaultModelRef,
    defaultImageProbe: backend.liveTest?.defaultImageProbe === true,
    defaultMcpProbe: backend.liveTest?.defaultMcpProbe === true,
    dockerNpmPackage: backend.liveTest?.docker?.npmPackage,
    dockerBinaryName: backend.liveTest?.docker?.binaryName,
  };
}

export function resolveCliBackendConfig(
  provider: string,
  cfg?: OpenClawConfig,
  options: { agentId?: string } = {},
): ResolvedCliBackend | null {
  const normalized = normalizeBackendKey(provider);
  const normalizeContext: CliBackendNormalizeConfigContext = {
    backendId: normalized,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(cfg ? { config: cfg } : {}),
  };
  const runtimeTextTransforms = resolveRuntimeTextTransforms();
  const configured = cfg?.agents?.defaults?.cliBackends ?? {};
  const override = pickBackendConfig(configured, normalized);
  const registered = resolveRegisteredBackend(normalized);
  if (registered) {
    const merged = mergeBackendConfig(registered.config, override);
    const config = registered.normalizeConfig
      ? registered.normalizeConfig(merged, normalizeContext)
      : merged;
    const command = config.command?.trim();
    if (!command) {
      return null;
    }
    return {
      id: normalized,
      ...(registered.modelProvider
        ? { modelProvider: normalizeProviderId(registered.modelProvider) }
        : {}),
      config: { ...config, command },
      bundleMcp: registered.bundleMcp === true,
      bundleMcpMode: normalizeBundleMcpMode(
        registered.bundleMcpMode,
        registered.bundleMcp === true,
      ),
      pluginId: registered.pluginId,
      transformSystemPrompt: registered.transformSystemPrompt,
      textTransforms: mergePluginTextTransforms(runtimeTextTransforms, registered.textTransforms),
      defaultAuthProfileId: registered.defaultAuthProfileId,
      authEpochMode: registered.authEpochMode,
      contextEngineHostCapabilities: registered.contextEngineHostCapabilities,
      prepareExecution: registered.prepareExecution,
      resolveExecutionArgs: registered.resolveExecutionArgs,
      nativeToolMode: registered.nativeToolMode,
    };
  }

  const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
  if (!override) {
    if (!fallbackPolicy?.baseConfig) {
      return null;
    }
    const baseConfig = fallbackPolicy.normalizeConfig
      ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig, normalizeContext)
      : fallbackPolicy.baseConfig;
    const command = baseConfig.command?.trim();
    if (!command) {
      return null;
    }
    return {
      id: normalized,
      ...(fallbackPolicy.modelProvider ? { modelProvider: fallbackPolicy.modelProvider } : {}),
      config: { ...baseConfig, command },
      bundleMcp: fallbackPolicy.bundleMcp,
      bundleMcpMode: fallbackPolicy.bundleMcpMode,
      transformSystemPrompt: fallbackPolicy.transformSystemPrompt,
      textTransforms: mergePluginTextTransforms(
        runtimeTextTransforms,
        fallbackPolicy.textTransforms,
      ),
      defaultAuthProfileId: fallbackPolicy.defaultAuthProfileId,
      authEpochMode: fallbackPolicy.authEpochMode,
      contextEngineHostCapabilities: fallbackPolicy.contextEngineHostCapabilities,
      prepareExecution: fallbackPolicy.prepareExecution,
      resolveExecutionArgs: fallbackPolicy.resolveExecutionArgs,
      nativeToolMode: fallbackPolicy.nativeToolMode,
    };
  }
  const mergedFallback = fallbackPolicy?.baseConfig
    ? mergeBackendConfig(fallbackPolicy.baseConfig, override)
    : override;
  const config = fallbackPolicy?.normalizeConfig
    ? fallbackPolicy.normalizeConfig(mergedFallback, normalizeContext)
    : mergedFallback;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  return {
    id: normalized,
    ...(fallbackPolicy?.modelProvider ? { modelProvider: fallbackPolicy.modelProvider } : {}),
    config: { ...config, command },
    bundleMcp: fallbackPolicy?.bundleMcp === true,
    bundleMcpMode: fallbackPolicy?.bundleMcpMode,
    transformSystemPrompt: fallbackPolicy?.transformSystemPrompt,
    textTransforms: mergePluginTextTransforms(
      runtimeTextTransforms,
      fallbackPolicy?.textTransforms,
    ),
    defaultAuthProfileId: fallbackPolicy?.defaultAuthProfileId,
    authEpochMode: fallbackPolicy?.authEpochMode,
    contextEngineHostCapabilities: fallbackPolicy?.contextEngineHostCapabilities,
    prepareExecution: fallbackPolicy?.prepareExecution,
    resolveExecutionArgs: fallbackPolicy?.resolveExecutionArgs,
    nativeToolMode: fallbackPolicy?.nativeToolMode,
  };
}

export const testing = {
  resetDepsForTest(): void {
    cliBackendsDeps = defaultCliBackendsDeps;
  },
  setDepsForTest(deps: Partial<CliBackendsDeps>): void {
    cliBackendsDeps = {
      ...defaultCliBackendsDeps,
      ...deps,
    };
  },
} as const;
export { testing as __testing };
