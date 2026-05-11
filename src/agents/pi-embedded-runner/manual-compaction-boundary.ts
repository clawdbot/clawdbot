import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
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

function entryCreatesCompactionInputMessage(entry: SessionEntry): boolean {
  return (
    entry.type === "message" || entry.type === "custom_message" || entry.type === "branch_summary"
  );
}

function hasMessagesToSummarizeBeforeKeptTail(params: {
  branch: SessionEntry[];
  compaction: CompactionEntry;
}): boolean {
  const compactionIndex = params.branch.findIndex((entry) => entry.id === params.compaction.id);
  const firstKeptIndex = params.branch.findIndex(
    (entry) => entry.id === params.compaction.firstKeptEntryId,
  );
  if (compactionIndex <= 0 || firstKeptIndex < 0 || firstKeptIndex >= compactionIndex) {
    return false;
  }

  let boundaryStartIndex = 0;
  for (let i = compactionIndex - 1; i >= 0; i -= 1) {
    const entry = params.branch[i];
    if (entry?.type !== "compaction") {
      continue;
    }
    const previousFirstKeptIndex = params.branch.findIndex(
      (candidate) => candidate.id === entry.firstKeptEntryId,
    );
    boundaryStartIndex = previousFirstKeptIndex >= 0 ? previousFirstKeptIndex : i + 1;
    break;
  }

  return params.branch
    .slice(boundaryStartIndex, firstKeptIndex)
    .some((entry) => entryCreatesCompactionInputMessage(entry));
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

  const sessionContext = state.buildSessionContext();
  if (params.preserveRecentTail) {
    return {
      applied: false,
      firstKeptEntryId: leaf.firstKeptEntryId,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
    };
  }

  if (leaf.firstKeptEntryId === leaf.id) {
    return {
      applied: false,
      firstKeptEntryId: leaf.id,
      leafId: state.getLeafId() ?? undefined,
      messages: sessionContext.messages,
    };
  }

  if (
    !leaf.summary.trim() ||
    !hasMessagesToSummarizeBeforeKeptTail({
      branch: state.getBranch(leaf.id),
      compaction: leaf,
    })
  ) {
    return {
      applied: false,
      firstKeptEntryId: leaf.firstKeptEntryId,
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

  const replacedSessionContext = replacedState.buildSessionContext();
  return {
    applied: true,
    firstKeptEntryId: leaf.id,
    leafId: replacedState.getLeafId() ?? undefined,
    messages: replacedSessionContext.messages,
  };
}
