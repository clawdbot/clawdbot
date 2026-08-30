/** Query helpers for discovering secret target registry entries. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginManifestRegistry } from "../plugins/manifest-registry.js";
import { formatConcreteConfigPath, type ConcreteConfigPathSegment } from "../shared/dot-path.js";
import { loadChannelSecretContractApi } from "./channel-contract-api.js";
import { getPath } from "./path-utils.js";
import {
  buildSecretTargetRegistryFromPlugins,
  getCoreSecretTargetRegistry,
  getSecretTargetRegistry,
} from "./target-registry-data.js";
import {
  compileTargetRegistryEntry,
  expandPathTokens,
  materializePathTokens,
  matchPathTokens,
  type CompiledTargetRegistryEntry,
} from "./target-registry-pattern.js";
import type {
  DiscoveredConfigSecretTarget,
  ResolvedPlanTarget,
  SecretTargetConfigFile,
  SecretTargetRegistryEntry,
} from "./target-registry-types.js";

const compiledSecretTargetRegistries = new WeakMap<
  readonly SecretTargetRegistryEntry[],
  ReturnType<typeof compileSecretTargetRegistryState>
>();

let compiledCoreOpenClawTargetState: {
  knownTargetIds: Set<string>;
  openClawCompiledSecretTargets: CompiledTargetRegistryEntry[];
  openClawTargetsById: Map<string, CompiledTargetRegistryEntry[]>;
  planTargetsByType: Map<string, CompiledTargetRegistryEntry[]>;
} | null = null;

let compiledCoreAuthProfileTargetState: {
  entries: CompiledTargetRegistryEntry[];
  entriesById: Map<string, CompiledTargetRegistryEntry[]>;
} | null = null;

const compiledChannelOpenClawTargets = new WeakMap<
  readonly SecretTargetRegistryEntry[],
  CompiledTargetRegistryEntry[]
>();

function buildTargetTypeIndex(
  compiledSecretTargetRegistry: CompiledTargetRegistryEntry[],
): Map<string, CompiledTargetRegistryEntry[]> {
  const byType = new Map<string, CompiledTargetRegistryEntry[]>();
  const append = (type: string, entry: CompiledTargetRegistryEntry) => {
    const existing = byType.get(type);
    if (existing) {
      existing.push(entry);
      return;
    }
    byType.set(type, [entry]);
  };
  for (const entry of compiledSecretTargetRegistry) {
    append(entry.targetType, entry);
    for (const alias of entry.targetTypeAliases ?? []) {
      append(alias, entry);
    }
  }
  return byType;
}

function buildConfigTargetIdIndex(
  entries: CompiledTargetRegistryEntry[],
): Map<string, CompiledTargetRegistryEntry[]> {
  const byId = new Map<string, CompiledTargetRegistryEntry[]>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (existing) {
      existing.push(entry);
      continue;
    }
    byId.set(entry.id, [entry]);
  }
  return byId;
}

function compileSecretTargetRegistryState(registry: readonly SecretTargetRegistryEntry[]) {
  const compiledSecretTargetRegistry = registry.map(compileTargetRegistryEntry);
  const openClawCompiledSecretTargets = compiledSecretTargetRegistry.filter(
    (entry) => entry.configFile === "openclaw.json",
  );
  const authProfilesCompiledSecretTargets = compiledSecretTargetRegistry.filter(
    (entry) => entry.configFile === "auth-profile-store",
  );
  return {
    authProfilesCompiledSecretTargets,
    authProfilesTargetsById: buildConfigTargetIdIndex(authProfilesCompiledSecretTargets),
    compiledSecretTargetRegistry,
    knownTargetIds: new Set(compiledSecretTargetRegistry.map((entry) => entry.id)),
    openClawCompiledSecretTargets,
    openClawTargetsById: buildConfigTargetIdIndex(openClawCompiledSecretTargets),
    targetsByType: buildTargetTypeIndex(compiledSecretTargetRegistry),
  };
}

function getCompiledSecretTargetRegistryState(registry = getSecretTargetRegistry()) {
  const cached = compiledSecretTargetRegistries.get(registry);
  if (cached) {
    return cached;
  }
  const compiled = compileSecretTargetRegistryState(registry);
  compiledSecretTargetRegistries.set(registry, compiled);
  return compiled;
}

function getConfiguredSecretTargetRegistryState(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">,
) {
  return getCompiledSecretTargetRegistryState(
    manifestRegistry
      ? buildSecretTargetRegistryFromPlugins(manifestRegistry.plugins)
      : getSecretTargetRegistry({ config, env }),
  );
}

function getCompiledCoreOpenClawTargetState() {
  if (compiledCoreOpenClawTargetState) {
    return compiledCoreOpenClawTargetState;
  }
  const compiledCoreSecretTargets = getCoreSecretTargetRegistry().map(compileTargetRegistryEntry);
  const openClawCompiledSecretTargets = compiledCoreSecretTargets.filter(
    (entry) => entry.configFile === "openclaw.json",
  );
  compiledCoreOpenClawTargetState = {
    knownTargetIds: new Set(compiledCoreSecretTargets.map((entry) => entry.id)),
    openClawCompiledSecretTargets,
    openClawTargetsById: buildConfigTargetIdIndex(openClawCompiledSecretTargets),
    planTargetsByType: buildTargetTypeIndex(compiledCoreSecretTargets),
  };
  return compiledCoreOpenClawTargetState;
}

function getCompiledCoreAuthProfileTargetState() {
  if (compiledCoreAuthProfileTargetState) {
    return compiledCoreAuthProfileTargetState;
  }
  const entries = getCoreSecretTargetRegistry()
    .filter((entry) => entry.configFile === "auth-profile-store")
    .map(compileTargetRegistryEntry);
  compiledCoreAuthProfileTargetState = {
    entries,
    entriesById: buildConfigTargetIdIndex(entries),
  };
  return compiledCoreAuthProfileTargetState;
}

function getCompiledChannelOpenClawTargets(
  channelId: string,
): CompiledTargetRegistryEntry[] | null {
  const normalizedChannelId = channelId.trim();
  if (
    !normalizedChannelId ||
    normalizedChannelId === "." ||
    normalizedChannelId === ".." ||
    /[\\/:]/.test(normalizedChannelId)
  ) {
    return null;
  }
  const entries = loadChannelSecretContractApi({
    channelId: normalizedChannelId,
    env: process.env,
  })?.secretTargetRegistryEntries;
  if (!entries) {
    return null;
  }
  const cached = compiledChannelOpenClawTargets.get(entries);
  if (cached) {
    return cached;
  }
  const compiledEntries = entries
    .filter((entry) => entry.configFile === "openclaw.json")
    .map(compileTargetRegistryEntry);
  compiledChannelOpenClawTargets.set(entries, compiledEntries);
  return compiledEntries;
}

function normalizeAllowedTargetIds(targetIds?: Iterable<string>): Set<string> | null {
  if (targetIds === undefined) {
    return null;
  }
  return new Set(
    Array.from(targetIds)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function configHasPluginEntries(config: OpenClawConfig): boolean {
  return Boolean(config.plugins?.entries && Object.keys(config.plugins.entries).length > 0);
}

function getConfiguredChannelOpenClawTargets(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): CompiledTargetRegistryEntry[] | null {
  const entries: CompiledTargetRegistryEntry[] = [];
  for (const channelId of Object.keys(config.channels ?? {})) {
    if (channelId === "defaults" || channelId === "modelByChannel" || channelId === "tools") {
      continue;
    }
    const contract = loadChannelSecretContractApi({
      channelId,
      config,
      env,
      bundledOnly: true,
    });
    if (!contract) {
      // External/custom channels may have multiple manifest owners. Only the full registry can
      // prove their target set is complete; a config-scoped first-contract lookup cannot.
      return null;
    }
    entries.push(
      ...(contract.secretTargetRegistryEntries
        ?.filter((entry) => entry.configFile === "openclaw.json")
        .map(compileTargetRegistryEntry) ?? []),
    );
  }
  return entries;
}

function resolveDiscoveryEntries(params: {
  allowedTargetIds: Set<string> | null;
  defaultEntries: CompiledTargetRegistryEntry[];
  entriesById: Map<string, CompiledTargetRegistryEntry[]>;
}): CompiledTargetRegistryEntry[] {
  if (params.allowedTargetIds === null) {
    return params.defaultEntries;
  }
  return Array.from(params.allowedTargetIds).flatMap(
    (targetId) => params.entriesById.get(targetId) ?? [],
  );
}

function discoverSecretTargetsFromEntries(
  source: unknown,
  discoveryEntries: CompiledTargetRegistryEntry[],
): DiscoveredConfigSecretTarget[] {
  const formatDiscoveredPath = (segments: readonly ConcreteConfigPathSegment[]) =>
    formatConcreteConfigPath(segments, source);
  const out: DiscoveredConfigSecretTarget[] = [];
  const seen = new Set<string>();

  for (const entry of discoveryEntries) {
    const expanded = expandPathTokens(source, entry.pathTokens);
    for (const match of expanded) {
      const resolved = toResolvedPlanTarget(entry, match.captures);
      if (!resolved) {
        continue;
      }
      const key = JSON.stringify([entry.id, ...resolved.pathTokens]);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const refValue = resolved.refPathSegments
        ? getPath(source, resolved.refPathSegments)
        : undefined;
      out.push({
        entry,
        path: formatDiscoveredPath(match.segments),
        pathSegments: resolved.pathSegments,
        ...(resolved.refPathSegments
          ? {
              refPathSegments: resolved.refPathSegments,
              refPath: formatDiscoveredPath(resolved.refPathTokens ?? resolved.refPathSegments),
            }
          : {}),
        value: match.value,
        ...(resolved.providerId ? { providerId: resolved.providerId } : {}),
        ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
        ...(resolved.refPathSegments ? { refValue } : {}),
      });
    }
  }

  return out;
}

function toResolvedPlanTarget(
  entry: CompiledTargetRegistryEntry,
  captures: ConcreteConfigPathSegment[],
): ResolvedPlanTarget | null {
  const pathTokens = materializePathTokens(entry.pathTokens, captures);
  if (!pathTokens) {
    return null;
  }
  const pathSegments = pathTokens.map(String);
  const providerId =
    entry.providerIdPathSegmentIndex !== undefined
      ? pathSegments[entry.providerIdPathSegmentIndex]
      : undefined;
  const accountId =
    entry.accountIdPathSegmentIndex !== undefined
      ? pathSegments[entry.accountIdPathSegmentIndex]
      : undefined;
  const refPathTokens = entry.refPathTokens
    ? materializePathTokens(entry.refPathTokens, captures)
    : undefined;
  if (entry.refPathTokens && !refPathTokens) {
    return null;
  }
  return {
    entry,
    pathSegments,
    pathTokens,
    ...(refPathTokens ? { refPathTokens, refPathSegments: refPathTokens.map(String) } : {}),
    ...(providerId ? { providerId } : {}),
    ...(accountId ? { accountId } : {}),
  };
}

/**
 * Lists the full secrets target registry in public, serializable form.
 */
