import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/plugin-registry.js";
import { resolveBundledExplicitWebSearchProvidersFromPublicArtifacts } from "../plugins/web-provider-public-artifacts.explicit.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  analyzeCommandSecretAssignmentsFromSnapshot,
  collectCommandSecretAssignmentsFromSnapshot,
  type CommandSecretAssignment,
} from "./command-config.js";
import { getPath, setPathExistingStrict } from "./path-utils.js";
import { resolveSecretRefValue } from "./resolve.js";
import { createResolverContext } from "./runtime-shared.js";
import { getActiveSecretsRuntimeEnv, getActiveSecretsRuntimeSnapshot } from "./runtime-state.js";
import { resolveRuntimeWebTools } from "./runtime-web-tools.js";
import { assertExpectedResolvedSecretValue } from "./secret-value.js";
import { discoverConfigSecretTargetsByIds } from "./target-registry.js";

export type { CommandSecretAssignment } from "./command-config.js";

export type CommandSecretProviderOverrides = {
  webSearch?: string;
  webFetch?: string;
};

function hasProviderOverrides(overrides: CommandSecretProviderOverrides | undefined): boolean {
  return (
    normalizeOptionalString(overrides?.webSearch) !== undefined ||
    normalizeOptionalString(overrides?.webFetch) !== undefined
  );
}

function applyProviderOverridesToConfig(
  config: OpenClawConfig,
  overrides: CommandSecretProviderOverrides | undefined,
): OpenClawConfig {
  if (!hasProviderOverrides(overrides)) {
    return config;
  }
  const next = structuredClone(config);
  const tools = (next.tools ??= {}) as Record<string, unknown>;
  const web = (tools.web ??= {}) as Record<string, unknown>;
  const webSearch = normalizeOptionalString(overrides?.webSearch);
  if (webSearch) {
    const search = (web.search ??= {}) as Record<string, unknown>;
    search.provider = webSearch;
  }
  const webFetch = normalizeOptionalString(overrides?.webFetch);
  if (webFetch) {
    const fetch = (web.fetch ??= {}) as Record<string, unknown>;
    fetch.provider = webFetch;
  }
  return next;
}

function pluginIdFromRuntimeWebPath(path: string): string | undefined {
  return /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(path)?.[1];
}

function searchProviderFromDirectWebPath(path: string): string | undefined {
  return /^tools\.web\.search\.([^.]+)\.apiKey$/.exec(path)?.[1];
}

function fetchProviderFromDirectWebPath(path: string): string | undefined {
  return /^tools\.web\.fetch\.([^.]+)\.apiKey$/.exec(path)?.[1];
}

function isWebCommandSecretPath(path: string): boolean {
  return (
    path === "tools.web.search.apiKey" ||
    /^tools\.web\.(search|fetch)\.[^.]+\.apiKey$/.test(path) ||
    /^plugins\.entries\.[^.]+\.config\.(webSearch|webFetch)\.apiKey$/.test(path)
  );
}

function webSearchProviderUsesSharedSearchCredential(params: {
  config: OpenClawConfig;
  provider: string;
}): boolean {
  const sentinel = "__openclaw_shared_web_search_probe__";
  const pluginId = resolveManifestContractOwnerPluginId({
    contract: "webSearchProviders",
    value: params.provider,
    origin: "bundled",
    config: params.config,
  });
  if (!pluginId) {
    return false;
  }
  const providers = resolveBundledExplicitWebSearchProvidersFromPublicArtifacts({
    onlyPluginIds: [pluginId],
  });
  const provider = providers?.find((entry) => entry.id === params.provider);
  return (
    provider?.credentialPath === "tools.web.search.apiKey" ||
    provider?.getCredentialValue({ apiKey: sentinel }) === sentinel ||
    provider?.getConfiguredCredentialFallback?.(params.config)?.path === "tools.web.search.apiKey"
  );
}

