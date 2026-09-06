/**
 * Resolves the managed Codex app-server binary shipped with or installed beside
 * the Codex plugin before stdio startup.
 */
import { constants as fsConstants, existsSync, realpathSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import type { CodexAppServerStartOptions, CodexManagedCommandOrder } from "./config.js";
import { resolveMacOSDesktopCodexAppServerCommandCandidates } from "./desktop-app-paths.js";
import { MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

// Registration and lazy artifacts share a root within the invoking plugin
// instance; preparing a replacement must not change the active owner's launcher.
const registeredCodexPlugin = createPluginRuntimeStore<string>({
  key: "openclaw.codexManagedPluginRoot",
  errorMessage:
    "Codex plugin root is unavailable. Load the Codex plugin before starting its managed app-server.",
});

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

/** Records the plugin root for this loader-owned instance. */
export function setManagedCodexPluginRoot(pluginRoot: string | undefined): void {
  if (pluginRoot) {
    registeredCodexPlugin.setRuntime(pluginRoot);
  } else {
    registeredCodexPlugin.clearRuntime();
  }
}

/** Rewrites managed stdio start options to point at an executable Codex binary path. */
export async function resolveManagedCodexAppServerStartOptions(
  startOptions: CodexAppServerStartOptions,
  options: ResolveManagedCodexAppServerOptions = {},
): Promise<CodexAppServerStartOptions> {
  if (startOptions.transport !== "stdio" || startOptions.commandSource !== "managed") {
    return startOptions;
  }

  const pluginRoot = options.pluginRoot ?? registeredCodexPlugin.getRuntime();
  const platform = options.platform ?? process.platform;
  const candidateCommandPaths = resolveManagedCodexAppServerCommandCandidates(
    pluginRoot,
    platform,
    startOptions.managedCommandOrder ?? "package-first",
  );
  const pathExists = options.pathExists ?? commandPathExists;
  const commandPaths = await findManagedCodexAppServerCommandPaths({
    candidateCommandPaths,
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
  if (isManagedCodexDesktopCommand(command, platform)) {
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
  // The npm entrypoint selects the platform package before checking its binary.
  // An incomplete platform package must not attest a different embedded executable.
  const packageJsonPath =
    resolvePackageJson(target.packageName, packageRoot) ??
    resolvePackageJson(MANAGED_CODEX_APP_SERVER_PACKAGE, packageRoot);
  if (!packageJsonPath) {
    return undefined;
  }
  const candidate = path.join(
    path.dirname(packageJsonPath),
    "vendor",
    target.triple,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
  return pathExists(candidate) ? candidate : undefined;
}

/** Recognizes only the official npm entrypoint, not arbitrary configured wrappers. */
export function resolvePackagedCodexNativeCommand(entrypoint: string): string | undefined {
  const packageRoot = path.dirname(path.dirname(entrypoint));
  if (
    path.basename(packageRoot) !== "codex" ||
    path.basename(path.dirname(packageRoot)) !== "@openai" ||
    path.relative(packageRoot, entrypoint) !== path.join("bin", "codex.js")
  ) {
    return undefined;
  }
  return resolveManagedCodexNativeCommand(entrypoint);
}

/** Returns whether a command is one of the standard macOS desktop app executables. */
export function isManagedCodexDesktopCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return (
    platform === "darwin" &&
    resolveMacOSDesktopCodexAppServerCommandCandidates(platform).some(
      (candidate) => candidate === command,
    )
  );
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
    const manifestPath = realpathSync(path.join(root, "package.json"));
    return createRequire(manifestPath).resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function resolveManagedCodexAppServerCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
  managedCommandOrder: CodexManagedCommandOrder,
): string[] {
  const packageCommand = resolveManagedCodexPackageEntrypoint(pluginRoot);
  const packageCommandPaths = packageCommand ? [packageCommand] : [];
  const desktopCommandPaths = resolveMacOSDesktopCodexAppServerCommandCandidates(platform);
  // Ordinary turns must honor the pinned package version. Computer Use opts
  // into the desktop app owner because its macOS TCC permissions live there.
  const orderedCommandPaths =
    managedCommandOrder === "desktop-first"
      ? [...desktopCommandPaths, ...packageCommandPaths]
      : [...packageCommandPaths, ...desktopCommandPaths];
  return orderedCommandPaths;
}

function resolveManagedCodexPackageEntrypoint(pluginRoot: string): string | undefined {
  try {
    // Use the pinned package's official launcher on every OS. It owns platform
    // selection, manager environment markers, signal forwarding, and exit status.
    return createRequire(path.join(pluginRoot, "package.json")).resolve(
      `${MANAGED_CODEX_APP_SERVER_PACKAGE}/bin/codex.js`,
    );
  } catch {
    return undefined;
  }
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
