import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { isSupportedNodeVersion } from "../infra/runtime-guard.js";
import { resolveStableNodePath } from "../infra/stable-node-path.js";
import { getWindowsProgramFilesRoots } from "../infra/windows-install-roots.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";

const VERSION_MANAGER_MARKERS = [
  "/.nvm/",
  "/.fnm/",
  "/.local/share/fnm/",
  "/library/application support/fnm/",
  "/.volta/",
  "/.asdf/",
  "/.local/share/mise/",
  "/.n/",
  "/.nodenv/",
  "/.nodebrew/",
  "/nvs/",
];

function getPathModule(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function isNodeExecPath(execPath: string, platform: NodeJS.Platform): boolean {
  const pathModule = getPathModule(platform);
  const base = normalizeLowercaseStringOrEmpty(pathModule.basename(execPath));
  return base === "node" || base === "node.exe";
}

function normalizeForCompare(input: string, platform: NodeJS.Platform): string {
  const pathModule = getPathModule(platform);
  const normalized = pathModule.normalize(input).replaceAll("\\", "/");
  if (platform === "win32") {
    return normalizeLowercaseStringOrEmpty(normalized);
  }
  return normalized;
}

function buildSystemNodeCandidates(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string[] {
  if (platform === "darwin") {
    return [
      "/opt/homebrew/bin/node",
      "/opt/homebrew/opt/node/bin/node",
      "/opt/homebrew/opt/node@24/bin/node",
      "/opt/homebrew/opt/node@22/bin/node",
      "/usr/local/bin/node",
      "/usr/local/opt/node/bin/node",
      "/usr/local/opt/node@24/bin/node",
      "/usr/local/opt/node@22/bin/node",
      "/usr/bin/node",
    ];
  }
  if (platform === "linux") {
    return ["/usr/local/bin/node", "/usr/bin/node"];
  }
  if (platform === "win32") {
    const pathModule = getPathModule(platform);
    return getWindowsProgramFilesRoots(env).map((root) =>
      pathModule.join(root, "nodejs", "node.exe"),
    );
  }
  return [];
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8" },
) => Promise<{ stdout: string; stderr: string }>;

const execFileAsync = promisify(execFile) as unknown as ExecFileAsync;

async function resolveNodeVersion(
  nodePath: string,
  execFileImpl: ExecFileAsync,
): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl(nodePath, ["-p", "process.versions.node"], {
      encoding: "utf8",
    });
    const value = stdout.trim();
    return value ? value : null;
  } catch {
    return null;
  }
}

type SystemNodeInfo = {
  path: string;
  version: string | null;
  supported: boolean;
};

async function isVersionManagedRealNodePath(
  nodePath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const realPath = await fs.realpath(nodePath);
    return isVersionManagedNodePath(realPath, platform);
  } catch {
    return false;
  }
}

export function isVersionManagedNodePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(normalizeForCompare(nodePath, platform));
  return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}

export function isSystemNodePath(
  nodePath: string,
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeForCompare(nodePath, platform);
  return buildSystemNodeCandidates(env, platform).some((candidate) => {
    const normalizedCandidate = normalizeForCompare(candidate, platform);
    return normalized === normalizedCandidate;
  });
}

export async function resolveSystemNodePath(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  const candidates = buildSystemNodeCandidates(env, platform);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // keep going
    }
  }
  return null;
}

export async function resolveSystemNodeInfo(params: {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
}): Promise<SystemNodeInfo | null> {
  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const execFileImpl = params.execFile ?? execFileAsync;
  let firstAvailable: SystemNodeInfo | null = null;
  for (const systemNode of buildSystemNodeCandidates(env, platform)) {
    try {
      await fs.access(systemNode);
    } catch {
      continue;
    }
    if (await isVersionManagedRealNodePath(systemNode, platform)) {
      continue;
    }
    const version = await resolveNodeVersion(systemNode, execFileImpl);
    const info = {
      path: systemNode,
      version,
      supported: isSupportedNodeVersion(version),
    };
    if (info.supported) {
      return info;
    }
    firstAvailable ??= info;
  }
  return firstAvailable;
}

export function renderSystemNodeWarning(
  systemNode: SystemNodeInfo | null,
  selectedNodePath?: string,
): string | null {
  if (!systemNode || systemNode.supported) {
    return null;
  }
  const versionLabel = systemNode.version ?? "unknown";
  const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
  return `System Node ${versionLabel} at ${systemNode.path} is below the required Node 22.14+.${selectedLabel} Install Node 24 (recommended) or Node 22 LTS from nodejs.org or Homebrew.`;
}
export { resolveStableNodePath };

export async function resolvePreferredNodePath(params: {
  env?: Record<string, string | undefined>;
  runtime?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
  execPath?: string;
}): Promise<string | undefined> {
  if (params.runtime !== "node") {
    return undefined;
  }

  const platform = params.platform ?? process.platform;
  const currentExecPath = params.execPath ?? process.execPath;
  const execFileImpl = params.execFile ?? execFileAsync;
  if (currentExecPath && isNodeExecPath(currentExecPath, platform)) {
    const version = await resolveNodeVersion(currentExecPath, execFileImpl);
    if (isSupportedNodeVersion(version)) {
      const stableCurrentPath = await resolveStableNodePath(currentExecPath);
      if (!isVersionManagedNodePath(currentExecPath, platform)) {
        return stableCurrentPath;
      }
      const systemNode = await resolveSystemNodeInfo({
        env: params.env,
        platform,
        execFile: execFileImpl,
      });
      if (systemNode?.supported) {
        return systemNode.path;
      }
      return stableCurrentPath;
    }
  }

  // Fall back to system node.
  const systemNode = await resolveSystemNodeInfo(params);
  if (!systemNode?.supported) {
    return undefined;
  }
  return systemNode.path;
}
