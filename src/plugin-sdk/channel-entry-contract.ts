// Channel entry contracts validate plugin channel entrypoints and runtime API facades.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { emptyChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { tryNativeRequireJavaScriptModule } from "../plugins/native-module-require.js";
import {
  createProfiler,
  formatPluginLoadProfileLine,
  shouldProfilePluginLoader,
} from "../plugins/plugin-load-profile.js";
import {
  getCachedPluginSourceModuleLoader,
  type PluginModuleLoaderCache,
} from "../plugins/plugin-module-loader-cache.js";
import { buildPluginLoaderAliasMap, resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import { toSafeImportPath } from "../shared/import-specifier.js";
import type {
  BundledChannelLegacySessionSurface,
  BundledChannelLegacyStateMigrationDetector,
  BundledEntryModuleLoadOptions,
} from "./channel-entry-contract.types.js";

export type AnyAgentTool = import("../plugins/types.js").AnyAgentTool;
export type OpenClawPluginApi = import("../plugins/types.js").OpenClawPluginApi;
export type OpenClawPluginCommandDefinition =
  import("../plugins/types.js").OpenClawPluginCommandDefinition;
export type PluginCommandContext = import("../plugins/types.js").PluginCommandContext;

export type {
  BundledChannelLegacySessionSurface,
  BundledChannelLegacyStateMigrationDetector,
  BundledEntryModuleLoadOptions,
} from "./channel-entry-contract.types.js";

type BundledChannelRuntime = unknown;

type ChannelEntryConfigSchema<TPlugin> =
  TPlugin extends ChannelPlugin<unknown>
    ? NonNullable<TPlugin["configSchema"]>
    : ChannelConfigSchema;

type BundledEntryModuleRef = {
  specifier: string;
  exportName?: string;
};

type DefineBundledChannelEntryOptions<TPlugin = ChannelPlugin> = {
  id: string;
  name: string;
  description: string;
  importMetaUrl: string;
  plugin: BundledEntryModuleRef;
  outbound?: BundledEntryModuleRef;
  secrets?: BundledEntryModuleRef;
  configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ChannelEntryConfigSchema<TPlugin>);
  runtime?: BundledEntryModuleRef;
  accountInspect?: BundledEntryModuleRef;
  features?: BundledChannelEntryFeatures;
  registerCliMetadata?: (api: OpenClawPluginApi) => void;
  registerFull?: (api: OpenClawPluginApi) => void;
};

type DefineBundledChannelSetupEntryOptions = {
  importMetaUrl: string;
  plugin: BundledEntryModuleRef;
  secrets?: BundledEntryModuleRef;
  runtime?: BundledEntryModuleRef;
  legacyStateMigrations?: BundledEntryModuleRef;
  legacySessionSurface?: BundledEntryModuleRef;
  registerSetupRuntime?: (api: OpenClawPluginApi) => void;
  features?: BundledChannelSetupEntryFeatures;
};

/** Feature flags exposed by bundled setup entries for optional migration/session surfaces. */
export type BundledChannelSetupEntryFeatures = {
  legacyStateMigrations?: boolean;
  legacySessionSurfaces?: boolean;
};

/** Feature flags exposed by full bundled channel entries. */
export type BundledChannelEntryFeatures = {
  accountInspect?: boolean;
};

/** Runtime contract returned by a bundled channel's main entrypoint definition. */
export type BundledChannelEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  configSchema: ChannelEntryConfigSchema<TPlugin>;
  features?: BundledChannelEntryFeatures;
  register: (api: OpenClawPluginApi) => void;
  loadChannelPlugin: (options?: BundledEntryModuleLoadOptions) => TPlugin;
  loadChannelOutbound?: (
    options?: BundledEntryModuleLoadOptions,
  ) => ChannelOutboundAdapter | undefined;
  loadChannelSecrets?: (
    options?: BundledEntryModuleLoadOptions,
  ) => ChannelPlugin["secrets"] | undefined;
  loadChannelAccountInspector?: (
    options?: BundledEntryModuleLoadOptions,
  ) => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
  setChannelRuntime?: (runtime: BundledChannelRuntime) => void;
};

/** Runtime contract returned by a bundled channel's setup-only entrypoint definition. */
export type BundledChannelSetupEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: (options?: BundledEntryModuleLoadOptions) => TPlugin;
  loadSetupSecrets?: (
    options?: BundledEntryModuleLoadOptions,
  ) => ChannelPlugin["secrets"] | undefined;
  loadLegacyStateMigrationDetector?: (
    options?: BundledEntryModuleLoadOptions,
  ) => BundledChannelLegacyStateMigrationDetector;
  loadLegacySessionSurface?: (
    options?: BundledEntryModuleLoadOptions,
  ) => BundledChannelLegacySessionSurface;
  setChannelRuntime?: (runtime: BundledChannelRuntime) => void;
  registerSetupRuntime?: (api: OpenClawPluginApi) => void;
  features?: BundledChannelSetupEntryFeatures;
};

