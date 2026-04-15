import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveOpenClawPackageRootSync } from "../../infra/openclaw-root.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  listBundledChannelPluginMetadata,
  resolveBundledChannelGeneratedPath,
  type BundledChannelPluginMetadata,
} from "../../plugins/bundled-channel-runtime.js";
import { unwrapDefaultModuleExport } from "../../plugins/module-export.js";
import type { PluginRuntime } from "../../plugins/runtime/types.js";
import { isJavaScriptModulePath, loadChannelPluginModule } from "./module-loader.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelId } from "./types.public.js";

type BundledChannelEntryRuntimeContract = {
  kind: "bundled-channel-entry";
  id: string;
  name: string;
  description: string;
  register: (api: unknown) => void;
  loadChannelPlugin: () => ChannelPlugin;
  loadChannelSecrets?: () => ChannelPlugin["secrets"] | undefined;
  setChannelRuntime?: (runtime: PluginRuntime) => void;
};

type BundledChannelSetupEntryRuntimeContract = {
  kind: "bundled-channel-setup-entry";
  loadSetupPlugin: () => ChannelPlugin;
  loadSetupSecrets?: () => ChannelPlugin["secrets"] | undefined;
  features?: {
    legacyStateMigrations?: boolean;
    legacySessionSurfaces?: boolean;
  };
};

type GeneratedBundledChannelEntry = {
  id: string;
  entry: BundledChannelEntryRuntimeContract;
  setupEntry?: BundledChannelSetupEntryRuntimeContract;
};

const log = createSubsystemLogger("channels");
const OPENCLAW_PACKAGE_ROOT =
  resolveOpenClawPackageRootSync({
    argv1: process.argv[1],
    cwd: process.cwd(),
    moduleUrl: import.meta.url.startsWith("file:") ? import.meta.url : undefined,
  }) ??
  (import.meta.url.startsWith("file:")
    ? path.resolve(fileURLToPath(new URL("../../..", import.meta.url)))
    : process.cwd());

function resolveChannelPluginModuleEntry(
  moduleExport: unknown,
): BundledChannelEntryRuntimeContract | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelEntryRuntimeContract>;
  if (record.kind !== "bundled-channel-entry") {
    return null;
  }
  if (
    typeof record.id !== "string" ||
    typeof record.name !== "string" ||
    typeof record.description !== "string" ||
    typeof record.register !== "function" ||
    typeof record.loadChannelPlugin !== "function"
  ) {
    return null;
  }
  return record as BundledChannelEntryRuntimeContract;
}

function resolveChannelSetupModuleEntry(
  moduleExport: unknown,
): BundledChannelSetupEntryRuntimeContract | null {
  const resolved = unwrapDefaultModuleExport(moduleExport);
  if (!resolved || typeof resolved !== "object") {
    return null;
  }
  const record = resolved as Partial<BundledChannelSetupEntryRuntimeContract>;
  if (record.kind !== "bundled-channel-setup-entry") {
    return null;
  }
  if (typeof record.loadSetupPlugin !== "function") {
    return null;
  }
  return record as BundledChannelSetupEntryRuntimeContract;
}

function hasSetupEntryFeature(
  entry: BundledChannelSetupEntryRuntimeContract | undefined,
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
): boolean {
  return entry?.features?.[feature] === true;
}

function resolveBundledChannelBoundaryRoot(params: {
  metadata: BundledChannelPluginMetadata;
  modulePath: string;
}): string {
  const distRoot = path.resolve(
    OPENCLAW_PACKAGE_ROOT,
    "dist",
    "extensions",
    params.metadata.dirName,
  );
  if (params.modulePath === distRoot || params.modulePath.startsWith(`${distRoot}${path.sep}`)) {
    return distRoot;
  }
  return path.resolve(OPENCLAW_PACKAGE_ROOT, "extensions", params.metadata.dirName);
}

