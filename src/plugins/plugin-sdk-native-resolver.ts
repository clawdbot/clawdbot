/** Installs native Node resolution aliases so plugins can import the OpenClaw SDK in dev and tests. */
import fs from "node:fs";
import Module from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

type NativeAliasEntry = {
  parentRoot: string;
  target: string;
};

/** Resolver install options for CJS `_resolveFilename` and modern ESM loader hooks. */
export type InstallOpenClawPluginSdkNativeResolverOptions = {
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
    packageName: "@openclaw/normalization-core",
    packageDir: "normalization-core",
    subpaths: [
      ["", "index.ts"],
      ["boolean-coercion", "boolean-coercion.ts"],
      ["error-coercion", "error-coercion.ts"],
      ["number-coercion", "number-coercion.ts"],
      ["record-coerce", "record-coerce.ts"],
      ["string-coerce", "string-coerce.ts"],
      ["string-normalization", "string-normalization.ts"],
      ["utf16-slice", "utf16-slice.ts"],
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
      ["diagnostics", path.join("utils", "diagnostics.ts")],
      ["event-stream", path.join("utils", "event-stream.ts")],
      ["types", "types.ts"],
      ["validation", "validation.ts"],
      ["internal/anthropic", path.join("internal", "anthropic.ts")],
      ["internal/openai", path.join("internal", "openai.ts")],
      ["internal/retry-after", path.join("internal", "retry-after.ts")],
      ["internal/runtime", path.join("internal", "runtime.ts")],
      ["internal/shared", path.join("internal", "shared.ts")],
    ],
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpaths: [
      ["", "index.ts"],
      ["base64", "base64.ts"],
      ["constants", "constants.ts"],
      ["content-length", "content-length.ts"],
      ["file-name", "file-name.ts"],
      ["inbound-path-policy", "inbound-path-policy.ts"],
      ["inline-image-data-url", "inline-image-data-url.ts"],
      ["media-source-url", "media-source-url.ts"],
      ["mime", "mime.ts"],
      ["read-byte-stream-with-limit", "read-byte-stream-with-limit.ts"],
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
const pluginSdkNativeAliases = new Map<string, NativeAliasEntry[]>();
let installed = false;
let previousResolveFilename: ResolveFilename | undefined;
let esmHooks: { deregister: () => void } | undefined;

function resolveLoaderModulePath(options: InstallOpenClawPluginSdkNativeResolverOptions): string {
  return options.modulePath ?? fileURLToPath(options.moduleUrl ?? import.meta.url);
}

function isPluginSdkAliasSpecifier(specifier: string): boolean {
  return PLUGIN_SDK_PACKAGE_PREFIXES.some(
    (prefix) => specifier === prefix || specifier.startsWith(`${prefix}/`),
  );
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

function normalizePathForBoundary(candidate: string): string {
  try {
    return fs.realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

function findNearestPackageRoot(modulePath: string): string {
  let cursor = path.dirname(path.resolve(modulePath));
  for (let i = 0; i < 12; i += 1) {
    if (fs.existsSync(path.join(cursor, "package.json"))) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return path.dirname(path.resolve(modulePath));
}

function findBundledPluginRoot(modulePath: string): string | undefined {
  const resolvedModulePath = normalizePathForBoundary(modulePath);
  const packageRoot = normalizePathForBoundary(resolveLoaderPackageRootFromModulePath(modulePath));
  for (const relativeRoot of ["extensions", "dist/extensions", "dist-runtime/extensions"]) {
    const bundledRoot = path.join(packageRoot, relativeRoot);
    const relative = path.relative(bundledRoot, resolvedModulePath);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
      continue;
    }
    const [pluginId] = relative.split(path.sep);
    if (pluginId) {
      return path.join(bundledRoot, pluginId);
    }
  }
  return undefined;
}

function resolveLoaderPackageRootFromModulePath(modulePath: string): string {
  let cursor = path.dirname(path.resolve(modulePath));
  for (let i = 0; i < 12; i += 1) {
    const packageJsonPath = path.join(cursor, "package.json");
    if (fs.existsSync(packageJsonPath)) {
      try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
          bin?: unknown;
          name?: unknown;
        };
        if (
          packageJson.name === "openclaw" ||
          (typeof packageJson.bin === "object" &&
            packageJson.bin !== null &&
            typeof (packageJson.bin as { openclaw?: unknown }).openclaw === "string")
        ) {
          return cursor;
        }
      } catch {
        // Keep walking; malformed package metadata should not widen alias scope.
      }
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return findNearestPackageRoot(modulePath);
}

function resolveAllowedParentRoot(modulePath: string): string {
  return findBundledPluginRoot(modulePath) ?? findNearestPackageRoot(modulePath);
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
  const relative = path.relative(root, normalizePathForBoundary(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  const entries = pluginSdkNativeAliases.get(request);
  if (!entries || !parentFilename) {
    return undefined;
  }
  return entries.find((entry) => isWithinRoot(parentFilename, entry.parentRoot))?.target;
}

function listPluginSdkNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): Array<readonly [string, string]> {
  const modulePath = options.pluginModulePath ?? resolveLoaderModulePath(options);
  return Object.entries(
    buildPluginLoaderAliasMap(
      modulePath,
      options.argv1 ?? process.argv[1],
      options.moduleUrl,
      // Native require hooks must point at JavaScript artifacts, even when the
      // plugin loader itself is configured to prefer source imports.
      "dist",
      options.devSourceRoot,
    ),
  )
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
}

function listInternalCorePackageNativeAliases(
  options: InstallOpenClawPluginSdkNativeResolverOptions,
): Array<{
  request: string;
  target: string;
  parentRoots: string[];
}> {
  const packageRoot = resolveLoaderPackageRootFromModulePath(resolveLoaderModulePath(options));
  const parentRoots = ["src", "scripts", "packages", "test"]
    .map((segment) => path.join(packageRoot, segment))
    .filter((candidate) => fs.existsSync(candidate))
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
    {
      packageName: "@openclaw/acp-core",
      packageDir: "acp-core",
      subpaths: listWorkspacePackageExportAliasEntries({
        packageRoot,
        packageName: "@openclaw/acp-core",
        packageDir: "acp-core",
      }).map((entry) => [entry.subpath, entry.srcFile] as const),
    },
  ];
  for (const entry of internalCorePackageAliases) {
    for (const [subpath, srcFile] of entry.subpaths) {
      const request = subpath ? `${entry.packageName}/${subpath}` : entry.packageName;
      const target = path.join(packageRoot, "packages", entry.packageDir, "src", srcFile);
      if (fs.existsSync(target)) {
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
  esmHooks = moduleWithResolver.registerHooks?.({
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
  for (const [request, entries] of pluginSdkNativeAliases) {
    const nextEntries = entries.filter((entry) => !parentRootSet.has(entry.parentRoot));
    if (nextEntries.length === 0) {
      pluginSdkNativeAliases.delete(request);
    } else {
      pluginSdkNativeAliases.set(request, nextEntries);
    }
  }
}

export function installOpenClawPluginSdkNativeResolver(
  options: InstallOpenClawPluginSdkNativeResolverOptions = {},
): string[] {
  const parentRoots = resolveAllowedParentRoots(options);
  clearNativeAliasesForParentRoots(parentRoots);
  for (const [specifier, target] of listPluginSdkNativeAliases(options)) {
    registerNativeAlias({ request: specifier, target, parentRoots });
  }
  for (const alias of listInternalCorePackageNativeAliases(options)) {
    registerNativeAlias(alias);
  }
  installResolver();
  return [...pluginSdkNativeAliases.keys()].toSorted();
}

export function installOpenClawInternalCorePackageNativeResolver(
  options: Pick<InstallOpenClawPluginSdkNativeResolverOptions, "moduleUrl"> = {},
): string[] {
  for (const alias of listInternalCorePackageNativeAliases(options)) {
    registerNativeAlias(alias);
  }
  installResolver();
  return [...pluginSdkNativeAliases.keys()].toSorted();
}

export function resetOpenClawPluginSdkNativeResolverForTest(): void {
  pluginSdkNativeAliases.clear();
  esmHooks?.deregister();
  esmHooks = undefined;
  if (installed && previousResolveFilename) {
    moduleWithResolver[nodeResolveFilenameProperty] = previousResolveFilename;
  }
  previousResolveFilename = undefined;
  installed = false;
}
