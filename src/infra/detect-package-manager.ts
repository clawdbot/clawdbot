// Detects the package manager used by a project directory.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readPackageManagerSpec } from "./package-json.js";

type DetectedPackageManager = "pnpm" | "bun" | "npm";

export type BunGlobalInstallOwner = {
  globalRoot: string;
  globalProjectRoot: string;
  bunInstall?: string;
};

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Resolves Bun's global project from its installed owner rather than unrelated caller settings. */
export function resolveBunGlobalInstallOwner(
  pkgRoot?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): BunGlobalInstallOwner | null {
  const configuredInstall = env.BUN_INSTALL?.trim();
  const configuredGlobalProject = env.BUN_INSTALL_GLOBAL_DIR?.trim();
  if (pkgRoot == null) {
    const bunInstall = configuredInstall || path.join(os.homedir(), ".bun");
    const globalProjectRoot = path.resolve(
      configuredGlobalProject || path.join(bunInstall, "install", "global"),
    );
    return {
      globalRoot: path.join(globalProjectRoot, "node_modules"),
      globalProjectRoot,
      ...(!configuredGlobalProject || configuredInstall
        ? { bunInstall: path.resolve(bunInstall) }
        : {}),
    };
  }

  const trimmed = pkgRoot.trim();
  if (!trimmed) {
    return null;
  }
  let globalRoot = path.dirname(path.resolve(trimmed));
  if (path.basename(globalRoot).startsWith("@")) {
    globalRoot = path.dirname(globalRoot);
  }
  if (path.basename(globalRoot) !== "node_modules") {
    return null;
  }

  const globalProjectRoot = path.dirname(globalRoot);
  const installRoot = path.dirname(globalProjectRoot);
  const conventionalLayout =
    path.basename(globalProjectRoot) === "global" && path.basename(installRoot) === "install";
  const configuredProjectMatches =
    configuredGlobalProject !== undefined &&
    path.resolve(configuredGlobalProject) === globalProjectRoot;
  if (!conventionalLayout && !configuredProjectMatches) {
    return null;
  }

  const bunInstall = conventionalLayout ? path.dirname(installRoot) : configuredInstall;
  return {
    globalRoot,
    globalProjectRoot,
    ...(bunInstall ? { bunInstall: path.resolve(bunInstall) } : {}),
  };
}

export function resolvePnpmNodeModulesRoot(root: string): string | null {
  const resolved = path.resolve(root);
  const parts = resolved.split(path.sep);
  const pnpmIndex = parts.lastIndexOf(".pnpm");
  if (pnpmIndex > 0) {
    const layoutRoot = parts.slice(0, pnpmIndex).join(path.sep) || path.sep;
    return path.basename(layoutRoot) === "node_modules"
      ? layoutRoot
      : path.join(layoutRoot, "node_modules");
  }

  const parent = path.dirname(resolved);
  return path.basename(parent) === "node_modules" ? parent : null;
}

export async function isBunOwnedPackageRoot(root: string): Promise<boolean> {
  return resolveBunGlobalInstallOwner(root) !== null;
}

export async function isPnpmOwnedPackageRoot(root: string): Promise<boolean> {
  const nodeModulesRoot = resolvePnpmNodeModulesRoot(root);
  if (!nodeModulesRoot || !(await exists(path.join(nodeModulesRoot, ".modules.yaml")))) {
    return false;
  }
  return true;
}

/** Detects the package manager that owns a package root from manifests, locks, and install layout. */
export async function detectPackageManager(root: string): Promise<DetectedPackageManager | null> {
  const pm = (await readPackageManagerSpec(root))?.split("@")[0]?.trim();
  const files = await fs.readdir(root).catch((): string[] => []);
  const hasNpmShrinkwrap = files.includes("npm-shrinkwrap.json");
  const hasPnpmLock = files.includes("pnpm-lock.yaml");
  const hasBunLock = files.includes("bun.lock") || files.includes("bun.lockb");

  // Published packages retain source pnpm metadata, and modern releases omit
  // shrinkwrap; detect Bun by its install root before checking older npm locks.
  if (await isBunOwnedPackageRoot(root)) {
    return "bun";
  }
  if (hasNpmShrinkwrap) {
    if (pm === "pnpm" && (hasPnpmLock || (await isPnpmOwnedPackageRoot(root)))) {
      return "pnpm";
    }
    if (pm === "bun" && hasBunLock) {
      return "bun";
    }
    return "npm";
  }

  if (pm === "pnpm" || pm === "bun" || pm === "npm") {
    return pm;
  }

  if (hasPnpmLock) {
    return "pnpm";
  }
  if (hasBunLock) {
    return "bun";
  }
  if (files.includes("package-lock.json") || hasNpmShrinkwrap) {
    return "npm";
  }
  return null;
}