function resolveGeneratedBundledChannelModulePath(params: {
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): string | null {
  if (!params.entry) {
    return null;
  }
  const resolved = resolveBundledChannelGeneratedPath(
    OPENCLAW_PACKAGE_ROOT,
    params.entry,
    params.metadata.dirName,
  );
  if (resolved) {
    return resolved;
  }
  return null;
}

function loadGeneratedBundledChannelModule(params: {
  metadata: BundledChannelPluginMetadata;
  entry: BundledChannelPluginMetadata["source"] | BundledChannelPluginMetadata["setupSource"];
}): unknown {
  const modulePath = resolveGeneratedBundledChannelModulePath(params);
  if (!modulePath) {
    throw new Error(`missing generated module for bundled channel ${params.metadata.manifest.id}`);
  }
  return loadChannelPluginModule({
    modulePath,
    rootDir: resolveBundledChannelBoundaryRoot({
      metadata: params.metadata,
      modulePath,
    }),
    boundaryRootDir: resolveBundledChannelBoundaryRoot({
      metadata: params.metadata,
      modulePath,
    }),
    shouldTryNativeRequire: (safePath) =>
      safePath.includes(`${path.sep}dist${path.sep}`) && isJavaScriptModulePath(safePath),
  });
}

function loadGeneratedBundledChannelEntry(params: {
  metadata: BundledChannelPluginMetadata;
  includeSetup: boolean;
}): GeneratedBundledChannelEntry | null {
  try {
    const entry = resolveChannelPluginModuleEntry(
      loadGeneratedBundledChannelModule({
        metadata: params.metadata,
        entry: params.metadata.source,
      }),
    );
    if (!entry) {
      log.warn(
        `[channels] bundled channel entry ${params.metadata.manifest.id} missing bundled-channel-entry contract; skipping`,
      );
      return null;
    }
    const setupEntry =
      params.includeSetup && params.metadata.setupSource
        ? resolveChannelSetupModuleEntry(
            loadGeneratedBundledChannelModule({
              metadata: params.metadata,
              entry: params.metadata.setupSource,
            }),
          )
        : null;
    return {
      id: params.metadata.manifest.id,
      entry,
      ...(setupEntry ? { setupEntry } : {}),
    };
  } catch (error) {
    const detail = formatErrorMessage(error);
    log.warn(`[channels] failed to load bundled channel ${params.metadata.manifest.id}: ${detail}`);
    return null;
  }
}

let cachedBundledChannelMetadata: readonly BundledChannelPluginMetadata[] | null = null;

function listBundledChannelMetadata(): readonly BundledChannelPluginMetadata[] {
  cachedBundledChannelMetadata ??= listBundledChannelPluginMetadata({
    includeChannelConfigs: false,
    includeSyntheticChannelConfigs: false,
  }).filter((metadata) => (metadata.manifest.channels?.length ?? 0) > 0);
  return cachedBundledChannelMetadata;
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listBundledChannelMetadata()
    .map((metadata) => metadata.manifest.id)
    .toSorted((left, right) => left.localeCompare(right));
}

const pluginLoadInProgressIds = new Set<ChannelId>();
const setupPluginLoadInProgressIds = new Set<ChannelId>();
const entryLoadInProgressIds = new Set<ChannelId>();
const lazyEntriesById = new Map<ChannelId, GeneratedBundledChannelEntry | null>();
const lazyPluginsById = new Map<ChannelId, ChannelPlugin>();
const lazySetupPluginsById = new Map<ChannelId, ChannelPlugin>();
const lazySecretsById = new Map<ChannelId, ChannelPlugin["secrets"] | null>();
const lazySetupSecretsById = new Map<ChannelId, ChannelPlugin["secrets"] | null>();

function resolveBundledChannelMetadata(id: ChannelId): BundledChannelPluginMetadata | undefined {
  return listBundledChannelMetadata().find(
    (metadata) => metadata.manifest.id === id || metadata.manifest.channels?.includes(id),
  );
}

function getLazyGeneratedBundledChannelEntry(
  id: ChannelId,
  params?: { includeSetup?: boolean },
): GeneratedBundledChannelEntry | null {
  const cached = lazyEntriesById.get(id);
  if (cached && (!params?.includeSetup || cached.setupEntry)) {
    return cached;
  }
  if (cached === null && !params?.includeSetup) {
    return null;
  }
  const metadata = resolveBundledChannelMetadata(id);
  if (!metadata) {
    lazyEntriesById.set(id, null);
    return null;
  }
  if (entryLoadInProgressIds.has(id)) {
    return null;
  }
  entryLoadInProgressIds.add(id);
  try {
    const entry = loadGeneratedBundledChannelEntry({
      metadata,
      includeSetup: params?.includeSetup === true,
    });
    lazyEntriesById.set(id, entry);
    if (entry?.entry.id && entry.entry.id !== id) {
      lazyEntriesById.set(entry.entry.id, entry);
    }
    return entry;
  } finally {
    entryLoadInProgressIds.delete(id);
  }
}

export function listBundledChannelPlugins(): readonly ChannelPlugin[] {
  return listBundledChannelPluginIds().flatMap((id) => {
    const plugin = getBundledChannelPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPlugins(): readonly ChannelPlugin[] {
  return listBundledChannelPluginIds().flatMap((id) => {
    const plugin = getBundledChannelSetupPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function listBundledChannelSetupPluginsByFeature(
  feature: keyof NonNullable<BundledChannelSetupEntryRuntimeContract["features"]>,
): readonly ChannelPlugin[] {
  return listBundledChannelPluginIds().flatMap((id) => {
    const setupEntry = getLazyGeneratedBundledChannelEntry(id, { includeSetup: true })?.setupEntry;
    if (!hasSetupEntryFeature(setupEntry, feature)) {
      return [];
    }
    const plugin = getBundledChannelSetupPlugin(id);
    return plugin ? [plugin] : [];
  });
}

export function getBundledChannelPlugin(id: ChannelId): ChannelPlugin | undefined {
  const cached = lazyPluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (pluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntry(id)?.entry;
  if (!entry) {
    return undefined;
  }
  pluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadChannelPlugin();
    lazyPluginsById.set(id, plugin);
    return plugin;
  } finally {
    pluginLoadInProgressIds.delete(id);
  }
}

export function getBundledChannelSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  if (lazySecretsById.has(id)) {
    return lazySecretsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntry(id)?.entry;
  if (!entry) {
    return undefined;
  }
  const secrets = entry.loadChannelSecrets?.() ?? getBundledChannelPlugin(id)?.secrets;
  lazySecretsById.set(id, secrets ?? null);
  return secrets;
}

export function getBundledChannelSetupPlugin(id: ChannelId): ChannelPlugin | undefined {
  const cached = lazySetupPluginsById.get(id);
  if (cached) {
    return cached;
  }
  if (setupPluginLoadInProgressIds.has(id)) {
    return undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntry(id, { includeSetup: true })?.setupEntry;
  if (!entry) {
    return undefined;
  }
  setupPluginLoadInProgressIds.add(id);
  try {
    const plugin = entry.loadSetupPlugin();
    lazySetupPluginsById.set(id, plugin);
    return plugin;
  } finally {
    setupPluginLoadInProgressIds.delete(id);
  }
}

export function getBundledChannelSetupSecrets(id: ChannelId): ChannelPlugin["secrets"] | undefined {
  if (lazySetupSecretsById.has(id)) {
    return lazySetupSecretsById.get(id) ?? undefined;
  }
  const entry = getLazyGeneratedBundledChannelEntry(id, { includeSetup: true })?.setupEntry;
  if (!entry) {
    return undefined;
  }
  const secrets = entry.loadSetupSecrets?.() ?? getBundledChannelSetupPlugin(id)?.secrets;
  lazySetupSecretsById.set(id, secrets ?? null);
  return secrets;
}

export function requireBundledChannelPlugin(id: ChannelId): ChannelPlugin {
  const plugin = getBundledChannelPlugin(id);
  if (!plugin) {
    throw new Error(`missing bundled channel plugin: ${id}`);
  }
  return plugin;
}

export function setBundledChannelRuntime(id: ChannelId, runtime: PluginRuntime): void {
  const setter = getLazyGeneratedBundledChannelEntry(id)?.entry.setChannelRuntime;
  if (!setter) {
    throw new Error(`missing bundled channel runtime setter: ${id}`);
  }
  setter(runtime);
}
