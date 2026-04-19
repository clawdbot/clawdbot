import fs from "node:fs/promises";
import path from "node:path";
import {
  readConfigFileSnapshot,
  resolveConfigPath,
  resolveOAuthDir,
  resolveStateDir,
} from "../config/config.js";
import { formatSessionArchiveTimestamp } from "../config/sessions/artifacts.js";
import { pathExists, shortenHomePath } from "../utils.js";
import { buildCleanupPlan, isPathWithin } from "./cleanup-utils.js";

export type BackupAssetKind = "state" | "config" | "credentials" | "workspace";
export type BackupSkipReason = "covered" | "missing";

export type BackupAsset = {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  archivePath: string;
};

export type SkippedBackupAsset = {
  kind: BackupAssetKind;
  sourcePath: string;
  displayPath: string;
  reason: BackupSkipReason;
  coveredBy?: string;
};

export type BackupPlan = {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs: string[];
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
  }
  throw new Error("Unsupported backup asset kind");
}

export function buildBackupArchiveRoot(nowMs = Date.now()): string {
  return `${formatSessionArchiveTimestamp(nowMs)}-openclaw-backup`;
}

export function buildBackupArchiveBasename(nowMs = Date.now()): string {
  return `${buildBackupArchiveRoot(nowMs)}.tar.gz`;
}

export function encodeAbsolutePathForBackupArchive(sourcePath: string): string {
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

export function buildBackupArchivePath(archiveRoot: string, sourcePath: string): string {
  return path.posix.join(archiveRoot, "payload", encodeAbsolutePathForBackupArchive(sourcePath));
}

export async function resolveBackupPlanFromPaths(params: {
  stateDir: string;
  configPath: string;
  oauthDir: string;
  workspaceDirs?: string[];
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
  const configInsideState = params.configInsideState ?? false;
  const oauthInsideState = params.oauthInsideState ?? false;

  if (onlyConfig) {
    const resolvedConfigPath = path.resolve(configPath);
    if (!(await pathExists(resolvedConfigPath))) {
      return {
        stateDir,
        configPath,
        oauthDir,
        workspaceDirs: [],
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

  return {
    stateDir,
    configPath,
    oauthDir,
    workspaceDirs: workspaceDirs.map((entry) => path.resolve(entry)),
    included,
    skipped,
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

async function canonicalizeExistingPath(targetPath: string): Promise<string> {
  try {
    return await fs.realpath(targetPath);
  } catch {
    return path.resolve(targetPath);
  }
}

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

  const configSnapshot = await readConfigFileSnapshot();
  if (includeWorkspace && configSnapshot.exists && !configSnapshot.valid) {
    throw new Error(
      `Config invalid at ${shortenHomePath(configSnapshot.path)}. OpenClaw cannot reliably discover custom workspaces for backup. Fix the config or rerun with --no-include-workspace for a partial backup.`,
    );
  }
  const cleanupPlan = buildCleanupPlan({
    cfg: configSnapshot.config,
    stateDir,
    configPath,
    oauthDir,
  });
  return await resolveBackupPlanFromPaths({
    stateDir,
    configPath,
    oauthDir,
    workspaceDirs: includeWorkspace ? cleanupPlan.workspaceDirs : [],
    includeWorkspace,
    onlyConfig,
    configInsideState: cleanupPlan.configInsideState,
    oauthInsideState: cleanupPlan.oauthInsideState,
    nowMs: params.nowMs,
  });
}