/** Lists all configured secret target registry entries. */
export function listSecretTargetRegistryEntries(): SecretTargetRegistryEntry[] {
  return getCompiledSecretTargetRegistryState().compiledSecretTargetRegistry.map((entry) =>
    Object.assign(
      { id: entry.id, targetType: entry.targetType },
      entry.targetTypeAliases ? { targetTypeAliases: [...entry.targetTypeAliases] } : {},
      { configFile: entry.configFile, pathPattern: entry.pathPattern },
      entry.pathPatternSegments ? { pathPatternSegments: [...entry.pathPatternSegments] } : {},
      entry.refPathPattern ? { refPathPattern: entry.refPathPattern } : {},
      {
        secretShape: entry.secretShape,
        expectedResolvedValue: entry.expectedResolvedValue,
        includeInPlan: entry.includeInPlan,
        includeInConfigure: entry.includeInConfigure,
        includeInAudit: entry.includeInAudit,
      },
      entry.providerIdPathSegmentIndex !== undefined
        ? { providerIdPathSegmentIndex: entry.providerIdPathSegmentIndex }
        : {},
      entry.accountIdPathSegmentIndex !== undefined
        ? { accountIdPathSegmentIndex: entry.accountIdPathSegmentIndex }
        : {},
      entry.authProfileType ? { authProfileType: entry.authProfileType } : {},
      entry.trackProviderShadowing ? { trackProviderShadowing: true } : {},
    ),
  );
}

