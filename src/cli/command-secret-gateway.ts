import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSecretInputRef } from "../config/types.secrets.js";
import { callGateway } from "../gateway/call.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../gateway/protocol/client-info.js";
import { validateSecretsResolveResult } from "../gateway/protocol/index.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveManifestContractOwnerPluginId } from "../plugins/manifest-registry.js";
import {
  analyzeCommandSecretAssignmentsFromSnapshot,
  type UnresolvedCommandSecretAssignment,
} from "../secrets/command-config.js";
import { getPath, setPathExistingStrict } from "../secrets/path-utils.js";
import { resolveSecretRefValue } from "../secrets/resolve.js";
import { collectConfigAssignments } from "../secrets/runtime-config-collectors.js";
import { createResolverContext } from "../secrets/runtime-shared.js";
import { resolveRuntimeWebTools } from "../secrets/runtime-web-tools.js";
import { assertExpectedResolvedSecretValue } from "../secrets/secret-value.js";
import {
  discoverConfigSecretTargetsByIds,
  type DiscoveredConfigSecretTarget,
} from "../secrets/target-registry.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

type ResolveCommandSecretsResult = {
  resolvedConfig: OpenClawConfig;
  diagnostics: string[];
  targetStatesByPath: Record<string, CommandSecretTargetState>;
  hadUnresolvedTargets: boolean;
};

export type CommandSecretResolutionMode =
  | "enforce_resolved"
  | "read_only_status"
  | "read_only_operational";

type LegacyCommandSecretResolutionMode = "strict" | "summary" | "operational_readonly"; // pragma: allowlist secret

type CommandSecretResolutionModeInput =
  | CommandSecretResolutionMode
  | LegacyCommandSecretResolutionMode;

export type CommandSecretTargetState =
  | "resolved_gateway"
  | "resolved_local"
  | "inactive_surface"
  | "unresolved";

type GatewaySecretsResolveResult = {
  ok?: boolean;
  assignments?: Array<{
    path?: string;
    pathSegments: string[];
    value: unknown;
  }>;
  diagnostics?: string[];
  inactiveRefPaths?: string[];
};

const WEB_RUNTIME_SECRET_TARGET_ID_PREFIXES = ["tools.web.search", "plugins.entries."] as const;
const WEB_RUNTIME_SECRET_PATH_PREFIXES = ["tools.web.search.", "plugins.entries."] as const;

type CommandSecretGatewayDeps = {
  analyzeCommandSecretAssignmentsFromSnapshot: typeof analyzeCommandSecretAssignmentsFromSnapshot;
  collectConfigAssignments: typeof collectConfigAssignments;
  discoverConfigSecretTargetsByIds: typeof discoverConfigSecretTargetsByIds;
  resolveManifestContractOwnerPluginId: typeof resolveManifestContractOwnerPluginId;
  resolveRuntimeWebTools: typeof resolveRuntimeWebTools;
};

const commandSecretGatewayDeps: CommandSecretGatewayDeps = {
  analyzeCommandSecretAssignmentsFromSnapshot,
  collectConfigAssignments,
  discoverConfigSecretTargetsByIds,
  resolveManifestContractOwnerPluginId,
  resolveRuntimeWebTools,
};

export const __testing = {
  setDepsForTest(overrides: Partial<CommandSecretGatewayDeps>): () => void {
    const previous = { ...commandSecretGatewayDeps };
    Object.assign(commandSecretGatewayDeps, overrides);
    return () => {
      Object.assign(commandSecretGatewayDeps, previous);
    };
  },
  resetDepsForTest(): void {
    Object.assign(commandSecretGatewayDeps, {
      analyzeCommandSecretAssignmentsFromSnapshot,
      collectConfigAssignments,
      discoverConfigSecretTargetsByIds,
      resolveManifestContractOwnerPluginId,
      resolveRuntimeWebTools,
    });
  },
};

function pluginIdFromRuntimeWebPath(path: string): string | undefined {
  const match = /^plugins\.entries\.([^.]+)\.config\.(webSearch|webFetch)\.apiKey$/.exec(path);
  return match?.[1];
}

