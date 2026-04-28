import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";

const DISABLED_BUNDLED_PLUGINS_DIR = path.join(os.tmpdir(), "openclaw-empty-bundled-plugins");

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
    fs.existsSync(path.join(packageRoot, "src")) &&
    fs.existsSync(path.join(packageRoot, "extensions"))
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

function runningSourceTypeScriptProcess(): boolean {
  const argv1 = process.argv[1]?.toLowerCase();
  if (
    argv1?.endsWith(".ts") ||
    argv1?.endsWith(".tsx") ||
    argv1?.endsWith(".mts") ||
    argv1?.endsWith(".cts")
  ) {
    return true;
  }

  for (let index = 0; index < process.execArgv.length; index += 1) {
    const arg = process.execArgv[index]?.toLowerCase();
    if (!arg) {
      continue;
    }
    if (arg === "tsx" || arg.includes("tsx/register")) {
      return true;
    }
    if ((arg === "--import" || arg === "--loader") && process.execArgv[index + 1]) {
      const next = process.execArgv[index + 1].toLowerCase();
      if (next === "tsx" || next.includes("tsx/")) {
        return true;
      }
    }
  }

  return false;
}

function resolveBundledDirFromPackageRoot(
  packageRoot: string,
  preferSourceCheckout: boolean,
): string | undefined {
  const sourceExtensionsDir = path.join(packageRoot, "extensions");
  const builtExtensionsDir = path.join(packageRoot, "dist", "extensions");
  const sourceCheckout = isSourceCheckoutRoot(packageRoot);
  if (preferSourceCheckout && fs.existsSync(sourceExtensionsDir)) {
    return sourceExtensionsDir;
  }
  // Local source checkouts stage a runtime-complete bundled plugin tree under
  // dist-runtime/. Prefer that over source extensions only when the paired
  // dist/ tree exists; otherwise wrappers can drift ahead of the last build.
  const runtimeExtensionsDir = path.join(packageRoot, "dist-runtime", "extensions");
  const hasUsableRuntimeTree = sourceCheckout
    ? hasUsableBundledPluginTree(runtimeExtensionsDir)
    : fs.existsSync(runtimeExtensionsDir);
  const hasUsableBuiltTree = sourceCheckout
    ? hasUsableBundledPluginTree(builtExtensionsDir)
    : fs.existsSync(builtExtensionsDir);
  if (hasUsableRuntimeTree && hasUsableBuiltTree) {
    return runtimeExtensionsDir;
  }
  if (hasUsableBuiltTree) {
    return builtExtensionsDir;
  }
  if (sourceCheckout && fs.existsSync(sourceExtensionsDir)) {
    return sourceExtensionsDir;
  }
  return undefined;
}

export function resolveBundledPluginsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (areBundledPluginsDisabled(env)) {
    return resolveDisabledBundledPluginsDir();
  }

  const override = env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim();
  if (override) {
    const resolvedOverride = resolveUserPath(override, env);
    if (fs.existsSync(resolvedOverride)) {
      return resolvedOverride;
    }
    // Installed CLIs can inherit stale bundled-dir overrides from older shells
    // or debug sessions. Prefer the package that owns argv[1] over a broken
    // override so bundled providers keep working in packaged installs.
    try {
      const argvPackageRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
      if (argvPackageRoot && !isSourceCheckoutRoot(argvPackageRoot)) {
        const argvFallback = resolveBundledDirFromPackageRoot(argvPackageRoot, false);
        if (argvFallback) {
          return argvFallback;
        }
      }
    } catch {
      // ignore
    }
    return resolvedOverride;
  }

  const preferSourceCheckout = Boolean(env.VITEST) || runningSourceTypeScriptProcess();

  try {
    const argvRoot = resolveOpenClawPackageRootSync({ argv1: process.argv[1] });
    const cwdRoot = resolveOpenClawPackageRootSync({ cwd: process.cwd() });
    const moduleRoot = resolveOpenClawPackageRootSync({ moduleUrl: import.meta.url });
    const packageRoots = (
      preferSourceCheckout ? [cwdRoot, argvRoot, moduleRoot] : [argvRoot, cwdRoot, moduleRoot]
    ).filter(
      (entry, index, all): entry is string => Boolean(entry) && all.indexOf(entry) === index,
    );
    for (const packageRoot of packageRoots) {
      const bundledDir = resolveBundledDirFromPackageRoot(packageRoot, preferSourceCheckout);
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