function isProviderOverridePath(params: {
  config: OpenClawConfig;
  path: string;
  providerOverrides: CommandSecretProviderOverrides | undefined;
}): boolean {
  const webSearch = normalizeOptionalString(params.providerOverrides?.webSearch);
  if (webSearch) {
    if (params.config.tools?.web?.search?.enabled === false) {
      return false;
    }
    if (params.path === "tools.web.search.apiKey") {
      return webSearchProviderUsesSharedSearchCredential({
        config: params.config,
        provider: webSearch,
      });
    }
    const directProvider = searchProviderFromDirectWebPath(params.path);
    if (directProvider) {
      return directProvider === webSearch;
    }
    const pluginId = pluginIdFromRuntimeWebPath(params.path);
    if (pluginId && params.path.endsWith(".config.webSearch.apiKey")) {
      return (
        resolveManifestContractOwnerPluginId({
          contract: "webSearchProviders",
          value: webSearch,
          origin: "bundled",
          config: params.config,
        }) === pluginId
      );
    }
  }

  const webFetch = normalizeOptionalString(params.providerOverrides?.webFetch);
  if (webFetch) {
    if (params.config.tools?.web?.fetch?.enabled === false) {
      return false;
    }
    const directProvider = fetchProviderFromDirectWebPath(params.path);
    if (directProvider) {
      return directProvider === webFetch;
    }
    const pluginId = pluginIdFromRuntimeWebPath(params.path);
    if (pluginId && params.path.endsWith(".config.webFetch.apiKey")) {
      return (
        resolveManifestContractOwnerPluginId({
          contract: "webFetchProviders",
          value: webFetch,
          origin: "bundled",
          config: params.config,
        }) === pluginId
      );
    }
  }

  return false;
}

function restoreInactiveWebCommandSecretTargets(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  targetIds: ReadonlySet<string>;
  inactiveRefPaths: string[];
  providerOverrides: CommandSecretProviderOverrides | undefined;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
}): string[] {
  if (!hasProviderOverrides(params.providerOverrides)) {
    return params.inactiveRefPaths;
  }
  const inactive = new Set(params.inactiveRefPaths);
  const defaults = params.sourceConfig.secrets?.defaults;
  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    if (!isWebCommandSecretPath(target.path)) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (!ref) {
      continue;
    }
    if (
      params.forcedActivePaths?.has(target.path) ||
      params.optionalActivePaths?.has(target.path)
    ) {
      continue;
    }
    if (
      isProviderOverridePath({
        config: params.sourceConfig,
        path: target.path,
        providerOverrides: params.providerOverrides,
      })
    ) {
      continue;
    }
    inactive.add(target.path);
    setPathExistingStrict(params.resolvedConfig, target.pathSegments, target.value);
  }
  return [...inactive];
}

function filterInactiveRefPaths(params: {
  config: OpenClawConfig;
  inactiveRefPaths: readonly string[];
  providerOverrides: CommandSecretProviderOverrides | undefined;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
}): string[] {
  return params.inactiveRefPaths.filter((path) => {
    if (params.allowedPaths && !params.allowedPaths.has(path)) {
      return false;
    }
    if (params.forcedActivePaths?.has(path) || params.optionalActivePaths?.has(path)) {
      return false;
    }
    if (!hasProviderOverrides(params.providerOverrides)) {
      return true;
    }
    return !isProviderOverridePath({
      config: params.config,
      path,
      providerOverrides: params.providerOverrides,
    });
  });
}

function mirrorResolvedProviderCredentialToDirectPath(params: {
  config: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  contract: "webSearchProviders" | "webFetchProviders";
  provider: string | undefined;
  directPathPrefix: string;
  pluginConfigKey: "webSearch" | "webFetch";
}): void {
  const provider = normalizeOptionalString(params.provider);
  if (!provider) {
    return;
  }
  const pluginId = resolveManifestContractOwnerPluginId({
    contract: params.contract,
    value: provider,
    origin: "bundled",
    config: params.config,
  });
  if (!pluginId) {
    return;
  }
  const directSegments = [...params.directPathPrefix.split("."), provider, "apiKey"];
  const directValue = getPath(params.config, directSegments);
  if (directValue === undefined) {
    return;
  }
  const resolvedValue = getPath(params.resolvedConfig, [
    "plugins",
    "entries",
    pluginId,
    "config",
    params.pluginConfigKey,
    "apiKey",
  ]);
  if (typeof resolvedValue !== "string" || resolvedValue.length === 0) {
    return;
  }
  setPathExistingStrict(params.resolvedConfig, directSegments, resolvedValue);
}

