import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";

const DISABLED_BUNDLED_PLUGINS_DIR = path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");
const TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV = "OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR";
let bundledPluginsDirOverrideForTest: string | undefined;
const bundledPluginsDirCache = new Map<string, string | undefined>();

export type SourceCheckoutDependencyDiagnostic = {
  source: string;
  message: string;
};

export function areBundledPluginsDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = normalizeOptionalLowercaseString(env.OPENCLAW_DISABLE_BUNDLED_PLUGINS);
  return raw === "1" || raw === "true";
}

function resolveDisabledBundledPluginsDir(): string {
  fs.mkdirSync(DISABLED_BUNDLED_PLUGINS_DIR, { recursive: true });
  return DISABLED_BUNDLED_PLUGINS_DIR;
}

function isSourceCheckoutRoot(packageRoot: string): boolean {
  return (
    fs.existsSync(path.join(packageRoot, ".git")) &&
    fs.existsSync(path.join(packageRoot, "pnpm-workspace.yaml")) &&
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
  );
}

function isTruthyEnvValue(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function shouldTrustTestBundledPluginsDirOverride(env: NodeJS.ProcessEnv): boolean {
  const isVitestProcess = Boolean(env.VITEST) || Boolean(process.env.VITEST);
  return (
    isVitestProcess &&
    (isTruthyEnvValue(env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV]) ||
      isTruthyEnvValue(process.env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV]))
  );
}

function hasUsableBundledPluginTree(pluginsDir: string): boolean {
  if (!fs.existsSync(pluginsDir)) {
    return false;
  }
  try {
    return fs.readdirSync(pluginsDir, { withFileTypes: true }).some((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      const pluginDir = path.join(pluginsDir, entry.name);
      return (
        fs.existsSync(path.join(pluginDir, "package.json")) ||
        fs.existsSync(path.join(pluginDir, "openclaw.plugin.json"))
      );
    });
  } catch {
    return false;
  }
}

function safeRealpathSync(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function pathContains(parentDir: string, childPath: string): boolean {
  const relative = path.relative(parentDir, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
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
  return [argvRoot, moduleRoot].filter(
    (entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index,
  );
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
    if (fs.existsSync(path.join(packageRoot, "node_modules", ".pnpm"))) {
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
    : fs.existsSync(runtimeExtensionsDir);
  const hasUsableBuiltTree = sourceCheckout
    ? hasUsableBundledPluginTree(builtExtensionsDir)
    : fs.existsSync(builtExtensionsDir);
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

function createBundledPluginsDirCacheKey(env: NodeJS.ProcessEnv): string {
  return JSON.stringify({
    disabled: env.OPENCLAW_DISABLE_BUNDLED_PLUGINS ?? "",
    override: env.OPENCLAW_BUNDLED_PLUGINS_DIR ?? "",
    trustOverride: env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV] ?? "",
    processTrustOverride: process.env[TEST_TRUST_BUNDLED_PLUGINS_DIR_ENV] ?? "",
    vitest: env.VITEST ?? "",
    processVitest: process.env.VITEST ?? "",
    nodeEnv: process.env.NODE_ENV ?? "",
    argv1: process.argv[1] ?? "",
    execPath: process.execPath,
    openClawHome: env.OPENCLAW_HOME ?? "",
    home: env.HOME ?? "",
    userProfile: env.USERPROFILE ?? "",
    testOverride: bundledPluginsDirOverrideForTest ?? "",
  });
}

function resolveBundledPluginsDirUncached(env: NodeJS.ProcessEnv): string | undefined {
  if (areBundledPluginsDisabled(env)) {
    return resolveDisabledBundledPluginsDir();
  }

  if (bundledPluginsDirOverrideForTest) {
    return bundledPluginsDirOverrideForTest;
  }

  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  let rejectedExistingOverride: string | null = null;
  if (override) {
    const resolvedOverride = resolveUserPath(override, env);
    if (fs.existsSync(resolvedOverride)) {
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
    const packageRoots = [safeArgvRoot, moduleRoot].filter(
      (entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index,
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
    if (fs.existsSync(siblingBuilt)) {
      return siblingBuilt;
    }
    const sibling = path.join(execDir, "extensions");
    if (fs.existsSync(sibling)) {
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
      if (fs.existsSync(candidate)) {
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

export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const cacheKey = createBundledPluginsDirCacheKey(env);
  if (bundledPluginsDirCache.has(cacheKey)) {
    return bundledPluginsDirCache.get(cacheKey);
  }
  const resolved = resolveBundledPluginsDirUncached(env);
  bundledPluginsDirCache.set(cacheKey, resolved);
  return resolved;
}

export function setBundledPluginsDirOverrideForTest(dir: string | undefined): void {
  if (process.env.VITEST !== "true" && process.env.NODE_ENV !== "test") {
    throw new Error("setBundledPluginsDirOverrideForTest is only available in tests");
  }
  bundledPluginsDirOverrideForTest = dir;
  bundledPluginsDirCache.clear();
}
