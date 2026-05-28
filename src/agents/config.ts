import { accessSync, constants, existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnProcessSync } from "./utils/child-process.ts";

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

/** Detect if Bun is the runtime (compiled binary or bun run) */
export const isBunRuntime = !!process.versions.bun;

// =============================================================================
// Install Method Detection
// =============================================================================

export type InstallMethod = "bun-binary" | "npm" | "pnpm" | "yarn" | "bun" | "unknown";

interface SelfUpdateCommandStep {
  command: string;
  args: string[];
  display: string;
}

export interface SelfUpdateCommand extends SelfUpdateCommandStep {
  steps?: SelfUpdateCommandStep[];
}

function makeSelfUpdateCommand(
  installStep: SelfUpdateCommandStep,
  uninstallStep?: SelfUpdateCommandStep,
): SelfUpdateCommand {
  if (!uninstallStep) {
    return installStep;
  }
  return {
    ...installStep,
    display: `${uninstallStep.display} && ${installStep.display}`,
    steps: [uninstallStep, installStep],
  };
}

function makeSelfUpdateCommandStep(command: string, args: string[]): SelfUpdateCommandStep {
  return {
    command,
    args,
    display: [command, ...args].map((arg) => (/\s/.test(arg) ? `"${arg}"` : arg)).join(" "),
  };
}

export function detectInstallMethod(): InstallMethod {
  if (isBunBinary) {
    return "bun-binary";
  }

  const resolvedPath = `${currentDir}\0${process.execPath || ""}`.toLowerCase().replace(/\\/g, "/");

  if (resolvedPath.includes("/pnpm/") || resolvedPath.includes("/.pnpm/")) {
    return "pnpm";
  }
  if (resolvedPath.includes("/yarn/") || resolvedPath.includes("/.yarn/")) {
    return "yarn";
  }
  if (isBunRuntime || resolvedPath.includes("/install/global/node_modules/")) {
    return "bun";
  }
  if (resolvedPath.includes("/npm/") || resolvedPath.includes("/node_modules/")) {
    return "npm";
  }

  return "unknown";
}

function getInferredNpmInstall(): { root: string; prefix: string } | undefined {
  const packageDir = getPackageDir();
  const path =
    process.platform === "win32" || packageDir.includes("\\") ? win32 : { basename, dirname };
  const parent = path.dirname(packageDir);
  let root: string | undefined;
  if (
    path.basename(parent).startsWith("@") &&
    path.basename(path.dirname(parent)) === "node_modules"
  ) {
    root = path.dirname(parent);
  } else if (path.basename(parent) === "node_modules") {
    root = parent;
  }
  if (!root) {
    return undefined;
  }
  const rootParent = path.dirname(root);
  if (path.basename(rootParent) === "lib") {
    return { root, prefix: path.dirname(rootParent) };
  }
  // Windows global npm prefixes use `<prefix>\\node_modules`, which is
  // indistinguishable from local project installs by path shape alone. Do not
  // infer unsupported Windows custom prefixes without `npm root -g` evidence.
  return undefined;
}

function getSelfUpdateCommandForMethod(
  method: InstallMethod,
  installedPackageName: string,
  updatePackageName = installedPackageName,
  npmCommand?: string[],
): SelfUpdateCommand | undefined {
  switch (method) {
    case "bun-binary":
      return undefined;
    case "pnpm":
      return makeSelfUpdateCommand(
        makeSelfUpdateCommandStep("pnpm", ["install", "-g", "--ignore-scripts", updatePackageName]),
        updatePackageName === installedPackageName
          ? undefined
          : makeSelfUpdateCommandStep("pnpm", ["remove", "-g", installedPackageName]),
      );
    case "yarn":
      return makeSelfUpdateCommand(
        makeSelfUpdateCommandStep("yarn", ["global", "add", "--ignore-scripts", updatePackageName]),
        updatePackageName === installedPackageName
          ? undefined
          : makeSelfUpdateCommandStep("yarn", ["global", "remove", installedPackageName]),
      );
    case "bun":
      return makeSelfUpdateCommand(
        makeSelfUpdateCommandStep("bun", ["install", "-g", "--ignore-scripts", updatePackageName]),
        updatePackageName === installedPackageName
          ? undefined
          : makeSelfUpdateCommandStep("bun", ["uninstall", "-g", installedPackageName]),
      );
    case "npm": {
      const [command = "npm", ...npmArgs] = npmCommand ?? [];
      const inferred = npmCommand?.length ? undefined : getInferredNpmInstall();
      const prefixArgs = [...npmArgs, ...(inferred ? ["--prefix", inferred.prefix] : [])];
      const installStep = makeSelfUpdateCommandStep(command, [
        ...prefixArgs,
        "install",
        "-g",
        "--ignore-scripts",
        updatePackageName,
      ]);
      const uninstallStep =
        updatePackageName === installedPackageName
          ? undefined
          : makeSelfUpdateCommandStep(command, [
              ...prefixArgs,
              "uninstall",
              "-g",
              installedPackageName,
            ]);
      return makeSelfUpdateCommand(installStep, uninstallStep);
    }
    case "unknown":
      return undefined;
  }
  return undefined;
}