/**
 * Narrows unknown input to a target id currently present in the compiled registry.
 */
export function isKnownSecretTargetId(value: unknown): value is string {
  return (
    typeof value === "string" && getCompiledSecretTargetRegistryState().knownTargetIds.has(value)
  );
}

/** Checks the static core registry without materializing plugin/channel contracts. */
export function isKnownCoreSecretTargetId(value: unknown): value is string {
  return (
    typeof value === "string" && getCompiledCoreOpenClawTargetState().knownTargetIds.has(value)
  );
}

/**
 * Resolves a secrets apply-plan target against registered target type and path patterns.
 */
export function resolvePlanTargetAgainstRegistry(candidate: {
  type: string;
  pathSegments: string[];
  pathTokens?: readonly ConcreteConfigPathSegment[];
  allowLegacyArrayString?: boolean;
  providerId?: string;
  accountId?: string;
}): ResolvedPlanTarget | null {
  const coreEntries = getCompiledCoreOpenClawTargetState().planTargetsByType.get(candidate.type);
  if (coreEntries) {
    return resolvePlanTargetAgainstEntries(candidate, coreEntries);
  }
  const explicitChannelId =
    candidate.pathSegments[0] === "channels" ? (candidate.pathSegments[1]?.trim() ?? "") : "";
  if (explicitChannelId) {
    if (/[\\/:]/.test(explicitChannelId)) {
      return null;
    }
    const channelEntries = getCompiledChannelOpenClawTargets(explicitChannelId) ?? [];
    const channelTypeEntries = buildTargetTypeIndex(channelEntries).get(candidate.type);
    if (channelTypeEntries) {
      return resolvePlanTargetAgainstEntries(candidate, channelTypeEntries);
    }
  }
  const entries = getCompiledSecretTargetRegistryState().targetsByType.get(candidate.type);
  return resolvePlanTargetAgainstEntries(candidate, entries);
}

