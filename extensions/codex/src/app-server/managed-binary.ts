/**
 * Resolves the managed Codex app-server binary shipped with or installed beside
 * the Codex plugin before stdio startup.
 */
import { constants as fsConstants, existsSync, readFileSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type { CodexAppServerStartOptions, CodexManagedCommandOrder } from "./config.js";
import { MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

const CODEX_APP_SERVER_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_PLUGIN_ROOT = resolveDefaultCodexPluginRoot(CODEX_APP_SERVER_MODULE_DIR);
// ChatGPT.app is the current desktop owner; keep Codex.app as the legacy fallback.
const MACOS_DESKTOP_CODEX_APP_SERVER_COMMANDS = [
  "/Applications/ChatGPT.app/Contents/Resources/codex",
  "/Applications/Codex.app/Contents/Resources/codex",
] as const;

type ManagedCodexAppServerPaths = {
  commandPath: string;
  candidateCommandPaths: string[];
};

type ResolveManagedCodexAppServerOptions = {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  pathExists?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
};

type ResolveManagedCodexNativeCommandOptions = {
  platform?: NodeJS.Platform;
  arch?: NodeJS.Architecture;
  pathExists?: (filePath: string) => boolean;
  resolvePackageJson?: (packageName: string, root: string) => string | undefined;
};

/** Rewrites managed stdio start options to point at an executable Codex binary path. */
export async function resolveManagedCodexAppServerStartOptions(
  startOptions: CodexAppServerStartOptions,
  options: ResolveManagedCodexAppServerOptions = {},
): Promise<CodexAppServerStartOptions> {
  if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") {
    return startOptions;
  }

  const platform = options.platform ?? process.platform;
  const paths = resolveManagedCodexAppServerPaths({
    platform,
    pluginRoot: options.pluginRoot,
    managedCommandOrder: startOptions.managedCommandOrder,
  });
  const pathExists = options.pathExists ?? commandPathExists;
  const commandPaths = await findManagedCodexAppServerCommandPaths({
    candidateCommandPaths: paths.candidateCommandPaths,
    pathExists,
    platform,
  });
  const commandPath = expectDefined(commandPaths[0], "resolved managed Codex command path");
  const managedFallbackCommandPaths = commandPaths.slice(1);

  return {
    ...startOptions,
    command: commandPath,
    commandSource: "resolved-managed",
    ...(managedFallbackCommandPaths.length > 0 ? { managedFallbackCommandPaths } : {}),
  };
}

/** Resolves the native artifact behind a successful managed launcher selection. */
export function resolveManagedCodexNativeCommand(
  command: string,
  options: ResolveManagedCodexNativeCommandOptions = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  if (
    platform === "darwin" &&
    MACOS_DESKTOP_CODEX_APP_SERVER_COMMANDS.some((candidate) => candidate === command)
  ) {
    return command;
  }
  const target = resolveCodexNativeTarget(platform, options.arch ?? process.arch);
  if (!target) {
    return undefined;
  }
  const packageRoot = resolveManagedCodexPackageRootForCommand(command, platform);
  if (!packageRoot) {
    return undefined;
  }
  const resolvePackageJson = options.resolvePackageJson ?? resolvePackageJsonFromRoot;
  const pathExists = options.pathExists ?? existsSync;
  for (const packageName of [target.packageName, MANAGED_CODEX_APP_SERVER_PACKAGE]) {
    const packageJsonPath = resolvePackageJson(packageName, packageRoot);
    if (!packageJsonPath) {
      continue;
    }
    const candidate = path.join(
      path.dirname(packageJsonPath),
      "vendor",
      target.triple,
      "bin",
      platform === "win32" ? "codex.exe" : "codex",
    );
    if (pathExists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

function resolveManagedCodexPackageRootForCommand(
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  const pathApi = pathForPlatform(platform);
  const commandPaths = [command];
  try {
    commandPaths.unshift(realpathSync(command));
  } catch {
    // Lexical .bin shims still identify their adjacent package root.
  }
  for (const commandPath of commandPaths) {
    let current = pathApi.dirname(commandPath);
    while (true) {
      if (
        pathApi.basename(current) === "codex" &&
        pathApi.basename(pathApi.dirname(current)) === "@openai"
      ) {
        return current;
      }
      if (pathApi.basename(current) === ".bin") {
        return pathApi.join(pathApi.dirname(current), "@openai", "codex");
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return undefined;
}

function resolveCodexNativeTarget(
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): { packageName: string; triple: string } | undefined {
  // Mirrors @openai/codex's launcher mapping; this resolves identity only and
  // leaves process environment/launch behavior with the upstream entrypoint.
  if ((platform === "linux" || platform === "android") && arch === "x64") {
    return { packageName: "@openai/codex-linux-x64", triple: "x86_64-unknown-linux-musl" };
  }
  if ((platform === "linux" || platform === "android") && arch === "arm64") {
    return { packageName: "@openai/codex-linux-arm64", triple: "aarch64-unknown-linux-musl" };
  }
  if (platform === "darwin" && arch === "x64") {
    return { packageName: "@openai/codex-darwin-x64", triple: "x86_64-apple-darwin" };
  }
  if (platform === "darwin" && arch === "arm64") {
    return { packageName: "@openai/codex-darwin-arm64", triple: "aarch64-apple-darwin" };
  }
  if (platform === "win32" && arch === "x64") {
    return { packageName: "@openai/codex-win32-x64", triple: "x86_64-pc-windows-msvc" };
  }
  if (platform === "win32" && arch === "arm64") {
    return { packageName: "@openai/codex-win32-arm64", triple: "aarch64-pc-windows-msvc" };
  }
  return undefined;
}

function resolvePackageJsonFromRoot(packageName: string, root: string): string | undefined {
  try {
    return createRequire(path.join(root, "package.json")).resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

/** Returns the preferred and fallback managed Codex binary paths for a plugin root. */
export function resolveManagedCodexAppServerPaths(params: {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  managedCommandOrder?: CodexManagedCommandOrder;
}): ManagedCodexAppServerPaths {
  const platform = params.platform ?? process.platform;
  const candidateCommandPaths = resolveManagedCodexAppServerCommandCandidates(
    params.pluginRoot ?? CODEX_PLUGIN_ROOT,
    platform,
    params.managedCommandOrder ?? "package-first",
  );
  return {
    commandPath: candidateCommandPaths[0] ?? "",
    candidateCommandPaths,
  };
}

function resolveManagedCodexAppServerCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
  managedCommandOrder: CodexManagedCommandOrder,
): string[] {
  const pathApi = pathForPlatform(platform);
  const commandName = platform === "win32" ? "codex.cmd" : "codex";
  const roots = resolveManagedCodexAppServerCandidateRoots(pluginRoot, platform);
  const packageCommandPaths = [
    ...roots.map((root) => pathApi.join(root, "node_modules", ".bin", commandName)),
    ...resolveManagedCodexPackageBinCandidates(roots, platform),
  ];
  const desktopCommandPaths = resolveDesktopCodexAppServerCommandCandidates(platform);
  // Ordinary turns must honor the pinned package version. Computer Use opts
  // into the desktop app owner because its macOS TCC permissions live there.
  const orderedCommandPaths =
    managedCommandOrder === "desktop-first"
      ? [...desktopCommandPaths, ...packageCommandPaths]
      : [...packageCommandPaths, ...desktopCommandPaths];
  return [...new Set(orderedCommandPaths)];
}

function resolveDesktopCodexAppServerCommandCandidates(platform: NodeJS.Platform): string[] {
  return platform === "darwin" ? [...MACOS_DESKTOP_CODEX_APP_SERVER_COMMANDS] : [];
}

function resolveDefaultCodexPluginRoot(moduleDir: string): string {
  const moduleBaseName = path.basename(moduleDir);
  if (moduleBaseName === "dist" || moduleBaseName === "dist-runtime") {
    return path.dirname(moduleDir);
  }
  return path.resolve(moduleDir, "..", "..");
}

function resolveManagedCodexAppServerCandidateRoots(
  pluginRoot: string,
  platform: NodeJS.Platform,
): string[] {
  const pathApi = pathForPlatform(platform);
  const directRoots = [
    pluginRoot,
    pathApi.dirname(pluginRoot),
    pathApi.dirname(pathApi.dirname(pluginRoot)),
    isDistExtensionRoot(pluginRoot, platform)
      ? pathApi.dirname(pathApi.dirname(pathApi.dirname(pluginRoot)))
      : null,
  ].filter((root): root is string => Boolean(root));
  return [
    ...new Set([...directRoots, ...resolveNearestNodeModulesProjectRoots(directRoots, platform)]),
  ];
}

function resolveNearestNodeModulesProjectRoots(
  roots: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  const pathApi = pathForPlatform(platform);
  const projectRoots: string[] = [];
  for (const root of roots) {
    let current = pathApi.resolve(root);
    while (true) {
      if (pathApi.basename(current) === "node_modules") {
        projectRoots.push(pathApi.dirname(current));
        break;
      }
      const parent = pathApi.dirname(current);
      if (parent === current) {
        break;
      }
      current = parent;
    }
  }
  return projectRoots;
}

function resolveManagedCodexPackageBinCandidates(
  roots: readonly string[],
  platform: NodeJS.Platform,
): string[] {
  if (platform === "win32") {
    return [];
  }

  const candidates: string[] = [];
  for (const root of roots) {
    const candidate = resolveManagedCodexPackageBinCandidate(root);
    if (candidate) {
      candidates.push(candidate);
    }
  }
  return candidates;
}

function resolveManagedCodexPackageBinCandidate(root: string): string | null {
  try {
    const requireFromRoot = createRequire(path.join(root, "package.json"));
    const packageJsonPath = requireFromRoot.resolve(
      `${MANAGED_CODEX_APP_SERVER_PACKAGE}/package.json`,
    );
    const packageRoot = path.dirname(packageJsonPath);
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      bin?: unknown;
    };
    const binPath =
      typeof packageJson.bin === "string"
        ? packageJson.bin
        : isRecord(packageJson.bin) && typeof packageJson.bin.codex === "string"
          ? packageJson.bin.codex
          : null;
    return binPath ? path.resolve(packageRoot, binPath) : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Internal helpers exposed for managed-binary path-resolution tests. */
export const testing = {
  resolveDefaultCodexPluginRoot,
};

function isDistExtensionRoot(pluginRoot: string, platform: NodeJS.Platform): boolean {
  const pathApi = pathForPlatform(platform);
  const extensionsDir = pathApi.dirname(pluginRoot);
  const distDir = pathApi.dirname(extensionsDir);
  return (
    pathApi.basename(extensionsDir) === "extensions" &&
    (pathApi.basename(distDir) === "dist" || pathApi.basename(distDir) === "dist-runtime")
  );
}

function pathForPlatform(platform: NodeJS.Platform): typeof path {
  return platform === "win32" ? path.win32 : path.posix;
}

async function findManagedCodexAppServerCommandPaths(params: {
  candidateCommandPaths: readonly string[];
  pathExists: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  platform: NodeJS.Platform;
}): Promise<string[]> {
  const commandPaths: string[] = [];
  for (const commandPath of params.candidateCommandPaths) {
    if (await params.pathExists(commandPath, params.platform)) {
      commandPaths.push(commandPath);
    }
  }
  if (commandPaths.length > 0) {
    return commandPaths;
  }

  throw new Error(
    [
      `Managed Codex app-server binary was not found for ${MANAGED_CODEX_APP_SERVER_PACKAGE}.`,
      "Reinstall or update OpenClaw, or run pnpm install in a source checkout.",
      "Set plugins.entries.codex.config.appServer.command or OPENCLAW_CODEX_APP_SERVER_BIN to use a custom Codex binary.",
    ].join(" "),
  );
}

async function commandPathExists(filePath: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    await access(filePath, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
export { testing as __testing };
