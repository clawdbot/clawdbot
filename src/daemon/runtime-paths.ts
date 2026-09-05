/** Selects stable runtime executable paths for daemon installs across platforms. */
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { SUPPORTED_NODE_VERSIONS } from "../../node-version.mjs";
import { isMissingPathError } from "../infra/errno.js";
import { isSupportedBunVersion, isSupportedNodeVersion } from "../infra/runtime-guard.js";
import { isSqliteWalResetSafeVersion } from "../infra/sqlite-runtime-version.js";
import { resolveStableNodePath } from "../infra/stable-node-path.js";
import { getWindowsProgramFilesRoots } from "../infra/windows-install-roots.js";
import { runExec } from "../process/exec.js";
import { isBunRuntime } from "./runtime-binary.js";

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

function buildBunCandidates(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  execPath: string,
): string[] {
  const pathModule = getPathModule(platform);
  const executable = platform === "win32" ? "bun.exe" : "bun";
  const candidates: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (candidate: string | undefined) => {
    if (!candidate || !pathModule.isAbsolute(candidate)) {
      return;
    }
    const normalized = normalizeForCompare(candidate, platform);
    if (seen.has(normalized)) {
      return;
    }
    seen.add(normalized);
    candidates.push(candidate);
  };

  const bunInstall = env.BUN_INSTALL?.trim();
  if (bunInstall) {
    addCandidate(pathModule.join(bunInstall, "bin", executable));
  }
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  if (home) {
    addCandidate(pathModule.join(home, ".bun", "bin", executable));
  }
  const pathEnv = env.PATH ?? env.Path ?? env.path ?? "";
  const delimiter = platform === "win32" ? ";" : ":";
  for (const entry of pathEnv.split(delimiter)) {
    const trimmed = entry.trim();
    if (trimmed) {
      addCandidate(pathModule.join(trimmed, executable));
    }
  }
  if (isBunRuntime(execPath)) {
    addCandidate(execPath);
  }
  for (const candidate of platform === "darwin"
    ? ["/opt/homebrew/bin/bun", "/usr/local/bin/bun", "/usr/bin/bun"]
    : platform === "linux"
      ? ["/usr/local/bin/bun", "/usr/bin/bun"]
      : []) {
    addCandidate(candidate);
  }
  return candidates;
}

type ExecFileAsync = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeoutMs: number },
) => Promise<{ stdout: string; stderr: string }>;

const RUNTIME_PROBE_TIMEOUT_MS = 5_000;

const execFileAsync: ExecFileAsync = async (file, args, options) =>
  await runExec(file, [...args], { logOutput: false, timeoutMs: options.timeoutMs });

const RUNTIME_PROBE = String.raw`
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
const variables = (process.config && process.config.variables) || {};
const nodeSharedSqlite = variables.node_shared_sqlite === true || variables.node_shared_sqlite === "true";
process.stdout.write(JSON.stringify({ nodeVersion: process.versions.node, bunVersion: process.versions.bun ?? null, sqliteVersion, nodeSharedSqlite }));
`;

type RuntimeInfo =
  | {
      status: "supported" | "unsupported";
      version: string | null;
      sqliteVersion: string | null;
      nodeSharedSqlite: boolean;
    }
  | { status: "probe-failed"; error: Error };

type SystemNodeInfo = RuntimeInfo & { path: string };

async function resolveRuntimeInfo(
  runtimePath: string,
  runtime: "node" | "bun",
  execFileImpl: ExecFileAsync,
): Promise<RuntimeInfo> {
  const label = runtime === "node" ? "Node" : "Bun";
  let cwd: string | undefined;
  try {
    cwd = process.cwd();
    const { stdout } = await execFileImpl(runtimePath, ["-e", RUNTIME_PROBE], {
      encoding: "utf8",
      timeoutMs: RUNTIME_PROBE_TIMEOUT_MS,
    });
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed)) {
      throw new Error("Runtime probe returned invalid output");
    }
    const version = parsed[`${runtime}Version`];
    const sqliteVersion = parsed.sqliteVersion;
    if (
      !(typeof version === "string" || (runtime === "bun" && version === null)) ||
      !(typeof sqliteVersion === "string" || sqliteVersion === null)
    ) {
      throw new Error("Runtime probe returned invalid version metadata");
    }
    const supportedVersion =
      runtime === "node" ? isSupportedNodeVersion(version) : isSupportedBunVersion(version);
    return {
      status:
        supportedVersion && sqliteVersion !== null && isSqliteWalResetSafeVersion(sqliteVersion)
          ? "supported"
          : "unsupported",
      version,
      sqliteVersion,
      nodeSharedSqlite: parsed.nodeSharedSqlite === true || parsed.nodeSharedSqlite === "true",
    };
  } catch (cause) {
    // A failed exec says nothing about runtime support. Preserve its cause and launch context.
    const error = new Error(
      `${label} runtime probe failed for ${runtimePath} (cwd: ${cwd ?? "unavailable"}): ${String(cause)}. Check executable and working-directory access, then retry.`,
      { cause },
    );
    return { status: "probe-failed", error };
  }
}

