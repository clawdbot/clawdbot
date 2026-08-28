/** Installs native Node resolution aliases so plugins can import the OpenClaw SDK in dev and tests. */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { isPathInside, isPathStrictlyInside } from "../infra/path-guards.js";
import { pluginCacheExistsSync, pluginCacheRealpathSync } from "./plugin-cache-files.js";
import { getPluginSdkHostFacts } from "./plugin-cache-sdk.js";
import { getPluginCache } from "./plugin-cache.js";
import {
  buildPluginLoaderAliasMap,
  listWorkspacePackageExportAliasEntries,
  type PluginSdkResolutionPreference,
} from "./sdk-alias.js";

type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;

type ModuleWithResolver = typeof Module & {
  _resolveFilename?: ResolveFilename;
  registerHooks?: (options: {
    resolve?: (
      specifier: string,
      context: { parentURL?: string | undefined },
      nextResolve: (
        specifier: string,
        context?: { parentURL?: string | undefined },
      ) => {
        url: string;
      },
    ) => { shortCircuit?: boolean; url: string };
  }) => { deregister: () => void };
};

/** Resolver install options for CJS `_resolveFilename` and modern ESM loader hooks. */
type InstallOpenClawPluginSdkNativeResolverOptions = {
  modulePath?: string;
  pluginModulePath?: string;
  allowedParentRoots?: readonly string[];
  argv1?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};

const moduleWithResolver = Module as ModuleWithResolver;
const nodeResolveFilenameProperty = "_resolveFilename" as const;
const PLUGIN_SDK_PACKAGE_PREFIXES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;
const INTERNAL_CORE_PACKAGE_ALIASES = [
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpaths: [
      ["", "index.ts"],
      ["code-spans", "code-spans.ts"],
      ["fences", "fences.ts"],
      ["frontmatter", "frontmatter.ts"],
      ["ir", "ir.ts"],
      ["render", "render.ts"],
      ["render-aware-chunking", "render-aware-chunking.ts"],
      ["tables", "tables.ts"],
      ["types", "types.ts"],
    ],
  },
  {
    // Mirrors packages/ai/package.json exports; dist file names do not follow
    // the src layout (dist/diagnostics.mjs <- src/utils/diagnostics.ts), so the
    // generic export-map derivation cannot be used here.
    packageName: "@openclaw/ai",
    packageDir: "ai",
    subpaths: [
      ["", "index.ts"],
      ["providers", "providers.ts"],
      ["transports", "transports.ts"],
      ["diagnostics", path.join("utils", "diagnostics.ts")],
      ["event-stream", path.join("utils", "event-stream.ts")],
      ["types", "types.ts"],
      ["validation", "validation.ts"],
      ["internal/anthropic", path.join("internal", "anthropic.ts")],
      ["internal/openai", path.join("internal", "openai.ts")],
      [
        "internal/openai-responses-payload-policy",
        path.join("internal", "openai-responses-payload-policy.ts"),
      ],
      ["internal/retry-after", path.join("internal", "retry-after.ts")],
      ["internal/runtime", path.join("internal", "runtime.ts")],
      ["internal/shared", path.join("internal", "shared.ts")],
    ],
  },
  {
    packageName: "@openclaw/llm-core",
    packageDir: "llm-core",
    subpaths: [
      ["", "index.ts"],
      ["diagnostics", path.join("utils", "diagnostics.ts")],
      ["event-stream", path.join("utils", "event-stream.ts")],
      ["types", "types.ts"],
      ["validation", "validation.ts"],
    ],
  },
] as const;
let installed = false;
let previousResolveFilename: ResolveFilename | undefined;

function resolveLoaderModulePath(options: InstallOpenClawPluginSdkNativeResolverOptions): string {
  return options.modulePath ?? fileURLToPath(options.moduleUrl ?? import.meta.url);
}

function isPluginSdkAliasSpecifier(specifier: string): boolean {
  return PLUGIN_SDK_PACKAGE_PREFIXES.some((prefix) => specifier.startsWith(`${prefix}/`));
}

