/** Doctor checks and repairs for state dir durability, sessions, transcripts, and credentials. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { decodeMountInfoPath } from "@openclaw/normalization-core/mountinfo-path";
import { asNullableObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { note } from "../../packages/terminal-core/src/note.js";
import { isSharedAuthStoreOwner } from "../agents/agent-delete-safety.js";
import {
  listAgentIds,
  resolveDefaultAgentDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import {
  clearWedgedSubagentRecoveryAbort,
  formatSubagentRecoveryWedgedReason,
  isSubagentRecoveryWedgedEntry,
} from "../agents/subagents/registry/subagent-recovery-state.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveSessionStoreCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import {
  resolveSessionFilePathCore,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptsDirForAgent,
  resolveSessionStorePathCore,
} from "../config/sessions/paths.js";
import {
  applySessionEntryReplacements,
  iterateDoctorSessionKeyBatches,
  loadExactSessionEntryReadOnly,
  scanDoctorSessionEntriesStrict,
} from "../config/sessions/session-accessor.js";
import { resolveSqliteTargetFromSessionStorePath } from "../config/sessions/session-sqlite-target.js";
import { resolveSessionStoreTargets, type SessionStoreTarget } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { HealthFinding, HealthRepairEffect } from "../flows/health-checks.js";
import { safeRealpathSync } from "../infra/boundary-path.js";
import { findGitRoot } from "../infra/git-root.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import {
  loadLegacySessionStore,
  updateLegacySessionStore,
} from "../infra/state-migrations.legacy-session-store.js";
import { listConfiguredChannelIdsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { shortenHomePath } from "../utils.js";
import { repairHeartbeatPoisonedMainSession } from "./doctor-heartbeat-main-session-repair.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";
import {
  inspectMainSessionRecoveryEntry,
  noteMainSessionRecoveryIntegrity,
  type MainSessionRecoveryIntegrityCandidate,
} from "./doctor-main-session-recovery.js";
import {
  createPluginSessionStateDoctorScanner,
  runPluginSessionStateDoctorRepairs,
} from "./doctor-session-state-providers.js";
import { countLabel } from "./doctor-state-integrity-format.js";
import { collectRetainedUnconfiguredAgentDatabaseWarnings } from "./doctor-unconfigured-agent-databases.js";

const STATE_INTEGRITY_CHECK_ID = "core/doctor/state-integrity";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: {
    message: string;
    initialValue?: boolean;
    requiresInteractiveConfirmation?: boolean;
  }) => Promise<boolean>;
  note?: typeof note;
};

function existsDir(dir: string): boolean {
  try {
    return fs.existsSync(dir) && fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function existsFile(filePath: string): boolean {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

type OrphanAgentDir = {
  dirName: string;
  agentId: string;
};

type RuntimeDirLabel = "Sessions dir" | "Session store dir" | "OAuth dir";

export type StateIntegrityHealthIssue =
  | {
      kind: "mac-cloud-state-dir";
      path: string;
      storage: string;
    }
  | {
      kind: "linux-sd-state-dir";
      path: string;
      mountPoint: string;
      fsType: string;
      source: string;
    }
  | {
      kind: "linux-volatile-state-dir";
      path: string;
      mountPoint: string;
      fsType: string;
    }
  | {
      kind: "missing-state-dir";
      path: string;
    }
  | {
      kind: "state-dir-not-writable";
      path: string;
      hint?: string;
    }
  | {
      kind: "state-dir-too-open";
      path: string;
      mode: number;
    }
  | {
      kind: "config-file-too-open";
      path: string;
      mode: number;
    }
  | {
      kind: "missing-runtime-dir";
      label: "OAuth dir";
      path: string;
    }
  | {
      kind: "runtime-dir-not-writable";
      label: RuntimeDirLabel;
      path: string;
      hint?: string;
    };

function tryResolveNativeRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function areComparablePathsEqual(leftPath: string, rightPath: string): boolean {
  const leftRealPath = tryResolveNativeRealPath(leftPath);
  const rightRealPath = tryResolveNativeRealPath(rightPath);
  return leftRealPath !== null && leftRealPath === rightRealPath;
}

function isReachableConfiguredAgentDir(params: {
  agentsRoot: string;
  dirName: string;
  agentId: string;
}): boolean {
  if (params.dirName === params.agentId) {
    return true;
  }
  const rawDir = path.join(params.agentsRoot, params.dirName, "agent");
  const normalizedDir = path.join(params.agentsRoot, params.agentId, "agent");
  const rawRealPath = tryResolveNativeRealPath(rawDir);
  const normalizedRealPath = tryResolveNativeRealPath(normalizedDir);
  return rawRealPath !== null && rawRealPath === normalizedRealPath;
}

function formatOrphanAgentDirLabel(entry: OrphanAgentDir): string {
  return entry.dirName === entry.agentId ? entry.agentId : `${entry.dirName} (id ${entry.agentId})`;
}

function formatOrphanAgentDirPreview(entries: OrphanAgentDir[], limit = 3): string {
  const labels = entries.slice(0, limit).map(formatOrphanAgentDirLabel);
  const remaining = entries.length - labels.length;
  if (remaining > 0) {
    return `${labels.join(", ")}, and ${remaining} more`;
  }
  return labels.join(", ");
}

function listOrphanAgentDirs(cfg: OpenClawConfig, stateDir: string): OrphanAgentDir[] {
  const configuredIds = new Set(listAgentIds(cfg));
  const sharedAuthOwnership = resolveSharedAuthStoreOwnership();
  const sharedAuthDbPath = resolveSharedAuthStorePath();
  const defaultAgentId = tryResolveDefaultAgentId(cfg);

  const agentsRoot = path.join(stateDir, "agents");
  const liveDefaultAgentDir = defaultAgentId ? resolveDefaultAgentDir(cfg) : undefined;
  try {
    const entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({
        dirName: entry.name,
        agentId: normalizeAgentId(entry.name),
      }))
      .filter(({ dirName, agentId }) => {
        const nestedAgentDir = path.join(agentsRoot, dirName, "agent");
        const hasNestedAgentDir = existsDir(nestedAgentDir);
        if (!hasNestedAgentDir) {
          return false;
        }
        if (
          isSharedAuthStoreOwner({
            ownership: sharedAuthOwnership,
            agentAuthDbPath: resolveAuthProfileDatabasePath(nestedAgentDir),
            sharedAuthDbPath,
          })
        ) {
          return false;
        }
        if (liveDefaultAgentDir && areComparablePathsEqual(nestedAgentDir, liveDefaultAgentDir)) {
          return false;
        }
        if (!configuredIds.has(agentId)) {
          return true;
        }
        return !isReachableConfiguredAgentDir({
          agentsRoot,
          dirName,
          agentId,
        });
      })
      .toSorted(
        (left, right) =>
          left.agentId.localeCompare(right.agentId) || left.dirName.localeCompare(right.dirName),
      );
  } catch {
    return [];
  }
}

function canWriteDir(dir: string): boolean {
  try {
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function ensureDir(dir: string): { ok: boolean; error?: string } {
  try {
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

function dirPermissionHint(dir: string): string | null {
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const gid = typeof process.getgid === "function" ? process.getgid() : null;
  try {
    const stat = fs.statSync(dir);
    if (uid !== null && stat.uid !== uid) {
      return `Owner mismatch (uid ${stat.uid}). Run: sudo chown -R $USER "${dir}"`;
    }
    if (gid !== null && stat.gid !== gid) {
      return `Group mismatch (gid ${stat.gid}). If access fails, run: sudo chown -R $USER "${dir}"`;
    }
  } catch {
    return null;
  }
  return null;
}

function addUserRwx(mode: number): number {
  const perms = mode & 0o777;
  return perms | 0o700;
}

function countJsonlLines(filePath: string): number {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "r");
  } catch {
    return 0;
  }
  try {
    const chunk = Buffer.alloc(64 * 1024);
    let count = 0;
    let hasBytes = false;
    let endsWithNewline = false;
    for (;;) {
      const bytesRead = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead <= 0) {
        break;
      }
      hasBytes = true;
      endsWithNewline = chunk[bytesRead - 1] === 0x0a;
      for (let index = 0; index < bytesRead; index += 1) {
        if (chunk[index] === 0x0a) {
          count += 1;
        }
      }
    }
    if (hasBytes && !endsWithNewline) {
      count += 1;
    }
    return count;
  } catch {
    return 0;
  } finally {
    fs.closeSync(fd);
  }
}

function isPathUnderRoot(targetPath: string, rootPath: string): boolean {
  const normalizedTarget = path.resolve(targetPath);
  const normalizedRoot = path.resolve(rootPath);
  const rootToken = path.parse(normalizedRoot).root;
  if (normalizedRoot === rootToken) {
    return normalizedTarget.startsWith(rootToken);
  }
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

const tryResolveRealPath = safeRealpathSync;

function resolvePathThroughExistingAncestor(
  targetPath: string,
  resolveRealPath: (targetPath: string) => string | null,
  pathOps: Pick<typeof path, "resolve" | "dirname" | "basename">,
): string | null {
  const missingSegments: string[] = [];
  let candidate = pathOps.resolve(targetPath);
  while (true) {
    const resolved = resolveRealPath(candidate);
    if (resolved) {
      return pathOps.resolve(resolved, ...missingSegments);
    }
    const parent = pathOps.dirname(candidate);
    if (parent === candidate) {
      return null;
    }
    missingSegments.unshift(pathOps.basename(candidate));
    candidate = parent;
  }
}

function escapeControlCharsForTerminal(value: string): string {
  let escaped = "";
  for (const char of value) {
    if (char === "\u001b") {
      escaped += "\\x1b";
      continue;
    }
    if (char === "\r") {
      escaped += "\\r";
      continue;
    }
    if (char === "\n") {
      escaped += "\\n";
      continue;
    }
    if (char === "\t") {
      escaped += "\\t";
      continue;
    }
    const code = char.charCodeAt(0);
    if ((code >= 0 && code <= 8) || code === 11 || code === 12 || (code >= 14 && code <= 31)) {
      escaped += `\\x${code.toString(16).padStart(2, "0")}`;
      continue;
    }
    if (code === 127) {
      escaped += "\\x7f";
      continue;
    }
    escaped += char;
  }
  return escaped;
}

type LinuxMountInfoEntry = {
  mountPoint: string;
  fsType: string;
  source: string;
};

type LinuxSdBackedStateDir = {
  path: string;
  mountPoint: string;
  fsType: string;
  source: string;
};

function parseLinuxMountInfo(rawMountInfo: string): LinuxMountInfoEntry[] {
  const entries: LinuxMountInfoEntry[] = [];
  for (const line of rawMountInfo.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(" - ");
    if (separatorIndex === -1) {
      continue;
    }

    const left = trimmed.slice(0, separatorIndex);
    const right = trimmed.slice(separatorIndex + 3);
    const leftFields = left.split(" ");
    const rightFields = right.split(" ");
    if (leftFields.length < 5 || rightFields.length < 2) {
      continue;
    }

    entries.push({
      mountPoint: decodeMountInfoPath(expectDefined(leftFields[4], "left fields entry at 4")),
      fsType: expectDefined(rightFields[0], "right fields entry at 0"),
      source: decodeMountInfoPath(expectDefined(rightFields[1], "right fields entry at 1")),
    });
  }
  return entries;
}

function isPathUnderRootWithPathOps(
  targetPath: string,
  rootPath: string,
  pathOps: Pick<typeof path, "resolve" | "sep" | "parse">,
): boolean {
  const normalizedTarget = pathOps.resolve(targetPath);
  const normalizedRoot = pathOps.resolve(rootPath);
  const rootToken = pathOps.parse(normalizedRoot).root;
  if (normalizedRoot === rootToken) {
    return normalizedTarget.startsWith(rootToken);
  }
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${pathOps.sep}`)
  );
}

function findLinuxMountInfoEntryForPath(
  targetPath: string,
  entries: LinuxMountInfoEntry[],
  pathOps: Pick<typeof path, "resolve" | "sep" | "parse">,
): LinuxMountInfoEntry | null {
  const normalizedTarget = pathOps.resolve(targetPath);
  let bestMatch: LinuxMountInfoEntry | null = null;
  for (const entry of entries) {
    if (!isPathUnderRootWithPathOps(normalizedTarget, entry.mountPoint, pathOps)) {
      continue;
    }
    if (
      !bestMatch ||
      pathOps.resolve(entry.mountPoint).length > pathOps.resolve(bestMatch.mountPoint).length
    ) {
      bestMatch = entry;
    }
  }
  return bestMatch;
}

function isMmcDevicePath(devicePath: string, pathOps: Pick<typeof path, "basename">): boolean {
  const name = pathOps.basename(devicePath);
  return /^mmcblk\d+(?:p\d+)?$/.test(name);
}

function tryReadLinuxMountInfo(): string | null {
  try {
    return fs.readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    return null;
  }
}

function resolveLinuxStateMount(
  stateDir: string,
  deps?: {
    mountInfo?: string;
    resolveRealPath?: (targetPath: string) => string | null;
  },
): LinuxSdBackedStateDir | null {
  const linuxPath = path.posix;
  const resolveRealPath = deps?.resolveRealPath ?? tryResolveRealPath;
  const resolvedStatePath =
    resolvePathThroughExistingAncestor(stateDir, resolveRealPath, linuxPath) ??
    linuxPath.resolve(stateDir);
  const mountInfo = deps?.mountInfo ?? tryReadLinuxMountInfo();
  const mountEntry = mountInfo
    ? findLinuxMountInfoEntryForPath(resolvedStatePath, parseLinuxMountInfo(mountInfo), linuxPath)
    : null;
  return mountEntry
    ? {
        path: linuxPath.resolve(resolvedStatePath),
        mountPoint: linuxPath.resolve(mountEntry.mountPoint),
        fsType: mountEntry.fsType,
        source: mountEntry.source,
      }
    : null;
}

/** Detects Linux state directories mounted from SD/eMMC-style block devices. */
export function detectLinuxSdBackedStateDir(
  stateDir: string,
  deps?: {
    platform?: NodeJS.Platform;
    mountInfo?: string;
    resolveRealPath?: (targetPath: string) => string | null;
    resolveDeviceRealPath?: (targetPath: string) => string | null;
  },
): LinuxSdBackedStateDir | null {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "linux") {
    return null;
  }
  const linuxPath = path.posix;
  const stateMount = resolveLinuxStateMount(stateDir, deps);
  if (!stateMount) {
    return null;
  }

  const sourceCandidates = [stateMount.source];
  if (stateMount.source.startsWith("/dev/")) {
    const resolvedDevicePath = (deps?.resolveDeviceRealPath ?? tryResolveRealPath)(
      stateMount.source,
    );
    if (resolvedDevicePath) {
      sourceCandidates.push(linuxPath.resolve(resolvedDevicePath));
    }
  }
  if (!sourceCandidates.some((candidate) => isMmcDevicePath(candidate, linuxPath))) {
    return null;
  }

  return stateMount;
}

