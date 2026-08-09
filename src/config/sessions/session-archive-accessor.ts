import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import type { SessionArchivedTranscriptCleanupRule } from "./session-accessor.lifecycle-types.js";

const loadSessionArchiveRuntime = createLazyRuntimeModule(
  () => import("../../gateway/session-archive.runtime.js"),
);

type SessionArchivedTranscriptFileCleanupParams = {
  directories: string[];
  rules: SessionArchivedTranscriptCleanupRule[];
  nowMs?: number;
  dryRun?: boolean;
  excludeCanonicalPaths?: ReadonlySet<string>;
  onRemoveFile?: (canonicalPath: string) => void;
};

type SessionArchivedTranscriptFileCleanupResult = {
  removed: number;
  scanned: number;
};

export async function cleanupSessionArchivedTranscriptFiles(
  params: SessionArchivedTranscriptFileCleanupParams,
): Promise<SessionArchivedTranscriptFileCleanupResult> {
  const { cleanupArchivedSessionTranscripts } = await loadSessionArchiveRuntime();
  return await cleanupArchivedSessionTranscripts(params);
}
