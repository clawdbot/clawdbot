/**
 * Resolves CLI runtime backends registered by plugins or setup metadata.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ContextEngineHostCapability } from "../context-engine/types.js";
import type {
  CliBackendConfig,
  CliBackendRuntimeArtifactPolicy,
} from "../plugins/cli-backend.types.js";
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
  CliBackendSideQuestionToolMode,
  CliBackendToolAvailabilityEnforcement,
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

/** Fully merged CLI backend definition used by agent runner execution. */
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
  autoSelectAuthProfile?: boolean;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  ownsNativeCompaction?: boolean;
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  toolAvailabilityEnforcement?: CliBackendToolAvailabilityEnforcement;
  nativeToolMode?: CliBackendNativeToolMode;
  sideQuestionToolMode?: CliBackendSideQuestionToolMode;
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
};

type ResolvedCliBackendLiveTest = {
  defaultModelRef?: string;
  defaultImageProbe: boolean;
  defaultMcpProbe: boolean;
  dockerNpmPackage?: string;
  dockerBinaryName?: string;
};

/** Binding between a model provider and the CLI runtime that serves it. */
type CliRuntimeModelBackendBinding = {
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
  autoSelectAuthProfile?: boolean;
  contextEngineHostCapabilities?: readonly ContextEngineHostCapability[];
  ownsNativeCompaction?: boolean;
  prepareExecution?: CliBackendPlugin["prepareExecution"];
  resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
  toolAvailabilityEnforcement?: CliBackendToolAvailabilityEnforcement;
  nativeToolMode?: CliBackendNativeToolMode;
  sideQuestionToolMode?: CliBackendSideQuestionToolMode;
  runtimeArtifact?: CliBackendRuntimeArtifactPolicy;
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

function resolveToolAvailabilityEnforcement(
  backend: Pick<
    CliBackendPlugin,
    "nativeToolMode" | "resolveExecutionArgs" | "toolAvailabilityEnforcement"
  > & { builtWithOpenClawVersion?: string },
): CliBackendToolAvailabilityEnforcement | undefined {
  if (backend.toolAvailabilityEnforcement) {
    return backend.toolAvailabilityEnforcement;
  }
  // v2026.7.2-beta.1 through .3 made selectable + resolveExecutionArgs the
  // public enforcement contract. Require matching package build provenance so
  // a new no-op hook cannot be mistaken for that shipped SDK path.
  const builtWith = backend.builtWithOpenClawVersion?.replace(/^v/u, "");
  const isShippedBetaContract = /^2026\.7\.2-beta\.[123]$/u.test(builtWith ?? "");
  return isShippedBetaContract &&
    backend.nativeToolMode === "selectable" &&
    backend.resolveExecutionArgs
    ? "execution-args"
    : undefined;
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
    autoSelectAuthProfile: entry.backend.autoSelectAuthProfile,
    contextEngineHostCapabilities: entry.backend.contextEngineHostCapabilities,
    ownsNativeCompaction: entry.backend.ownsNativeCompaction,
    prepareExecution: entry.backend.prepareExecution,
    resolveExecutionArgs: entry.backend.resolveExecutionArgs,
    toolAvailabilityEnforcement: entry.backend.toolAvailabilityEnforcement,
    nativeToolMode: entry.backend.nativeToolMode,
    sideQuestionToolMode: entry.backend.sideQuestionToolMode,
    runtimeArtifact: entry.backend.runtimeArtifact,
  };
}

function resolveFallbackCliBackendPolicy(provider: string): FallbackCliBackendPolicy | undefined {
  return FALLBACK_CLI_BACKEND_POLICIES[provider] ?? resolveSetupCliBackendPolicy(provider);
}