/** Formats the warning for state stored on SD/eMMC media. */
export function formatLinuxSdBackedStateDirWarning(
  displayStateDir: string,
  linuxSdBackedStateDir: LinuxSdBackedStateDir,
): string {
  const displayMountPoint =
    linuxSdBackedStateDir.mountPoint === "/"
      ? "/"
      : shortenHomePath(linuxSdBackedStateDir.mountPoint);
  const safeSource = escapeControlCharsForTerminal(linuxSdBackedStateDir.source);
  const safeFsType = escapeControlCharsForTerminal(linuxSdBackedStateDir.fsType);
  const safeMountPoint = escapeControlCharsForTerminal(displayMountPoint);
  return [
    `- State directory appears to be on SD/eMMC storage (${displayStateDir}; device ${safeSource}, fs ${safeFsType}, mount ${safeMountPoint}).`,
    "- SD/eMMC media can be slower for random I/O and wear faster under session/log churn.",
    "- For better startup and state durability, prefer SSD/NVMe (or USB SSD on Raspberry Pi) for OPENCLAW_STATE_DIR.",
  ].join("\n");
}

type LinuxVolatileStateDir = Omit<LinuxSdBackedStateDir, "source">;

/** Filesystems whose state disappears on reboot. Docker overlayfs is intentionally excluded. */
const VOLATILE_FS_TYPES = new Set(["tmpfs", "ramfs"]);