function normalizeCommandSecretResolutionMode(
  mode?: CommandSecretResolutionModeInput,
): CommandSecretResolutionMode {
  if (!mode || mode === "enforce_resolved" || mode === "strict") {
    return "enforce_resolved";
  }
  if (mode === "read_only_status" || mode === "summary") {
    return "read_only_status";
  }
  return "read_only_operational";
}

function enforcesResolvedSecrets(mode: CommandSecretResolutionMode): boolean {
  return mode === "enforce_resolved";
}

function dedupeDiagnostics(entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    ordered.push(trimmed);
  }
  return ordered;
}

function targetsRuntimeWebPath(path: string): boolean {
  return WEB_RUNTIME_SECRET_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

function classifyRuntimeWebTargetPathState(params: {
  config: OpenClawConfig;
  path: string;
}): "active" | "inactive" | "unknown" {
  if (params.path === "tools.web.search.apiKey") {
    return params.config.tools?.web?.search?.enabled !== false ? "active" : "inactive";
  }

  const pluginId = pluginIdFromRuntimeWebPath(params.path);
  if (pluginId) {
    if (params.path.endsWith(".config.webFetch.apiKey")) {
      const fetch = params.config.tools?.web?.fetch;
      if (fetch?.enabled === false) {
        return "inactive";
      }
      const configuredProvider = normalizeLowercaseStringOrEmpty(fetch?.provider);
      if (!configuredProvider) {
        return "active";
      }
      return commandSecretGatewayDeps.resolveManifestContractOwnerPluginId({
        contract: "webFetchProviders",
        value: configuredProvider,
        origin: "bundled",
        config: params.config,
      }) === pluginId
        ? "active"
        : "inactive";
    }
    const search = params.config.tools?.web?.search;
    if (search?.enabled === false) {
      return "inactive";
    }
    const configuredProvider = normalizeLowercaseStringOrEmpty(search?.provider);
    if (!configuredProvider) {
      return "active";
    }
    return commandSecretGatewayDeps.resolveManifestContractOwnerPluginId({
      contract: "webSearchProviders",
      value: configuredProvider,
      origin: "bundled",
      config: params.config,
    }) === pluginId
      ? "active"
      : "inactive";
  }

  const match = /^tools\.web\.search\.([^.]+)\.apiKey$/.exec(params.path);
  if (!match) {
    return "unknown";
  }

  const search = params.config.tools?.web?.search;
  if (search?.enabled === false) {
    return "inactive";
  }

  const configuredProvider = normalizeLowercaseStringOrEmpty(search?.provider);
  if (!configuredProvider) {
    return "active";
  }

  return configuredProvider === match[1] ? "active" : "inactive";
}

function describeInactiveRuntimeWebTargetPath(params: {
  config: OpenClawConfig;
  path: string;
}): string | undefined {
  if (params.path === "tools.web.search.apiKey") {
    return params.config.tools?.web?.search?.enabled === false
      ? "tools.web.search is disabled."
      : undefined;
  }

  const pluginId = pluginIdFromRuntimeWebPath(params.path);
  if (pluginId) {
    if (params.path.endsWith(".config.webFetch.apiKey")) {
      const fetch = params.config.tools?.web?.fetch;
      if (fetch?.enabled === false) {
        return "tools.web.fetch is disabled.";
      }
      const configuredProvider = normalizeLowercaseStringOrEmpty(fetch?.provider);
      if (configuredProvider) {
        return `tools.web.fetch.provider is "${configuredProvider}".`;
      }
      return undefined;
    }
    const search = params.config.tools?.web?.search;
    if (search?.enabled === false) {
      return "tools.web.search is disabled.";
    }
    const configuredProvider = normalizeLowercaseStringOrEmpty(search?.provider);
    const configuredPluginId = configuredProvider
      ? commandSecretGatewayDeps.resolveManifestContractOwnerPluginId({
          contract: "webSearchProviders",
          value: configuredProvider,
          origin: "bundled",
          config: params.config,
        })
      : undefined;
    if (configuredPluginId && configuredPluginId !== pluginId) {
      return `tools.web.search.provider is "${configuredProvider}".`;
    }
    return undefined;
  }

  const match = /^tools\.web\.search\.([^.]+)\.apiKey$/.exec(params.path);
  if (!match) {
    return undefined;
  }

  const search = params.config.tools?.web?.search;
  if (search?.enabled === false) {
    return "tools.web.search is disabled.";
  }

  const configuredProvider = normalizeLowercaseStringOrEmpty(search?.provider);
  if (configuredProvider && configuredProvider !== match[1]) {
    return `tools.web.search.provider is "${configuredProvider}".`;
  }

  return undefined;
}

function targetsRuntimeWebResolution(params: {
  targetIds: ReadonlySet<string>;
  allowedPaths?: ReadonlySet<string>;
}): boolean {
  if (params.allowedPaths) {
    for (const path of params.allowedPaths) {
      if (targetsRuntimeWebPath(path)) {
        return true;
      }
    }
    return false;
  }
  for (const targetId of params.targetIds) {
    if (WEB_RUNTIME_SECRET_TARGET_ID_PREFIXES.some((prefix) => targetId.startsWith(prefix))) {
      return true;
    }
  }
  return false;
}

function collectConfiguredTargetRefPaths(params: {
  config: OpenClawConfig;
  targetIds: Set<string>;
  allowedPaths?: ReadonlySet<string>;
}): Set<string> {
  const defaults = params.config.secrets?.defaults;
  const configuredTargetRefPaths = new Set<string>();
  for (const target of commandSecretGatewayDeps.discoverConfigSecretTargetsByIds(
    params.config,
    params.targetIds,
  )) {
    if (params.allowedPaths && !params.allowedPaths.has(target.path)) {
      continue;
    }
    const { ref } = resolveSecretInputRef({
      value: target.value,
      refValue: target.refValue,
      defaults,
    });
    if (ref) {
      configuredTargetRefPaths.add(target.path);
    }
  }
  return configuredTargetRefPaths;
}

function classifyConfiguredTargetRefs(params: {
  config: OpenClawConfig;
  configuredTargetRefPaths: Set<string>;
}): {
  hasActiveConfiguredRef: boolean;
  hasUnknownConfiguredRef: boolean;
  diagnostics: string[];
} {
  if (params.configuredTargetRefPaths.size === 0) {
    return {
      hasActiveConfiguredRef: false,
      hasUnknownConfiguredRef: false,
      diagnostics: [],
    };
  }
  const context = createResolverContext({
    sourceConfig: params.config,
    env: process.env,
  });
  commandSecretGatewayDeps.collectConfigAssignments({
    config: structuredClone(params.config),
    context,
  });

  const activePaths = new Set(context.assignments.map((assignment) => assignment.path));
  const inactiveWarningsByPath = new Map<string, string>();
  for (const warning of context.warnings) {
    if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") {
      continue;
    }
    inactiveWarningsByPath.set(warning.path, warning.message);
  }

  const diagnostics = new Set<string>();
  let hasActiveConfiguredRef = false;
  let hasUnknownConfiguredRef = false;

  for (const path of params.configuredTargetRefPaths) {
    if (activePaths.has(path)) {
      hasActiveConfiguredRef = true;
      continue;
    }
    const inactiveWarning = inactiveWarningsByPath.get(path);
    if (inactiveWarning) {
      diagnostics.add(inactiveWarning);
      continue;
    }
    hasUnknownConfiguredRef = true;
  }

  return {
    hasActiveConfiguredRef,
    hasUnknownConfiguredRef,
    diagnostics: [...diagnostics],
  };
}

