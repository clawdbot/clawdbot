import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyChannelConfigSchema } from "../channels/plugins/config-schema.js";
import type { ChannelConfigSchema } from "../channels/plugins/types.config.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  getCachedPluginJitiLoader,
  type PluginJitiLoaderCache,
} from "../plugins/jiti-loader-cache.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { resolveLoaderPackageRoot } from "../plugins/sdk-alias.js";
import type { AnyAgentTool, OpenClawPluginApi, PluginCommandContext } from "../plugins/types.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

export type { AnyAgentTool, OpenClawPluginApi, PluginCommandContext };

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
  features?: BundledChannelSetupEntryFeatures;
};

export type BundledChannelSetupEntryFeatures = {
  legacyStateMigrations?: boolean;
  legacySessionSurfaces?: boolean;
};

export type BundledChannelEntryFeatures = {
  accountInspect?: boolean;
};

export type BundledChannelEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  configSchema: ChannelEntryConfigSchema<TPlugin>;
  features?: BundledChannelEntryFeatures;
  register: (api: OpenClawPluginApi) => void;
  loadChannelPlugin: () => TPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  loadChannelAccountInspector?: () => NonNullable<ChannelPlugin["config"]["inspectAccount"]>;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

export type BundledChannelSetupEntryContract<TPlugin = ChannelPlugin> = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: () => TPlugin;
  loadSetupSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
  features?: BundledChannelSetupEntryFeatures;
};

const nodeRequire = createRequire(import.meta.url);
const jitiLoaders: PluginJitiLoaderCache = new Map();
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
  const importerPath = fileURLToPath(importMetaUrl);
  const importerDir = path.dirname(importerPath);
  const boundaryRoot = resolveEntryBoundaryRoot(importMetaUrl);
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

  const packageRoot = resolveLoaderPackageRoot({
    modulePath: importerPath,
    moduleUrl: importMetaUrl,
    cwd: importerDir,
    argv1: process.argv[1],
  });
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
  failure: Extract<ReturnType<typeof openBoundaryFileSync>, { ok: false }>;
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

function resolveBundledEntryModulePath(importMetaUrl: string, specifier: string): string {
  const candidates = resolveBundledEntryModuleCandidates(importMetaUrl, specifier);
  const fallbackCandidate = candidates[0] ?? {
    path: path.resolve(path.dirname(fileURLToPath(importMetaUrl)), specifier),
    boundaryRoot: resolveEntryBoundaryRoot(importMetaUrl),
  };

  let firstFailure: {
    candidate: BundledEntryModuleCandidate;
    failure: Extract<ReturnType<typeof openBoundaryFileSync>, { ok: false }>;
  } | null = null;

  for (const candidate of candidates) {
    const opened = openBoundaryFileSync({
      absolutePath: candidate.path,
      rootPath: candidate.boundaryRoot,
      boundaryLabel: "plugin root",
      rejectHardlinks: false,
      skipLexicalRootCheck: true,
    });
    if (opened.ok) {
      fs.closeSync(opened.fd);
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

function getJiti(modulePath: string) {
  return getCachedPluginJitiLoader({
    cache: jitiLoaders,
    modulePath,
    importerUrl: import.meta.url,
    preferBuiltDist: true,
    jitiFilename: import.meta.url,
  });
}

function loadBundledEntryModuleSync(importMetaUrl: string, specifier: string): unknown {
  const modulePath = resolveBundledEntryModulePath(importMetaUrl, specifier);
  const cached = loadedModuleExports.get(modulePath);
  if (cached !== undefined) {
    return cached;
  }
  let loaded: unknown;
  if (
    process.platform === "win32" &&
    modulePath.includes(`${path.sep}dist${path.sep}`) &&
    [".js", ".mjs", ".cjs"].includes(normalizeLowercaseStringOrEmpty(path.extname(modulePath)))
  ) {
    try {
      loaded = nodeRequire(modulePath);
    } catch {
      loaded = getJiti(modulePath)(modulePath);
    }
  } else {
    loaded = getJiti(modulePath)(modulePath);
  }
  loadedModuleExports.set(modulePath, loaded);
  return loaded;
}

export function loadBundledEntryExportSync<T>(
  importMetaUrl: string,
  reference: BundledEntryModuleRef,
): T {
  const loaded = loadBundledEntryModuleSync(importMetaUrl, reference.specifier);
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

export function defineBundledChannelEntry<TPlugin = ChannelPlugin>({
  id,
  name,
  description,
  importMetaUrl,
  plugin,
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
  const loadChannelPlugin = () => loadBundledEntryExportSync<TPlugin>(importMetaUrl, plugin);
  const loadChannelSecrets = secrets
    ? () => loadBundledEntryExportSync<ChannelPlugin["secrets"] | undefined>(importMetaUrl, secrets)
    : undefined;
  const loadChannelAccountInspector = accountInspect
    ? () =>
        loadBundledEntryExportSync<NonNullable<ChannelPlugin["config"]["inspectAccount"]>>(
          importMetaUrl,
          accountInspect,
        )
    : undefined;
  const setChannelRuntime = runtime
    ? (pluginRuntime: PluginRuntime) => {
        const setter = loadBundledEntryExportSync<(runtime: PluginRuntime) => void>(
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
      setChannelRuntime?.(api.runtime);
      api.registerChannel({ plugin: loadChannelPlugin() as ChannelPlugin });
      if (api.registrationMode !== "full") {
        return;
      }
      registerCliMetadata?.(api);
      registerFull?.(api);
    },
    loadChannelPlugin,
    ...(loadChannelSecrets ? { loadChannelSecrets } : {}),
    ...(loadChannelAccountInspector ? { loadChannelAccountInspector } : {}),
    ...(setChannelRuntime ? { setChannelRuntime } : {}),
  };
}

export function defineBundledChannelSetupEntry<TPlugin = ChannelPlugin>({
  importMetaUrl,
  plugin,
  secrets,
  runtime,
  features,
}: DefineBundledChannelSetupEntryOptions): BundledChannelSetupEntryContract<TPlugin> {
  // Bundled setup entries stay on a light path during setup-only/setup-runtime loads.
  // When runtime wiring is needed, expose only the setter so the loader can hand
  // the setup surface the active runtime without importing the full channel entry.
  const setChannelRuntime = runtime
    ? (pluginRuntime: PluginRuntime) => {
        const setter = loadBundledEntryExportSync<(runtime: PluginRuntime) => void>(
          importMetaUrl,
          runtime,
        );
        setter(pluginRuntime);
      }
    : undefined;
  return {
    kind: "bundled-channel-setup-entry",
    loadSetupPlugin: () => loadBundledEntryExportSync<TPlugin>(importMetaUrl, plugin),
    ...(secrets
      ? {
          loadSetupSecrets: () =>
            loadBundledEntryExportSync<ChannelPlugin["secrets"] | undefined>(
              importMetaUrl,
              secrets,
            ),
        }
      : {}),
    ...(setChannelRuntime ? { setChannelRuntime } : {}),
    ...(features ? { features } : {}),
  };
}