/** Detects Linux state directories mounted on filesystems that do not survive a reboot. */
export function detectLinuxVolatileStateDir(
  stateDir: string,
  deps?: {
    platform?: NodeJS.Platform;
    mountInfo?: string;
    resolveRealPath?: (targetPath: string) => string | null;
  },
): LinuxVolatileStateDir | null {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "linux") {
    return null;
  }
  const stateMount = resolveLinuxStateMount(stateDir, deps);
  if (!stateMount || !VOLATILE_FS_TYPES.has(stateMount.fsType)) {
    return null;
  }
  const { source: _source, ...volatileStateMount } = stateMount;
  return volatileStateMount;
}

/** Formats the warning for state stored on a volatile Linux filesystem. */
export function formatLinuxVolatileStateDirWarning(
  displayStateDir: string,
  volatileDir: LinuxVolatileStateDir,
): string {
  const safeFsType = escapeControlCharsForTerminal(volatileDir.fsType);
  const safeMountPoint =
    volatileDir.mountPoint === "/"
      ? "/"
      : escapeControlCharsForTerminal(shortenHomePath(volatileDir.mountPoint));
  return [
    `- State directory is on a volatile filesystem (${displayStateDir}; fs ${safeFsType}, mount ${safeMountPoint}).`,
    "- Sessions, credentials, config, and SQLite state (including WAL/journal sidecars) will be lost on reboot.",
    "- Move OPENCLAW_STATE_DIR to a persistent filesystem to avoid data loss.",
  ].join("\n");
}

/** Detects macOS state directories under iCloud Drive or CloudStorage providers. */
export function detectMacCloudSyncedStateDir(
  stateDir: string,
  deps?: {
    platform?: NodeJS.Platform;
    homedir?: string;
    resolveRealPath?: (targetPath: string) => string | null;
  },
): {
  path: string;
  storage: "iCloud Drive" | "CloudStorage provider";
} | null {
  const platform = deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return null;
  }

  // Cloud-sync roots should always be anchored to the OS account home on macOS.
  // OPENCLAW_HOME can relocate app data defaults, but iCloud/CloudStorage remain under the OS home.
  const homedir = deps?.homedir ?? os.homedir();
  const roots = [
    {
      storage: "iCloud Drive" as const,
      root: path.join(homedir, "Library", "Mobile Documents", "com~apple~CloudDocs"),
    },
    {
      storage: "CloudStorage provider" as const,
      root: path.join(homedir, "Library", "CloudStorage"),
    },
  ];
  const resolveRealPath = deps?.resolveRealPath ?? tryResolveRealPath;
  // Missing state leaves must still follow existing symlink ancestors, like the Linux detectors.
  const resolvedStatePath =
    resolvePathThroughExistingAncestor(stateDir, resolveRealPath, path) ?? path.resolve(stateDir);

  for (const { storage, root } of roots) {
    if (isPathUnderRoot(resolvedStatePath, root)) {
      return { path: resolvedStatePath, storage };
    }
  }

  return null;
}

