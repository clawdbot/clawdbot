import type { MemorySessionTarget } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";

export type MemoryForgetReport = {
  agentId: string;
  dryRun: boolean;
  sessionIds: string[];
  participantMatches: Array<{ actorId: string; identities: MemorySessionTarget["participants"] }>;
  sessionResolutions: Array<{
    sessionId: string;
    sessionKey?: string;
    source: "live" | "archived" | "unresolved";
  }>;
  entryKeys: string[];
  mixedLineageEntryKeys: string[];
  untargetableEntryKeys: string[];
  curatedWrites: Array<{ relativePath: string; observedAt: number }>;
  artifacts: {
    memoryFiles: number;
    memoryEntries: number;
    memoryLines: number;
    sessionCorpusFiles: number;
    sessionCorpusLines: number;
    indexChunks: number;
    indexSources: number;
    ftsRows: number;
    vectorRows: number;
    embeddingCacheRows: number;
    shortTermEntries: number;
    seenHashScopes: number;
    backups: number;
    originRows: number;
  };
  refusals: string[];
};

export function summarizeParticipantMatches(
  targets: MemorySessionTarget[],
  participants?: string[],
): MemoryForgetReport["participantMatches"] {
  return [...new Set(participants ?? [])].toSorted().map((actorId) => ({
    actorId,
    identities: [
      ...new Map(
        targets.flatMap((target) =>
          target.participants
            .filter((identity) => identity.id === actorId)
            .map((identity) => [JSON.stringify(identity), identity] as const),
        ),
      ).values(),
    ],
  }));
}
