/**
 * Bundled channel plugin contract loader.
 *
 * Loads public plugin surfaces and directory contract artifacts without reaching into private sources.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadBundledPluginPublicSurface,
  resolveBundledPluginPublicModulePath,
} from "../../../../test-utils/bundled-plugin-public-surface.js";
import { listBundledChannelPluginIds as listCatalogBundledChannelPluginIds } from "../../bundled-ids.js";
import type { ChannelId } from "../../channel-id.types.js";
import type { ChannelPlugin } from "../../types.js";

type ChannelPluginApiModule = Record<string, unknown>;
type ChannelDirectoryContractModule = Record<string, unknown>;

const channelPluginCache = new Map<ChannelId, ChannelPlugin | null>();
const channelPluginPromiseCache = new Map<ChannelId, Promise<ChannelPlugin | null>>();
const channelDirectoryPluginCache = new Map<
  ChannelId,
  Pick<ChannelPlugin, "id" | "directory"> | null
>();
const channelDirectoryPluginPromiseCache = new Map<
  ChannelId,
  Promise<Pick<ChannelPlugin, "id" | "directory"> | null>
>();

class MissingBundledDirectoryContractArtifactError extends Error {
  constructor(id: ChannelId) {
    super(`Missing bundled directory contract artifact for ${id}`);
    this.name = "MissingBundledDirectoryContractArtifactError";
  }
}

function isChannelPlugin(value: unknown): value is ChannelPlugin {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).meta) &&
    Boolean((value as Partial<ChannelPlugin>).config)
  );
}

function isChannelDirectoryContractPlugin(
  value: unknown,
): value is Pick<ChannelPlugin, "id" | "directory"> {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof (value as Partial<ChannelPlugin>).id === "string" &&
    Boolean((value as Partial<ChannelPlugin>).directory)
  );
}

function findChannelPlugin(module: ChannelPluginApiModule): ChannelPlugin | null {
  return Object.values(module).find(isChannelPlugin) ?? null;
}

function findChannelDirectoryContractPlugin(
  module: ChannelDirectoryContractModule,
): Pick<ChannelPlugin, "id" | "directory"> | null {
  return Object.values(module).find(isChannelDirectoryContractPlugin) ?? null;
}

function hasBasePluginMetadata(plugin: ChannelPlugin | null, id: ChannelId): boolean {
  return (
    plugin?.id === id &&
    plugin.meta?.id === id &&
    typeof plugin.meta.label === "string" &&
    typeof plugin.meta.selectionLabel === "string" &&
    typeof plugin.meta.docsPath === "string" &&
    typeof plugin.meta.blurb === "string"
  );
}

function isBuiltArtifactMissingDependency(error: unknown): boolean {
  const record = error as
    | {
        code?: unknown;
        message?: unknown;
        requireStack?: unknown;
        stack?: unknown;
      }
    | undefined;
  const requireStack = Array.isArray(record?.requireStack)
    ? record.requireStack.filter((entry): entry is string => typeof entry === "string")
    : [];
  const text = [
    typeof record?.message === "string" ? record.message : "",
    typeof record?.stack === "string" ? record.stack : "",
    requireStack.join("\n"),
  ].join("\n");
  return (
    (record?.code === "MODULE_NOT_FOUND" || record?.code === "ERR_MODULE_NOT_FOUND") &&
    isBareMissingModuleSpecifier(text) &&
    (requireStack.some((entry) => isExternalDistArtifactPath(entry)) ||
      hasExternalDistArtifactPath(text))
  );
}

function isBareMissingModuleSpecifier(text: string): boolean {
  const match = text.match(/Cannot find (?:module|package) ['"]([^'"]+)['"]/u);
  const specifier = match?.[1];
  return Boolean(
    specifier &&
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !path.win32.isAbsolute(specifier),
  );
}

function hasExternalDistArtifactPath(text: string): boolean {
  const candidates = [
    ...text.matchAll(/file:\/\/(\/[^\s)]+[/\\]dist(?:-runtime)?[/\\][^\s)]*)/gu),
    ...text.matchAll(/(\b[A-Za-z]:\\[^\s)]+\\dist(?:-runtime)?\\[^\s)]*)/gu),
    ...text.matchAll(/(\/[^\s)]+[/\\]dist(?:-runtime)?[/\\][^\s)]*)/gu),
  ];
  return candidates.some((match) => {
    const candidate = match[1];
    return Boolean(candidate && isExternalDistArtifactPath(candidate));
  });
}

function canFallbackToPackageSource(): boolean {
  return !process.env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
}

function isExternalDistArtifactPath(entry: string): boolean {
  const isDistPath =
    entry.includes("/dist/") ||
    entry.includes("\\dist\\") ||
    entry.includes("/dist-runtime/") ||
    entry.includes("\\dist-runtime\\");
  if (!isDistPath || !path.isAbsolute(entry)) {
    return false;
  }
  const relativeToCwd = path.relative(process.cwd(), entry);
  return relativeToCwd.startsWith("..") || path.isAbsolute(relativeToCwd);
}

async function importBundledChannelPluginSourceSurface(id: ChannelId) {
  const artifactPath = resolveBundledPluginPublicModulePath({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  });
  const sourcePath =
    artifactPath.endsWith(".js") && fs.existsSync(`${artifactPath.slice(0, -3)}.ts`)
      ? `${artifactPath.slice(0, -3)}.ts`
      : artifactPath;
  return (await import(pathToFileURL(sourcePath).href)) as ChannelPluginApiModule;
}

function resolveSourceArtifactPath(artifactPath: string): string {
  if (artifactPath.endsWith(".js") && fs.existsSync(`${artifactPath.slice(0, -3)}.ts`)) {
    return `${artifactPath.slice(0, -3)}.ts`;
  }
  return artifactPath;
}

async function importBundledChannelDirectoryContractSourceSurface(
  id: ChannelId,
): Promise<ChannelDirectoryContractModule> {
  const artifactPath = resolveBundledPluginPublicModulePath({
    pluginId: id,
    artifactBasename: "directory-contract-api.js",
  });
  const sourcePath = resolveSourceArtifactPath(artifactPath);
  if (!fs.existsSync(sourcePath)) {
    throw new MissingBundledDirectoryContractArtifactError(id);
  }
  return (await import(pathToFileURL(sourcePath).href)) as ChannelDirectoryContractModule;
}

function isMissingBundledDirectoryContractArtifact(error: unknown, id: ChannelId): boolean {
  return (
    error instanceof Error &&
    error.message ===
      `Unable to resolve bundled plugin public surface ${id}/directory-contract-api.js`
  );
}

async function loadBundledChannelDirectoryContractSurface(
  id: ChannelId,
): Promise<ChannelDirectoryContractModule> {
  return await loadBundledPluginPublicSurface<ChannelDirectoryContractModule>({
    pluginId: id,
    artifactBasename: "directory-contract-api.js",
  }).catch((error: unknown) => {
    if (isMissingBundledDirectoryContractArtifact(error, id)) {
      throw new MissingBundledDirectoryContractArtifactError(id);
    }
    if (!isBuiltArtifactMissingDependency(error) || !canFallbackToPackageSource()) {
      throw error;
    }
    return importBundledChannelDirectoryContractSourceSurface(id);
  });
}

async function resolveBundledChannelPluginFromSurface(
  id: ChannelId,
  loaded: ChannelPluginApiModule,
): Promise<ChannelPlugin | null> {
  const plugin = findChannelPlugin(loaded);
  if (!plugin) {
    return plugin;
  }
  if (hasBasePluginMetadata(plugin, id)) {
    return plugin;
  }

  const sourceLoaded = await importBundledChannelPluginSourceSurface(id);
  const sourcePlugin = findChannelPlugin(sourceLoaded);
  return sourcePlugin ?? plugin;
}

export function listBundledChannelPluginIds(): readonly ChannelId[] {
  return listCatalogBundledChannelPluginIds() as ChannelId[];
}

/** Returns a bundled channel plugin from its generated public API artifact. */
export async function getBundledChannelPluginAsync(
  id: ChannelId,
): Promise<ChannelPlugin | undefined> {
  if (channelPluginCache.has(id)) {
    return channelPluginCache.get(id) ?? undefined;
  }

  const cachedPromise = channelPluginPromiseCache.get(id);
  if (cachedPromise) {
    return (await cachedPromise) ?? undefined;
  }

  // Cache both resolved plugins and in-flight loads so sharded contract suites
  // do not repeatedly import the same generated plugin artifact.
  const loading = loadBundledPluginPublicSurface<ChannelPluginApiModule>({
    pluginId: id,
    artifactBasename: "channel-plugin-api.js",
  })
    .catch((error: unknown) => {
      if (!isBuiltArtifactMissingDependency(error) || !canFallbackToPackageSource()) {
        throw error;
      }
      return importBundledChannelPluginSourceSurface(id);
    })
    .then(async (loaded) => {
      const plugin = await resolveBundledChannelPluginFromSurface(id, loaded);
      channelPluginCache.set(id, plugin);
      return plugin;
    })
    .finally(() => {
      channelPluginPromiseCache.delete(id);
    });
  channelPluginPromiseCache.set(id, loading);
  return (await loading) ?? undefined;
}