/** Probes whether a Bun executable satisfies the managed daemon runtime contract. */
export function resolveBunRuntimeInfo(
  bunPath: string,
  execFileImpl: ExecFileAsync = execFileAsync,
) {
  return resolveRuntimeInfo(bunPath, "bun", execFileImpl);
}

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
    const runtime = await resolveRuntimeInfo(systemNode, "node", execFileImpl);
    const info = { path: systemNode, ...runtime };
    if (info.status === "supported") {
      return info;
    }
    // If any available candidate could not be probed, lack of support is not established.
    firstAvailable = info.status === "probe-failed" ? info : (firstAvailable ?? info);
  }
  return firstAvailable;
}

/** Renders a warning when the system Node exists but is unsuitable for the daemon. */
export function renderSystemNodeWarning(
  systemNode: SystemNodeInfo | null,
  selectedNodePath?: string,
): string | null {
  if (!systemNode || systemNode.status === "supported") {
    return null;
  }
  const selectedLabel = selectedNodePath ? ` Using ${selectedNodePath} for the daemon.` : "";
  if (systemNode.status === "probe-failed") {
    return `${systemNode.error.message}${selectedLabel}`;
  }
  const versionLabel = systemNode.version;
  if (isSupportedNodeVersion(systemNode.version)) {
    const sqliteLabel = systemNode.sqliteVersion ?? "unknown";
    if (systemNode.nodeSharedSqlite) {
      return (
        `System Node ${versionLabel} at ${systemNode.path} uses shared system SQLite ${sqliteLabel}, which is not WAL-reset-safe.${selectedLabel} ` +
        "Upgrade the system SQLite library to 3.51.3+ (or patched 3.50.7+/3.44.6+), or install a Node build that embeds a safe version."
      );
    }
    return `System Node ${versionLabel} at ${systemNode.path} uses SQLite ${sqliteLabel}, which is not WAL-reset-safe.${selectedLabel} Install Node ${SUPPORTED_NODE_VERSIONS} from nodejs.org or Homebrew.`;
  }
  return `System Node ${versionLabel} at ${systemNode.path} is outside the supported range.${selectedLabel} Install Node ${SUPPORTED_NODE_VERSIONS} from nodejs.org or Homebrew.`;
}
type RuntimePathOptions = {
  env?: Record<string, string | undefined>;
  runtime?: string;
  platform?: NodeJS.Platform;
  execFile?: ExecFileAsync;
  execPath?: string;
};

/** Resolves the Node binary the daemon should use for a node runtime. */
export async function resolvePreferredNodePath(
  params: RuntimePathOptions,
): Promise<string | undefined> {
  if (params.runtime !== "node") {
    return undefined;
  }

  const platform = params.platform ?? process.platform;
  const currentExecPath = params.execPath ?? process.execPath;
  const execFileImpl = params.execFile ?? execFileAsync;
  const currentNode = isNodeExecPath(currentExecPath, platform)
    ? await resolveRuntimeInfo(currentExecPath, "node", execFileImpl)
    : null;
  if (currentNode?.status === "supported" && !isVersionManagedNodePath(currentExecPath, platform)) {
    return resolveStableNodePath(currentExecPath);
  }

  // Prefer system Node over a version-manager shim, but retain a proven working runtime.
  const systemNode = await resolveSystemNodeInfo(params);
  if (systemNode?.status === "supported") {
    return systemNode.path;
  }
  if (currentNode?.status === "supported") {
    return resolveStableNodePath(currentExecPath);
  }
  if (currentNode?.status === "probe-failed") {
    throw currentNode.error;
  }
  if (systemNode?.status === "probe-failed") {
    throw systemNode.error;
  }
  return undefined;
}

/** Resolves a stable Bun binary that satisfies the daemon runtime contract. */
export async function resolvePreferredBunPath(
  params: RuntimePathOptions,
): Promise<string | undefined> {
  if (params.runtime !== "bun") {
    return undefined;
  }

  const env = params.env ?? process.env;
  const platform = params.platform ?? process.platform;
  const execFileImpl = params.execFile ?? execFileAsync;
  const currentExecPath = params.execPath ?? process.execPath;
  let probeFailure: Error | undefined;
  for (const candidate of buildBunCandidates(env, platform, currentExecPath)) {
    try {
      await fs.access(candidate);
    } catch (error) {
      if (isMissingPathError(error)) {
        continue;
      }
    }
    const runtime = await resolveBunRuntimeInfo(candidate, execFileImpl);
    if (runtime.status === "probe-failed") {
      probeFailure ??= runtime.error;
    }
    if (runtime.status === "supported") {
      return candidate;
    }
  }
  if (probeFailure) {
    throw probeFailure;
  }
  return undefined;
}
