import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { SessionEntry } from "@mariozechner/pi-coding-agent";
import {
  readTranscriptFileState,
  TranscriptFileState,
  writeTranscriptFileAtomic,
} from "./transcript-file-state.js";

type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

export type HardenedManualCompactionBoundary = {
  applied: boolean;
  firstKeptEntryId?: string;
  leafId?: string;
  messages: AgentMessage[];
};

function replaceLatestCompactionBoundary(params: {
  entries: SessionEntry[];
  compactionEntryId: string;
}): SessionEntry[] {
  return params.entries.map((entry) => {
    if (entry.type !== "compaction" || entry.id !== params.compactionEntryId) {
      return entry;
    }
    return {
      ...entry,
      // Manual /compact is an explicit checkpoint request, so make the
      // rebuilt context start from the summary itself instead of preserving
      // an upstream "recent tail" that can keep large prior turns alive.
      firstKeptEntryId: entry.id,
    } satisfies CompactionEntry;
  });
}

export async function hardenManualCompactionBoundary(params: {
  sessionFile: string;
  preserveRecentTail?: boolean;
}): Promise<HardenedManualCompactionBoundary> {
  const state = await readTranscriptFileState(params.sessionFile);
  const header = state.getHeader();
  if (!header) {
    return {
      applied: false,
      messages: [],
    };
  }

  const leaf = state.getLeafEntry();
  if (leaf?.type !== "compaction") {
    const sessionContext = state.buildSessionContext();
    return {
      applied: false,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
    };
  }

  if (params.preserveRecentTail) {
    const sessionContext = state.buildSessionContext();
    return {
      applied: false,
      firstKeptEntryId: leaf.firstKeptEntryId,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
    };
  }

  if (leaf.firstKeptEntryId === leaf.id) {
    const sessionContext = state.buildSessionContext();
    return {
      applied: false,
      firstKeptEntryId: leaf.id,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
    };
  }

  const replacedEntries = replaceLatestCompactionBoundary({
    entries: state.getEntries(),
    compactionEntryId: leaf.id,
  });
  const replacedState = new TranscriptFileState({
    header,
    entries: replacedEntries,
  });
  await writeTranscriptFileAtomic(params.sessionFile, [header, ...replacedEntries]);

  const sessionContext = replacedState.buildSessionContext();
  return {
    applied: true,
    firstKeptEntryId: leaf.id,
    leafId: replacedState.getLeafId() ?? undefined,
    messages: sessionContext.messages,
  };
}
