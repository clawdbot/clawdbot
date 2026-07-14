/** Selects stable Node runtime paths for daemon installs across platforms. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { isSupportedNodeVersion } from "../infra/runtime-guard.js";
import { isSqliteWalResetSafeVersion } from "../infra/sqlite-runtime-version.js";
import { resolveStableNodePath } from "../infra/stable-node-path.js";
import { getWindowsProgramFilesRoots } from "../infra/windows-install-roots.js";
import { runExec } from "../process/exec.js";

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
  // Prefer system package-manager Node paths over shell-managed shims; daemons
  // launch without interactive shell init files.
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

const execFileAsync: ExecFileAsync = async (file, args) =>
  await runExec(file, [...args], { logOutput: false });

const NODE_RUNTIME_PROBE = String.raw`
let sqliteVersion = null;
try {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    sqliteVersion = db.prepare("SELECT sqlite_version() AS version").get()?.version ?? null;
  } finally {
    db.close();
  }
} catch {}
process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, sqliteVersion }));
`;

type NodeRuntimeInfo = {
  nodeVersion: string | null;
  sqliteVersion: string | null;
  supported: boolean;
};

async function resolveNodeRuntimeInfo(
  nodePath: string,
  execFileImpl: ExecFileAsync,
): Promise<NodeRuntimeInfo> {
  try {
    const { stdout } = await execFileImpl(nodePath, ["-e", NODE_RUNTIME_PROBE], {
      encoding: "utf8",
    });
    const parsed = JSON.parse(stdout) as {
      nodeVersion?: unknown;
      sqliteVersion?: unknown;
    };
    const nodeVersion = typeof parsed.nodeVersion === "string" ? parsed.nodeVersion : null;
    const sqliteVersion = typeof parsed.sqliteVersion === "string" ? parsed.sqliteVersion : null;
    return {
      nodeVersion,
      sqliteVersion,
      supported:
        isSupportedNodeVersion(nodeVersion) &&
        sqliteVersion !== null &&
        isSqliteWalResetSafeVersion(sqliteVersion),
    };
  } catch {
    return { nodeVersion: null, sqliteVersion: null, supported: false };
  }
}

type SystemNodeInfo = {
  path: string;
  sqliteVersion: string | null;
  version: string | null;
  supported: boolean;
};

async function isVersionManagedRealNodePath(
  nodePath: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    const realPath = await fs.realpath(nodePath);
    // Symlinks in /usr/local/bin can resolve into version-manager trees.
    return isVersionManagedNodePath(realPath, platform);
  } catch {
    return false;
  }
}

/** True when a Node path lives under a known user version-manager root. */
export function isVersionManagedNodePath(
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(normalizeForCompare(nodePath, platform));
  return VERSION_MANAGER_MARKERS.some((marker) => normalized.includes(marker));
}

/** True when a Node path matches known system install candidates for the platform. */
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

/** Resolves the first available system Node candidate for the platform. */
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

/** Resolves system Node info, preferring a supported non-version-managed install. */
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
    const runtime = await resolveNodeRuntimeInfo(systemNode, execFileImpl);
    const info = {
      path: systemNode,
      sqliteVersion: runtime.sqliteVersion,
      version: runtime.nodeVersion,
      supported: runtime.supported,
    };
    if (info.supported) {
      return info;
    }
    firstAvailable ??= info;
  }
  return firstAvailable;
}

/** Renders a warning when the system Node exists but is outside the supported range. */
export function renderSystemNodeWarning(
  systemNode: SystemNodeInfo | null,
  selectedNodePath?: string,
): string | null {
  if (!systemNode || systemNode.supported) {
    return null;
  }
  const versionLabel = systemNode.version ?? "unknown";
  const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
  if (isSupportedNodeVersion(systemNode.version)) {
    const sqliteLabel = systemNode.sqliteVersion ?? "unknown";
    return `System Node ${versionLabel} at ${systemNode.path} uses SQLite ${sqliteLabel}, which is not WAL-reset-safe.${selectedLabel} Install Node 24.15+ (recommended) or Node 22.22.3+ from nodejs.org or Homebrew.`;
  }
  return `System Node ${versionLabel} at ${systemNode.path} is outside the supported range.${selectedLabel} Install Node 24.15+ (recommended) or Node 22.22.3+ from nodejs.org or Homebrew.`;
}
/** Resolves the Node binary the daemon should use for a node runtime. */
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
    const runtime = await resolveNodeRuntimeInfo(currentExecPath, execFileImpl);
    if (runtime.supported) {
      const stableCurrentPath = await resolveStableNodePath(currentExecPath);
      if (!isVersionManagedNodePath(currentExecPath, platform)) {
        return stableCurrentPath;
      }
      // Prefer system Node over a version-manager shim so daemon launch survives
      // shell setup differences and package manager upgrades.
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

  // Fall back to system Node when the current executable is unsupported or not Node.
  const systemNode = await resolveSystemNodeInfo(params);
  if (!systemNode?.supported) {
    return undefined;
  }
  return systemNode.path;
}
