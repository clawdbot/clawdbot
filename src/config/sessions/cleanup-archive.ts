import path from "node:path";
import { resolveSessionArtifactCanonicalPathsForEntry } from "./disk-budget.js";
import { cleanupSessionArchivedTranscriptFiles } from "./session-accessor.js";
import { resolveSessionTranscriptArchiveDirectoryFromStorePath } from "./session-sqlite-target.js";
import {
  EMPTY_SESSION_ARCHIVE_CLEANUP_REPORT,
  resolveSessionArchiveCleanupRules,
  type SessionArchiveCleanupReport,
} from "./store-maintenance-operations.js";
import type { ResolvedSessionMaintenanceConfig } from "./store-maintenance.js";
import type { SessionStoreTarget } from "./targets.js";
import type { SessionEntry } from "./types.js";

export function collectSessionEntryArtifactPaths(params: {
  store: Record<string, SessionEntry>;
  storePath: string;
  keySets: Iterable<ReadonlySet<string>>;
}): Set<string> {
  const paths = new Set<string>();
  const sessionsDir = path.dirname(params.storePath);
  for (const keys of params.keySets) {
    for (const key of keys) {
      const entry = params.store[key];
      if (!entry) {
        continue;
      }
      for (const artifactPath of resolveSessionArtifactCanonicalPathsForEntry({
        sessionsDir,
        entry,
      })) {
        paths.add(artifactPath);
      }
    }
  }
  return paths;
}

async function cleanupArchivedTranscriptsForSummary(params: {
  target: SessionStoreTarget;
  maintenance: ResolvedSessionMaintenanceConfig;
  dryRun: boolean;
  excludeCanonicalPaths?: ReadonlySet<string>;
  onRemoveFile?: (canonicalPath: string) => void;
}): Promise<SessionArchiveCleanupReport> {
  const result = await cleanupSessionArchivedTranscriptFiles({
    directories: [
      resolveSessionTranscriptArchiveDirectoryFromStorePath(params.target.storePath, {
        agentId: params.target.agentId,
      }),
    ],
    rules: resolveSessionArchiveCleanupRules(params.maintenance),
    dryRun: params.dryRun,
    excludeCanonicalPaths: params.excludeCanonicalPaths,
    onRemoveFile: params.onRemoveFile,
  });
  return {
    scannedFiles: result.scanned,
    removedFiles: result.removed,
  };
}

type SessionArchiveCleanupPreview = {
  report: SessionArchiveCleanupReport;
  excludeCanonicalPaths: ReadonlySet<string>;
};

function resolveArchiveDirectory(target: SessionStoreTarget): string {
  return path.resolve(
    resolveSessionTranscriptArchiveDirectoryFromStorePath(target.storePath, {
      agentId: target.agentId,
    }),
  );
}

function resolveTargetIdentity(target: SessionStoreTarget): string {
  return `${target.agentId}\0${path.resolve(target.storePath)}`;
}

/** Coordinates safe archive cleanup when multiple logical stores share one directory. */
export class SessionArchiveCleanupPreviewCoordinator {
  readonly #filePathsByDirectory = new Map<string, Set<string>>();
  readonly #appliedDirectories = new Set<string>();
  readonly #cleanableDirectories = new Set<string>();

  constructor(params: {
    selectedTargets: readonly SessionStoreTarget[];
    knownTargets: readonly SessionStoreTarget[];
  }) {
    const selectedIdentities = new Set(params.selectedTargets.map(resolveTargetIdentity));
    const ownersByDirectory = new Map<string, Set<string>>();
    for (const target of [...params.knownTargets, ...params.selectedTargets]) {
      const directory = resolveArchiveDirectory(target);
      const owners = ownersByDirectory.get(directory) ?? new Set<string>();
      owners.add(resolveTargetIdentity(target));
      ownersByDirectory.set(directory, owners);
    }
    for (const [directory, owners] of ownersByDirectory) {
      if ([...owners].every((owner) => selectedIdentities.has(owner))) {
        this.#cleanableDirectories.add(directory);
      }
    }
  }

  async preview(params: {
    target: SessionStoreTarget;
    maintenance: ResolvedSessionMaintenanceConfig;
  }): Promise<SessionArchiveCleanupPreview> {
    const archiveDirectory = resolveArchiveDirectory(params.target);
    if (!this.#cleanableDirectories.has(archiveDirectory)) {
      return {
        report: { ...EMPTY_SESSION_ARCHIVE_CLEANUP_REPORT },
        excludeCanonicalPaths: new Set<string>(),
      };
    }
    const existingFilePaths = this.#filePathsByDirectory.get(archiveDirectory);
    if (existingFilePaths) {
      return {
        report: { ...EMPTY_SESSION_ARCHIVE_CLEANUP_REPORT },
        excludeCanonicalPaths: existingFilePaths,
      };
    }

    const filePaths = new Set<string>();
    this.#filePathsByDirectory.set(archiveDirectory, filePaths);
    const report = await cleanupArchivedTranscriptsForSummary({
      ...params,
      dryRun: true,
      onRemoveFile: (canonicalPath) => {
        filePaths.add(canonicalPath);
      },
    });
    return { report, excludeCanonicalPaths: filePaths };
  }

  async apply(params: {
    target: SessionStoreTarget;
    maintenance: ResolvedSessionMaintenanceConfig;
  }): Promise<SessionArchiveCleanupReport> {
    const archiveDirectory = resolveArchiveDirectory(params.target);
    if (
      !this.#cleanableDirectories.has(archiveDirectory) ||
      this.#appliedDirectories.has(archiveDirectory)
    ) {
      return { ...EMPTY_SESSION_ARCHIVE_CLEANUP_REPORT };
    }
    this.#appliedDirectories.add(archiveDirectory);
    return await cleanupArchivedTranscriptsForSummary({
      ...params,
      dryRun: false,
    });
  }
}