function isNativeLoadableSdkTarget(targetPath: string): boolean {
  switch (path.extname(targetPath)) {
    case ".cjs":
    case ".js":
    case ".mjs":
      return true;
    default:
      return false;
  }
}

const normalizePathForBoundary = (targetPath: string) =>
  pluginCacheRealpathSync(targetPath) ?? path.resolve(targetPath);

function findNearestPackageRoot(modulePath: string): string {
  const normalizedModulePath = path.resolve(modulePath);
  const roots = getPluginCache().sdk.native.nearestPackageRoots;
  const cached = roots.get(normalizedModulePath);
  if (cached) {
    return cached;
  }
  let cursor = path.dirname(normalizedModulePath);
  for (let i = 0; i < 12; i += 1) {
    if (pluginCacheExistsSync(path.join(cursor, "package.json"))) {
      roots.set(normalizedModulePath, cursor);
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  const fallback = path.dirname(normalizedModulePath);
  roots.set(normalizedModulePath, fallback);
  return fallback;
}

function findBundledPluginRoot(modulePath: string): string | undefined {
  const resolvedModulePath = normalizePathForBoundary(modulePath);
  const packageRoot = normalizePathForBoundary(resolveLoaderPackageRootFromModulePath(modulePath));
  for (const relativeRoot of ["extensions", "dist/extensions", "dist-runtime/extensions"]) {
    const bundledRoot = path.join(packageRoot, relativeRoot);
    if (!isPathStrictlyInside(bundledRoot, resolvedModulePath)) {
      continue;
    }
    const relative = path.relative(bundledRoot, resolvedModulePath);
    const [pluginId] = relative.split(path.sep);
    if (pluginId) {
      return path.join(bundledRoot, pluginId);
    }
  }
  return undefined;
}

function resolveLoaderPackageRootFromModulePath(modulePath: string): string {
  const normalizedModulePath = path.resolve(modulePath);
  const roots = getPluginCache().sdk.native.loaderPackageRoots;
  const cached = roots.get(normalizedModulePath);
  if (cached) {
    return cached;
  }
  let cursor = path.dirname(normalizedModulePath);
  for (let i = 0; i < 12; i += 1) {
    const packageJsonPath = path.join(cursor, "package.json");
    if (pluginCacheExistsSync(packageJsonPath)) {
      const facts = getPluginSdkHostFacts(getPluginCache().sdk, cursor);
      if (facts.nativePackage === undefined) {
        try {
          // This native host probe historically follows package.json symlinks.
          // Keep that read contract distinct from checked SDK manifest reads.
          const parsed: unknown = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
          facts.nativePackage = isRecord(parsed)
            ? {
                ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
                hasOpenClawBin: isRecord(parsed.bin) && typeof parsed.bin.openclaw === "string",
              }
            : null;
        } catch {
          facts.nativePackage = null;
        }
      }
      if (facts.nativePackage?.name === "openclaw" || facts.nativePackage?.hasOpenClawBin) {
        roots.set(normalizedModulePath, cursor);
        return cursor;
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  const fallback = findNearestPackageRoot(modulePath);
  roots.set(normalizedModulePath, fallback);
  return fallback;
}

function resolveInternalCorePackageHostRoot(modulePath: string): string {
  const normalizedModulePath = path.resolve(modulePath);
  const internalCorePackageHostRoots = getPluginCache().sdk.native.hostRoots;
  const cached = internalCorePackageHostRoots.get(normalizedModulePath);
  if (cached) {
    return cached;
  }
  const packageRoot = normalizePathForBoundary(
    resolveLoaderPackageRootFromModulePath(normalizedModulePath),
  );
  internalCorePackageHostRoots.set(normalizedModulePath, packageRoot);
  return packageRoot;
}

function resolveAllowedParentRoot(modulePath: string): string {
  const roots = getPluginCache().sdk.native.allowedParentRoots;
  const key = path.resolve(modulePath);
  const cached = roots.get(key);
  if (cached) {
    return cached;
  }
  const root = findBundledPluginRoot(modulePath) ?? findNearestPackageRoot(modulePath);
  roots.set(key, root);
  return root;
}

function resolveAllowedParentRoots(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): string[] {
  const roots = new Set<string>();
  if (options.pluginModulePath) {
    roots.add(normalizePathForBoundary(resolveAllowedParentRoot(options.pluginModulePath)));
  }
  for (const root of options.allowedParentRoots ?? []) {
    roots.add(normalizePathForBoundary(root));
  }
  return [...roots];
}

function isWithinRoot(candidate: string, root: string): boolean {
  return isPathInside(root, normalizePathForBoundary(candidate));
}

function resolveAliasTargetForParent(
  request: string,
  parent: NodeJS.Module | undefined,
): string | undefined {
  return resolveAliasTargetForParentPath(request, parent?.filename);
}

function resolveAliasTargetForParentUrl(
  request: string,
  parentUrl: string | undefined,
): string | undefined {
  if (!parentUrl?.startsWith("file:")) {
    return undefined;
  }
  try {
    return resolveAliasTargetForParentPath(request, fileURLToPath(parentUrl));
  } catch {
    return undefined;
  }
}

function resolveAliasTargetForParentPath(
  request: string,
  parentFilename: string | undefined,
): string | undefined {
  const entries = getPluginCache().sdk.native.aliases.get(request);
  if (!entries || !parentFilename) {
    return undefined;
  }
  return entries.find((entry) => isWithinRoot(parentFilename, entry.parentRoot))?.target;
}

function listPluginSdkNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): Array<readonly [string, string]> {
  const modulePath = options.pluginModulePath ?? resolveLoaderModulePath(options);
  const aliasMap = buildPluginLoaderAliasMap(
    modulePath,
    options.argv1 ?? process.argv[1],
    options.moduleUrl,
    // Native require hooks must point at JavaScript artifacts, even when the
    // plugin loader itself is configured to prefer source imports.
    "dist",
    options.devSourceRoot,
  );
  const pluginSdkNativeAliasesByMap = getPluginCache().sdk.native.aliasesByMap;
  const cached = pluginSdkNativeAliasesByMap.get(aliasMap);
  if (cached) {
    return cached;
  }
  const aliases = Object.entries(aliasMap)
    .filter(([specifier]) => isPluginSdkAliasSpecifier(specifier))
    .filter(([, target]) => isNativeLoadableSdkTarget(target))
    .flatMap(([specifier, target]) => {
      if (specifier.endsWith(".js")) {
        return [[specifier, target]] as Array<readonly [string, string]>;
      }
      return [
        [specifier, target],
        [`${specifier}.js`, target],
      ] as Array<readonly [string, string]>;
    });
  pluginSdkNativeAliasesByMap.set(aliasMap, aliases);
  return aliases;
}

function listInternalCorePackageNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
  packageRoot = resolveInternalCorePackageHostRoot(resolveLoaderModulePath(options)),
): Array<{
  request: string;
  target: string;
  parentRoots: string[];
}> {
  const parentRoots = ["src", "scripts", "packages", "test"]
    .map((segment) => path.join(packageRoot, segment))
    .filter((candidate) => pluginCacheExistsSync(candidate))
    .map(normalizePathForBoundary);
  if (parentRoots.length === 0) {
    return [];
  }

  const aliases: Array<{
    request: string;
    target: string;
    parentRoots: string[];
  }> = [];
  const internalCorePackageAliases = [
    ...INTERNAL_CORE_PACKAGE_ALIASES,
    ...["media-core", "normalization-core", "acp-core"].map((packageDir) => ({
      packageName: `@openclaw/${packageDir}`,
      packageDir,
      subpaths: listWorkspacePackageExportAliasEntries({
        packageRoot,
        packageName: `@openclaw/${packageDir}`,
        packageDir,
      }).map((entry) => [entry.subpath, entry.srcFile] as const),
    })),
  ];
  for (const entry of internalCorePackageAliases) {
    for (const [subpath, srcFile] of entry.subpaths) {
      const request = subpath ? `${entry.packageName}/${subpath}` : entry.packageName;
      const target = path.join(packageRoot, "packages", entry.packageDir, "src", srcFile);
      if (pluginCacheExistsSync(target)) {
        aliases.push({ request, target, parentRoots });
      }
    }
  }
  return aliases;
}

function installResolver(): void {
  if (installed || !moduleWithResolver[nodeResolveFilenameProperty]) {
    return;
  }
  previousResolveFilename = moduleWithResolver[nodeResolveFilenameProperty];
  moduleWithResolver[nodeResolveFilenameProperty] = ((request, parent, isMain, options) => {
    const aliasTarget = resolveAliasTargetForParent(request, parent);
    if (aliasTarget) {
      return aliasTarget;
    }
    return previousResolveFilename?.(request, parent, isMain, options) ?? request;
  }) satisfies ResolveFilename;
  moduleWithResolver.registerHooks?.({
    resolve(specifier, context, nextResolve) {
      const aliasTarget = resolveAliasTargetForParentUrl(specifier, context.parentURL);
      if (aliasTarget) {
        return {
          shortCircuit: true,
          url: pathToFileURL(aliasTarget).href,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  installed = true;
}

function registerNativeAlias(params: {
  request: string;
  target: string;
  parentRoots: readonly string[];
}): void {
  const pluginSdkNativeAliases = getPluginCache().sdk.native.aliases;
  const entries = pluginSdkNativeAliases.get(params.request) ?? [];
  for (const parentRoot of params.parentRoots) {
    const existingIndex = entries.findIndex((entry) => entry.parentRoot === parentRoot);
    if (existingIndex !== -1) {
      entries[existingIndex] = { parentRoot, target: params.target };
      continue;
    }
    entries.push({ parentRoot, target: params.target });
  }
  if (entries.length > 0) {
    pluginSdkNativeAliases.set(params.request, entries);
  }
}

function clearNativeAliasesForParentRoots(parentRoots: readonly string[]): void {
  if (parentRoots.length === 0) {
    return;
  }
  const parentRootSet = new Set(parentRoots);
  const pluginSdkNativeAliases = getPluginCache().sdk.native.aliases;
  for (const [request, entries] of pluginSdkNativeAliases) {
    const nextEntries = entries.filter((entry) => !parentRootSet.has(entry.parentRoot));
    if (nextEntries.length === 0) {
      pluginSdkNativeAliases.delete(request);
    } else {
      pluginSdkNativeAliases.set(request, nextEntries);
    }
  }
}

function registerInternalCorePackageNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): void {
  const packageRoot = resolveInternalCorePackageHostRoot(resolveLoaderModulePath(options));
  const registeredInternalCorePackageHosts = getPluginCache().sdk.native.registeredHosts;
  if (registeredInternalCorePackageHosts.has(packageRoot)) {
    return;
  }
  for (const alias of listInternalCorePackageNativeAliases(options, packageRoot)) {
    registerNativeAlias(alias);
  }
  registeredInternalCorePackageHosts.add(packageRoot);
}

export function installOpenClawPluginSdkNativeResolver(
  options: InstallOpenClawPluginSdkNativeResolverOptions = {},
): string[] {
  const parentRoots = resolveAllowedParentRoots(options);
  clearNativeAliasesForParentRoots(parentRoots);
  for (const [specifier, target] of listPluginSdkNativeAliases(options)) {
    registerNativeAlias({ request: specifier, target, parentRoots });
  }
  registerInternalCorePackageNativeAliases(options);
  installResolver();
  return [...getPluginCache().sdk.native.aliases.keys()].toSorted();
}

export function installOpenClawInternalCorePackageNativeResolver(
  options: Pick<InstallOpenClawPluginSdkNativeResolverOptions, "moduleUrl"> = {},
): string[] {
  registerInternalCorePackageNativeAliases(options);
  installResolver();
  return [...getPluginCache().sdk.native.aliases.keys()].toSorted();
}