function resolvePlanTargetAgainstEntries(
  candidate: {
    type: string;
    pathSegments: string[];
    pathTokens?: readonly ConcreteConfigPathSegment[];
    allowLegacyArrayString?: boolean;
    providerId?: string;
    accountId?: string;
  },
  entries: CompiledTargetRegistryEntry[] | undefined,
): ResolvedPlanTarget | null {
  if (!entries || entries.length === 0) {
    return null;
  }

  const pathTokens = candidate.pathTokens ?? candidate.pathSegments;
  for (const entry of entries) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(pathTokens, entry.pathTokens, {
      allowLegacyArrayString: candidate.allowLegacyArrayString,
    });
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, matched.captures);
    if (!resolved) {
      continue;
    }
    if (candidate.providerId && candidate.providerId.trim().length > 0) {
      if (!resolved.providerId || resolved.providerId !== candidate.providerId) {
        continue;
      }
    }
    if (candidate.accountId && candidate.accountId.trim().length > 0) {
      if (!resolved.accountId || resolved.accountId !== candidate.accountId) {
        continue;
      }
    }
    return resolved;
  }
  return null;
}

/**
 * Resolves a plan-capable secret target by owning config document and concrete path.
 */
export function resolveSecretPlanTargetByPathCore(params: {
  configFile: SecretTargetConfigFile;
  pathSegments: string[];
  pathTokens?: readonly ConcreteConfigPathSegment[];
}): ResolvedPlanTarget | null {
  if (params.configFile === "openclaw.json") {
    return resolveConfigSecretTargetByPath(params.pathSegments, params.pathTokens);
  }
  const pathTokens = params.pathTokens ?? params.pathSegments;
  for (const entry of getCompiledSecretTargetRegistryState().authProfilesCompiledSecretTargets) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(pathTokens, entry.pathTokens);
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, matched.captures);
    if (resolved) {
      return resolved;
    }
  }
  return null;
}

/**
 * Resolves an openclaw.json config path to the matching plan-capable secrets target.
 */
