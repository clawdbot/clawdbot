/**
 * Resolves package assets and per-user agent directories for the CLI/runtime.
 *
 * These helpers must work from source, dist, and Bun single-file binaries.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// Package Detection
// =============================================================================

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);

/**
 * Detect if we're running as a Bun compiled binary.
 * Bun binaries have import.meta.url containing "$bunfs", "~BUN", or "%7EBUN" (Bun's virtual filesystem path)
 */
export const isBunBinary =
  import.meta.url.includes("$bunfs") ||
  import.meta.url.includes("~BUN") ||
  import.meta.url.includes("%7EBUN");

// =============================================================================
// Package Asset Paths (shipped with executable)
// =============================================================================

/**
 * Get the base directory for resolving package assets (themes, package.json, README.md, CHANGELOG.md).
 * - For Bun binary: returns the directory containing the executable
 * - For Node.js (dist/): returns currentDir (the dist/ directory)
 * - For tsx (src/): returns parent directory (the package root)
 */
export function getPackageDir(): string {
  // Allow override via environment variable (useful for Nix/Guix where store paths tokenize poorly)
  const envDir = process.env.OPENCLAW_PACKAGE_DIR;
  if (envDir) {
    if (envDir === "~") {
      return homedir();
    }
    if (envDir.startsWith("~/")) {
      return homedir() + envDir.slice(1);
    }
    return envDir;
  }

  if (isBunBinary) {
    // Bun binary: process.execPath points to the compiled executable
    return dirname(process.execPath);
  }
  // Node.js: walk up from currentDir until we find package.json
  let dir = currentDir;
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  // Fallback (shouldn't happen)
  return currentDir;
}

function getPackageSourceOrDistDir(): string {
  const packageDir = getPackageDir();
  const srcOrDist = existsSync(join(packageDir, "src")) ? "src" : "dist";
  return join(packageDir, srcOrDist);
}

/**
 * Get path to built-in themes directory (shipped with package)
 * - For Bun binary: theme/ next to executable
 * - For Node.js (dist/): dist/agents/modes/interactive/theme/
 * - For tsx (src/): src/agents/modes/interactive/theme/
 */
export function getThemesDir(): string {
  if (isBunBinary) {
    return join(getPackageDir(), "theme");
  }
  return join(getPackageSourceOrDistDir(), "agents", "modes", "interactive", "theme");
}

/** Get path to package.json */
export function getPackageJsonPath(): string {
  return join(getPackageDir(), "package.json");
}

/** Get path to README.md */
export function getReadmePath(): string {
  return resolve(join(getPackageDir(), "README.md"));
}

/** Get path to docs directory */
export function getDocsPath(): string {
  return resolve(join(getPackageDir(), "docs"));
}

/** Get path to examples directory */
export function getExamplesPath(): string {
  return resolve(join(getPackageDir(), "examples"));
}

// =============================================================================
// App Config (from package.json openclawConfig)
// =============================================================================

interface PackageJson {
  name?: string;
  version?: string;
  openclawConfig?: {
    name?: string;
    configDir?: string;
  };
}

const pkg = JSON.parse(readFileSync(getPackageJsonPath(), "utf-8")) as PackageJson;

const openClawConfigName: string | undefined = pkg.openclawConfig?.name;
export const APP_NAME: string = openClawConfigName || "openclaw";
export const CONFIG_DIR_NAME: string = pkg.openclawConfig?.configDir || ".openclaw";
export const VERSION: string = pkg.version || "0.0.0";

export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_AGENT_DIR`;

export function expandTildePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return homedir() + path.slice(1);
  }
  return path;
}

// =============================================================================
// User Config Paths (~/.openclaw/agent/*)
// =============================================================================

/** Get the agent config directory (e.g., ~/.openclaw/agent/) */
export function getAgentDir(): string {
  const envDir = process.env[ENV_AGENT_DIR];
  if (envDir) {
    return expandTildePath(envDir);
  }
  return join(homedir(), CONFIG_DIR_NAME, "agent");
}

/** Get path to user's custom themes directory */
export function getCustomThemesDir(): string {
  return join(getAgentDir(), "themes");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
  return join(getAgentDir(), "bin");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}