const moduleLoaders: PluginModuleLoaderCache = new Map();
const entryBoundaryInfoCache = new Map<string, BundledEntryBoundaryInfo>();
const resolvedModulePaths = new Map<string, string>();
const loadedModuleExports = new Map<string, unknown>();
const disableBundledEntrySourceFallbackEnv = "OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK";

function isTruthyEnvFlag(value: string | undefined): boolean {
  return value !== undefined && !/^(?:0|false)$/iu.test(value.trim());
}

function resolveSpecifierCandidates(modulePath: string): string[] {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(modulePath));
  if (ext === ".js") {
    return [modulePath, modulePath.slice(0, -3) + ".ts"];
  }
  if (ext === ".mjs") {
    return [modulePath, modulePath.slice(0, -4) + ".mts"];
  }
  if (ext === ".cjs") {
    return [modulePath, modulePath.slice(0, -4) + ".cts"];
  }
  return [modulePath];
}

function resolveEntryBoundaryRoot(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

type BundledEntryModuleCandidate = {
  path: string;
  boundaryRoot: string;
};

type BundledEntryBoundaryInfo = {
  importerPath: string;
  importerDir: string;
  boundaryRoot: string;
  packageRoot: string | null;
};

function resolveBundledEntryBoundaryInfo(importMetaUrl: string): BundledEntryBoundaryInfo {
  const cacheKey = `${process.argv[1] ?? ""}\0${importMetaUrl}`;
  const cached = entryBoundaryInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const importerPath = fileURLToPath(importMetaUrl);
  const importerDir = path.dirname(importerPath);
  const boundaryRoot = path.dirname(importerPath);
  const info = {
    importerPath,
    importerDir,
    boundaryRoot,
    packageRoot:
      resolveLoaderPackageRoot({
        modulePath: importerPath,
        moduleUrl: importMetaUrl,
        cwd: importerDir,
        argv1: process.argv[1],
      }) ?? null,
  };
  entryBoundaryInfoCache.set(cacheKey, info);
  return info;
}

function addBundledEntryCandidates(
  candidates: BundledEntryModuleCandidate[],
  basePath: string,
  boundaryRoot: string,
): void {
  for (const candidate of resolveSpecifierCandidates(basePath)) {
    if (
      candidates.some((entry) => entry.path === candidate && entry.boundaryRoot === boundaryRoot)
    ) {
      continue;
    }
    candidates.push({ path: candidate, boundaryRoot });
  }
}

function resolveBundledEntryModuleCandidates(
  importMetaUrl: string,
  specifier: string,
): BundledEntryModuleCandidate[] {
  const { importerPath, importerDir, boundaryRoot, packageRoot } =
    resolveBundledEntryBoundaryInfo(importMetaUrl);
  const candidates: BundledEntryModuleCandidate[] = [];
  const primaryResolved = path.resolve(importerDir, specifier);
  addBundledEntryCandidates(candidates, primaryResolved, boundaryRoot);

  const sourceRelativeSpecifier = specifier.replace(/^\.\/src\//u, "./");
  if (sourceRelativeSpecifier !== specifier) {
    addBundledEntryCandidates(
      candidates,
      path.resolve(importerDir, sourceRelativeSpecifier),
      boundaryRoot,
    );
  }

  if (!packageRoot) {
    return candidates;
  }

  const distExtensionsRoot = path.join(packageRoot, "dist", "extensions") + path.sep;
  if (!importerPath.startsWith(distExtensionsRoot)) {
    return candidates;
  }
  if (isTruthyEnvFlag(process.env[disableBundledEntrySourceFallbackEnv])) {
    return candidates;
  }

  const pluginDirName = path.basename(importerDir);
  const sourcePluginRoot = path.join(packageRoot, "extensions", pluginDirName);
  if (sourcePluginRoot === boundaryRoot) {
    return candidates;
  }

  // Published bundles resolve from dist first, then fall back to source so local dev checkouts
  // can exercise bundled entries without requiring a fresh package build.
  addBundledEntryCandidates(
    candidates,
    path.resolve(sourcePluginRoot, specifier),
    sourcePluginRoot,
  );
  if (sourceRelativeSpecifier !== specifier) {
    addBundledEntryCandidates(
      candidates,
      path.resolve(sourcePluginRoot, sourceRelativeSpecifier),
      sourcePluginRoot,
    );
  }
  return candidates;
}

function formatBundledEntryUnknownError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error === undefined) {
    return "boundary validation failed";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "non-serializable error";
  }
}

