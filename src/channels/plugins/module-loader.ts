/**
 * Channel plugin module loader.
 *
 * Loads JavaScript or source plugin modules through native require or cached TS loaders.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describeRootFileOpenFailure, openRootFileSync } from "../../infra/boundary-file-read.js";
import { hasErrnoCode } from "../../infra/errno.js";
import { isJavaScriptModulePath } from "../../plugins/native-module-require.js";
import { getPluginCacheRoot, getPluginCacheSource } from "../../plugins/plugin-cache.js";
import {
  getCachedPluginModuleLoader,
  recordPluginModuleRoot,
} from "../../plugins/plugin-module-loader-cache.js";

const nodeRequire = createRequire(import.meta.url);
const SOURCE_MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const SOURCE_MODULE_RESOLUTION_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"] as const;

function hasNativeSourceRequireHook(modulePath: string): boolean {
  const extension = path.extname(modulePath).toLowerCase();
  return (
    SOURCE_MODULE_EXTENSIONS.has(extension) &&
    typeof nodeRequire.extensions?.[extension] === "function"
  );
}

function isSourceModulePath(modulePath: string): boolean {
  return SOURCE_MODULE_EXTENSIONS.has(path.extname(modulePath).toLowerCase());
}

function loadModuleWithJiti(modulePath: string, rootDir: string): unknown {
  const loadWithJiti = getCachedPluginModuleLoader({
    modulePath,
    rootDir,
    importerUrl: import.meta.url,
    loaderFilename: import.meta.url,
    tryNative: false,
    cacheScopeKey: "channel-plugin-module-loader",
  });
  return loadWithJiti(modulePath);
}

function loadModule(modulePath: string, rootDir: string): unknown {
  if (!isJavaScriptModulePath(modulePath) && !hasNativeSourceRequireHook(modulePath)) {
    if (isSourceModulePath(modulePath)) {
      // Local source plugins need the TS loader unless the current runtime has
      // installed a native source require hook for that extension.
      return loadModuleWithJiti(modulePath, rootDir);
    }
    throw new Error(`channel plugin module must be built JavaScript: ${modulePath}`);
  }
  try {
    return nodeRequire(modulePath);
  } catch (error) {
    if (isSourceModulePath(modulePath)) {
      // Native source hooks can still fail on ESM/TS edge cases; fall back to
      // the cached loader before surfacing the error.
      return loadModuleWithJiti(modulePath, rootDir);
    }
    throw new Error(`failed to load channel plugin module with native require: ${modulePath}`, {
      cause: error,
    });
  }
}

function resolveSourceModuleCandidates(rootDir: string, specifier: string): string[] {
  const normalizedSpecifier = specifier.replace(/\\/g, "/");
  const resolvedPath = path.resolve(rootDir, normalizedSpecifier);
  if (path.extname(resolvedPath)) {
    return [];
  }
  return SOURCE_MODULE_RESOLUTION_EXTENSIONS.map((extension) => `${resolvedPath}${extension}`);
}

/**
 * Resolves a plugin-relative module specifier to an existing candidate path.
 */
export function resolveExistingPluginModulePath(rootDir: string, specifier: string): string {
  const artifacts = getPluginCacheRoot(rootDir).artifacts;
  const key = `channel-specifier:${specifier}`;
  const cached = artifacts.get(key);
  if (cached) {
    return cached.modulePath;
  }
  const modulePath = resolvePluginModulePath(rootDir, specifier);
  artifacts.set(key, { modulePath, boundaryRoot: rootDir });
  return modulePath;
}

function resolvePluginModulePath(rootDir: string, specifier: string): string {
  const resolvedPath = path.resolve(rootDir, specifier.replace(/\\/g, "/"));
  try {
    // Match Node package semantics for explicit files, extensionless JavaScript,
    // package mains, and directory indexes before applying source-only fallbacks.
    return nodeRequire.resolve(resolvedPath);
  } catch (error) {
    if (!hasErrnoCode(error, "MODULE_NOT_FOUND")) {
      throw error;
    }
  }
  for (const candidate of resolveSourceModuleCandidates(rootDir, specifier)) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolvedPath;
}

/**
 * Loads a channel plugin module after enforcing plugin-root file boundaries.
 *
 * `rootDir` is always the plugin's own directory, so the containment failure is
 * reported against that one root; no caller boundary override exists.
 */
export function loadChannelPluginModule(params: { modulePath: string; rootDir: string }): unknown {
  const source = getPluginCacheSource(params.modulePath);
  const key = `channel-plugin-module:${path.resolve(params.rootDir)}`;
  const cached = source.variants.get(key)?.exports;
  if (cached) {
    return cached.value;
  }
  const boundaryLabel = "plugin root";
  const opened = openRootFileSync({
    absolutePath: params.modulePath,
    rootPath: params.rootDir,
    boundaryLabel,
    rejectHardlinks: false,
    skipLexicalRootCheck: true,
  });
  if (!opened.ok) {
    throw new Error(
      describeRootFileOpenFailure({
        failure: opened,
        subject: "plugin module path",
        boundaryLabel,
        filePath: params.modulePath,
      }),
      { cause: opened.error },
    );
  }
  const safePath = opened.path;
  // The boundary check opens the file to verify the path; close before loading
  // through require/jiti so module evaluation owns its own descriptor lifecycle.
  fs.closeSync(opened.fd);
  recordPluginModuleRoot(safePath, params.rootDir);
  const value = loadModule(safePath, params.rootDir);
  source.variants.set(key, { exports: { value } });
  return value;
}