function parseGatewaySecretsResolveResult(payload: unknown): {
  assignments: Array<{ path?: string; pathSegments: string[]; value: unknown }>;
  diagnostics: string[];
  inactiveRefPaths: string[];
} {
  if (!validateSecretsResolveResult(payload)) {
    throw new Error("gateway returned invalid secrets.resolve payload.");
  }
  const parsed = payload as GatewaySecretsResolveResult;
  return {
    assignments: parsed.assignments ?? [],
    diagnostics: (parsed.diagnostics ?? []).filter((entry) => entry.trim().length > 0),
    inactiveRefPaths: (parsed.inactiveRefPaths ?? []).filter((entry) => entry.trim().length > 0),
  };
}

function collectInactiveSurfacePathsFromDiagnostics(diagnostics: string[]): Set<string> {
  const paths = new Set<string>();
  for (const entry of diagnostics) {
    const marker = ": secret ref is configured on an inactive surface;";
    const markerIndex = entry.indexOf(marker);
    if (markerIndex <= 0) {
      continue;
    }
    const path = entry.slice(0, markerIndex).trim();
    if (path.length > 0) {
      paths.add(path);
    }
  }
  return paths;
}

function isUnsupportedSecretsResolveError(err: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
  if (!message.includes("secrets.resolve")) {
    return false;
  }
  return (
    message.includes("does not support required method") ||
    message.includes("unknown method") ||
    message.includes("method not found") ||
    message.includes("invalid request")
  );
}

