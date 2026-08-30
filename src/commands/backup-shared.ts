// Backup planning helpers for archive naming, payload paths, and deduplicated asset selection.
import type { Dirent } from "node:fs";
import { closeSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope-config.js";
import {
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openRootFileSync } from "../infra/boundary-file-read.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  resolveActivatedPluginBackupInventory,
  type ActivatedPluginBackupInventory,
} from "../plugins/manifest-backup-resources.js";
import type { RuntimeEnv } from "../runtime.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
import { pathExists, resolveUserPath, shortenHomePath } from "../utils.js";
import {
  createBackupResourceInventory,
  type BackupAgentRoot,
  type BackupRegenerableKind,
  type BackupResourceInventory,
} from "./backup-resource-inventory.js";
import { buildCleanupPlan, isPathWithin } from "./cleanup-utils.js";
import { resolveStartupConfigSnapshot } from "./doctor/shared/automatic-startup-config-repair.js";

// DEFLATE can legitimately encode zero-filled sparse ranges just over 1000:1.
// Keep bounded headroom without disabling node-tar's decompression bomb guard.
export const BACKUP_MAX_DECOMPRESSION_RATIO = 1100;

export function recordBackupOutcomeBestEffort(
  runtime: RuntimeEnv,
  params: Parameters<typeof recordBackupRunOutcome>[0],
): void {
  try {
    recordBackupRunOutcome(params);
  } catch (error) {
    const label = params.kind === "git" ? "Git backup" : "backup";
    runtime.error(
      `Warning: the ${label} outcome could not be recorded: ${formatErrorMessage(error)}`,
    );
  }
}

export function resolveRequiredBackupPath(
  value: string | undefined,
  label: "--repository" | "--target" | "<snapshot>" | "--scratch",
): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`Missing required ${label} value.`);
  }
  return resolveUserPath(trimmed);
}

type BackupAssetKind = "state" | "config" | "credentials" | "workspace" | "agent" | "skill-link";
type BackupSkipReason = "covered" | "missing" | "regenerable" | "unresolved";

export type BackupAsset = {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  archivePath: string;
};

type SkippedBackupAsset = {
  kind: BackupAssetKind | BackupRegenerableKind | "plugin resources";
  sourcePath: string;
  displayPath: string;
  reason: BackupSkipReason;
  coveredBy?: string;
};

type BackupPlan = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
  inventory: BackupResourceInventory;
  included: BackupAsset[];
  skipped: SkippedBackupAsset[];
};

type BackupAssetCandidate = {
  kind: BackupAssetKind;
  sourcePath: string;
  canonicalPath: string;
  exists: boolean;
};

function backupAssetPriority(kind: BackupAssetKind): number {
  switch (kind) {
    case "state":
      return 0;
    case "config":
      return 1;
    case "credentials":
      return 2;
    case "workspace":
      return 3;
    case "agent":
      return 4;
    case "skill-link":
      return 5;
  }
  throw new Error("Unsupported backup asset kind");
}