function readCommandOutput(
  command: string,
  args: string[],
  options: { requireSuccess?: boolean } = {},
): string | undefined {
  const result = spawnProcessSync(command, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status === 0) {
    return result.stdout.trim() || undefined;
  }
  if (options.requireSuccess) {
    const reason =
      result.error?.message || result.stderr.trim() || `exit code ${result.status ?? "unknown"}`;
    throw new Error(`Failed to run ${[command, ...args].join(" ")}: ${reason}`);
  }
  return undefined;
}

function getGlobalPackageRoots(
  method: InstallMethod,
  _packageName: string,
  npmCommand?: string[],
): string[] {
  switch (method) {
    case "npm": {
      const configured = !!npmCommand?.length;
      const [command = "npm", ...npmArgs] = npmCommand ?? [];
      if (configured && command === "bun") {
        const bunBin = readCommandOutput(command, [...npmArgs, "pm", "bin", "-g"], {
          requireSuccess: true,
        });
        const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
        if (bunBin) {
          roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
        }
        return roots;
      }
      const root = readCommandOutput(command, [...npmArgs, "root", "-g"], {
        requireSuccess: configured,
      });
      const inferred = configured ? undefined : getInferredNpmInstall();
      return [root, inferred?.root].filter((x): x is string => !!x);
    }
    case "pnpm": {
      const root = readCommandOutput("pnpm", ["root", "-g"]);
      return root ? [root, dirname(root)] : [];
    }
    case "yarn": {
      const dir = readCommandOutput("yarn", ["global", "dir"]);
      return dir ? [dir, join(dir, "node_modules")] : [];
    }
    case "bun": {
      const bunBin = readCommandOutput("bun", ["pm", "bin", "-g"]);
      const roots = [join(homedir(), ".bun", "install", "global", "node_modules")];
      if (bunBin) {
        roots.push(join(dirname(bunBin), "install", "global", "node_modules"));
      }
      return roots;
    }
    case "bun-binary":
    case "unknown":
      return [];
  }
  return [];
}

function normalizeExistingPathForComparison(
  path: string,
  resolveSymlinks: boolean,
): string | undefined {
  const resolvedPath = resolve(path);
  if (!existsSync(resolvedPath)) {
    return undefined;
  }
  let normalizedPath = resolvedPath;
  if (resolveSymlinks) {
    try {
      normalizedPath = realpathSync(resolvedPath);
    } catch {
      return undefined;
    }
  }
  if (process.platform === "win32") {
    normalizedPath = normalizedPath.toLowerCase();
  }
  return normalizedPath;
}

function getPathComparisonCandidates(path: string): string[] {
  return Array.from(
    new Set(
      [
        normalizeExistingPathForComparison(path, false),
        normalizeExistingPathForComparison(path, true),
      ].filter((candidate): candidate is string => !!candidate),
    ),
  );
}

function getEntrypointPackageDir(): string | undefined {
  const entrypoint = process.argv[1];
  if (!entrypoint) {
    return undefined;
  }
  let dir = dirname(entrypoint);
  while (dir !== dirname(dir)) {
    if (existsSync(join(dir, "package.json"))) {
      return dir;
    }
    dir = dirname(dir);
  }
  return undefined;
}