function formatBundledEntryModuleOpenFailure(params: {
  importMetaUrl: string;
  specifier: string;
  resolvedPath: string;
  boundaryRoot: string;
  failure: Extract<ReturnType<typeof openRootFileSync>, { ok: false }>;
}): string {
  const importerPath = fileURLToPath(params.importMetaUrl);
  const errorDetail =
    params.failure.error instanceof Error
      ? params.failure.error.message
      : formatBundledEntryUnknownError(params.failure.error);
  return [
    `bundled plugin entry "${params.specifier}" failed to open`,
    `from "${importerPath}"`,
    `(resolved "${params.resolvedPath}", plugin root "${params.boundaryRoot}",`,
    `reason "${params.failure.reason}"): ${errorDetail}`,
  ].join(" ");
}

function createBundledEntryModulePathCacheKey(importMetaUrl: string, specifier: string): string {
  const sourceFallbackDisabled = isTruthyEnvFlag(process.env[disableBundledEntrySourceFallbackEnv]);
  return `${sourceFallbackDisabled ? "1" : "0"}\0${importMetaUrl}\0${specifier}`;
}

function resolveBundledEntryModulePath(importMetaUrl: string, specifier: string): string {
  const cacheKey = createBundledEntryModulePathCacheKey(importMetaUrl, specifier);
  const cached = resolvedModulePaths.get(cacheKey);
  if (cached) {
    return cached;
  }
  const candidates = resolveBundledEntryModuleCandidates(importMetaUrl, specifier);
  const fallbackCandidate = candidates[0] ?? {
    path: path.resolve(path.dirname(fileURLToPath(importMetaUrl)), specifier),
    boundaryRoot: resolveEntryBoundaryRoot(importMetaUrl),
  };

  let firstFailure: {
    candidate: BundledEntryModuleCandidate;
    failure: Extract<ReturnType<typeof openRootFileSync>, { ok: false }>;
  } | null = null;

  for (const candidate of candidates) {
    const opened = openRootFileSync({
      absolutePath: candidate.path,
      rootPath: candidate.boundaryRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: false,
      skipLexicalRootCheck: true,
    });
    if (opened.ok) {
      fs.closeSync(opened.fd);
      resolvedModulePaths.set(cacheKey, opened.path);
      return opened.path;
    }
    firstFailure ??= { candidate, failure: opened };
  }

  const failure = firstFailure;
  if (!failure) {
    throw new Error(
      formatBundledEntryModuleOpenFailure({
        importMetaUrl,
        specifier,
        resolvedPath: fallbackCandidate.path,
        boundaryRoot: fallbackCandidate.boundaryRoot,
        failure: {
          ok: false,
          reason: "path",
          error: new Error(`ENOENT: no such file or directory, lstat '${fallbackCandidate.path}'`),
        },
      }),
    );
  }

  throw new Error(
    formatBundledEntryModuleOpenFailure({
      importMetaUrl,
      specifier,
      resolvedPath: failure.candidate.path,
      boundaryRoot: failure.candidate.boundaryRoot,
      failure: failure.failure,
    }),
  );
}

function getSourceModuleLoader(modulePath: string, options: BundledEntryModuleLoadOptions) {
  return getCachedPluginSourceModuleLoader({
    cache: moduleLoaders,
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    loaderFilename: import.meta.url,
    ...(options.createLoaderForTest ? { createLoader: options.createLoaderForTest } : {}),
  });
}

function canTryNodeRequireBuiltModule(modulePath: string): boolean {
  const isBuiltBundledArtifact =
    modulePath.includes(`${path.sep}dist${path.sep}`) ||
    modulePath.includes(`${path.sep}dist-runtime${path.sep}`);
  return (
    isBuiltBundledArtifact &&
    [".js", ".mjs", ".cjs"].includes(normalizeLowercaseStringOrEmpty(path.extname(modulePath)))
  );
}

