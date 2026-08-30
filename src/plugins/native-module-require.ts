// Resolves native module require paths for plugin runtime loading.
import fs from "node:fs";
import Module, { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isPathInside } from "../infra/path-guards.js";

const nodeRequire = createRequire(import.meta.url);
type ResolveFilename = (
  request: string,
  parent: NodeJS.Module | undefined,
  isMain: boolean,
  options?: { paths?: string[] },
) => string;
const moduleWithResolver = Module as typeof Module & {
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

/** True for file extensions Node can load through the native JS module loader. */
export function isJavaScriptModulePath(modulePath: string): boolean {
  return [".js", ".mjs", ".cjs"].includes(path.extname(modulePath).toLowerCase());
}

function isMissingTargetModuleError(
  error: { code?: unknown; message?: unknown },
  modulePath: string,
): boolean {
  if (error.code !== "MODULE_NOT_FOUND" || typeof error.message !== "string") {
    return false;
  }
  const firstLine = error.message.split("\n", 1)[0] ?? "";
  return firstLine.includes(`'${modulePath}'`) || firstLine.includes(`"${modulePath}"`);
}

function isSourceTransformFallbackError(error: unknown, modulePath: string): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  const candidate = error as { code?: unknown; message?: unknown };
  const code = candidate.code;
  return (
    code === "ERR_REQUIRE_ESM" ||
    code === "ERR_REQUIRE_ASYNC_MODULE" ||
    code === "ERR_REQUIRE_ESM_RACE_CONDITION" ||
    isMissingTargetModuleError(candidate, modulePath)
  );
}

/** Attempts native require before falling back to source transform paths. */
export function tryNativeRequireJavaScriptModule(
  modulePath: string,
  options: {
    allowWindows?: boolean;
    aliasMap?: Record<string, string> | ((specifier: string) => string | undefined);
    fallbackOnMissingDependency?: boolean;
    fallbackOnNativeError?: boolean;
  } = {},
): { ok: true; moduleExport: unknown } | { ok: false } {
  if (process.platform === "win32" && options.allowWindows !== true) {
    return { ok: false };
  }
  if (!isJavaScriptModulePath(modulePath)) {
    return { ok: false };
  }
  try {
    return { ok: true, moduleExport: requireWithOptionalAliases(modulePath, options.aliasMap) };
  } catch (error) {
    const code =
      error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (
      isSourceTransformFallbackError(error, modulePath) ||
      options.fallbackOnNativeError ||
      (options.fallbackOnMissingDependency === true &&
        (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND"))
    ) {
      return { ok: false };
    }
    throw error;
  }
}

/** Clears native and source-transformed modules within the plugin dependency root. */
export function clearPluginModuleRequireCache(
  modulePath: string,
  options: { dependencyRoot?: string } = {},
): void {
  try {
    const resolved = nodeRequire.resolve(modulePath);
    clearRequireCacheSubtree(
      resolved,
      resolveRequireCachePath(options.dependencyRoot ?? path.dirname(resolved)),
      new Set(),
    );
  } catch {
    // Best-effort lifecycle cleanup: unresolved paths were not loaded.
  }
}

function resolveRequireCachePath(targetPath: string): string {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

function clearRequireCacheSubtree(
  resolvedPath: string,
  dependencyRoot: string,
  seen: Set<string>,
): void {
  if (seen.has(resolvedPath)) {
    return;
  }
  seen.add(resolvedPath);
  const cached = nodeRequire.cache[resolvedPath];
  if (cached) {
    for (const child of cached.children) {
      if (isPathInside(dependencyRoot, child.id)) {
        clearRequireCacheSubtree(child.id, dependencyRoot, seen);
      }
    }
  }
  delete nodeRequire.cache[resolvedPath];
}

function requireWithOptionalAliases(
  modulePath: string,
  aliasMap: Record<string, string> | ((specifier: string) => string | undefined) | undefined,
): unknown {
  // A process-wide require retains evicted modules through its synthetic parent's children.
  // Keep that parent scoped to this load so retired graphs can be collected.
  return withNativeRequireAliases(aliasMap, () => createRequire(import.meta.url)(modulePath));
}

/** Runs a native require block with temporary CJS/ESM alias hooks and restores both afterward. */
function withNativeRequireAliases<T>(
  aliasMap: Record<string, string> | ((specifier: string) => string | undefined) | undefined,
  run: () => T,
): T {
  if (!aliasMap || !moduleWithResolver["_resolveFilename"]) {
    return run();
  }
  const resolveAlias =
    typeof aliasMap === "function" ? aliasMap : (specifier: string) => aliasMap[specifier];
  const originalResolveFilename = moduleWithResolver["_resolveFilename"];
  const esmHooks = moduleWithResolver.registerHooks?.({
    resolve(specifier, context, nextResolve) {
      const aliasTarget = resolveAlias(specifier);
      if (aliasTarget) {
        return {
          shortCircuit: true,
          url: pathToFileURL(aliasTarget).href,
        };
      }
      return nextResolve(specifier, context);
    },
  });
  moduleWithResolver["_resolveFilename"] = ((request, parent, isMain, options) => {
    const aliasTarget = resolveAlias(request);
    if (aliasTarget) {
      return aliasTarget;
    }
    return originalResolveFilename(request, parent, isMain, options);
  }) satisfies ResolveFilename;
  try {
    return run();
  } finally {
    moduleWithResolver["_resolveFilename"] = originalResolveFilename;
    esmHooks?.deregister();
  }
}