function isPairingPolicy(value: unknown): boolean {
  return normalizeOptionalLowercaseString(value) === "pairing";
}

function hasPairingPolicy(value: unknown): boolean {
  const record = asNullableObjectRecord(value);
  if (!record) {
    return false;
  }
  if (isPairingPolicy(record.dmPolicy)) {
    return true;
  }
  const dm = asNullableObjectRecord(record.dm);
  if (dm && isPairingPolicy(dm.policy)) {
    return true;
  }
  const accounts = asNullableObjectRecord(record.accounts);
  if (!accounts) {
    return false;
  }
  for (const accountCfg of Object.values(accounts)) {
    if (hasPairingPolicy(accountCfg)) {
      return true;
    }
  }
  return false;
}

function shouldRequireOAuthDir(cfg: OpenClawConfig, env: NodeJS.ProcessEnv): boolean {
  if (env.OPENCLAW_OAUTH_DIR?.trim()) {
    return true;
  }
  const channels = asNullableObjectRecord(cfg.channels);
  if (!channels) {
    return false;
  }
  const withPersistedAuth = new Set(
    listConfiguredChannelIdsForReadOnlyScope({
      config: cfg,
      env,
    }),
  );
  const withoutPersistedAuth = new Set(
    listConfiguredChannelIdsForReadOnlyScope({
      config: cfg,
      env,
      includePersistedAuthState: false,
    }),
  );
  if ([...withPersistedAuth].some((channelId) => !withoutPersistedAuth.has(channelId))) {
    return true;
  }
  // Pairing allowlists are persisted under credentials/<channel>-allowFrom.json.
  for (const [channelId, channelCfg] of Object.entries(channels)) {
    if (channelId === "defaults" || channelId === "modelByChannel") {
      continue;
    }
    if (hasPairingPolicy(channelCfg)) {
      return true;
    }
  }
  return false;
}

export function detectStateIntegrityHealthIssues(
  cfg: OpenClawConfig,
  params?: {
    configPath?: string;
    env?: NodeJS.ProcessEnv;
    homedir?: () => string;
  },
): StateIntegrityHealthIssue[] {
  const issues: StateIntegrityHealthIssue[] = [];
  const env = params?.env ?? process.env;
  const homedir = () => resolveRequiredHomeDir(env, params?.homedir ?? os.homedir);
  const stateDir = resolveStateDir(env, homedir);
  const oauthDir = resolveOAuthDir(env, stateDir);
  const agentId = tryResolveDefaultAgentId(cfg);
  const sessionsDir = agentId
    ? resolveSessionTranscriptsDirForAgent(agentId, env, homedir)
    : undefined;
  const storePath = agentId
    ? resolveSessionStorePathCore(cfg.session?.store, { agentId })
    : undefined;
  const storeDir = storePath ? path.dirname(storePath) : undefined;
  const requireOAuthDir = shouldRequireOAuthDir(cfg, env);

  const cloudSyncedStateDir = detectMacCloudSyncedStateDir(stateDir);
  if (cloudSyncedStateDir) {
    issues.push({
      kind: "mac-cloud-state-dir",
      path: cloudSyncedStateDir.path,
      storage: cloudSyncedStateDir.storage,
    });
  }

  const linuxSdBackedStateDir = detectLinuxSdBackedStateDir(stateDir);
  if (linuxSdBackedStateDir) {
    issues.push({
      kind: "linux-sd-state-dir",
      path: linuxSdBackedStateDir.path,
      mountPoint: linuxSdBackedStateDir.mountPoint,
      fsType: linuxSdBackedStateDir.fsType,
      source: linuxSdBackedStateDir.source,
    });
  }

  const linuxVolatileStateDir = detectLinuxVolatileStateDir(stateDir);
  if (linuxVolatileStateDir) {
    issues.push({
      kind: "linux-volatile-state-dir",
      path: linuxVolatileStateDir.path,
      mountPoint: linuxVolatileStateDir.mountPoint,
      fsType: linuxVolatileStateDir.fsType,
    });
  }

  const stateDirExists = existsDir(stateDir);
  if (!stateDirExists) {
    issues.push({ kind: "missing-state-dir", path: stateDir });
  }

  if (stateDirExists && !canWriteDir(stateDir)) {
    const hint = dirPermissionHint(stateDir);
    issues.push({
      kind: "state-dir-not-writable",
      path: stateDir,
      ...(hint ? { hint } : {}),
    });
  }

  if (stateDirExists && process.platform !== "win32") {
    try {
      const dirLstat = fs.lstatSync(stateDir);
      const isDirSymlink = dirLstat.isSymbolicLink();
      const stat = isDirSymlink ? fs.statSync(stateDir) : dirLstat;
      const resolvedDir = isDirSymlink ? fs.realpathSync(stateDir) : stateDir;
      if (!resolvedDir.startsWith("/nix/store/") && (stat.mode & 0o077) !== 0) {
        issues.push({ kind: "state-dir-too-open", path: stateDir, mode: stat.mode });
      }
    } catch {
      // Legacy noteStateIntegrity reports stat failures. Structured findings
      // are limited to actionable state that can be inspected safely.
    }
  }

  if (params?.configPath && existsFile(params.configPath) && process.platform !== "win32") {
    try {
      const configLstat = fs.lstatSync(params.configPath);
      const isSymlink = configLstat.isSymbolicLink();
      const stat = isSymlink ? fs.statSync(params.configPath) : configLstat;
      const resolvedConfig = isSymlink ? fs.realpathSync(params.configPath) : params.configPath;
      if (!resolvedConfig.startsWith("/nix/store/") && (stat.mode & 0o077) !== 0) {
        issues.push({ kind: "config-file-too-open", path: params.configPath, mode: stat.mode });
      }
    } catch {
      // See state-dir stat handling above.
    }
  }

  if (stateDirExists) {
    const dirCandidates = new Map<string, RuntimeDirLabel>();
    if (sessionsDir) {
      dirCandidates.set(sessionsDir, "Sessions dir");
    }
    if (storeDir) {
      dirCandidates.set(storeDir, "Session store dir");
    }
    if (requireOAuthDir) {
      dirCandidates.set(oauthDir, "OAuth dir");
    }
    for (const [dir, label] of dirCandidates) {
      if (!existsDir(dir)) {
        if (label === "OAuth dir") {
          issues.push({ kind: "missing-runtime-dir", label, path: dir });
          continue;
        }
        // Transcript-archive writers create session dirs lazily (session-accessor.sqlite-archive.ts),
        // and readers tolerate ENOENT, so absence is healthy on fresh profiles.
        continue;
      }
      if (!canWriteDir(dir)) {
        const hint = dirPermissionHint(dir);
        issues.push({
          kind: "runtime-dir-not-writable",
          label,
          path: dir,
          ...(hint ? { hint } : {}),
        });
      }
    }
  }

  return issues;
}

