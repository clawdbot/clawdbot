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

/** Deduplicates archive previews when multiple logical stores share one transcript directory. */
export class SessionArchiveCleanupPreviewCoordinator {
  readonly #filePathsByDirectory = new Map<string, Set<string>>();

  async preview(params: {
    target: SessionStoreTarget;
    maintenance: ResolvedSessionMaintenanceConfig;
  }): Promise<SessionArchiveCleanupPreview> {
    const archiveDirectory = path.resolve(
      resolveSessionTranscriptArchiveDirectoryFromStorePath(params.target.storePath, {
        agentId: params.target.agentId,
      }),
    );
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
}

export async function applySessionArchiveCleanup(params: {
  target: SessionStoreTarget;
  maintenance: ResolvedSessionMaintenanceConfig;
}): Promise<SessionArchiveCleanupReport> {
  return await cleanupArchivedTranscriptsForSummary({
    ...params,
    dryRun: false,
  });
}
