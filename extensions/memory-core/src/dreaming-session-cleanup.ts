import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { cleanupSessionLifecycleArtifacts } from "openclaw/plugin-sdk/session-store-runtime";

const DREAMING_SESSION_KEY_PREFIX = "dreaming-narrative-";
export const DREAMING_ORPHAN_MIN_AGE_MS = 300_000;
const DREAMING_TRANSCRIPT_RUN_MARKER = '"runId":"dreaming-narrative-';

export async function scrubDreamingNarrativeArtifacts(params: {
  agentId: string;
  config: OpenClawConfig;
  logger: { info: (message: string) => void };
  nowMs?: number;
}): Promise<void> {
  const result = await cleanupSessionLifecycleArtifacts({
    agentId: params.agentId,
    archiveRemovedEntryTranscripts: false,
    orphanTranscriptMinAgeMs: DREAMING_ORPHAN_MIN_AGE_MS,
    pluginOwnerId: "memory-core",
    sessionStore: params.config.session?.store,
    sessionKeySegmentPrefix: DREAMING_SESSION_KEY_PREFIX,
    transcriptContentMarker: DREAMING_TRANSCRIPT_RUN_MARKER,
    ...(params.nowMs === undefined ? {} : { nowMs: params.nowMs }),
  });
  const prunedEntries = result.removedEntries;
  const archivedOrphans = result.archivedTranscriptArtifacts;
  if (prunedEntries > 0 || archivedOrphans > 0) {
    params.logger.info(
      `memory-core: dreaming cleanup scrubbed ${prunedEntries} stale session entr${prunedEntries === 1 ? "y" : "ies"} and archived ${archivedOrphans} orphan transcript${archivedOrphans === 1 ? "" : "s"}.`,
    );
  }
}
