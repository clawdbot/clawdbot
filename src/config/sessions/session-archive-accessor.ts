import type { SessionArchivedTranscriptCleanupRule } from "./session-accessor.lifecycle-types.js";

export type SessionArchivedTranscriptFileCleanupParams = {
  directories: string[];
  rules: SessionArchivedTranscriptCleanupRule[];
  nowMs?: number;
  dryRun?: boolean;
  excludeCanonicalPaths?: ReadonlySet<string>;
  onRemoveFile?: (canonicalPath: string) => void;
};

export type SessionArchivedTranscriptFileCleanupResult = {
  removed: number;
  scanned: number;
};