function loadBundledEntryModuleSync(
  importMetaUrl: string,
  specifier: string,
  options: BundledEntryModuleLoadOptions = {},
): unknown {
  const modulePath = resolveBundledEntryModulePath(importMetaUrl, specifier);
  const cached = loadedModuleExports.get(modulePath);
  if (cached !== undefined) {
    return cached;
  }
  let loaded: unknown;
  const profile = shouldProfilePluginLoader();
  const loadStartMs = profile ? performance.now() : 0;
  let sourceLoaderReadyMs = 0;
  if (canTryNodeRequireBuiltModule(modulePath)) {
    const native = tryNativeRequireJavaScriptModule(modulePath, {
      allowWindows: true,
      aliasMap: buildPluginLoaderAliasMap(modulePath, process.argv[1], import.meta.url, "dist"),
      fallbackOnMissingDependency: true,
      fallbackOnNativeError: true,
    });
    if (native.ok) {
      loaded = native.moduleExport;
    } else {
      const moduleLoader = getSourceModuleLoader(modulePath, options);
      sourceLoaderReadyMs = profile ? performance.now() : 0;
      loaded = moduleLoader(toSafeImportPath(modulePath));
    }
  } else {
    const moduleLoader = getSourceModuleLoader(modulePath, options);
    sourceLoaderReadyMs = profile ? performance.now() : 0;
    loaded = moduleLoader(toSafeImportPath(modulePath));
  }
  if (profile) {
    const endMs = performance.now();
    // Use shared formatter — but split timing fields ourselves so we can
    // attribute time spent in source-loader creation vs the actual graph load.
    // Both are emitted as extras
    // alongside the canonical `elapsedMs=<total>` field.
    console.error(
      formatPluginLoadProfileLine({
        phase: "bundled-entry-module-load",
        pluginId: "(bundled-entry)",
        source: modulePath,
        elapsedMs: endMs - loadStartMs,
        // When the built-artifact fast path resolves natively, the
        // source-loader timestamp stays `0`; keep its breakdown at zero so
        // `elapsedMs=` owns the native load time.
        extras: [
          ["sourceLoaderCreateMs", sourceLoaderReadyMs ? sourceLoaderReadyMs - loadStartMs : 0],
          ["sourceLoaderCallMs", sourceLoaderReadyMs ? endMs - sourceLoaderReadyMs : 0],
        ],
      }),
    );
  }
  loadedModuleExports.set(modulePath, loaded);
  return loaded;
}

/** Loads one export from a bundled channel sidecar module through the guarded entry boundary. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- Dynamic entry export loaders use caller-supplied export types.
export function loadBundledEntryExportSync<T>(
  importMetaUrl: string,
  reference: BundledEntryModuleRef,
  options?: BundledEntryModuleLoadOptions,
): T {
  const loaded = loadBundledEntryModuleSync(importMetaUrl, reference.specifier, options);
  const resolved =
    loaded && typeof loaded === "object" && "default" in (loaded as Record<string, unknown>)
      ? (loaded as { default: unknown }).default
      : loaded;
  if (!reference.exportName) {
    return resolved as T;
  }
  const record = (resolved ?? loaded) as Record<string, unknown> | undefined;
  if (!record || !(reference.exportName in record)) {
    throw new Error(
      `missing export "${reference.exportName}" from bundled entry module ${reference.specifier}`,
    );
  }
  return record[reference.exportName] as T;
}

/** Defines the full bundled channel entry contract used by core plugin registration. */
export function defineBundledChannelEntry<TPlugin = ChannelPlugin>({
  id,
  name,
  description,
  importMetaUrl,
  plugin,
  outbound,
  secrets,
  configSchema,
  runtime,
  accountInspect,
  features,
  registerCliMetadata,
  registerFull,
}: DefineBundledChannelEntryOptions<TPlugin>): BundledChannelEntryContract<TPlugin> {
  const resolvedConfigSchema: ChannelEntryConfigSchema<TPlugin> =
    typeof configSchema === "function"
      ? configSchema()
      : ((configSchema ?? emptyChannelConfigSchema()) as ChannelEntryConfigSchema<TPlugin>);
  const loadChannelPlugin = (options?: BundledEntryModuleLoadOptions) =>
    loadBundledEntryExportSync<TPlugin>(importMetaUrl, plugin, options);
  const loadChannelOutbound = outbound
    ? (options?: BundledEntryModuleLoadOptions) =>
        loadBundledEntryExportSync<ChannelOutboundAdapter | undefined>(
          importMetaUrl,
          outbound,
          options,
        )
    : undefined;
  const loadChannelSecrets = secrets
    ? (options?: BundledEntryModuleLoadOptions) =>
        loadBundledEntryExportSync<ChannelPlugin["secrets"] | undefined>(
          importMetaUrl,
          secrets,
          options,
        )
    : undefined;
  const loadChannelAccountInspector = accountInspect
    ? (options?: BundledEntryModuleLoadOptions) =>
        loadBundledEntryExportSync<NonNullable<ChannelPlugin["config"]["inspectAccount"]>>(
          importMetaUrl,
          accountInspect,
          options,
        )
    : undefined;
  const setChannelRuntime = runtime
    ? (pluginRuntime: BundledChannelRuntime) => {
        const setter = loadBundledEntryExportSync<(runtime: BundledChannelRuntime) => void>(
          importMetaUrl,
          runtime,
        );
        setter(pluginRuntime);
      }
    : undefined;

  return {
    kind: "bundled-channel-entry",
    id,
    name,
    description,
    configSchema: resolvedConfigSchema,
    ...(features || accountInspect
      ? { features: { ...features, ...(accountInspect ? { accountInspect: true } : {}) } }
      : {}),
    register(api: OpenClawPluginApi) {
      if (api.registrationMode === "cli-metadata") {
        registerCliMetadata?.(api);
        return;
      }
      if (api.registrationMode === "tool-discovery") {
        const profile = createProfiler({ pluginId: id, source: importMetaUrl });
        profile("bundled-register:registerFull", () => registerFull?.(api));
        return;
      }
      const profile = createProfiler({ pluginId: id, source: importMetaUrl });
      const channelPlugin = profile("bundled-register:loadChannelPlugin", loadChannelPlugin);
      profile("bundled-register:registerChannel", () =>
        api.registerChannel({ plugin: channelPlugin as ChannelPlugin }),
      );
      profile("bundled-register:setChannelRuntime", () => setChannelRuntime?.(api.runtime));
      if (api.registrationMode === "discovery") {
        profile("bundled-register:registerCliMetadata", () => registerCliMetadata?.(api));
        return;
      }
      if (api.registrationMode !== "full") {
        return;
      }
      profile("bundled-register:registerCliMetadata", () => registerCliMetadata?.(api));
      profile("bundled-register:registerFull", () => registerFull?.(api));
    },
    loadChannelPlugin,
    ...(loadChannelOutbound ? { loadChannelOutbound } : {}),
    ...(loadChannelSecrets ? { loadChannelSecrets } : {}),
    ...(loadChannelAccountInspector ? { loadChannelAccountInspector } : {}),
    ...(setChannelRuntime ? { setChannelRuntime } : {}),
  };
}