function isDirectRuntimeWebTargetPath(path: string): boolean {
  return (
    /^plugins\.entries\.[^.]+\.config\.(webSearch|webFetch)\.apiKey$/.test(path) ||
    /^tools\.web\.search\.[^.]+\.apiKey$/.test(path)
  );
}

async function resolveCommandSecretRefsLocally(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  preflightDiagnostics: string[];
  mode: CommandSecretResolutionMode;
  allowedPaths?: ReadonlySet<string>;
}): Promise<ResolveCommandSecretsResult> {
  const sourceConfig = params.config;
  const resolvedConfig = structuredClone(params.config);
  const context = createResolverContext({
    sourceConfig,
    env: process.env,
  });
  const localResolutionDiagnostics: string[] = [];
  const discoveredTargets = commandSecretGatewayDeps
    .discoverConfigSecretTargetsByIds(sourceConfig, params.targetIds)
    .filter((target) => !params.allowedPaths || params.allowedPaths.has(target.path));
  const runtimeWebTargets = discoveredTargets.filter((target) =>
    targetsRuntimeWebPath(target.path),
  );
  commandSecretGatewayDeps.collectConfigAssignments({
    config: structuredClone(params.config),
    context,
  });
  if (
    targetsRuntimeWebResolution({
      targetIds: params.targetIds,
      allowedPaths: params.allowedPaths,
    }) &&
    !runtimeWebTargets.every((target) => isDirectRuntimeWebTargetPath(target.path))
  ) {
    try {
      await commandSecretGatewayDeps.resolveRuntimeWebTools({
        sourceConfig,
        resolvedConfig,
        context,
      });
    } catch (error) {
      if (enforcesResolvedSecrets(params.mode)) {
        throw error;
      }
      localResolutionDiagnostics.push(
        `${params.commandName}: failed to resolve web tool secrets locally (${formatErrorMessage(error)}).`,
      );
    }
  }
  const inactiveRefPaths = new Set(
    context.warnings
      .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
      .filter((warning) => !params.allowedPaths || params.allowedPaths.has(warning.path))
      .map((warning) => warning.path),
  );
  const runtimeWebActivePaths = new Set<string>();
  const runtimeWebInactiveDiagnostics: string[] = [];
  for (const target of runtimeWebTargets) {
    const runtimeState = classifyRuntimeWebTargetPathState({
      config: sourceConfig,
      path: target.path,
    });
    if (runtimeState === "inactive") {
      inactiveRefPaths.add(target.path);
      const inactiveDetail = describeInactiveRuntimeWebTargetPath({
        config: sourceConfig,
        path: target.path,
      });
      if (inactiveDetail) {
        runtimeWebInactiveDiagnostics.push(`${target.path}: ${inactiveDetail}`);
      }
      continue;
    }
    if (runtimeState === "active") {
      runtimeWebActivePaths.add(target.path);
    }
  }
  const inactiveWarningDiagnostics = context.warnings
    .filter((warning) => warning.code === "SECRETS_REF_IGNORED_INACTIVE_SURFACE")
    .filter((warning) => !params.allowedPaths || params.allowedPaths.has(warning.path))
    .map((warning) => warning.message);
  const activePaths = new Set(context.assignments.map((assignment) => assignment.path));
  for (const target of discoveredTargets) {
    await resolveTargetSecretLocally({
      target,
      sourceConfig,
      resolvedConfig,
      env: context.env,
      cache: context.cache,
      activePaths,
      runtimeWebActivePaths,
      inactiveRefPaths,
      mode: params.mode,
      commandName: params.commandName,
      localResolutionDiagnostics,
    });
  }
  const analyzed = commandSecretGatewayDeps.analyzeCommandSecretAssignmentsFromSnapshot({
    sourceConfig,
    resolvedConfig,
    targetIds: params.targetIds,
    inactiveRefPaths,
    ...(params.allowedPaths ? { allowedPaths: params.allowedPaths } : {}),
  });
  const targetStatesByPath = buildTargetStatesByPath({
    analyzed,
    resolvedState: "resolved_local",
  });
  if (!enforcesResolvedSecrets(params.mode) && analyzed.unresolved.length > 0) {
    scrubUnresolvedAssignments(resolvedConfig, analyzed.unresolved);
  } else if (analyzed.unresolved.length > 0) {
    throw new Error(
      `${params.commandName}: ${analyzed.unresolved[0]?.path ?? "target"} is unresolved in the active runtime snapshot.`,
    );
  }

  return {
    resolvedConfig,
    diagnostics: dedupeDiagnostics([
      ...params.preflightDiagnostics,
      ...runtimeWebInactiveDiagnostics,
      ...inactiveWarningDiagnostics,
      ...filterInactiveSurfaceDiagnostics({
        diagnostics: analyzed.diagnostics,
        inactiveRefPaths,
      }),
      ...localResolutionDiagnostics,
      ...buildUnresolvedDiagnostics(params.commandName, analyzed.unresolved, params.mode),
    ]),
    targetStatesByPath,
    hadUnresolvedTargets: analyzed.unresolved.length > 0,
  };
}