export function stateIntegrityIssueToHealthFinding(
  issue: StateIntegrityHealthIssue,
): HealthFinding {
  switch (issue.kind) {
    case "mac-cloud-state-dir":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "warning",
        message: `State directory is under macOS cloud-synced storage (${issue.storage}), which can cause slow I/O and sync races.`,
        path: issue.path,
        fixHint: "Move OPENCLAW_STATE_DIR to local non-synced storage such as ~/.openclaw.",
      };
    case "linux-sd-state-dir":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "warning",
        message: `State directory appears to be on SD/eMMC storage (${issue.source}, ${issue.fsType}), which can hurt startup and durability.`,
        path: issue.path,
        target: issue.mountPoint,
        fixHint: "Move OPENCLAW_STATE_DIR to SSD/NVMe-backed storage.",
      };
    case "linux-volatile-state-dir":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "warning",
        message: `State directory is on volatile ${issue.fsType} storage and may disappear on reboot.`,
        path: issue.path,
        target: issue.mountPoint,
        fixHint: "Move OPENCLAW_STATE_DIR to persistent local storage.",
      };
    case "missing-state-dir":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "error",
        message:
          "State directory is missing. Sessions, credentials, logs, and config are stored there.",
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to create the state directory.",
      };
    case "state-dir-not-writable":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "error",
        message: issue.hint
          ? `State directory is not writable. ${issue.hint}`
          : "State directory is not writable.",
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to repair state directory permissions.",
      };
    case "state-dir-too-open":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "warning",
        message: "State directory permissions are too open. Recommend chmod 700.",
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to tighten state directory permissions.",
      };
    case "config-file-too-open":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "warning",
        message: "Config file is group/world readable. Recommend chmod 600.",
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to tighten config file permissions.",
      };
    case "missing-runtime-dir":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "error",
        message: `${issue.label} is missing.`,
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to create missing runtime state directories.",
      };
    case "runtime-dir-not-writable":
      return {
        checkId: STATE_INTEGRITY_CHECK_ID,
        severity: "error",
        message: issue.hint
          ? `${issue.label} is not writable. ${issue.hint}`
          : `${issue.label} is not writable.`,
        path: issue.path,
        fixHint: "Run `openclaw doctor --fix` to repair runtime state directory permissions.",
      };
  }
  return assertNeverStateIntegrityIssue(issue);
}

export function stateIntegrityIssueToRepairEffect(
  issue: StateIntegrityHealthIssue,
): HealthRepairEffect {
  switch (issue.kind) {
    case "mac-cloud-state-dir":
    case "linux-sd-state-dir":
    case "linux-volatile-state-dir":
      return {
        kind: "state",
        action: "would-recommend-moving-state-dir",
        target: issue.path,
        dryRunSafe: true,
      };
    case "missing-state-dir":
      return {
        kind: "state",
        action: "would-create-state-dir",
        target: issue.path,
        dryRunSafe: false,
      };
    case "state-dir-not-writable":
    case "state-dir-too-open":
      return {
        kind: "state",
        action: "would-repair-state-dir-permissions",
        target: issue.path,
        dryRunSafe: false,
      };
    case "config-file-too-open":
      return {
        kind: "file",
        action: "would-tighten-config-file-permissions",
        target: issue.path,
        dryRunSafe: false,
      };
    case "missing-runtime-dir":
      return {
        kind: "state",
        action: "would-create-runtime-state-dir",
        target: issue.path,
        dryRunSafe: false,
      };
    case "runtime-dir-not-writable":
      return {
        kind: "state",
        action: "would-repair-runtime-state-dir-permissions",
        target: issue.path,
        dryRunSafe: false,
      };
  }
  return assertNeverStateIntegrityIssue(issue);
}

function assertNeverStateIntegrityIssue(issue: never): never {
  throw new Error(
    `Unhandled state integrity issue kind: ${String((issue as { kind?: unknown }).kind)}`,
  );
}