function isSelfUpdatePathWritable(): boolean {
  const packageDir = getPackageDir();
  try {
    accessSync(packageDir, constants.W_OK);
    accessSync(dirname(packageDir), constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isManagedByGlobalPackageManager(
  method: InstallMethod,
  packageName: string,
  npmCommand?: string[],
): boolean {
  const packageDirs = [getPackageDir(), getEntrypointPackageDir()].filter(
    (dir): dir is string => !!dir,
  );
  const packageDirCandidates = packageDirs.flatMap((dir) => getPathComparisonCandidates(dir));
  return getGlobalPackageRoots(method, packageName, npmCommand).some((root) => {
    return getPathComparisonCandidates(root).some((normalizedRoot) => {
      const rootPrefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
      return packageDirCandidates.some((packageDir) => packageDir.startsWith(rootPrefix));
    });
  });
}

export function getSelfUpdateCommand(
  packageName: string,
  npmCommand?: string[],
  updatePackageName = packageName,
): SelfUpdateCommand | undefined {
  const method = detectInstallMethod();
  const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
  if (
    !command ||
    !isManagedByGlobalPackageManager(method, packageName, npmCommand) ||
    !isSelfUpdatePathWritable()
  ) {
    return undefined;
  }
  return command;
}

export function getSelfUpdateUnavailableInstruction(
  packageName: string,
  npmCommand?: string[],
  updatePackageName = packageName,
): string {
  const method = detectInstallMethod();
  if (method === "bun-binary") {
    return `Download from: https://github.com/openclaw/openclaw/releases/latest`;
  }
  const command = getSelfUpdateCommandForMethod(method, packageName, updatePackageName, npmCommand);
  if (command) {
    if (
      isManagedByGlobalPackageManager(method, packageName, npmCommand) &&
      !isSelfUpdatePathWritable()
    ) {
      return `This installation is managed by a global ${method} install, but the install path is not writable. Update it yourself with: ${command.display}`;
    }
    return `This installation is not managed by a global ${method} install. Update it with the package manager, wrapper, or source checkout that provides it.`;
  }
  return `Update ${updatePackageName} using the package manager, wrapper, or source checkout that provides this installation.`;
}

export function getUpdateInstruction(packageName: string): string {
  const method = detectInstallMethod();
  const command = getSelfUpdateCommandForMethod(method, packageName);
  if (command) {
    return `Run: ${command.display}`;
  }
  return getSelfUpdateUnavailableInstruction(packageName);
}

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

/** Get path to CHANGELOG.md */
export function getChangelogPath(): string {
  return resolve(join(getPackageDir(), "CHANGELOG.md"));
}

/**
 * Get path to built-in interactive assets directory.
 * - For Bun binary: assets/ next to executable
 * - For Node.js (dist/): dist/agents/modes/interactive/assets/
 * - For tsx (src/): src/agents/modes/interactive/assets/
 */
export function getInteractiveAssetsDir(): string {
  if (isBunBinary) {
    return join(getPackageDir(), "assets");
  }
  return join(getPackageSourceOrDistDir(), "agents", "modes", "interactive", "assets");
}

/** Get path to a bundled interactive asset */
export function getBundledInteractiveAssetPath(name: string): string {
  return join(getInteractiveAssetsDir(), name);
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
export const PACKAGE_NAME: string = pkg.name || "openclaw/plugin-sdk/agent-sessions";
export const APP_NAME: string = openClawConfigName || "openclaw";
export const APP_TITLE: string = openClawConfigName ? APP_NAME : "OpenClaw";
export const CONFIG_DIR_NAME: string = pkg.openclawConfig?.configDir || ".openclaw";
export const VERSION: string = pkg.version || "0.0.0";

export const ENV_AGENT_DIR = `${APP_NAME.toUpperCase()}_AGENT_DIR`;
export const ENV_SESSION_DIR = `${APP_NAME.toUpperCase()}_AGENT_SESSION_DIR`;

export function expandTildePath(path: string): string {
  if (path === "~") {
    return homedir();
  }
  if (path.startsWith("~/")) {
    return homedir() + path.slice(1);
  }
  return path;
}

const DEFAULT_SHARE_VIEWER_URL = "https://openclaw.ai/session/";

/** Get the share viewer URL for a gist ID */
export function getShareViewerUrl(gistId: string): string {
  const baseUrl = process.env.OPENCLAW_SHARE_VIEWER_URL || DEFAULT_SHARE_VIEWER_URL;
  return `${baseUrl}#${gistId}`;
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

/** Get path to models.json */
export function getModelsPath(): string {
  return join(getAgentDir(), "models.json");
}

/** Get path to auth.json */
export function getAuthPath(): string {
  return join(getAgentDir(), "auth.json");
}

/** Get path to settings.json */
export function getSettingsPath(): string {
  return join(getAgentDir(), "settings.json");
}

/** Get path to tools directory */
export function getToolsDir(): string {
  return join(getAgentDir(), "tools");
}

/** Get path to managed binaries directory (fd, rg) */
export function getBinDir(): string {
  return join(getAgentDir(), "bin");
}

/** Get path to prompt templates directory */
export function getPromptsDir(): string {
  return join(getAgentDir(), "prompts");
}

/** Get path to sessions directory */
export function getSessionsDir(): string {
  return join(getAgentDir(), "sessions");
}

/** Get path to debug log file */
export function getDebugLogPath(): string {
  return join(getAgentDir(), `${APP_NAME}-debug.log`);
}