export async function getBundledChannelDirectoryPluginAsync(
  id: ChannelId,
): Promise<Pick<ChannelPlugin, "id" | "directory"> | undefined> {
  if (channelDirectoryPluginCache.has(id)) {
    return channelDirectoryPluginCache.get(id) ?? undefined;
  }

  const cachedPromise = channelDirectoryPluginPromiseCache.get(id);
  if (cachedPromise) {
    return (await cachedPromise) ?? undefined;
  }

  const loading = loadBundledChannelDirectoryContractSurface(id)
    .catch(async (error: unknown) => {
      if (error instanceof MissingBundledDirectoryContractArtifactError) {
        return null;
      }
      throw error;
    })
    .then(async (loaded) => {
      if (!loaded) {
        return (await getBundledChannelPluginAsync(id)) ?? null;
      }
      const plugin = findChannelDirectoryContractPlugin(loaded);
      return plugin ?? (await getBundledChannelPluginAsync(id)) ?? null;
    })
    .then((plugin) => {
      channelDirectoryPluginCache.set(id, plugin);
      return plugin;
    })
    .finally(() => {
      channelDirectoryPluginPromiseCache.delete(id);
    });
  channelDirectoryPluginPromiseCache.set(id, loading);
  return (await loading) ?? undefined;
}
