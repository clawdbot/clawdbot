/** Resolves the bundled plugin directory for source checkouts, dist builds, and tests. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { isTruthyEnvValue, isVitestRuntimeEnv } from "../infra/env.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import {
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  readPluginCacheDirectory,
  refreshPluginCacheStat,
} from "./plugin-cache-files.js";

const DISABLED_BUNDLED_PLUGINS_DIR = path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");
const TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV = "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR";

/** Diagnostic emitted when source-checkout bundled plugins lack dependency installs. */
type SourceCheckoutDependencyDiagnostic = {
  source: string;
  message: string;
};

/** Returns true when env disables bundled plugin discovery. */
export function areBundledPluginsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS);
  return raw === "1" || raw === "true";
}

function resolveDisabledBundledPluginsDir(): string {
  if (!pluginCacheExistsSync(DISABLED_BUNDLED_PLUGINS_DIR)) {
    fs.mkdirSync(DISABLED_BUNDLED_PLUGINS_DIR, { recursive: true });
    refreshPluginCacheStat(DISABLED_BUNDLED_PLUGINS_DIR);
  }
  return DISABLED_BUNDLED_PLUGINS_DIR;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    pluginCacheExistsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    pluginCacheExistsSync(path.join(packageRoot, "src")) &&
    pluginCacheExistsSync(path.join(packageRoot, "extensions"))
  );
}

function shouldTrustTestBundledPluginsDirOverride(env: NodeJS.ProcessEnv): boolean {
  const isVitestProcess = isVitestRuntimeEnv(env) || isVitestRuntimeEnv(process.env);
  return (
    isVitestProcess &&
    (isTruthyEnvValue(env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV]) ||
      isTruthyEnvValue(process.env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV]))
  );
}