function mirrorResolvedProviderCredentialToDirectPaths(params: {
  config: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  providerOverrides: CommandSecretProviderOverrides | undefined;
}): void {
  const configuredSearchProvider =
    normalizeOptionalString(params.providerOverrides?.webSearch) ??
    normalizeOptionalString(params.config.tools?.web?.search?.provider);
  const configuredFetchProvider =
    normalizeOptionalString(params.providerOverrides?.webFetch) ??
    normalizeOptionalString(params.config.tools?.web?.fetch?.provider);
  mirrorResolvedProviderCredentialToDirectPath({
    config: params.config,
    resolvedConfig: params.resolvedConfig,
    contract: "webSearchProviders",
    provider: configuredSearchProvider,
    directPathPrefix: "tools.web.search",
    pluginConfigKey: "webSearch",
  });
  mirrorResolvedProviderCredentialToDirectPath({
    config: params.config,
    resolvedConfig: params.resolvedConfig,
    contract: "webFetchProviders",
    provider: configuredFetchProvider,
    directPathPrefix: "tools.web.fetch",
    pluginConfigKey: "webFetch",
  });
  const webSearch = configuredSearchProvider;
  if (
    webSearch &&
    webSearchProviderUsesSharedSearchCredential({
      config: params.config,
      provider: webSearch,
    }) &&
    getPath(params.config, ["tools", "web", "search", "apiKey"]) !== undefined
  ) {
    const pluginId = resolveManifestContractOwnerPluginId({
      contract: "webSearchProviders",
      value: webSearch,
      origin: "bundled",
      config: params.config,
    });
    const resolvedValue = pluginId
      ? getPath(params.resolvedConfig, [
          "plugins",
          "entries",
          pluginId,
          "config",
          "webSearch",
          "apiKey",
        ])
      : undefined;
    if (typeof resolvedValue === "string" && resolvedValue.length > 0) {
      setPathExistingStrict(
        params.resolvedConfig,
        ["tools", "web", "search", "apiKey"],
        resolvedValue,
      );
    }
  }
}

async function resolveForcedActiveCommandSecretTargets(params: {
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  targetIds: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
}): Promise<void> {
  const activePaths = new Set([
    ...(params.forcedActivePaths ?? []),
    ...(params.optionalActivePaths ?? []),
  ]);
  if (activePaths.size === 0) {
    return;
  }
  const context = createResolverContext({
    sourceConfig: params.sourceConfig,
    env: getActiveSecretsRuntimeEnv(),
  });
  const defaults = params.sourceConfig.secrets?.defaults;
  for (const target of discoverConfigSecretTargetsByIds(params.sourceConfig, params.targetIds)) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    if (!activePaths.has(target.path)) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (!ref) {
      continue;
    }
    try {
      const resolved = await resolveSecretRefValue(ref, {
        config: params.sourceConfig,
        env: context.env,
        cache: context.cache,
      });
      assertExpectedResolvedSecretValue({
        value: resolved,
        expected: target.entry.expectedResolvedValue,
        errorMessage:
          target.entry.expectedResolvedValue === "string"
            ? `${target.path} resolved to a non-string or empty value.`
            : `${target.path} resolved to an unsupported value type.`,
      });
      setPathExistingStrict(params.resolvedConfig, target.pathSegments, resolved);
    } catch {
      // Leave unresolved; the CLI can still attempt local fallback for incomplete gateway snapshots.
    }
  }
}

export function resolveCommandSecretsFromActiveRuntimeSnapshot(params: {
  commandName: string;
  targetIds: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  providerOverrides?: CommandSecretProviderOverrides;
}): Promise<{
  assignments: CommandSecretAssignment[];
  diagnostics: string[];
  inactiveRefPaths: string[];
}> {
  const activeSnapshot = getActiveSecretsRuntimeSnapshot();
  if (!activeSnapshot) {
    throw new Error("Secrets runtime snapshot is not active.");
  }
  if (params.targetIds.size === 0) {
    return Promise.resolve({ assignments: [], diagnostics: [], inactiveRefPaths: [] });
  }
  return resolveCommandSecretsFromSnapshot({
    activeSnapshot,
    commandName: params.commandName,
    targetIds: params.targetIds,
    allowedPaths: params.allowedPaths,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
    providerOverrides: params.providerOverrides,
  });
}

