import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listAgentEntries, resolveDefaultAgentId } from "../agents/agent-scope.js";
import {
  clearWedgedSubagentRecoveryAbort,
  formatSubagentRecoveryWedgedReason,
  isSubagentRecoveryWedgedEntry,
} from "../agents/subagent-recovery-state.js";
import { formatCliCommand } from "../cli/command-format.js";
import { resolveOAuthDir, resolveStateDir } from "../config/paths.js";
import {
  formatSessionArchiveTimestamp,
  isPrimarySessionTranscriptFileName,
} from "../config/sessions/artifacts.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  resolveSessionFilePath,
  resolveSessionFilePathOptions,
  resolveSessionTranscriptsDirForAgent,
  resolveStorePath,
} from "../config/sessions/paths.js";
import { loadSessionStore } from "../config/sessions/store-load.js";
import { updateSessionStore } from "../config/sessions/store.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { resolveMemoryBackendConfig } from "../memory-host-sdk/engine-storage.js";
import { resolveOpenClawAgentDir } from "../plugin-sdk/agent-dir-compat.js";
import { listConfiguredChannelIdsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { asNullableObjectRecord } from "../shared/record-coerce.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { note } from "../terminal/note.js";
import { shortenHomePath } from "../utils.js";
import { repairHeartbeatPoisonedMainSession } from "./doctor-heartbeat-main-session-repair.js";
import { describeHeartbeatSessionTargetIssues } from "./doctor-heartbeat-session-target.js";
import { runPluginSessionStateDoctorRepairs } from "./doctor-session-state-providers.js";

type DoctorPrompterLike = {
  confirmRuntimeRepair: (params: {
    message: string;
    initialValue?: boolean;
    requiresInteractiveConfirmation?: boolean;
  }) => Promise<boolean>;
  note?: typeof note;
};

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatFilePreview(paths: string[], limit = 3): string {
  const names = paths.slice(0, limit).map((filePath) => path.basename(filePath));
  const remaining = paths.length - names.length;
  if (remaining > 0) {
    return `${names.join(", ")}, and ${remaining} more`;
  }
  return names.join(", ");
}

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

function tryResolveNativeRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync.native(targetPath);
  } catch {
    return null;
  }
}