/** Format a filesystem-safe local timestamp with explicit UTC offset for backup names. */
function formatBackupArchiveTimestamp(
  nowMs = Date.now(),
  offsetMinutes = -new Date(nowMs).getTimezoneOffset(),
): string {
  const shifted = nowMs + offsetMinutes * 60_000;
  const local = new Date(shifted);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absOffsetMinutes = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absOffsetMinutes / 60)).padStart(2, "0");
  const offsetMins = String(absOffsetMinutes % 60).padStart(2, "0");
  const year = String(local.getUTCFullYear()).padStart(4, "0");
  const month = String(local.getUTCMonth() + 1).padStart(2, "0");
  const day = String(local.getUTCDate()).padStart(2, "0");
  const hours = String(local.getUTCHours()).padStart(2, "0");
  const minutes = String(local.getUTCMinutes()).padStart(2, "0");
  const seconds = String(local.getUTCSeconds()).padStart(2, "0");
  const millis = String(local.getUTCMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day}T${hours}-${minutes}-${seconds}.${millis}${sign}${offsetHours}-${offsetMins}`;
}

/** Build the root directory name stored inside a backup tarball. */
export function buildBackupArchiveRoot(nowMs = Date.now()): string {
  return `${formatBackupArchiveTimestamp(nowMs)}-openclaw-backup`;
}

/** Build the default `.tar.gz` filename for a backup archive. */
export function buildBackupArchiveBasename(nowMs = Date.now()): string {
  return `${buildBackupArchiveRoot(nowMs)}.tar.gz`;
}

/** Encode an absolute or relative source path into a traversal-safe archive payload path. */
function encodeAbsolutePathForBackupArchive(sourcePath: string): string {
  const normalized = sourcePath.replaceAll("\\", "/");
  const windowsMatch = normalized.match(/^([A-Za-z]):\/(.*)$/);
  if (windowsMatch) {
    const drive = windowsMatch[1]?.toUpperCase() ?? "UNKNOWN";
    const rest = windowsMatch[2] ?? "";
    return path.posix.join("windows", drive, rest);
  }
  if (normalized.startsWith("/")) {
    return path.posix.join("posix", normalized.slice(1));
  }
  return path.posix.join("relative", normalized);
}

/** Build the archive-relative payload path for one source path. */
export function buildBackupArchivePath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForBackupArchive(sourcePath));
}

/** Resolve a backup plan from explicit paths, deduplicating assets already covered by parents. */
async function resolveBackupPlanFromPaths(params: {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs?: string[];
  agentRoots?: readonly BackupAgentRoot[];
  pluginInventory?: ActivatedPluginBackupInventory;
  unresolvedOwnership?: boolean;
  includeWorkspace?: boolean;
  onlyConfig?: boolean;
  configInsideState?: boolean;
  oauthInsideState?: boolean;
  nowMs?: number;
}): Promise<BackupPlan> {
  const includeWorkspace = params.includeWorkspace ?? true;
  const onlyConfig = params.onlyConfig ?? false;
  const stateDir = params.stateDir;
  const configPath = params.configPath;
  const oauthDir = params.oauthDir;
  const archiveRoot = buildBackupArchiveRoot(params.nowMs);
  const workspaceDirs = includeWorkspace ? (params.workspaceDirs ?? []) : [];
  const agentRoots = onlyConfig ? [] : (params.agentRoots ?? []);
  const configInsideState = params.configInsideState ?? false;
  const oauthInsideState = params.oauthInsideState ?? false;
  const canonicalStateDir = await canonicalizePathForContainment(stateDir);
  const inventory = await createBackupResourceInventory({
    stateDir: canonicalStateDir,
    configPath: await canonicalizePathForContainment(configPath),
    oauthDir: await canonicalizePathForContainment(oauthDir),
    workspaceDirs: await Promise.all(
      workspaceDirs.map((workspaceDir) => canonicalizePathForContainment(workspaceDir)),
    ),
    agentRoots,
    pluginResources: params.pluginInventory?.resources ?? [],
    pluginRoots: params.pluginInventory?.pluginRoots ?? [],
    onlyConfig,
  });

  if (onlyConfig) {
    const resolvedConfigPath = path.resolve(configPath);
    if (!(await pathExists(resolvedConfigPath))) {
      return {
        stateDir,
        configPath,
        oauthDir,
        workspaceDirs: [],
        inventory,
        included: [],
        skipped: [
          {
            kind: "config",
            sourcePath: resolvedConfigPath,
            displayPath: shortenHomePath(resolvedConfigPath),
            reason: "missing",
          },
        ],
      };
    }

    const canonicalConfigPath = await canonicalizeExistingPath(resolvedConfigPath);
    return {
      stateDir,
      configPath,
      oauthDir,
      workspaceDirs: [],
      inventory,
      included: [
        {
          kind: "config",
          sourcePath: canonicalConfigPath,
          displayPath: shortenHomePath(canonicalConfigPath),
          archivePath: buildBackupArchivePath(archiveRoot, canonicalConfigPath),
        },
      ],
      skipped: [],
    };
  }

  const rawCandidates: Array<Pick<BackupAssetCandidate, "kind" | "sourcePath">> = [
    { kind: "state", sourcePath: path.resolve(stateDir) },
    ...(configInsideState
      ? []
      : [{ kind: "config" as const, sourcePath: path.resolve(configPath) }]),
    ...(oauthInsideState
      ? []
      : [{ kind: "credentials" as const, sourcePath: path.resolve(oauthDir) }]),
    ...workspaceDirs.map((workspaceDir) => ({
      kind: "workspace" as const,
      sourcePath: path.resolve(workspaceDir),
    })),
    ...agentRoots.map((root) => ({ kind: "agent" as const, sourcePath: root.sourcePath })),
    ...(await resolveManagedSkillSymlinkTargetCandidates(stateDir)).map((sourcePath) => ({
      kind: "skill-link" as const,
      sourcePath,
    })),
  ];

  const candidates: BackupAssetCandidate[] = await Promise.all(
    rawCandidates.map(async (candidate) => {
      const exists = await pathExists(candidate.sourcePath);
      return Object.assign({}, candidate, {
        exists,
        canonicalPath: exists
          ? await canonicalizeExistingPath(candidate.sourcePath)
          : path.resolve(candidate.sourcePath),
      });
    }),
  );

  const uniqueCandidates: BackupAssetCandidate[] = [];
  const seenCanonicalPaths = new Set<string>();
  for (const candidate of [...candidates].toSorted(compareCandidates)) {
    if (seenCanonicalPaths.has(candidate.canonicalPath)) {
      continue;
    }
    seenCanonicalPaths.add(candidate.canonicalPath);
    uniqueCandidates.push(candidate);
  }
  const included: BackupAsset[] = [];
  const skipped: SkippedBackupAsset[] = [];

  for (const candidate of uniqueCandidates) {
    if (!candidate.exists) {
      if (
        candidate.kind === "agent" &&
        agentRoots.some(
          (root) =>
            root.sourcePath === candidate.canonicalPath &&
            root.sourcePath === path.join(canonicalStateDir, "agents", root.agentId, "agent"),
        )
      ) {
        continue;
      }
      skipped.push({
        kind: candidate.kind,
        sourcePath: candidate.sourcePath,
        displayPath: shortenHomePath(candidate.sourcePath),
        reason: "missing",
      });
      continue;
    }

    const coveredBy = included.find((asset) =>
      isPathWithin(candidate.canonicalPath, asset.sourcePath),
    );
    if (coveredBy) {
      skipped.push({
        kind: candidate.kind,
        sourcePath: candidate.canonicalPath,
        displayPath: shortenHomePath(candidate.canonicalPath),
        reason: "covered",
        coveredBy: coveredBy.displayPath,
      });
      continue;
    }

    included.push({
      kind: candidate.kind,
      sourcePath: candidate.canonicalPath,
      displayPath: shortenHomePath(candidate.canonicalPath),
      archivePath: buildBackupArchivePath(archiveRoot, candidate.canonicalPath),
    });
  }

  const regenerableRoots = inventory.regenerableRoots.filter(
    (resource) =>
      !inventory.isIncluded(resource.sourcePath) &&
      included.some((asset) => isPathWithin(resource.sourcePath, asset.sourcePath)),
  );
  const regenerableResourceExists = await Promise.all(
    regenerableRoots.map((resource) => pathExists(resource.sourcePath)),
  );
  for (const [index, resource] of regenerableRoots.entries()) {
    if (!regenerableResourceExists[index]) {
      continue;
    }
    skipped.push({
      kind: resource.kind,
      sourcePath: resource.sourcePath,
      displayPath: shortenHomePath(resource.sourcePath),
      reason: "regenerable",
    });
  }
  if (params.unresolvedOwnership) {
    for (const kind of ["agent", "plugin resources"] as const) {
      skipped.push({
        kind,
        sourcePath: configPath,
        displayPath: shortenHomePath(configPath),
        reason: "unresolved",
      });
    }
  }

  return {
    stateDir,
    configPath,
    oauthDir,
    workspaceDirs: workspaceDirs.map((entry) => path.resolve(entry)),
    inventory,
    included,
    skipped,
  };
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.backupPlanTestApi")] = {
    resolveBackupPlanFromPaths,
  };
}

function compareCandidates(left: BackupAssetCandidate, right: BackupAssetCandidate): number {
  const depthDelta = left.canonicalPath.length - right.canonicalPath.length;
  if (depthDelta !== 0) {
    return depthDelta;
  }
  const priorityDelta = backupAssetPriority(left.kind) - backupAssetPriority(right.kind);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return left.canonicalPath.localeCompare(right.canonicalPath);
}

// Managed skill roots deliberately accept directory symlinks resolving outside
// the root (the `skills` CLI symlink-mode layout), while the archive guard is
// fail-closed on any link whose target is not a declared asset. Declare only
// bounded skill targets: a link to a state ancestor or any broad directory
// would otherwise promote that whole tree to an archive root.
async function resolveManagedSkillSymlinkTargetCandidates(stateDir: string): Promise<string[]> {
  const managedSkillsDir = path.join(stateDir, "skills");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(managedSkillsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const canonicalStateDir = await canonicalizePathForContainment(stateDir);
  const targets: string[] = [];
  for (const entry of entries) {
    if (!entry.isSymbolicLink()) {
      continue;
    }
    const linkPath = path.join(managedSkillsDir, entry.name);
    const targetPath = await canonicalizeExistingPath(linkPath);
    // Neither side may contain the other: an external target that holds the
    // state asset would swallow it (and everything else) via covered dedupe.
    if (
      isPathWithin(targetPath, canonicalStateDir) ||
      isPathWithin(canonicalStateDir, targetPath)
    ) {
      continue;
    }
    try {
      if (!(await fs.stat(linkPath)).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    // Skill loaders admit a directory only when its metadata opens through the
    // skill-root boundary; a final SKILL.md symlink that escapes the target
    // would otherwise satisfy existence and declare a broad external target
    // whose cross-asset link the archive guard accepts.
    const opened = openRootFileSync({
      absolutePath: path.join(targetPath, "SKILL.md"),
      rootPath: targetPath,
      rootRealPath: targetPath,
      boundaryLabel: "skill target",
      rejectSymlinks: false,
    });
    if (!opened.ok) {
      continue;
    }
    closeSync(opened.fd);
    targets.push(targetPath);
  }
  return targets;
}

async function canonicalizeExistingPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

/** Resolve symlinks in the existing prefix while retaining a not-yet-created suffix. */
export async function canonicalizePathForContainment(targetPath: string): Promise<string> {
  const resolved = path.resolve(targetPath);
  const suffix: string[] = [];
  let probe = resolved;

  while (true) {
    try {
      const realProbe = await fs.realpath(probe);
      return suffix.length === 0 ? realProbe : path.join(realProbe, ...suffix.toReversed());
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) {
        return resolved;
      }
      suffix.push(path.basename(probe));
      probe = parent;
    }
  }
}

/** Resolve one configured agent's canonical backup root and owner database path. */
export async function resolveBackupAgentRoot(
  config: OpenClawConfig,
  agentId: string,
): Promise<BackupAgentRoot> {
  const sourcePath = await canonicalizePathForContainment(resolveAgentDir(config, agentId));
  return {
    agentId,
    sourcePath,
    databasePath: path.join(sourcePath, "openclaw-agent.sqlite"),
  };
}

/** Resolve configured agent storage roots and their canonical database paths for backup ownership. */
export async function resolveBackupAgentRoots(config: OpenClawConfig): Promise<BackupAgentRoot[]> {
  return await Promise.all(
    listAgentIds(config).map((agentId) => resolveBackupAgentRoot(config, agentId)),
  );
}

/** Resolve the backup plan from the current OpenClaw state/config/workspace paths on disk. */
export async function resolveBackupPlanFromDisk(
  params: {
    includeWorkspace?: boolean;
    onlyConfig?: boolean;
    nowMs?: number;
  } = {},
): Promise<BackupPlan> {
  const includeWorkspace = params.includeWorkspace ?? true;
  const onlyConfig = params.onlyConfig ?? false;
  const stateDir = resolveStateDir();
  const configPath = resolveConfigPath();
  const oauthDir = resolveOAuthDir();

  if (onlyConfig) {
    return await resolveBackupPlanFromPaths({
      stateDir,
      configPath,
      oauthDir,
      includeWorkspace: false,
      onlyConfig: true,
      nowMs: params.nowMs,
    });
  }

  // Backup discovery must not initialize or migrate the state DB before snapshot validation.
  const configSnapshot = await readConfigFileSnapshot({ observe: false });
  const discoverySnapshot = resolveStartupConfigSnapshot(configSnapshot) ?? configSnapshot;
  if (includeWorkspace && discoverySnapshot.exists && !discoverySnapshot.valid) {
    throw new Error(
      `Config invalid at ${shortenHomePath(discoverySnapshot.path)}. OpenClaw cannot reliably discover custom workspaces for backup. Fix the config or rerun with --no-include-workspace for a partial backup.`,
    );
  }
  const cleanupPlan = buildCleanupPlan({
    // Discovery uses the validated compatibility view; the archive still reads configPath bytes.
    cfg: discoverySnapshot.config,
    stateDir,
    configPath,
    oauthDir,
  });
  const unresolvedOwnership = discoverySnapshot.exists && !discoverySnapshot.valid;
  const agentRoots = unresolvedOwnership
    ? []
    : await resolveBackupAgentRoots(discoverySnapshot.config);
  const workspaceDirs = includeWorkspace ? cleanupPlan.workspaceDirs : [];
  const pluginInventory = unresolvedOwnership
    ? undefined
    : resolveActivatedPluginBackupInventory({
        config: discoverySnapshot.config,
        env: process.env,
        stateDir,
        workspaceDirs,
      });
  return await resolveBackupPlanFromPaths({
    stateDir,
    configPath,
    oauthDir,
    workspaceDirs,
    agentRoots,
    pluginInventory,
    unresolvedOwnership,
    includeWorkspace,
    onlyConfig,
    configInsideState: cleanupPlan.configInsideState,
    oauthInsideState: cleanupPlan.oauthInsideState,
    nowMs: params.nowMs,
  });
}
