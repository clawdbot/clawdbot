import { constants as fsConstants, readFileSync } from "node:fs";
import { access } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CodexAppServerStartOptions } from "./config.js";
import { MANAGED_CODEX_APP_SERVER_PACKAGE } from "./version.js";

const CODEX_APP_SERVER_MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const CODEX_PLUGIN_ROOT = resolveDefaultCodexPluginRoot(CODEX_APP_SERVER_MODULE_DIR);

type ManagedCodexAppServerPaths = {
  commandPath: string;
  candidateCommandPaths: string[];
};

type ResolveManagedCodexAppServerOptions = {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
  pathExists?: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
};

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
  });
  const pathExists = options.pathExists ?? commandPathExists;
  const commandPath = await findManagedCodexAppServerCommandPath({
    candidateCommandPaths: paths.candidateCommandPaths,
    pathExists,
    platform,
  });

  return {
    ...startOptions,
    command: commandPath,
    commandSource: "resolved-managed",
  };
}

export function resolveManagedCodexAppServerPaths(params: {
  platform?: NodeJS.Platform;
  pluginRoot?: string;
}): ManagedCodexAppServerPaths {
  const platform = params.platform ?? process.platform;
  const candidateCommandPaths = resolveManagedCodexAppServerCommandCandidates(
    params.pluginRoot ?? CODEX_PLUGIN_ROOT,
    platform,
  );
  return {
    commandPath: candidateCommandPaths[0] ?? "",
    candidateCommandPaths,
  };
}

function resolveManagedCodexAppServerCommandCandidates(
  pluginRoot: string,
  platform: NodeJS.Platform,
): string[] {
  const pathApi = pathForPlatform(platform);
  const commandName = platform === "win32" ? "codex.cmd" : "codex";
  const roots = resolveManagedCodexAppServerCandidateRoots(pluginRoot, platform);
  return [
    ...new Set([
      ...roots.map((root) => pathApi.join(root, "node_modules", ".bin", commandName)),
      ...resolveManagedCodexPackageBinCandidates(roots, platform),
    ]),
  ];
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
  return [
    pluginRoot,
    pathApi.dirname(pluginRoot),
    pathApi.dirname(pathApi.dirname(pluginRoot)),
    isDistExtensionRoot(pluginRoot, platform)
      ? pathApi.dirname(pathApi.dirname(pathApi.dirname(pluginRoot)))
      : null,
  ].filter((root): root is string => Boolean(root));
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

export const __testing = {
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

async function findManagedCodexAppServerCommandPath(params: {
  candidateCommandPaths: readonly string[];
  pathExists: (filePath: string, platform: NodeJS.Platform) => Promise<boolean>;
  platform: NodeJS.Platform;
}): Promise<string> {
  for (const commandPath of params.candidateCommandPaths) {
    if (await params.pathExists(commandPath, params.platform)) {
      return commandPath;
    }
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
