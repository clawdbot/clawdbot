// Memory Core plugin module maps transcript corpus entries onto session entry options.
import type { SessionTranscriptCorpusEntry } from "openclaw/plugin-sdk/memory-core-host-engine-qmd";

export function buildCorpusSessionEntryOptions(entry: SessionTranscriptCorpusEntry) {
  return {
    generatedByDreamingNarrative: entry.generatedByDreamingNarrative === true,
    generatedByCronRun: entry.generatedByCronRun === true,
    ...(entry.sessionKind ? { sessionKind: entry.sessionKind } : {}),
    ...(entry.transcriptSource === "sqlite" && entry.storePath
      ? {
          agentId: entry.agentId,
          sessionId: entry.sessionId,
          storePath: entry.storePath,
        }
      : {}),
    ...(entry.sessionKey ? { sessionKey: entry.sessionKey } : {}),
    ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
  };
}