/** Emits state integrity warnings and applies selected runtime repairs. */
export async function noteStateIntegrity(
  cfg: OpenClawConfig,
  prompter: DoctorPrompterLike,
  configPath?: string,
  options?: { stateDirExistedAtStart?: boolean },
) {
  const warnings: string[] = [];
  const changes: string[] = [];
  const noteFn = prompter.note ?? note;
  const env = process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, homedir);
  const defaultStateDir = path.join(homedir(), ".openclaw");
  const oauthDir = resolveOAuthDir(env, stateDir);
  const runtimeAgentId = tryResolveDefaultAgentId(cfg);
  const runtimeSessionsDir = runtimeAgentId
    ? resolveSessionTranscriptsDirForAgent(runtimeAgentId, env, homedir)
    : undefined;
  const runtimeStorePath = runtimeAgentId
    ? resolveSessionStorePathCore(cfg.session?.store, { agentId: runtimeAgentId })
    : undefined;
  const runtimeStoreDir = runtimeStorePath ? path.dirname(runtimeStorePath) : undefined;
  const displayStateDir = shortenHomePath(stateDir);
  const displayOauthDir = shortenHomePath(oauthDir);
  const displayConfigPath = configPath ? shortenHomePath(configPath) : undefined;
  const requireOAuthDir = shouldRequireOAuthDir(cfg, env);
  const cloudSyncedStateDir = detectMacCloudSyncedStateDir(stateDir);
  const linuxSdBackedStateDir = detectLinuxSdBackedStateDir(stateDir);
  const linuxVolatileStateDir = detectLinuxVolatileStateDir(stateDir);

  if (cloudSyncedStateDir) {
    warnings.push(
      [
        `- State directory is under macOS cloud-synced storage (${displayStateDir}; ${cloudSyncedStateDir.storage}).`,
        "- This can cause slow I/O and sync/lock races for sessions and credentials.",
        "- Prefer a local non-synced state dir (for example: ~/.openclaw).",
        `  Set locally: OPENCLAW_STATE_DIR=~/.openclaw ${formatCliCommand("openclaw doctor")}`,
      ].join("\n"),
    );
  }
  if (linuxSdBackedStateDir) {
    warnings.push(formatLinuxSdBackedStateDirWarning(displayStateDir, linuxSdBackedStateDir));
  }
  if (linuxVolatileStateDir) {
    warnings.push(formatLinuxVolatileStateDirWarning(displayStateDir, linuxVolatileStateDir));
  }

  let stateDirExists = existsDir(stateDir);
  if (stateDirExists && options?.stateDirExistedAtStart === false) {
    warnings.push(
      `- State directory was missing at doctor start and was initialized during startup checks (${displayStateDir}).`,
    );
  }
  if (!stateDirExists) {
    warnings.push(
      `- CRITICAL: state directory missing (${displayStateDir}). Sessions, credentials, logs, and config are stored there.`,
    );
    if (cfg.gateway?.mode === "remote") {
      warnings.push(
        "- Gateway is in remote mode; run doctor on the remote host where the gateway runs.",
      );
    }
    const create = await prompter.confirmRuntimeRepair({
      message: `Create ${displayStateDir} now?`,
      initialValue: false,
    });
    if (create) {
      const created = ensureDir(stateDir);
      if (created.ok) {
        changes.push(`- Created ${displayStateDir}`);
        stateDirExists = true;
      } else {
        warnings.push(`- Failed to create ${displayStateDir}: ${created.error}`);
      }
    }
  }

  if (stateDirExists && !canWriteDir(stateDir)) {
    warnings.push(`- State directory not writable (${displayStateDir}).`);
    const hint = dirPermissionHint(stateDir);
    if (hint) {
      warnings.push(`  ${hint}`);
    }
    const repair = await prompter.confirmRuntimeRepair({
      message: `Repair permissions on ${displayStateDir}?`,
      initialValue: true,
    });
    if (repair) {
      try {
        const stat = fs.statSync(stateDir);
        const target = addUserRwx(stat.mode);
        fs.chmodSync(stateDir, target);
        changes.push(`- Repaired permissions on ${displayStateDir}`);
      } catch (err) {
        warnings.push(`- Failed to repair ${displayStateDir}: ${String(err)}`);
      }
    }
  }
  if (stateDirExists && process.platform !== "win32") {
    try {
      const dirLstat = fs.lstatSync(stateDir);
      const isDirSymlink = dirLstat.isSymbolicLink();
      // For symlinks, check the resolved target permissions instead of the
      // symlink itself (which always reports 777). Skip the warning only when
      // the target lives in a known immutable store (e.g. /nix/store/).
      const stat = isDirSymlink ? fs.statSync(stateDir) : dirLstat;
      const resolvedDir = isDirSymlink ? fs.realpathSync(stateDir) : stateDir;
      const isImmutableStore = resolvedDir.startsWith("/nix/store/");
      if (!isImmutableStore && (stat.mode & 0o077) !== 0) {
        warnings.push(
          `- State directory permissions are too open (${displayStateDir}). Recommend chmod 700.`,
        );
        const tighten = await prompter.confirmRuntimeRepair({
          message: `Tighten permissions on ${displayStateDir} to 700?`,
          initialValue: true,
        });
        if (tighten) {
          fs.chmodSync(stateDir, 0o700);
          changes.push(`- Tightened permissions on ${displayStateDir} to 700`);
        }
      }
    } catch (err) {
      warnings.push(`- Failed to read ${displayStateDir} permissions: ${String(err)}`);
    }
  }

  if (configPath && existsFile(configPath) && process.platform !== "win32") {
    try {
      const configLstat = fs.lstatSync(configPath);
      const isSymlink = configLstat.isSymbolicLink();
      // For symlinks, check the resolved target permissions. Skip the warning
      // only when the target lives in an immutable store (e.g. /nix/store/).
      const stat = isSymlink ? fs.statSync(configPath) : configLstat;
      const resolvedConfig = isSymlink ? fs.realpathSync(configPath) : configPath;
      const isImmutableConfig = resolvedConfig.startsWith("/nix/store/");
      if (!isImmutableConfig && (stat.mode & 0o077) !== 0) {
        warnings.push(
          `- Config file is group/world readable (${displayConfigPath ?? configPath}). Recommend chmod 600.`,
        );
        const tighten = await prompter.confirmRuntimeRepair({
          message: `Tighten permissions on ${displayConfigPath ?? configPath} to 600?`,
          initialValue: true,
        });
        if (tighten) {
          fs.chmodSync(configPath, 0o600);
          changes.push(`- Tightened permissions on ${displayConfigPath ?? configPath} to 600`);
        }
      }
    } catch (err) {
      warnings.push(
        `- Failed to read config permissions (${displayConfigPath ?? configPath}): ${String(err)}`,
      );
    }
  }

  if (stateDirExists) {
    const dirCandidates = new Map<string, RuntimeDirLabel>();
    if (runtimeSessionsDir) {
      dirCandidates.set(runtimeSessionsDir, "Sessions dir");
    }
    if (runtimeStoreDir) {
      dirCandidates.set(runtimeStoreDir, "Session store dir");
    }
    if (requireOAuthDir) {
      dirCandidates.set(oauthDir, "OAuth dir");
    } else if (!existsDir(oauthDir)) {
      warnings.push(
        `- OAuth dir not present (${displayOauthDir}). Skipping create because no WhatsApp/pairing channel config is active.`,
      );
    }
    for (const [dir, label] of dirCandidates) {
      const displayDir = shortenHomePath(dir);
      if (!existsDir(dir)) {
        if (label !== "OAuth dir") {
          continue;
        }
        warnings.push(`- CRITICAL: ${label} missing (${displayDir}).`);
        const create = await prompter.confirmRuntimeRepair({
          message: `Create ${label} at ${displayDir}?`,
          initialValue: true,
        });
        if (create) {
          const created = ensureDir(dir);
          if (created.ok) {
            changes.push(`- Created ${label}: ${displayDir}`);
          } else {
            warnings.push(`- Failed to create ${displayDir}: ${created.error}`);
          }
        }
        continue;
      }
      if (!canWriteDir(dir)) {
        warnings.push(`- ${label} not writable (${displayDir}).`);
        const hint = dirPermissionHint(dir);
        if (hint) {
          warnings.push(`  ${hint}`);
        }
        const repair = await prompter.confirmRuntimeRepair({
          message: `Repair permissions on ${label}?`,
          initialValue: true,
        });
        if (repair) {
          try {
            const stat = fs.statSync(dir);
            const target = addUserRwx(stat.mode);
            fs.chmodSync(dir, target);
            changes.push(`- Repaired permissions on ${label}: ${displayDir}`);
          } catch (err) {
            warnings.push(`- Failed to repair ${displayDir}: ${String(err)}`);
          }
        }
      }
    }
  }

  // Compare only the effective home's default; other accounts do not share this history.
  if (path.resolve(stateDir) !== path.resolve(defaultStateDir) && existsDir(defaultStateDir)) {
    warnings.push(
      [
        "- Multiple state directories detected. This can split session history.",
        `  - ${shortenHomePath(defaultStateDir)}`,
        `  Active state dir: ${displayStateDir}`,
      ].join("\n"),
    );
  }

  const orphanAgentDirs = listOrphanAgentDirs(cfg, stateDir);
  if (orphanAgentDirs.length > 0) {
    warnings.push(
      [
        `- Found ${countLabel(orphanAgentDirs.length, "agent directory", "agent directories")} on disk without a matching agents.list entry.`,
        "  These agents can still have sessions/auth state on disk, but config-driven routing, identity, and model selection will ignore them.",
        `  Examples: ${formatOrphanAgentDirPreview(orphanAgentDirs)}`,
        `  Restore the missing agents.list entries or remove stale dirs after confirming they are no longer needed: ${shortenHomePath(path.join(stateDir, "agents"))}`,
      ].join("\n"),
    );
  }
  if (stateDirExists) {
    warnings.push(...collectRetainedUnconfiguredAgentDatabaseWarnings({ cfg, env }));
  }

  const compatibilityAgentId = resolveSessionStoreCompatibilityAgentId(cfg);
  const sessionTargets = resolveSessionStoreTargets(cfg, { allAgents: true }, { env }).toSorted(
    (left, right) =>
      left.agentId === compatibilityAgentId ? -1 : right.agentId === compatibilityAgentId ? 1 : 0,
  );

  const inspectAgentSessionIntegrity = async (
    target: SessionStoreTarget,
    inspectLegacyStore: boolean,
  ) => {
    const { agentId, storePath } = target;
    const absoluteStorePath = path.resolve(storePath);

    const sqliteStorePath = resolveSqliteTargetFromSessionStorePath(absoluteStorePath, {
      agentId,
      defaultAgentId: compatibilityAgentId,
      env,
    }).path;
    // A successful SQLite import archives sessions.json. Its continued presence
    // is therefore the explicit signal that pre-import rows still need inspection.
    const legacyStore =
      inspectLegacyStore && existsFile(absoluteStorePath)
        ? loadLegacySessionStore(absoluteStorePath)
        : {};
    const legacyEntries = Object.entries(legacyStore).filter(
      (candidate): candidate is [string, SessionEntry] =>
        candidate[1] != null && typeof candidate[1] === "object",
    );
    const legacySessionKeys = new Set(legacyEntries.map(([sessionKey]) => sessionKey));
    const sqliteSessionKeys = new Set<string>();
    const isSessionKeyOccupied = (sessionKey: string) =>
      sqliteSessionKeys.has(sessionKey) || legacySessionKeys.has(sessionKey);
    const mainKey = resolveCanonicalMainSessionKey({
      agentId,
      mainKey: cfg.session?.mainKey,
      sessionScope: cfg.session?.scope,
    });
    const mainRecoveryWedged: MainSessionRecoveryIntegrityCandidate[] = [];
    const wedgedSubagentSessions: Array<{ key: string; reason: string }> = [];
    const sqlitePluginStateScanner = createPluginSessionStateDoctorScanner({ agentId, cfg, env });
    const legacyPluginStateScanner = createPluginSessionStateDoctorScanner({ agentId, cfg, env });
    let mainEntry: SessionEntry | undefined;
    const inspectMergedEntry = (sessionKey: string, entry: SessionEntry) => {
      if (sessionKey === mainKey) {
        mainEntry = entry;
      }
      if (isSubagentRecoveryWedgedEntry(entry)) {
        wedgedSubagentSessions.push({
          key: sessionKey,
          reason: formatSubagentRecoveryWedgedReason(entry),
        });
      }
    };
    const sqliteEntryCount = scanDoctorSessionEntriesStrict(
      { agentId, storePath: sqliteStorePath },
      ({ entry, sessionKey }) => {
        sqliteSessionKeys.add(sessionKey);
        sqlitePluginStateScanner.scanEntry(sessionKey, entry);
        inspectMergedEntry(sessionKey, entry);
        const recovery = inspectMainSessionRecoveryEntry(sessionKey, entry);
        if (recovery) {
          mainRecoveryWedged.push(recovery);
        }
      },
    );
    for (const [sessionKey, entry] of legacyEntries) {
      if (sqliteSessionKeys.has(sessionKey)) {
        continue;
      }
      legacyPluginStateScanner.scanEntry(sessionKey, entry);
      inspectMergedEntry(sessionKey, entry);
    }
    const sessionPathOpts = resolveSessionFilePathOptions({ agentId, storePath });
    await noteMainSessionRecoveryIntegrity({
      storePath: sqliteStorePath,
      wedged: mainRecoveryWedged,
      warnings,
      changes,
      confirmRepair: (params) => prompter.confirmRuntimeRepair(params),
      countLabel,
    });
    // Session SQLite migration owns legacy transcript validation and archival.
    // Repeating it here turns healthy pending imports into integrity warnings.
    if (sqliteEntryCount > 0 || legacyEntries.length > 0) {
      if (wedgedSubagentSessions.length > 0) {
        const wedgedCount = countLabel(wedgedSubagentSessions.length, "wedged subagent session");
        warnings.push(
          [
            `- Found ${wedgedCount} with automatic restart recovery tombstoned.`,
            "  OpenClaw will not auto-resume these child sessions on restart; reconcile their task records instead.",
            `  Examples: ${wedgedSubagentSessions
              .slice(0, 3)
              .map(({ key }) => key)
              .join(", ")}`,
            `  Fix: ${formatCliCommand("openclaw tasks maintenance --apply")}`,
          ].join("\n"),
        );
        const repairWedged = await prompter.confirmRuntimeRepair({
          message: `Clear stale aborted recovery flags for ${wedgedCount}?`,
          initialValue: true,
        });
        if (repairWedged) {
          let repaired = 0;
          const repairedAt = Date.now();
          const sqliteKeys = wedgedSubagentSessions
            .map(({ key }) => key)
            .filter((key) => sqliteSessionKeys.has(key));
          for (const sessionKeys of iterateDoctorSessionKeyBatches(sqliteKeys)) {
            repaired += await applySessionEntryReplacements<number>({
              agentId,
              sessionKeys,
              storePath: sqliteStorePath,
              update: (currentEntries) => {
                const replacements = currentEntries.flatMap(({ entry, sessionKey }) =>
                  clearWedgedSubagentRecoveryAbort(entry, repairedAt)
                    ? [{ entry, sessionKey }]
                    : [],
                );
                return { replacements, result: replacements.length };
              },
            });
          }
          const legacyKeys = wedgedSubagentSessions
            .map(({ key }) => key)
            .filter((key) => !sqliteSessionKeys.has(key));
          if (legacyKeys.length > 0 && existsFile(absoluteStorePath)) {
            await updateLegacySessionStore(absoluteStorePath, (currentStore) => {
              for (const key of legacyKeys) {
                const current = currentStore[key];
                if (current && clearWedgedSubagentRecoveryAbort(current, repairedAt)) {
                  repaired += 1;
                  currentStore[key] = current;
                }
              }
            });
          }
          if (repaired > 0) {
            changes.push(
              `- Cleared aborted restart-recovery flags for ${countLabel(
                repaired,
                "wedged subagent session",
              )}.`,
            );
          }
        }

        const wedgedReasons = wedgedSubagentSessions.map(({ reason }) => reason);
        const visibleWedgedReasons = uniqueStrings(wedgedReasons).slice(0, 2);
        if (visibleWedgedReasons.length > 0) {
          warnings.push(visibleWedgedReasons.map((reason) => `  Reason: ${reason}`).join("\n"));
        }
      }

      await runPluginSessionStateDoctorRepairs({
        scan: sqlitePluginStateScanner.result(),
        store: { kind: "sqlite", agentId, path: sqliteStorePath },
        prompter,
        warnings,
        changes,
      });
      await runPluginSessionStateDoctorRepairs({
        scan: legacyPluginStateScanner.result(),
        store: { kind: "legacy", path: absoluteStorePath },
        prompter,
        warnings,
        changes,
      });
      if (sqliteSessionKeys.has(mainKey)) {
        mainEntry = loadExactSessionEntryReadOnly({
          agentId,
          sessionKey: mainKey,
          storePath: sqliteStorePath,
        })?.entry;
      }

      const heartbeatMainMoved = await repairHeartbeatPoisonedMainSession({
        mainKey,
        mainEntry,
        isSessionKeyOccupied,
        store: sqliteSessionKeys.has(mainKey)
          ? { kind: "sqlite", agentId, path: sqliteStorePath }
          : { kind: "legacy", path: absoluteStorePath },
        stateDir,
        sessionPathOpts,
        prompter,
        warnings,
        changes,
      });

      // SQLite-owned transcripts live in the agent DB after import.
      // Do not require the archived legacy JSONL for those sessions.
      if (!heartbeatMainMoved && mainEntry?.sessionId && !sqliteSessionKeys.has(mainKey)) {
        const transcriptPath = resolveSessionFilePathCore(
          mainEntry.sessionId,
          mainEntry,
          sessionPathOpts,
        );
        if (!existsFile(transcriptPath)) {
          warnings.push(
            `- Main session transcript missing (${shortenHomePath(transcriptPath)}). History will appear to reset.`,
          );
        } else {
          const lineCount = countJsonlLines(transcriptPath);
          if (lineCount <= 1) {
            warnings.push(
              `- Main session transcript has only ${lineCount} line. Session history may not be appending.`,
            );
          }
        }
      }
    }
  };

  // A fixed store can map to several agent-owned SQLite targets but only one legacy JSON file.
  // Scan that file once under the compatibility owner so full-store work is not repeated.
  const inspectedLegacyStores = new Set<string>();
  for (const target of sessionTargets) {
    const legacyStorePath = path.resolve(target.storePath);
    const inspectLegacyStore =
      !legacyStorePath.endsWith(".sqlite") && !inspectedLegacyStores.has(legacyStorePath);
    await inspectAgentSessionIntegrity(target, inspectLegacyStore);
    inspectedLegacyStores.add(legacyStorePath);
  }
  for (const warning of describeHeartbeatSessionTargetIssues(cfg)) {
    warnings.push(warning);
  }

  if (warnings.length > 0) {
    noteFn(warnings.join("\n"), "State integrity");
  }
  if (changes.length > 0) {
    noteFn(changes.join("\n"), "Doctor changes");
  }
}

/** Returns the workspace git-backup tip when the workspace exists but is not a git repo. */
export function collectWorkspaceBackupTip(workspaceDir: string): string | null {
  if (!existsDir(workspaceDir)) {
    return null;
  }
  const resolvedWorkspaceDir = safeRealpathSync(workspaceDir);
  if (!resolvedWorkspaceDir || findGitRoot(resolvedWorkspaceDir)) {
    return null;
  }
  return "- Tip: back up the agent workspace in a private git repo; keep ~/.openclaw out of git (credentials, sessions). Details: /concepts/agent-workspace#git-backup-recommended";
}

/** Emits the workspace backup tip when applicable. */
export function noteWorkspaceBackupTip(workspaceDir: string) {
  const tip = collectWorkspaceBackupTip(workspaceDir);
  if (tip) {
    note(tip, "Workspace");
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