/** Defines the setup-only bundled channel entry contract for onboarding and migration surfaces. */
export function defineBundledChannelSetupEntry<TPlugin = ChannelPlugin>({
  importMetaUrl,
  plugin,
  secrets,
  runtime,
  legacyStateMigrations,
  legacySessionSurface,
  registerSetupRuntime,
  features,
}: DefineBundledChannelSetupEntryOptions): BundledChannelSetupEntryContract<TPlugin> {
  // Bundled setup entries stay on a light path during setup-only/setup-runtime loads.
  // When runtime wiring is needed, expose only the setter so the loader can hand
  // the setup surface the active runtime without importing the full channel entry.
  const setChannelRuntime = runtime
    ? (pluginRuntime: BundledChannelRuntime) => {
        const setter = loadBundledEntryExportSync<(runtime: BundledChannelRuntime) => void>(
          importMetaUrl,
          runtime,
        );
        setter(pluginRuntime);
      }
    : undefined;
  const loadLegacyStateMigrationDetector = legacyStateMigrations
    ? (options?: BundledEntryModuleLoadOptions) =>
        loadBundledEntryExportSync<BundledChannelLegacyStateMigrationDetector>(
          importMetaUrl,
          legacyStateMigrations,
          options,
        )
    : undefined;
  const loadLegacySessionSurface = legacySessionSurface
    ? (options?: BundledEntryModuleLoadOptions) =>
        loadBundledEntryExportSync<BundledChannelLegacySessionSurface>(
          importMetaUrl,
          legacySessionSurface,
          options,
        )
    : undefined;
  return {
    kind: "bundled-channel-setup-entry",
    loadSetupPlugin: (options) =>
      loadBundledEntryExportSync<TPlugin>(importMetaUrl, plugin, options),
    ...(secrets
      ? {
          loadSetupSecrets: (options) =>
            loadBundledEntryExportSync<ChannelPlugin["secrets"] | undefined>(
              importMetaUrl,
              secrets,
              options,
            ),
        }
      : {}),
    ...(loadLegacyStateMigrationDetector ? { loadLegacyStateMigrationDetector } : {}),
    ...(loadLegacySessionSurface ? { loadLegacySessionSurface } : {}),
    ...(setChannelRuntime ? { setChannelRuntime } : {}),
    ...(registerSetupRuntime ? { registerSetupRuntime } : {}),
    ...(features ? { features } : {}),
  };
}