export function resolveConfigSecretTargetByPath(
  pathSegments: string[],
  pathTokens: readonly ConcreteConfigPathSegment[] = pathSegments,
): ResolvedPlanTarget | null {
  for (const entry of getCompiledCoreOpenClawTargetState().openClawCompiledSecretTargets) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(pathTokens, entry.pathTokens);
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, matched.captures);
    if (!resolved) {
      continue;
    }
    return resolved;
  }

  const explicitChannelId = pathSegments[0] === "channels" ? (pathSegments[1]?.trim() ?? "") : "";
  const explicitChannelEntries = explicitChannelId
    ? getCompiledChannelOpenClawTargets(explicitChannelId)
    : null;
  // Channel-owned contracts get first chance for explicit channel paths before bundled defaults.
  for (const entry of explicitChannelEntries ?? []) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(pathTokens, entry.pathTokens);
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, matched.captures);
    if (!resolved) {
      continue;
    }
    return resolved;
  }

  for (const entry of getCompiledSecretTargetRegistryState().openClawCompiledSecretTargets) {
    if (!entry.includeInPlan) {
      continue;
    }
    const matched = matchPathTokens(pathTokens, entry.pathTokens);
    if (!matched) {
      continue;
    }
    const resolved = toResolvedPlanTarget(entry, matched.captures);
    if (!resolved) {
      continue;
    }
    return resolved;
  }
  return null;
}

/** Discovers configured secret-bearing values in openclaw.json. */
export function discoverConfigSecretTargets(
  config: OpenClawConfig,
  options: {
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  } = {},
): DiscoveredConfigSecretTarget[] {
  return discoverConfigSecretTargetsByIds(config, undefined, options);
}

/**
 * Discovers configured openclaw.json targets, optionally limited to selected registry ids.
 */
export function discoverConfigSecretTargetsByIds(
  config: OpenClawConfig,
  targetIds?: Iterable<string>,
  options: {
    env?: NodeJS.ProcessEnv;
    manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  } = {},
): DiscoveredConfigSecretTarget[] {
  const env = options.env ?? process.env;
  const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
  const coreState = getCompiledCoreOpenClawTargetState();
  const hasOnlyCoreTargetIds =
    allowedTargetIds !== null &&
    Array.from(allowedTargetIds).every((targetId) => coreState.knownTargetIds.has(targetId));
  const configuredChannelEntries =
    !options.manifestRegistry && !hasOnlyCoreTargetIds && !configHasPluginEntries(config)
      ? getConfiguredChannelOpenClawTargets(config, env)
      : null;
  const configuredEntries = hasOnlyCoreTargetIds
    ? coreState.openClawCompiledSecretTargets
    : configuredChannelEntries
      ? [...coreState.openClawCompiledSecretTargets, ...configuredChannelEntries]
      : null;
  const configuredEntriesById = configuredEntries
    ? buildConfigTargetIdIndex(configuredEntries)
    : null;
  const canUseConfiguredEntries =
    configuredEntries !== null &&
    (allowedTargetIds === null ||
      Array.from(allowedTargetIds).every((targetId) => configuredEntriesById?.has(targetId)));
  const registryState = canUseConfiguredEntries
    ? null
    : getConfiguredSecretTargetRegistryState(config, env, options.manifestRegistry);
  const discoveryEntries = resolveDiscoveryEntries({
    allowedTargetIds,
    defaultEntries: configuredEntries ?? registryState?.openClawCompiledSecretTargets ?? [],
    entriesById: configuredEntriesById ?? registryState?.openClawTargetsById ?? new Map(),
  });
  return discoverSecretTargetsFromEntries(config, discoveryEntries);
}

/**
 * Discovers secret-bearing values in auth-profiles.json store objects.
 */
export function discoverAuthProfileSecretTargets(
  store: unknown,
  targetIds?: Iterable<string>,
): DiscoveredConfigSecretTarget[] {
  const allowedTargetIds = normalizeAllowedTargetIds(targetIds);
  const registryState = getCompiledCoreAuthProfileTargetState();
  const discoveryEntries = resolveDiscoveryEntries({
    allowedTargetIds,
    defaultEntries: registryState.entries,
    entriesById: registryState.entriesById,
  });
  return discoverSecretTargetsFromEntries(store, discoveryEntries);
}

/**
 * Lists auth-profile target entries that participate in plaintext/unresolved-ref audit.
 */
export function listAuthProfileSecretTargetEntries(): SecretTargetRegistryEntry[] {
  return getCoreSecretTargetRegistry().filter(
    (entry) => entry.configFile === "auth-profile-store" && entry.includeInAudit,
  );
}

export type { DiscoveredConfigSecretTarget, ResolvedPlanTarget } from "./target-registry-types.js";
