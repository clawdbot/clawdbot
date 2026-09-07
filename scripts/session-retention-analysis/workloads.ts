import { writeSessionEntry } from "../../src/config/sessions/session-accessor.sqlite-entry-store.js";
import {
  resolveSqliteStoreScope,
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../src/config/sessions/session-accessor.sqlite-scope.js";
import { replaceSqliteTranscriptEventsInTransaction } from "../../src/config/sessions/session-accessor.sqlite-transcript-store.js";
import type { SessionEntry } from "../../src/config/sessions/types.js";
import {
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../src/state/openclaw-agent-db.js";

export const RETENTION_FIXTURE_VERSION = "graph-retention-fixtures-v2";

export const WORKLOAD_NAMES = [
  "isolated-stale-bulk",
  "fork-fanout",
  "generation-chain",
  "spawn-tree",
  "mixed-disk-pressure",
] as const;

export type RetentionWorkloadName = (typeof WORKLOAD_NAMES)[number];

export type WorkloadFixtureSummary = {
  name: RetentionWorkloadName;
  requestedGroups: number;
  sessionEntriesCreated: number;
  transcriptEventsCreated: number;
  protectedSessionKeys: string[];
  activeSession: {
    sessionKey: string;
    sessionIds: string[];
  };
};

type FixtureWriter = {
  database: OpenClawAgentDatabase;
  storePath: string;
  workload: RetentionWorkloadName;
  sessionEntriesCreated: number;
  transcriptEventsCreated: number;
  protectedSessionKeys: Set<string>;
};

type GroupOptions = {
  index: number;
  contentBytes?: number;
  generations?: number;
  keySuffix?: string;
  parentSessionKey?: string;
  spawnedBy?: string;
  forkSource?: { sessionKey: string; sessionId: string };
  pinned?: boolean;
  recent?: boolean;
  usageFamilySessionIds?: string[];
};

const STALE_EPOCH_MS = Date.UTC(2023, 0, 1);
const RECENT_WINDOW_MS = 60_000;

function fixtureKey(writer: FixtureWriter, suffix: string): string {
  return `agent:main:retention-${writer.workload}-${suffix}`;
}

function fixtureSessionId(writer: FixtureWriter, suffix: string, generation: number): string {
  return `retention-${writer.workload}-${suffix}-g${generation}`;
}

function writeTranscript(params: {
  writer: FixtureWriter;
  sessionKey: string;
  sessionId: string;
  contentBytes: number;
  generation: number;
}): void {
  const payload = "x".repeat(Math.max(16, params.contentBytes));
  const events = [
    {
      type: "session",
      id: params.sessionId,
      content: `fixture generation ${params.generation}`,
    },
    {
      type: "message",
      id: `${params.sessionId}-user`,
      parentId: null,
      message: { role: "user", content: payload },
    },
    {
      type: "message",
      id: `${params.sessionId}-assistant`,
      parentId: `${params.sessionId}-user`,
      message: { role: "assistant", content: "fixture response" },
    },
  ];
  replaceSqliteTranscriptEventsInTransaction(
    params.writer.database,
    resolveSqliteTranscriptScope({
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      storePath: params.writer.storePath,
    }),
    events,
  );
  params.writer.transcriptEventsCreated += events.length;
}

function writeGroup(
  writer: FixtureWriter,
  options: GroupOptions,
): {
  sessionKey: string;
  currentSessionId: string;
  sessionIds: string[];
} {
  const suffix = options.keySuffix ?? String(options.index).padStart(6, "0");
  const sessionKey = fixtureKey(writer, suffix);
  const generations = Math.max(1, options.generations ?? 1);
  let previousSessionId: string | undefined;
  let currentSessionId = "";
  const sessionIds: string[] = [];
  for (let generation = 0; generation < generations; generation += 1) {
    const sessionId = fixtureSessionId(writer, suffix, generation);
    const staleUpdatedAt = STALE_EPOCH_MS + options.index * 10_000 + generation;
    const updatedAt = options.recent ? Date.now() - RECENT_WINDOW_MS : staleUpdatedAt;
    const entry: SessionEntry = {
      sessionId,
      ...(previousSessionId ? { previousSessionId } : {}),
      updatedAt,
      lastActivityAt: updatedAt - (options.index % 7) * 1_000,
      ...(options.index % 3 === 0 ? {} : { lastInteractionAt: updatedAt - 500 }),
      ...(options.index % 4 === 0 ? {} : { lastReadAt: updatedAt - 250 }),
      ...(options.parentSessionKey ? { parentSessionKey: options.parentSessionKey } : {}),
      ...(options.spawnedBy ? { spawnedBy: options.spawnedBy } : {}),
      ...(options.forkSource ? { forkSource: options.forkSource } : {}),
      ...(options.pinned ? { pinnedAt: updatedAt } : {}),
      ...(options.usageFamilySessionIds
        ? { usageFamilySessionIds: options.usageFamilySessionIds }
        : {}),
    };
    writeSessionEntry(writer.database, sessionKey, entry);
    writeTranscript({
      writer,
      sessionKey,
      sessionId,
      contentBytes: (options.contentBytes ?? 128) + generation * 16,
      generation,
    });
    previousSessionId = sessionId;
    currentSessionId = sessionId;
    sessionIds.push(sessionId);
  }
  writer.sessionEntriesCreated += 1;
  if (options.pinned || options.recent) {
    writer.protectedSessionKeys.add(sessionKey);
  }
  return { sessionKey, currentSessionId, sessionIds };
}

function populateIsolated(writer: FixtureWriter, groupCount: number): void {
  for (let index = 0; index < groupCount; index += 1) {
    writeGroup(writer, {
      index,
      contentBytes: 64 + (index % 9) * 96,
    });
  }
}

function populateForkFanout(writer: FixtureWriter, groupCount: number): void {
  let index = 0;
  while (index < groupCount) {
    const root = writeGroup(writer, {
      index,
      keySuffix: `root-${String(index).padStart(6, "0")}`,
      contentBytes: 192,
    });
    index += 1;
    for (let child = 0; child < 4 && index < groupCount; child += 1) {
      writeGroup(writer, {
        index,
        keySuffix: `fork-${String(index).padStart(6, "0")}`,
        parentSessionKey: root.sessionKey,
        forkSource: {
          sessionKey: root.sessionKey,
          sessionId: root.currentSessionId,
        },
        contentBytes: 96 + child * 32,
      });
      index += 1;
    }
    for (let isolated = 0; isolated < 5 && index < groupCount; isolated += 1) {
      writeGroup(writer, {
        index,
        keySuffix: `isolated-${String(index).padStart(6, "0")}`,
        contentBytes: 256 + isolated * 64,
      });
      index += 1;
    }
  }
}

function populateGenerationChain(writer: FixtureWriter, groupCount: number): void {
  for (let index = 0; index < groupCount; index += 1) {
    writeGroup(writer, {
      index,
      generations: index % 4 === 0 ? 4 : index % 4 === 1 ? 2 : 1,
      contentBytes: 96 + (index % 5) * 40,
    });
  }
  writeGroup(writer, {
    index: groupCount,
    keySuffix: "protected-current-chain",
    generations: 3,
    recent: true,
    contentBytes: 128,
  });
}

function populateSpawnTree(writer: FixtureWriter, groupCount: number): void {
  let index = 0;
  while (index < groupCount) {
    const root = writeGroup(writer, {
      index,
      keySuffix: `spawn-root-${String(index).padStart(6, "0")}`,
      contentBytes: 144,
    });
    index += 1;
    const children: Array<{ sessionKey: string; currentSessionId: string }> = [];
    for (let child = 0; child < 3 && index < groupCount; child += 1) {
      children.push(
        writeGroup(writer, {
          index,
          keySuffix: `spawn-child-${String(index).padStart(6, "0")}`,
          parentSessionKey: root.sessionKey,
          spawnedBy: root.sessionKey,
          contentBytes: 112,
        }),
      );
      index += 1;
    }
    for (const child of children) {
      if (index >= groupCount) {
        break;
      }
      writeGroup(writer, {
        index,
        keySuffix: `spawn-grandchild-${String(index).padStart(6, "0")}`,
        parentSessionKey: child.sessionKey,
        spawnedBy: child.sessionKey,
        contentBytes: 80,
      });
      index += 1;
    }
    while (index < groupCount && index % 8 !== 0) {
      writeGroup(writer, {
        index,
        keySuffix: `spawn-isolated-${String(index).padStart(6, "0")}`,
        contentBytes: 224,
      });
      index += 1;
    }
  }
}

function populateMixedPressure(writer: FixtureWriter, groupCount: number): void {
  let previousConnected: { sessionKey: string; currentSessionId: string } | undefined;
  for (let index = 0; index < groupCount; index += 1) {
    const category = index % 10;
    if (category === 0) {
      previousConnected = writeGroup(writer, {
        index,
        keySuffix: `mixed-root-${String(index).padStart(6, "0")}`,
        contentBytes: 72,
      });
      continue;
    }
    if ((category === 1 || category === 2) && previousConnected) {
      writeGroup(writer, {
        index,
        keySuffix: `mixed-connected-${String(index).padStart(6, "0")}`,
        parentSessionKey: previousConnected.sessionKey,
        spawnedBy: previousConnected.sessionKey,
        forkSource: {
          sessionKey: previousConnected.sessionKey,
          sessionId: previousConnected.currentSessionId,
        },
        contentBytes: 64,
      });
      continue;
    }
    if (category === 3) {
      writeGroup(writer, { index, contentBytes: 2_048 });
      continue;
    }
    if (category === 4) {
      writeGroup(writer, { index, recent: true, contentBytes: 192 });
      continue;
    }
    if (category === 5) {
      writeGroup(writer, { index, pinned: true, contentBytes: 192 });
      continue;
    }
    if (category === 6) {
      writeGroup(writer, { index, generations: 3, contentBytes: 128 });
      continue;
    }
    if (category === 7 && index + 1 < groupCount) {
      const sharedSessionId = fixtureSessionId(writer, `shared-${index}`, 0);
      writeGroup(writer, {
        index,
        keySuffix: `shared-a-${String(index).padStart(6, "0")}`,
        usageFamilySessionIds: [sharedSessionId],
        contentBytes: 160,
      });
      writeGroup(writer, {
        index: index + 1,
        keySuffix: `shared-b-${String(index + 1).padStart(6, "0")}`,
        usageFamilySessionIds: [sharedSessionId],
        contentBytes: 160,
      });
      replaceSqliteTranscriptEventsInTransaction(
        writer.database,
        resolveSqliteTranscriptScope({
          sessionKey: fixtureKey(writer, `shared-a-${String(index).padStart(6, "0")}`),
          sessionId: sharedSessionId,
          storePath: writer.storePath,
        }),
        [{ type: "session", id: sharedSessionId, content: "shared ownership fixture" }],
      );
      writer.transcriptEventsCreated += 1;
      index += 1;
      continue;
    }
    writeGroup(writer, { index, contentBytes: 320 + category * 32 });
  }
}

function writeActiveSession(
  writer: FixtureWriter,
  index: number,
): {
  sessionKey: string;
  sessionIds: string[];
} {
  const activeSession = writeGroup(writer, {
    index,
    keySuffix: "protected-active-session",
    contentBytes: 128,
  });
  writer.protectedSessionKeys.add(activeSession.sessionKey);
  return {
    sessionKey: activeSession.sessionKey,
    sessionIds: activeSession.sessionIds,
  };
}

export function populateRetentionWorkload(params: {
  storePath: string;
  workload: RetentionWorkloadName;
  groupCount: number;
}): WorkloadFixtureSummary {
  const groupCount = Math.max(1, Math.floor(params.groupCount));
  const resolved = resolveSqliteStoreScope(params.storePath, { agentId: "main" });
  let summary: WorkloadFixtureSummary | undefined;
  runOpenClawAgentWriteTransaction((database) => {
    const writer: FixtureWriter = {
      database,
      storePath: params.storePath,
      workload: params.workload,
      sessionEntriesCreated: 0,
      transcriptEventsCreated: 0,
      protectedSessionKeys: new Set(),
    };
    if (params.workload === "isolated-stale-bulk") {
      populateIsolated(writer, groupCount);
    } else if (params.workload === "fork-fanout") {
      populateForkFanout(writer, groupCount);
    } else if (params.workload === "generation-chain") {
      populateGenerationChain(writer, groupCount);
    } else if (params.workload === "spawn-tree") {
      populateSpawnTree(writer, groupCount);
    } else {
      populateMixedPressure(writer, groupCount);
    }
    const activeSession = writeActiveSession(writer, groupCount + 1);
    summary = {
      name: params.workload,
      requestedGroups: groupCount,
      sessionEntriesCreated: writer.sessionEntriesCreated,
      transcriptEventsCreated: writer.transcriptEventsCreated,
      protectedSessionKeys: [...writer.protectedSessionKeys].toSorted((left, right) =>
        left.localeCompare(right),
      ),
      activeSession,
    };
  }, toDatabaseOptions(resolved));
  if (!summary) {
    throw new Error("Retention workload transaction did not produce a summary");
  }
  return summary;
}