function buildTargetStatesByPath(params: {
  analyzed: ReturnType<typeof analyzeCommandSecretAssignmentsFromSnapshot>;
  resolvedState: Extract<CommandSecretTargetState, "resolved_gateway" | "resolved_local">;
}): Record<string, CommandSecretTargetState> {
  const states: Record<string, CommandSecretTargetState> = {};
  for (const assignment of params.analyzed.assignments) {
    states[assignment.path] = params.resolvedState;
  }
  for (const entry of params.analyzed.inactive) {
    states[entry.path] = "inactive_surface";
  }
  for (const entry of params.analyzed.unresolved) {
    states[entry.path] = "unresolved";
  }
  return states;
}

function buildUnresolvedDiagnostics(
  commandName: string,
  unresolved: UnresolvedCommandSecretAssignment[],
  mode: CommandSecretResolutionMode,
): string[] {
  if (enforcesResolvedSecrets(mode)) {
    return [];
  }
  return unresolved.map(
    (entry) =>
      `${commandName}: ${entry.path} is unavailable in this command path; continuing with degraded read-only config.`,
  );
}

function scrubUnresolvedAssignments(
  config: OpenClawConfig,
  unresolved: UnresolvedCommandSecretAssignment[],
): void {
  for (const entry of unresolved) {
    setPathExistingStrict(config, entry.pathSegments, undefined);
  }
}

function filterInactiveSurfaceDiagnostics(params: {
  diagnostics: readonly string[];
  inactiveRefPaths: ReadonlySet<string>;
}): string[] {
  return params.diagnostics.filter((entry) => {
    const marker = ": secret ref is configured on an inactive surface;";
    const markerIndex = entry.indexOf(marker);
    if (markerIndex <= 0) {
      return true;
    }
    const path = entry.slice(0, markerIndex).trim();
    return !params.inactiveRefPaths.has(path);
  });
}