export function hasUsableBundledPluginTree(pluginsDir: string): boolean {
  if (!pluginCacheExistsSync(pluginsDir)) {
    return false;
  }
  try {
    return readPluginCacheDirectory(pluginsDir).some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const pluginDir = path.join(pluginsDir, entry.name);
      return (
        pluginCacheExistsSync(path.join(pluginDir, "package.json")) ||
        pluginCacheExistsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

function safeRealpathSync(targetPath: string): string | null {
  // Trusted bundled containment requires native platform canonicalization.
  return pluginCacheRealpathSync(targetPath, true);
}

function pathContains(parentDir: string, childPath: string): boolean {
  return isPathInside(parentDir, childPath);
}

function trustedBundledPluginRootsForPackageRoot(packageRoot: string): string[] {
  const roots = [
    path.join(packageRoot, "dist", "extensions"),
    path.join(packageRoot, "dist-runtime", "extensions"),
  ];
  if (isSourceCheckoutRoot(packageRoot)) {
    roots.push(path.join(packageRoot, "extensions"));
  }
  return roots;
}

function resolvePackageRootsForBundledPlugins(): string[] {
  const argvRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
  const moduleRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  return uniqueStrings([argvRoot, moduleRoot].filter((entry): entry is string => Boolean(entry)));
}

export function resolveSourceCheckoutDependencyDiagnostic(
  env: NodeJS.ProcessEnv = process.env,
): SourceCheckoutDependencyDiagnostic | null {
  if (areBundledPluginsDisabled(env)) {
    return null;
  }
  for (const packageRoot of resolvePackageRootsForBundledPlugins()) {
    if (!isSourceCheckoutRoot(packageRoot)) {
      continue;
    }
    const extensionsDir = path.join(packageRoot, "extensions");
    if (!hasUsableBundledPluginTree(extensionsDir)) {
      continue;
    }
    if (pluginCacheExistsSync(path.join(packageRoot, "node_modules", ".pnpm"))) {
      continue;
    }
    return {
      source: packageRoot,
      message:
        "OpenClaw source checkout detected without pnpm workspace dependencies; run `pnpm install` from the repo root so bundled plugins can load package-local dependencies.",
    };
  }
  return null;
}

function resolveTrustedExistingOverride(resolvedOverride: string): string | null {
  const realOverride = safeRealpathSync(resolvedOverride);
  if (!realOverride) {
    return null;
  }

  const modulePackageRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
  const packageRoots = modulePackageRoot ? [modulePackageRoot] : [];
  const trustedRoots = packageRoots
    .flatMap((packageRoot) => trustedBundledPluginRootsForPackageRoot(packageRoot))
    .map((trustedRoot) => safeRealpathSync(trustedRoot))
    .filter((entry): entry is string => Boolean(entry));
  if (!trustedRoots.some((trustedRoot) => pathContains(trustedRoot, realOverride))) {
    return null;
  }
  if (!hasUsableBundledPluginTree(realOverride)) {
    return null;
  }
  return realOverride;
}

function overrideResolvesUnderPackageBundledRoot(params: {
  resolvedOverride: string;
  packageRoot: string;
}): boolean {
  const realOverride = safeRealpathSync(params.resolvedOverride);
  if (!realOverride) {
    return false;
  }
  return trustedBundledPluginRootsForPackageRoot(params.packageRoot)
    .map((trustedRoot) => safeRealpathSync(trustedRoot))
    .filter((entry): entry is string => Boolean(entry))
    .some((trustedRoot) => pathContains(trustedRoot, realOverride));
}

function resolveBundledDirFromPackageRoot(packageRoot: string): string | undefined {
  const sourceExtensionsDir = path.join(packageRoot, "extensions");
  const builtExtensionsDir = path.join(packageRoot, "dist", "extensions");
  const sourceCheckout = isSourceCheckoutRoot(packageRoot);
  const hasUsableSourceTree = sourceCheckout && hasUsableBundledPluginTree(sourceExtensionsDir);
  // In pnpm source checkouts, prefer the built bundled plugin runtime when it
  // exists so dist gateway runs avoid loading TS plugin entrypoints through jiti.
  // Keep the source tree as the fallback for fresh checkouts before build.
  const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
  const hasUsableRuntimeTree = sourceCheckout
    ? hasUsableBundledPluginTree(runtimeExtensionsDir)
    : pluginCacheExistsSync(runtimeExtensionsDir);
  const hasUsableBuiltTree = sourceCheckout
    ? hasUsableBundledPluginTree(builtExtensionsDir)
    : pluginCacheExistsSync(builtExtensionsDir);
  if (sourceCheckout && hasUsableBuiltTree) {
    return builtExtensionsDir;
  }
  if (sourceCheckout && hasUsableRuntimeTree) {
    return runtimeExtensionsDir;
  }
  if (hasUsableRuntimeTree && hasUsableBuiltTree) {
    return runtimeExtensionsDir;
  }
  if (hasUsableBuiltTree) {
    return builtExtensionsDir;
  }
  if (hasUsableSourceTree) {
    return sourceExtensionsDir;
  }
  return undefined;
}

export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (areBundledPluginsDisabled(env)) {
    return resolveDisabledBundledPluginsDir();
  }

  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  let rejectedExistingOverride: string | null = null;
  if (override) {
    const resolvedOverride = resolveUserPath(override, env);
    if (pluginCacheExistsSync(resolvedOverride)) {
      if (shouldTrustTestBundledPluginsDirOverride(env)) {
        return path.resolve(resolvedOverride);
      }
      const trustedOverride = resolveTrustedExistingOverride(resolvedOverride);
      if (trustedOverride) {
        return trustedOverride;
      }
      rejectedExistingOverride = resolvedOverride;
    }
  }

  try {
    const argvRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
    const rejectedOverrideUsesArgvRoot = Boolean(
      argvRoot &&
      rejectedExistingOverride &&
      overrideResolvesUnderPackageBundledRoot({
        resolvedOverride: rejectedExistingOverride,
        packageRoot: argvRoot,
      }),
    );
    const safeArgvRoot = rejectedOverrideUsesArgvRoot ? null : argvRoot;
    const moduleRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    const packageRoots = uniqueStrings(
      [safeArgvRoot, moduleRoot].filter((entry): entry is string => Boolean(entry)),
    );
    for (const packageRoot of packageRoots) {
      const bundledDir = resolveBundledDirFromPackageRoot(packageRoot);
      if (bundledDir) {
        return bundledDir;
      }
    }
  } catch {
    // ignore
  }

  // bun --compile: ship a sibling bundled plugin tree next to the executable.
  try {
    const execDir = path.dirname(process.execPath);
    const siblingBuilt = path.join(execDir, "dist", "extensions");
    if (pluginCacheExistsSync(siblingBuilt)) {
      return siblingBuilt;
    }
    const sibling = path.join(execDir, "extensions");
    if (pluginCacheExistsSync(sibling)) {
      return sibling;
    }
  } catch {
    // ignore
  }

  // npm/dev: walk up from this module to find the bundled plugin tree at the package root.
  try {
    let cursor = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 6; i += 1) {
      const candidate = path.join(cursor, "extensions");
      if (pluginCacheExistsSync(candidate)) {
        return candidate;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  } catch {
    // ignore
  }

  return undefined;
}
