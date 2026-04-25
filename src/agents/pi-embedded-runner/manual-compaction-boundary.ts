import fs from "node:fs/promises";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { SessionManager } from "@mariozechner/pi-coding-agent";

type SessionManagerLike = ReturnType<typeof SessionManager.open>;
type SessionEntry = ReturnType<SessionManagerLike["getEntries"]>[number];
type SessionHeader = NonNullable<ReturnType<SessionManagerLike["getHeader"]>>;
type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;

export type HardenedManualCompactionBoundary = {
  applied: boolean;
  firstKeptEntryId?: string;
  leafId?: string;
  messages: AgentMessage[];
};

function serializeSessionFile(header: SessionHeader, entries: SessionEntry[]): string {
  return (
    [JSON.stringify(header), ...entries.map((entry) => JSON.stringify(entry))].join("\n") + "\n"
  );
}

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
  const sessionManager = SessionManager.open(params.sessionFile) as Partial<SessionManagerLike>;
  if (
    typeof sessionManager.getHeader !== "function" ||
    typeof sessionManager.getLeafEntry !== "function" ||
    typeof sessionManager.buildSessionContext !== "function" ||
    typeof sessionManager.getEntries !== "function"
  ) {
    return {
      applied: false,
      messages: [],
    };
  }

  const header = sessionManager.getHeader();
  const leaf = sessionManager.getLeafEntry();
  if (!header || leaf?.type !== "compaction") {
    const sessionContext = sessionManager.buildSessionContext();
    return {
      applied: false,
      leafId:
        typeof sessionManager.getLeafId === "function"
          ? (sessionManager.getLeafId() ?? undefined)
          : undefined,
      messages: sessionContext.messages,
    };
  }

  if (params.preserveRecentTail) {
    const sessionContext = sessionManager.buildSessionContext();
    return {
      applied: false,
      firstKeptEntryId: leaf.firstKeptEntryId,
      leafId:
        typeof sessionManager.getLeafId === "function"
          ? (sessionManager.getLeafId() ?? undefined)
          : undefined,
      messages: sessionContext.messages,
    };
  }

  if (leaf.firstKeptEntryId === leaf.id) {
    const sessionContext = sessionManager.buildSessionContext();
    return {
      applied: false,
      firstKeptEntryId: leaf.id,
      leafId:
        typeof sessionManager.getLeafId === "function"
          ? (sessionManager.getLeafId() ?? undefined)
          : undefined,
      messages: sessionContext.messages,
    };
  }

  const content = serializeSessionFile(
    header,
    replaceLatestCompactionBoundary({
      entries: sessionManager.getEntries(),
      compactionEntryId: leaf.id,
    }),
  );
  const tmpFile = `${params.sessionFile}.manual-compaction-tmp`;
  await fs.writeFile(tmpFile, content, "utf-8");
  await fs.rename(tmpFile, params.sessionFile);

  const refreshed = SessionManager.open(params.sessionFile);
  const sessionContext = refreshed.buildSessionContext();
  return {
    applied: true,
    firstKeptEntryId: leaf.id,
    leafId: refreshed.getLeafId() ?? undefined,
    messages: sessionContext.messages,
  };
}