async function resolveTargetSecretLocally(params: {
  target: DiscoveredConfigSecretTarget;
  sourceConfig: OpenClawConfig;
  resolvedConfig: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  cache: ReturnType<typeof createResolverContext>["cache"];
  activePaths: ReadonlySet<string>;
  runtimeWebActivePaths: ReadonlySet<string>;
  inactiveRefPaths: ReadonlySet<string>;
  mode: CommandSecretResolutionMode;
  commandName: string;
  localResolutionDiagnostics: string[];
}): Promise<void> {
  const defaults = params.sourceConfig.secrets?.defaults;
  const { ref } = resolveSecretInputRef({
    value: params.target.value,
    refValue: params.target.refValue,
    defaults,
  });
  if (
    !ref ||
    params.inactiveRefPaths.has(params.target.path) ||
    (!params.activePaths.has(params.target.path) &&
      !params.runtimeWebActivePaths.has(params.target.path))
  ) {
    return;
  }

  try {
    const resolved = await resolveSecretRefValue(ref, {
      config: params.sourceConfig,
      env: params.env,
      cache: params.cache,
    });
    assertExpectedResolvedSecretValue({
      value: resolved,
      expected: params.target.entry.expectedResolvedValue,
      errorMessage:
        params.target.entry.expectedResolvedValue === "string"
          ? `${params.target.path} resolved to a non-string or empty value.`
          : `${params.target.path} resolved to an unsupported value type.`,
    });
    setPathExistingStrict(params.resolvedConfig, params.target.pathSegments, resolved);
  } catch (error) {
    if (!enforcesResolvedSecrets(params.mode)) {
      params.localResolutionDiagnostics.push(
        `${params.commandName}: failed to resolve ${params.target.path} locally (${formatErrorMessage(error)}).`,
      );
    }
  }
}