function normalizeBackendKey(key: string): string {
  return normalizeProviderId(key);
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

/** Lists model-provider to CLI-runtime bindings from runtime and optional setup registries. */
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

/** Lists CLI runtime ids that alias canonical model providers. */
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

/** Resolves the canonical model provider served by a CLI runtime id. */
export function resolveCliRuntimeCanonicalProvider(params: {
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  includeSetupRegistry?: boolean;
}): string | undefined {
  const runtime = normalizeBackendKey(params.runtime ?? "");
  if (!runtime) {
    return undefined;
  }
  const runtimeBinding = listCliRuntimeModelBackendBindings().find(
    (binding) => binding.runtime === runtime,
  );
  if (runtimeBinding) {
    return runtimeBinding.provider;
  }
  if (params.includeSetupRegistry !== true) {
    return undefined;
  }
  const setupBackend = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  return setupBackend ? resolveCliBackendModelProvider(setupBackend.backend) : undefined;
}

/** Resolves the binding for one provider/runtime pair when registered. */
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
  const setupBackend = cliBackendsDeps.resolvePluginSetupCliBackend({
    backend: runtime,
    config: params.config,
    env: params.env,
  });
  if (!setupBackend) {
    return undefined;
  }
  const setupProvider = resolveCliBackendModelProvider(setupBackend.backend);
  return setupProvider === provider
    ? {
        provider,
        runtime,
        ...(setupBackend.pluginId ? { pluginId: setupBackend.pluginId } : {}),
      }
    : undefined;
}

/** Checks whether a runtime is registered to serve a model provider. */
export function isCliRuntimeModelBackendForProvider(params: {
  provider: string | undefined;
  runtime: string | undefined;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  return resolveCliRuntimeModelBackendBinding(params) !== undefined;
}

/** Resolves live-test defaults advertised by a CLI backend plugin. */
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

/** Resolves the executable CLI backend registered by its owning plugin. */
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
  const registered = resolveRegisteredBackend(normalized);
  if (registered) {
    const registeredConfig = { ...registered.config };
    const config = registered.normalizeConfig
      ? registered.normalizeConfig(registeredConfig, normalizeContext)
      : registeredConfig;
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
      autoSelectAuthProfile: registered.autoSelectAuthProfile,
      contextEngineHostCapabilities: registered.contextEngineHostCapabilities,
      ownsNativeCompaction: registered.ownsNativeCompaction,
      prepareExecution: registered.prepareExecution,
      resolveExecutionArgs: registered.resolveExecutionArgs,
      toolAvailabilityEnforcement: resolveToolAvailabilityEnforcement(registered),
      nativeToolMode: registered.nativeToolMode,
      sideQuestionToolMode: registered.sideQuestionToolMode,
      runtimeArtifact: registered.runtimeArtifact,
    };
  }

  const fallbackPolicy = resolveFallbackCliBackendPolicy(normalized);
  if (!fallbackPolicy?.baseConfig) {
    return null;
  }
  const config = fallbackPolicy.normalizeConfig
    ? fallbackPolicy.normalizeConfig(fallbackPolicy.baseConfig, normalizeContext)
    : fallbackPolicy.baseConfig;
  const command = config.command?.trim();
  if (!command) {
    return null;
  }
  return {
    id: normalized,
    ...(fallbackPolicy.modelProvider ? { modelProvider: fallbackPolicy.modelProvider } : {}),
    config: { ...config, command },
    bundleMcp: fallbackPolicy.bundleMcp,
    bundleMcpMode: fallbackPolicy.bundleMcpMode,
    transformSystemPrompt: fallbackPolicy.transformSystemPrompt,
    textTransforms: mergePluginTextTransforms(runtimeTextTransforms, fallbackPolicy.textTransforms),
    defaultAuthProfileId: fallbackPolicy.defaultAuthProfileId,
    authEpochMode: fallbackPolicy.authEpochMode,
    autoSelectAuthProfile: fallbackPolicy.autoSelectAuthProfile,
    contextEngineHostCapabilities: fallbackPolicy.contextEngineHostCapabilities,
    ownsNativeCompaction: fallbackPolicy.ownsNativeCompaction,
    prepareExecution: fallbackPolicy.prepareExecution,
    resolveExecutionArgs: fallbackPolicy.resolveExecutionArgs,
    toolAvailabilityEnforcement: fallbackPolicy.toolAvailabilityEnforcement,
    nativeToolMode: fallbackPolicy.nativeToolMode,
    sideQuestionToolMode: fallbackPolicy.sideQuestionToolMode,
    runtimeArtifact: fallbackPolicy.runtimeArtifact,
  };
}

/** Test-only dependency controls for CLI backend registry resolution. */
const testing = {
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

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.cliBackendsTestApi")] = testing;
}