async function resolveCommandSecretsFromSnapshot(params: {
  activeSnapshot: NonNullable<ReturnType<typeof getActiveSecretsRuntimeSnapshot>>;
  commandName: string;
  targetIds: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
  forcedActivePaths?: ReadonlySet<string>;
  optionalActivePaths?: ReadonlySet<string>;
  providerOverrides?: CommandSecretProviderOverrides;
}): Promise<{
  assignments: CommandSecretAssignment[];
  diagnostics: string[];
  inactiveRefPaths: string[];
}> {
  const hasOverrides = hasProviderOverrides(params.providerOverrides);
  const sourceConfig = applyProviderOverridesToConfig(
    params.activeSnapshot.sourceConfig,
    params.providerOverrides,
  );
  const resolvedConfig = applyProviderOverridesToConfig(
    params.activeSnapshot.config,
    params.providerOverrides,
  );
  const context = hasOverrides
    ? createResolverContext({
        sourceConfig,
        env: getActiveSecretsRuntimeEnv(),
      })
    : undefined;
  if (context) {
    await resolveRuntimeWebTools({
      sourceConfig,
      resolvedConfig,
      context,
    });
  }
  mirrorResolvedProviderCredentialToDirectPaths({
    config: sourceConfig,
    resolvedConfig,
    providerOverrides: params.providerOverrides,
  });
  await resolveForcedActiveCommandSecretTargets({
    sourceConfig,
    resolvedConfig,
    targetIds: params.targetIds,
    allowedPaths: params.allowedPaths,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
  });

  const warningSource = context?.warnings ?? params.activeSnapshot.warnings;
  let inactiveRefPaths = filterInactiveRefPaths({
    config: sourceConfig,
    providerOverrides: params.providerOverrides,
    allowedPaths: params.allowedPaths,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
    inactiveRefPaths: [
      ...new Set(
        warningSource
          .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
          .map((warning) => warning.path),
      ),
    ],
  });
  inactiveRefPaths = restoreInactiveWebCommandSecretTargets({
    sourceConfig,
    resolvedConfig,
    targetIds: params.targetIds,
    inactiveRefPaths,
    providerOverrides: params.providerOverrides,
    allowedPaths: params.allowedPaths,
    forcedActivePaths: params.forcedActivePaths,
    optionalActivePaths: params.optionalActivePaths,
  });

  let analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
    sourceConfig,
    resolvedConfig,
    targetIds: params.targetIds,
    inactiveRefPaths: new Set(inactiveRefPaths),
    ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
  });
  if (hasOverrides) {
    const impliedInactivePaths = analyzed.unresolved
      .filter((entry) => isWebCommandSecretPath(entry.path))
      .filter(
        (entry) =>
          !isProviderOverridePath({
            config: sourceConfig,
            path: entry.path,
            providerOverrides: params.providerOverrides,
          }),
      )
      .map((entry) => entry.path);
    if (impliedInactivePaths.length > 0) {
      inactiveRefPaths = [...new Set([...inactiveRefPaths, ...impliedInactivePaths])];
      analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
        sourceConfig,
        resolvedConfig,
        targetIds: params.targetIds,
        inactiveRefPaths: new Set(inactiveRefPaths),
        ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
      });
    }
  }
  const optionalActiveUnresolvedPaths = analyzed.unresolved
    .filter((entry) => params.optionalActivePaths?.has(entry.path))
    .map((entry) => entry.path);
  if (optionalActiveUnresolvedPaths.length > 0) {
    inactiveRefPaths = [...new Set([...inactiveRefPaths, ...optionalActiveUnresolvedPaths])];
    analyzed = analyzeCommandSecretAssignmentsFromSnapshot({
      sourceConfig,
      resolvedConfig,
      targetIds: params.targetIds,
      inactiveRefPaths: new Set(inactiveRefPaths),
      ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
    });
  }
  const selectedProviderUnresolved = analyzed.unresolved.filter((entry) =>
    isProviderOverridePath({
      config: sourceConfig,
      path: entry.path,
      providerOverrides: params.providerOverrides,
    }),
  );
  const forcedActiveUnresolved = analyzed.unresolved.filter((entry) =>
    params.forcedActivePaths?.has(entry.path),
  );
  if (selectedProviderUnresolved.length > 0 || forcedActiveUnresolved.length > 0) {
    return {
      assignments: analyzed.assignments,
      diagnostics: analyzed.diagnostics,
      inactiveRefPaths,
    };
  }
  const resolved = collectCommandSecretAssignmentsFromSnapshot({
    sourceConfig,
    resolvedConfig,
    commandName: params.commandName,
    targetIds: params.targetIds,
    inactiveRefPaths: new Set(inactiveRefPaths),
    ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
  });
  return {
    assignments: resolved.assignments,
    diagnostics: resolved.diagnostics,
    inactiveRefPaths,
  };
}