export async function resolveCommandSecretRefsViaGateway(params: {
  config: OpenClawConfig;
  commandName: string;
  targetIds: Set<string>;
  mode?: CommandSecretResolutionModeInput;
  allowedPaths?: ReadonlySet<string>;
}): Promise<ResolveCommandSecretsResult> {
  const mode = normalizeCommandSecretResolutionMode(params.mode);
  const configuredTargetRefPaths = collectConfiguredTargetRefPaths({
    config: params.config,
    targetIds: params.targetIds,
    allowedPaths: params.allowedPaths,
  });
  if (configuredTargetRefPaths.size === 0) {
    return {
      resolvedConfig: params.config,
      diagnostics: [],
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    };
  }
  const preflight = classifyConfiguredTargetRefs({
    config: params.config,
    configuredTargetRefPaths,
  });
  if (!preflight.hasActiveConfiguredRef && !preflight.hasUnknownConfiguredRef) {
    return {
      resolvedConfig: params.config,
      diagnostics: preflight.diagnostics,
      targetStatesByPath: {},
      hadUnresolvedTargets: false,
    };
  }

  let payload: GatewaySecretsResolveResult;
  try {
    payload = await callGateway({
      config: params.config,
      method: "secrets.resolve",
      requiredMethods: ["secrets.resolve"],
      params: {
        commandName: params.commandName,
        targetIds: [...params.targetIds],
      },
      timeoutMs: 30_000,
      clientName: GATEWAY_CLIENT_NAMES.CLI,
      mode: GATEWAY_CLIENT_MODES.CLI,
    });
  } catch (err) {
    try {
      const fallback = await resolveCommandSecretRefsLocally({
        config: params.config,
        commandName: params.commandName,
        targetIds: params.targetIds,
        preflightDiagnostics: preflight.diagnostics,
        mode,
        allowedPaths: params.allowedPaths,
      });
      const recoveredLocally = Object.values(fallback.targetStatesByPath).some(
        (state) => state === "resolved_local",
      );
      const fallbackMessage =
        recoveredLocally && !fallback.hadUnresolvedTargets
          ? "resolved command secrets locally."
          : "attempted local command-secret resolution.";
      return {
        resolvedConfig: fallback.resolvedConfig,
        diagnostics: dedupeDiagnostics([
          ...fallback.diagnostics,
          `${params.commandName}: gateway secrets.resolve unavailable (${formatErrorMessage(err)}); ${fallbackMessage}`,
        ]),
        targetStatesByPath: fallback.targetStatesByPath,
        hadUnresolvedTargets: fallback.hadUnresolvedTargets,
      };
    } catch {
      // Fall through to original gateway-specific error reporting.
    }
    if (isUnsupportedSecretsResolveError(err)) {
      throw new Error(
        `${params.commandName}: active gateway does not support secrets.resolve (${formatErrorMessage(err)}). Update the gateway or run without SecretRefs.`,
        { cause: err },
      );
    }
    throw new Error(
      `${params.commandName}: failed to resolve secrets from the active gateway snapshot (${formatErrorMessage(err)}). Start the gateway and retry.`,
      { cause: err },
    );
  }

  const parsed = parseGatewaySecretsResolveResult(payload);
  const resolvedConfig = structuredClone(params.config);
  for (const assignment of parsed.assignments) {
    const pathSegments = assignment.pathSegments.filter((segment) => segment.length > 0);
    if (pathSegments.length === 0) {
      continue;
    }
    try {
      setPathExistingStrict(resolvedConfig, pathSegments, assignment.value);
    } catch (err) {
      const path = pathSegments.join(".");
      throw new Error(
        `${params.commandName}: failed to apply resolved secret assignment at ${path} (${formatErrorMessage(err)}).`,
        { cause: err },
      );
    }
  }
  const inactiveRefPaths =
    parsed.inactiveRefPaths.length > 0
      ? new Set(parsed.inactiveRefPaths)
      : collectInactiveSurfacePathsFromDiagnostics(parsed.diagnostics);
  const analyzed = commandSecretGatewayDeps.analyzeCommandSecretAssignmentsFromSnapshot({
    sourceConfig: params.config,
    resolvedConfig,
    targetIds: params.targetIds,
    inactiveRefPaths,
    allowedPaths: params.allowedPaths,
  });
  let diagnostics = dedupeDiagnostics(parsed.diagnostics);
  const targetStatesByPath = buildTargetStatesByPath({
    analyzed,
    resolvedState: "resolved_gateway",
  });
  if (analyzed.unresolved.length > 0) {
    try {
      const localFallback = await resolveCommandSecretRefsLocally({
        config: params.config,
        commandName: params.commandName,
        targetIds: params.targetIds,
        preflightDiagnostics: [],
        mode,
        allowedPaths: new Set(analyzed.unresolved.map((entry) => entry.path)),
      });
      for (const unresolved of analyzed.unresolved) {
        if (localFallback.targetStatesByPath[unresolved.path] !== "resolved_local") {
          continue;
        }
        setPathExistingStrict(
          resolvedConfig,
          unresolved.pathSegments,
          getPath(localFallback.resolvedConfig, unresolved.pathSegments),
        );
        targetStatesByPath[unresolved.path] = "resolved_local";
      }
      const recoveredPaths = new Set(
        Object.entries(localFallback.targetStatesByPath)
          .filter(([, state]) => state === "resolved_local")
          .map(([path]) => path),
      );
      const stillUnresolved = analyzed.unresolved.filter(
        (entry) => !recoveredPaths.has(entry.path),
      );
      if (stillUnresolved.length > 0) {
        if (enforcesResolvedSecrets(mode)) {
          throw new Error(
            `${params.commandName}: ${stillUnresolved[0]?.path ?? "target"} is unresolved in the active runtime snapshot.`,
          );
        }
        scrubUnresolvedAssignments(resolvedConfig, stillUnresolved);
        diagnostics = dedupeDiagnostics([
          ...diagnostics,
          ...localFallback.diagnostics,
          ...buildUnresolvedDiagnostics(params.commandName, stillUnresolved, mode),
        ]);
        for (const unresolved of stillUnresolved) {
          targetStatesByPath[unresolved.path] = "unresolved";
        }
      } else if (recoveredPaths.size > 0) {
        diagnostics = dedupeDiagnostics([
          ...diagnostics,
          `${params.commandName}: resolved ${recoveredPaths.size} secret ${
            recoveredPaths.size === 1 ? "path" : "paths"
          } locally after the gateway snapshot was incomplete.`,
        ]);
      }
    } catch (error) {
      if (enforcesResolvedSecrets(mode)) {
        throw error;
      }
      scrubUnresolvedAssignments(resolvedConfig, analyzed.unresolved);
      diagnostics = dedupeDiagnostics([
        ...diagnostics,
        `${params.commandName}: local fallback after incomplete gateway snapshot failed (${formatErrorMessage(error)}).`,
        ...buildUnresolvedDiagnostics(params.commandName, analyzed.unresolved, mode),
      ]);
    }
  }

  return {
    resolvedConfig,
    diagnostics,
    targetStatesByPath,
    hadUnresolvedTargets: Object.values(targetStatesByPath).includes("unresolved"),
  };
}