function resolveComparableTranscriptPath(filePath: string): string {
  return tryResolveNativeRealPath(filePath) ?? path.resolve(filePath);
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
  const configuredIds = new Set<string>();
  configuredIds.add(normalizeAgentId(resolveDefaultAgentId(cfg)));
  for (const entry of listAgentEntries(cfg)) {
    configuredIds.add(normalizeAgentId(entry.id));
  }

  const agentsRoot = path.join(stateDir, "agents");
  const liveCompatibilityAgentDir = resolveOpenClawAgentDir();
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
        if (areComparablePathsEqual(nestedAgentDir, liveCompatibilityAgentDir)) {
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
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    if (!raw) {
      return 0;
    }
    let count = 0;
    for (let i = 0; i < raw.length; i += 1) {
      if (raw[i] === "\n") {
        count += 1;
      }
    }
    if (!raw.endsWith("\n")) {
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

function findOtherStateDirs(stateDir: string): string[] {
  const resolvedState = path.resolve(stateDir);
  const roots =
    process.platform === "darwin" ? ["/Users"] : process.platform === "linux" ? ["/home"] : [];
  const found: string[] = [];
  for (const root of roots) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (entry.name.startsWith(".")) {
        continue;
      }
      const candidates = [".openclaw"].map((dir) => path.resolve(root, entry.name, dir));
      for (const candidate of candidates) {
        if (candidate === resolvedState) {
          continue;
        }
        if (existsDir(candidate)) {
          found.push(candidate);
        }
      }
    }
  }
  return found;
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

function tryResolveRealPath(targetPath: string): string | null {
  try {
    return fs.realpathSync(targetPath);
  } catch {
    return null;
  }
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\([0-7]{3})/g, (_, octal: string) =>
    String.fromCharCode(Number.parseInt(octal, 8)),
  );
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

export type LinuxSdBackedStateDir = {
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
      mountPoint: decodeMountInfoPath(leftFields[4]),
      fsType: rightFields[0],
      source: decodeMountInfoPath(rightFields[1]),
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

  const resolveRealPath = deps?.resolveRealPath ?? tryResolveRealPath;
  const resolvedStatePath = resolveRealPath(stateDir) ?? linuxPath.resolve(stateDir);
  const mountInfo = deps?.mountInfo ?? tryReadLinuxMountInfo();
  if (!mountInfo) {
    return null;
  }

  const mountEntry = findLinuxMountInfoEntryForPath(
    resolvedStatePath,
    parseLinuxMountInfo(mountInfo),
    linuxPath,
  );
  if (!mountEntry) {
    return null;
  }

  const sourceCandidates = [mountEntry.source];
  if (mountEntry.source.startsWith("/dev/")) {
    const resolvedDevicePath = (deps?.resolveDeviceRealPath ?? tryResolveRealPath)(
      mountEntry.source,
    );
    if (resolvedDevicePath) {
      sourceCandidates.push(linuxPath.resolve(resolvedDevicePath));
    }
  }
  if (!sourceCandidates.some((candidate) => isMmcDevicePath(candidate, linuxPath))) {
    return null;
  }

  return {
    path: linuxPath.resolve(resolvedStatePath),
    mountPoint: linuxPath.resolve(mountEntry.mountPoint),
    fsType: mountEntry.fsType,
    source: mountEntry.source,
  };
}

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
  const realPath = (deps?.resolveRealPath ?? tryResolveRealPath)(stateDir);
  // Prefer the resolved target path when available so symlink prefixes do not
  // misclassify local state dirs as cloud-synced.
  const candidates = realPath ? [path.resolve(realPath)] : [path.resolve(stateDir)];

  for (const candidate of candidates) {
    for (const { storage, root } of roots) {
      if (isPathUnderRoot(candidate, root)) {
        return { path: candidate, storage };
      }
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

function isSlashRoutingSessionKey(sessionKey: string): boolean {
  const raw = normalizeOptionalLowercaseString(sessionKey);
  if (!raw) {
    return false;
  }
  const scoped = parseAgentSessionKey(raw)?.rest ?? raw;
  return /^[^:]+:slash:[^:]+(?:$|:)/.test(scoped);
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

function shouldSuppressOrphanTranscriptWarning(cfg: OpenClawConfig, agentId: string): boolean {
  const backendConfig = resolveMemoryBackendConfig({ cfg, agentId });
  return backendConfig?.backend === "qmd" && backendConfig.qmd?.sessions.enabled === true;
}

export async function noteStateIntegrity(
  cfg: OpenClawConfig,
  prompter: DoctorPrompterLike,
  configPath?: string,
) {
  const warnings: string[] = [];
  const changes: string[] = [];
  const noteFn = prompter.note ?? note;
  const env = process.env;
  const homedir = () => resolveRequiredHomeDir(env, os.homedir);
  const stateDir = resolveStateDir(env, homedir);
  const defaultStateDir = path.join(homedir(), ".openclaw");
  const oauthDir = resolveOAuthDir(env, stateDir);
  const agentId = resolveDefaultAgentId(cfg);
  const sessionsDir = resolveSessionTranscriptsDirForAgent(agentId, env, homedir);
  const storePath = resolveStorePath(cfg.session?.store, { agentId });
  const storeDir = path.dirname(storePath);
  const absoluteStorePath = path.resolve(storePath);
  const displayStateDir = shortenHomePath(stateDir);
  const displayOauthDir = shortenHomePath(oauthDir);
  const displaySessionsDir = shortenHomePath(sessionsDir);
  const displayStoreDir = shortenHomePath(storeDir);
  const displayConfigPath = configPath ? shortenHomePath(configPath) : undefined;
  const requireOAuthDir = shouldRequireOAuthDir(cfg, env);
  const cloudSyncedStateDir = detectMacCloudSyncedStateDir(stateDir);
  const linuxSdBackedStateDir = detectLinuxSdBackedStateDir(stateDir);
  const suppressOrphanTranscriptWarning = shouldSuppressOrphanTranscriptWarning(cfg, agentId);

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

  let stateDirExists = existsDir(stateDir);
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
    const dirCandidates = new Map<string, string>();
    dirCandidates.set(sessionsDir, "Sessions dir");
    dirCandidates.set(storeDir, "Session store dir");
    if (requireOAuthDir) {
      dirCandidates.set(oauthDir, "OAuth dir");
    } else if (!existsDir(oauthDir)) {
      warnings.push(
        `- OAuth dir not present (${displayOauthDir}). Skipping create because no WhatsApp/pairing channel config is active.`,
      );
    }
    const displayDirFor = (dir: string) => {
      if (dir === sessionsDir) {
        return displaySessionsDir;
      }
      if (dir === storeDir) {
        return displayStoreDir;
      }
      if (dir === oauthDir) {
        return displayOauthDir;
      }
      return shortenHomePath(dir);
    };

    for (const [dir, label] of dirCandidates) {
      const displayDir = displayDirFor(dir);
      if (!existsDir(dir)) {
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

  const extraStateDirs = new Set<string>();
  if (path.resolve(stateDir) !== path.resolve(defaultStateDir)) {
    if (existsDir(defaultStateDir)) {
      extraStateDirs.add(defaultStateDir);
    }
  }
  for (const other of findOtherStateDirs(stateDir)) {
    extraStateDirs.add(other);
  }
  if (extraStateDirs.size > 0) {
    warnings.push(
      [
        "- Multiple state directories detected. This can split session history.",
        ...Array.from(extraStateDirs).map((dir) => `  - ${shortenHomePath(dir)}`),
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

  const store = loadSessionStore(storePath);
  const sessionPathOpts = resolveSessionFilePathOptions({ agentId, storePath });
  const entries = Object.entries(store).filter(([, entry]) => entry && typeof entry === "object");
  if (entries.length > 0) {
    const recent = entries
      .slice()
      .toSorted((a, b) => {
        const aUpdated = typeof a[1].updatedAt === "number" ? a[1].updatedAt : 0;
        const bUpdated = typeof b[1].updatedAt === "number" ? b[1].updatedAt : 0;
        return bUpdated - aUpdated;
      })
      .slice(0, 5);
    const recentTranscriptCandidates = recent.filter(([key]) => !isSlashRoutingSessionKey(key));
    const missing = recentTranscriptCandidates.filter(([, entry]) => {
      const sessionId = entry.sessionId;
      if (!sessionId) {
        return false;
      }
      const transcriptPath = resolveSessionFilePath(sessionId, entry, sessionPathOpts);
      return !existsFile(transcriptPath);
    });
    if (missing.length > 0) {
      warnings.push(
        [
          `- ${missing.length}/${recentTranscriptCandidates.length} recent sessions are missing transcripts.`,
          `  Verify sessions in store: ${formatCliCommand(`openclaw sessions --store "${absoluteStorePath}"`)}`,
          `  Preview cleanup impact: ${formatCliCommand(`openclaw sessions cleanup --store "${absoluteStorePath}" --dry-run`)}`,
          `  Prune missing entries: ${formatCliCommand(`openclaw sessions cleanup --store "${absoluteStorePath}" --enforce --fix-missing`)}`,
        ].join("\n"),
      );
    }

    const wedgedSubagentSessions = entries.filter(([, entry]) =>
      isSubagentRecoveryWedgedEntry(entry),
    );
    if (wedgedSubagentSessions.length > 0) {
      const wedgedCount = countLabel(wedgedSubagentSessions.length, "wedged subagent session");
      warnings.push(
        [
          `- Found ${wedgedCount} with automatic restart recovery tombstoned.`,
          "  OpenClaw will not auto-resume these child sessions on restart; reconcile their task records instead.",
          `  Examples: ${wedgedSubagentSessions
            .slice(0, 3)
            .map(([key]) => key)
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
        await updateSessionStore(absoluteStorePath, (currentStore) => {
          for (const [key] of wedgedSubagentSessions) {
            const current = currentStore[key];
            if (current && clearWedgedSubagentRecoveryAbort(current, repairedAt)) {
              repaired += 1;
              currentStore[key] = current;
            }
          }
        });
        if (repaired > 0) {
          changes.push(
            `- Cleared aborted restart-recovery flags for ${countLabel(
              repaired,
              "wedged subagent session",
            )}.`,
          );
        }
      }

      const wedgedReasons = wedgedSubagentSessions
        .map(([, entry]) => formatSubagentRecoveryWedgedReason(entry))
        .filter((reason, index, all) => all.indexOf(reason) === index)
        .slice(0, 2);
      if (wedgedReasons.length > 0) {
        warnings.push(wedgedReasons.map((reason) => `  Reason: ${reason}`).join("\n"));
      }
    }

    await runPluginSessionStateDoctorRepairs({
      cfg,
      store,
      absoluteStorePath,
      prompter,
      env,
      warnings,
      changes,
    });

    await repairHeartbeatPoisonedMainSession({
      cfg,
      store,
      absoluteStorePath,
      stateDir,
      sessionPathOpts,
      prompter,
      warnings,
      changes,
    });

    for (const warning of describeHeartbeatSessionTargetIssues(cfg)) {
      warnings.push(warning);
    }

    const mainKey = resolveMainSessionKey(cfg);
    const mainEntry = store[mainKey];
    if (mainEntry?.sessionId) {
      const transcriptPath = resolveSessionFilePath(
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

  if (existsDir(sessionsDir)) {
    const referencedTranscriptPaths = new Set<string>();
    for (const [, entry] of entries) {
      if (!entry?.sessionId) {
        continue;
      }
      try {
        referencedTranscriptPaths.add(
          resolveComparableTranscriptPath(
            resolveSessionFilePath(entry.sessionId, entry, sessionPathOpts),
          ),
        );
      } catch {
        // ignore invalid legacy paths
      }
    }
    const sessionDirEntries = fs.readdirSync(sessionsDir, { withFileTypes: true });
    const orphanTranscriptPaths = sessionDirEntries
      .filter((entry) => entry.isFile() && isPrimarySessionTranscriptFileName(entry.name))
      .map((entry) => path.join(sessionsDir, entry.name))
      .filter(
        (filePath) => !referencedTranscriptPaths.has(resolveComparableTranscriptPath(filePath)),
      );
    if (orphanTranscriptPaths.length > 0 && !suppressOrphanTranscriptWarning) {
      const orphanCount = countLabel(orphanTranscriptPaths.length, "orphan transcript file");
      const orphanPreview = formatFilePreview(orphanTranscriptPaths);
      warnings.push(
        [
          `- Found ${orphanCount} in ${displaySessionsDir}.`,
          "  These .jsonl files are no longer referenced by sessions.json, so they are not part of any active session history.",
          "  Doctor can archive them safely by renaming each file to *.deleted.<timestamp>.",
          `  Examples: ${orphanPreview}`,
        ].join("\n"),
      );
      const archiveOrphans = await prompter.confirmRuntimeRepair({
        message: `Archive ${orphanCount} in ${displaySessionsDir}? This only renames them to *.deleted.<timestamp>.`,
        initialValue: false,
        requiresInteractiveConfirmation: true,
      });
      if (archiveOrphans) {
        let archived = 0;
        const archivedAt = formatSessionArchiveTimestamp();
        for (const orphanPath of orphanTranscriptPaths) {
          const archivedPath = `${orphanPath}.deleted.${archivedAt}`;
          try {
            fs.renameSync(orphanPath, archivedPath);
            archived += 1;
          } catch (err) {
            warnings.push(
              `- Failed to archive orphan transcript ${shortenHomePath(orphanPath)}: ${String(err)}`,
            );
          }
        }
        if (archived > 0) {
          changes.push(
            `- Archived ${countLabel(archived, "orphan transcript file")} in ${displaySessionsDir} as .deleted timestamped backups.`,
          );
        }
      }
    }
  }

  if (warnings.length > 0) {
    noteFn(warnings.join("\n"), "State integrity");
  }
  if (changes.length > 0) {
    noteFn(changes.join("\n"), "Doctor changes");
  }
}

export function noteWorkspaceBackupTip(workspaceDir: string) {
  if (!existsDir(workspaceDir)) {
    return;
  }
  const gitMarker = path.join(workspaceDir, ".git");
  if (fs.existsSync(gitMarker)) {
    return;
  }
  note(
    [
      "- Tip: back up the workspace in a private git repo (GitHub or GitLab).",
      "- Keep ~/.openclaw out of git; it contains credentials and session history.",
      "- Details: /concepts/agent-workspace#git-backup-recommended",
    ].join("\n"),
    "Workspace",
  );
}
