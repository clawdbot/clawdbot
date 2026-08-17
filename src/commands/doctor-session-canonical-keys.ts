import fs from "node:fs";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  copySessionOwnedStateForCanonicalRepair,
  ensureTranscriptGenerationsForCanonicalRepair,
  listSessionGenerationIdsForCanonicalRepair,
  loadTranscriptEvents,
  rehomeSessionDeliveryReferencesForCanonicalRepair,
  rehomeSessionDeliveryReferencesForCanonicalRepairBatch,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { writeTranscriptArchive } from "../config/sessions/session-accessor.sqlite-archive.js";
import { listSqliteSessionEntriesWithCanonicalOwnerEvidence } from "../config/sessions/session-accessor.sqlite-canonical-inventory.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionMembersForRepair,
} from "../config/sessions/session-accessor.sqlite-node-artifacts.js";
import { collectSessionStateIdsForEntry } from "../config/sessions/session-accessor.sqlite-references.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "../config/sessions/store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import { serializeJsonlLines } from "../config/sessions/transcript-jsonl.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../gateway/session-store-key.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { applyCanonicalOwnerEvidence } from "./doctor-session-canonical-owner-evidence.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

type CanonicalSessionCandidate = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  expectedEntry: SessionEntry;
  lineageRepairRequired: boolean;
  ownerEvidenceOnly: boolean;
  rawEntryJson?: string;
  sessionKey: string;
  sqlitePath: string;
  storePath: string;
};

function createCanonicalRepairRemoval(
  candidate: CanonicalSessionCandidate,
  params: {
    archiveRemovedTranscript: boolean;
    deleteOwnedWindows: boolean;
    deliveryCleanupKeys?: readonly string[];
  },
): SessionEntryLifecycleRemoval {
  const removal = {
    archiveRemovedTranscript: params.archiveRemovedTranscript,
    deleteOwnedWindows: params.deleteOwnedWindows,
    ...(params.deliveryCleanupKeys ? { deliveryCleanupKeys: params.deliveryCleanupKeys } : {}),
    exactStoredKey: true,
    expectedEntry: candidate.expectedEntry,
    sessionKey: candidate.sessionKey,
  } satisfies SessionEntryLifecycleRemoval;
  return candidate.rawEntryJson === undefined
    ? removal
    : Object.assign(removal, { expectedRawEntryJson: candidate.rawEntryJson });
}

export type CanonicalSessionKeyRepairReport = {
  archivedTranscriptDirectories: string[];
  foundGroups: number;
  repairBatches: number;
  removedRows: number;
  repairedGroups: number;
  scannedStores: number;
};

type CanonicalSessionRepairGroup = {
  candidates: CanonicalSessionCandidate[];
  removedRows: number;
};

const CANONICAL_SESSION_REPAIR_BATCH_GROUP_LIMIT = 64;

type CanonicalSessionStore = {
  agentId: string;
  sqlitePath: string;
  storePath: string;
};

function listCanonicalSessionStores(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): CanonicalSessionStore[] {
  const stores: CanonicalSessionStore[] = [];
  const seenDatabases = new Set<string>();
  for (const target of resolveAllAgentSessionStoreTargetsSync(params.cfg, { env: params.env })) {
    const sqlitePath = resolveTargetSqlitePath(target);
    if (seenDatabases.has(sqlitePath) || !fs.existsSync(sqlitePath)) {
      continue;
    }
    seenDatabases.add(sqlitePath);
    stores.push({ agentId: target.agentId, sqlitePath, storePath: target.storePath });
  }
  return stores;
}

function collectCanonicalSessionCandidates(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  stores: readonly CanonicalSessionStore[],
): CanonicalSessionCandidate[] {
  const inventory = stores.flatMap((target) =>
    listSqliteSessionEntriesWithCanonicalOwnerEvidence({
      agentId: target.agentId,
      clone: false,
      storePath: target.storePath,
    }).map(({ canonicalOwnerSessionKey, entry, rawEntryJson, sessionKey }) => {
      const storedKey = resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId: target.agentId,
        sessionKey,
      });
      return {
        canonicalKey: storedKey
          ? resolveDeliveryProvenCanonicalSessionKey(storedKey, entry)
          : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: target.agentId }),
        entry,
        canonicalOwnerSessionKey,
        rawEntryJson,
        sessionKey,
        storedKey,
        target,
      };
    }),
  );
  const canonicalKeysByStoredKey = applyCanonicalOwnerEvidence(inventory);
  return inventory.map(
    ({ canonicalKey, canonicalOwnerSessionKey, entry, rawEntryJson, sessionKey, target }) => {
      const canonicalAgentId =
        canonicalKey === "global" || canonicalKey === "unknown"
          ? target.agentId
          : resolveSessionStoreAgentId(params.cfg, canonicalKey);
      const canonicalizeLineageKey = (value: string | undefined) => {
        if (!value) {
          return undefined;
        }
        const storedKey = resolveStoredSessionKeyForAgentStore({
          cfg: params.cfg,
          agentId: canonicalAgentId,
          sessionKey: value,
        });
        const ownerAgentId = parseAgentSessionKey(storedKey)?.agentId ?? canonicalAgentId;
        for (const key of [value, storedKey]) {
          const sameStore = canonicalKeysByStoredKey.get(
            `${target.sqlitePath}\0${ownerAgentId}\0${key}`,
          );
          if (sameStore?.size === 1) {
            return [...sameStore][0];
          }
        }
        for (const key of [value, storedKey]) {
          const crossStore = canonicalKeysByStoredKey.get(`*\0${ownerAgentId}\0${key}`);
          if (crossStore?.size === 1) {
            return [...crossStore][0];
          }
        }
        return storedKey;
      };
      const parentSessionKey = canonicalizeLineageKey(entry.parentSessionKey);
      const spawnedBy = canonicalizeLineageKey(entry.spawnedBy);
      const forkSourceSessionKey = canonicalizeLineageKey(entry.forkSource?.sessionKey);
      const normalizedEntry = { ...entry };
      if (parentSessionKey) {
        normalizedEntry.parentSessionKey = parentSessionKey;
      } else {
        delete normalizedEntry.parentSessionKey;
      }
      if (spawnedBy) {
        normalizedEntry.spawnedBy = spawnedBy;
      } else {
        delete normalizedEntry.spawnedBy;
      }
      if (entry.forkSource && forkSourceSessionKey) {
        normalizedEntry.forkSource = {
          ...entry.forkSource,
          sessionKey: forkSourceSessionKey,
        };
      } else if (entry.forkSource && entry.forkSource.sessionKey !== undefined) {
        // A present but empty-normalized key cannot survive strict runtime validation. Missing
        // legacy keys remain untouched so unrelated repair does not erase independent provenance.
        const { sessionKey: _invalidSessionKey, ...forkProvenance } = entry.forkSource;
        normalizedEntry.forkSource = forkProvenance as typeof entry.forkSource;
      }
      const lineageRepairRequired =
        parentSessionKey !== (entry.parentSessionKey ?? undefined) ||
        spawnedBy !== (entry.spawnedBy ?? undefined) ||
        forkSourceSessionKey !== (entry.forkSource?.sessionKey ?? undefined);
      const candidate: CanonicalSessionCandidate = {
        agentId: target.agentId,
        canonicalKey,
        entry: normalizedEntry,
        expectedEntry: entry,
        lineageRepairRequired,
        ownerEvidenceOnly: canonicalOwnerSessionKey !== undefined,
        sessionKey,
        sqlitePath: target.sqlitePath,
        storePath: target.storePath,
      };
      if (rawEntryJson !== undefined) {
        candidate.rawEntryJson = rawEntryJson;
      }
      return candidate;
    },
  );
}

function resolveCanonicalDestination(params: {
  canonicalKey: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  sourceAgentId?: string;
}) {
  const agentId =
    params.canonicalKey === "global" || params.canonicalKey === "unknown"
      ? normalizeAgentId(
          params.sourceAgentId ?? resolveSessionStoreAgentId(params.cfg, params.canonicalKey),
        )
      : resolveSessionStoreAgentId(params.cfg, params.canonicalKey);
  const storePath = resolveSessionStorePathCore(params.cfg.session?.store, {
    agentId,
    env: params.env,
  });
  return {
    agentId,
    storePath,
    sqlitePath: resolveTargetSqlitePath({ agentId, storePath }),
  };
}

function mergeCanonicalSessionEntryCandidates<T>(
  candidates: readonly { entry: SessionEntry; preferred?: boolean; value: T }[],
): { entry: SessionEntry; winner: T } | undefined {
  let selected: { entry: SessionEntry; preferred: boolean; winner: T } | undefined;
  for (const candidate of candidates) {
    const incomingUpdatedAt =
      typeof candidate.entry.updatedAt === "number" && Number.isFinite(candidate.entry.updatedAt)
        ? candidate.entry.updatedAt
        : 0;
    const selectedUpdatedAt =
      typeof selected?.entry.updatedAt === "number" && Number.isFinite(selected.entry.updatedAt)
        ? selected.entry.updatedAt
        : 0;
    if (
      !selected ||
      incomingUpdatedAt > selectedUpdatedAt ||
      (incomingUpdatedAt === selectedUpdatedAt &&
        (candidate.preferred === true
          ? !selected.preferred
          : !selected.preferred &&
            Buffer.compare(
              Buffer.from(JSON.stringify(candidate.entry), "utf8"),
              Buffer.from(JSON.stringify(selected.entry), "utf8"),
            ) > 0))
    ) {
      selected = {
        entry: structuredClone(candidate.entry),
        preferred: candidate.preferred === true,
        winner: candidate.value,
      };
    }
  }
  return selected;
}

function selectCanonicalSessionCandidate(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
) {
  const first = candidates[0];
  if (!first) {
    return undefined;
  }
  const destination = resolveCanonicalDestination({
    canonicalKey: first.canonicalKey,
    cfg: params.cfg,
    env: params.env,
    sourceAgentId: first.agentId,
  });
  const metadataCandidates = candidates.filter((candidate) => !candidate.ownerEvidenceOnly);
  const selected = mergeCanonicalSessionEntryCandidates(
    (metadataCandidates.length > 0 ? metadataCandidates : candidates)
      .toSorted((left, right) =>
        Buffer.compare(
          Buffer.from(`${left.sqlitePath}\0${left.sessionKey}`, "utf8"),
          Buffer.from(`${right.sqlitePath}\0${right.sessionKey}`, "utf8"),
        ),
      )
      .map((candidate) => ({
        entry: candidate.entry,
        preferred:
          candidate.sqlitePath === destination.sqlitePath &&
          candidate.sessionKey === candidate.canonicalKey,
        value: candidate,
      })),
  );
  return selected ? { ...selected, destination } : undefined;
}

function groupRepairCandidates(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): CanonicalSessionRepairGroup[] {
  const byCanonicalKey = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const sentinelOwner =
      candidate.canonicalKey === "global" || candidate.canonicalKey === "unknown"
        ? candidate.agentId
        : "";
    const groupKey = `${candidate.canonicalKey}\0${sentinelOwner}`;
    const group = byCanonicalKey.get(groupKey) ?? [];
    group.push(candidate);
    byCanonicalKey.set(groupKey, group);
  }
  return [...byCanonicalKey.values()].flatMap((group) => {
    const first = group[0];
    if (!first) {
      return [];
    }
    const destination = resolveCanonicalDestination({
      canonicalKey: first.canonicalKey,
      cfg: params.cfg,
      env: params.env,
      sourceAgentId: first.agentId,
    });
    const repairRequired =
      group.length > 1 ||
      group.some(
        (candidate) =>
          candidate.rawEntryJson !== undefined ||
          candidate.lineageRepairRequired ||
          candidate.sessionKey !== candidate.canonicalKey ||
          candidate.sqlitePath !== destination.sqlitePath,
      );
    if (!repairRequired) {
      return [];
    }
    const canonicalRowSurvives = group.some(
      (candidate) =>
        candidate.sqlitePath === destination.sqlitePath &&
        candidate.sessionKey === candidate.canonicalKey,
    );
    return [{ candidates: group, removedRows: group.length - (canonicalRowSurvives ? 1 : 0) }];
  });
}

type SingleDatabaseCanonicalRepairGroup = {
  candidates: readonly CanonicalSessionCandidate[];
  selected: NonNullable<ReturnType<typeof selectCanonicalSessionCandidate>>;
};

function resolveSingleDatabaseCanonicalRepairGroup(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): SingleDatabaseCanonicalRepairGroup | undefined {
  const selected = selectCanonicalSessionCandidate(candidates, params);
  if (
    !selected ||
    selected.winner.sqlitePath !== selected.destination.sqlitePath ||
    candidates.some((candidate) => candidate.sqlitePath !== selected.destination.sqlitePath)
  ) {
    return undefined;
  }
  return { candidates, selected };
}

function createCanonicalDestinationRemovals(
  candidates: readonly CanonicalSessionCandidate[],
  selected: NonNullable<ReturnType<typeof selectCanonicalSessionCandidate>>,
): SessionEntryLifecycleRemoval[] {
  const relatedSessionIds = new Set(
    [selected.entry.sessionId, selected.entry.previousSessionId].filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    ),
  );
  return candidates
    .filter(
      (candidate) =>
        candidate.sessionKey !== selected.winner.canonicalKey ||
        candidate.rawEntryJson !== undefined,
    )
    .map((candidate) =>
      createCanonicalRepairRemoval(candidate, {
        archiveRemovedTranscript: !relatedSessionIds.has(candidate.entry.sessionId),
        deleteOwnedWindows: false,
      }),
    );
}

function listCanonicalDestinationAliasKeys(
  destinationStore: readonly CanonicalSessionCandidate[],
  winner: CanonicalSessionCandidate,
): string[] {
  return destinationStore
    .map((candidate) => candidate.sessionKey)
    .filter((sessionKey) => sessionKey !== winner.canonicalKey);
}

function applyCanonicalDestinationArtifacts(params: {
  copyWinnerAlias: boolean;
  database: OpenClawAgentDatabase;
  destinationStore: readonly CanonicalSessionCandidate[];
  rehomeDeliveries: boolean;
  winner: CanonicalSessionCandidate;
}): void {
  const destinationAliasKeys = listCanonicalDestinationAliasKeys(
    params.destinationStore,
    params.winner,
  );
  if (destinationAliasKeys.length > 0) {
    if (params.rehomeDeliveries) {
      rehomeSessionDeliveryReferencesForCanonicalRepair(
        params.database,
        params.winner.canonicalKey,
        destinationAliasKeys,
      );
    }
    copySessionNodeArtifactsForRepair(
      params.database,
      params.database,
      destinationAliasKeys,
      params.winner.canonicalKey,
      { includeMembers: false },
    );
  }
  if (!params.copyWinnerAlias || params.winner.sessionKey === params.winner.canonicalKey) {
    return;
  }
  deleteSessionMembersForRepair(params.database, params.winner.canonicalKey);
  copySessionNodeArtifactsForRepair(
    params.database,
    params.database,
    [params.winner.sessionKey],
    params.winner.canonicalKey,
  );
}

async function repairCanonicalSessionGroupsInSingleDatabase(
  groups: readonly SingleDatabaseCanonicalRepairGroup[],
): Promise<string[]> {
  const first = groups[0];
  if (!first) {
    return [];
  }
  await ensureTranscriptGenerationsForCanonicalRepair(groups.flatMap((group) => group.candidates));
  const destination = first.selected.destination;
  const result = await applySessionEntryLifecycleMutation({
    agentId: destination.agentId,
    allowCanonicalRepair: true,
    afterUpsertsInTransaction: (database) => {
      rehomeSessionDeliveryReferencesForCanonicalRepairBatch(
        database,
        groups.map((group) => ({
          canonicalKey: group.selected.winner.canonicalKey,
          previousKeys: listCanonicalDestinationAliasKeys(group.candidates, group.selected.winner),
        })),
      );
      for (const group of groups) {
        applyCanonicalDestinationArtifacts({
          copyWinnerAlias: true,
          database,
          destinationStore: group.candidates,
          rehomeDeliveries: false,
          winner: group.selected.winner,
        });
      }
    },
    removals: groups.flatMap((group) =>
      createCanonicalDestinationRemovals(group.candidates, group.selected),
    ),
    skipMaintenance: true,
    storePath: destination.storePath,
    upserts: groups.map((group) => ({
      entry: group.selected.entry,
      sessionKey: group.selected.winner.canonicalKey,
    })),
  });
  return result.archivedTranscriptDirectories;
}

async function repairCanonicalSessionGroup(
  candidates: readonly CanonicalSessionCandidate[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): Promise<string[]> {
  const selected = selectCanonicalSessionCandidate(candidates, params);
  if (!selected) {
    return [];
  }
  await ensureTranscriptGenerationsForCanonicalRepair(candidates);
  const winner = selected.winner;
  const destination = selected.destination;
  const byDatabase = new Map<string, CanonicalSessionCandidate[]>();
  for (const candidate of candidates) {
    const group = byDatabase.get(candidate.sqlitePath) ?? [];
    group.push(candidate);
    byDatabase.set(candidate.sqlitePath, group);
  }

  const destinationStore = byDatabase.get(destination.sqlitePath) ?? [];
  const preArchivedDirectories: string[] = [];
  if (winner.sqlitePath !== destination.sqlitePath) {
    const generationIds = new Set([
      ...listSessionGenerationIdsForCanonicalRepair({
        agentId: winner.agentId,
        canonicalKey: winner.canonicalKey,
        sourceKeys: [winner.sessionKey],
        storePath: winner.storePath,
      }),
      ...collectSessionStateIdsForEntry(winner.entry),
    ]);
    for (const sessionId of generationIds) {
      if (!sessionId) {
        continue;
      }
      const destinationCollision = destinationStore.find(
        (candidate) => candidate.entry.sessionId === sessionId,
      );
      const [destinationEvents, sourceEvents] = await Promise.all([
        loadTranscriptEvents({
          agentId: destinationCollision?.agentId ?? destination.agentId,
          sessionId,
          sessionKey: destinationCollision?.sessionKey ?? winner.canonicalKey,
          storePath: destinationCollision?.storePath ?? destination.storePath,
        }),
        loadTranscriptEvents({
          agentId: winner.agentId,
          sessionId,
          sessionKey: winner.sessionKey,
          storePath: winner.storePath,
        }),
      ]);
      const destinationContent = serializeJsonlLines(
        destinationEvents.map((event) => JSON.stringify(event)),
      );
      const sourceContent = serializeJsonlLines(sourceEvents.map((event) => JSON.stringify(event)));
      if (!destinationContent || destinationContent === sourceContent) {
        continue;
      }
      const archiveDirectory = resolveSqliteTranscriptArchiveDirectory({
        agentId: destination.agentId,
        env: params.env,
        path: destination.sqlitePath,
      });
      writeTranscriptArchive({
        archiveDirectory,
        content: destinationContent,
        reason: "deleted",
        sessionId,
      });
      if (!preArchivedDirectories.includes(archiveDirectory)) {
        preArchivedDirectories.push(archiveDirectory);
      }
    }
  }
  setCanonicalSqliteSessionMainKey(
    openOpenClawAgentDatabase({ agentId: destination.agentId, path: destination.sqlitePath }),
    params.cfg.session?.mainKey,
  );
  const winnerResult = await applySessionEntryLifecycleMutation({
    agentId: destination.agentId,
    allowCanonicalRepair: true,
    afterUpsertsInTransaction: (destinationDatabase) => {
      applyCanonicalDestinationArtifacts({
        copyWinnerAlias: winner.sqlitePath === destination.sqlitePath,
        database: destinationDatabase,
        destinationStore,
        rehomeDeliveries: true,
        winner,
      });
      if (winner.sqlitePath !== destination.sqlitePath) {
        copySessionOwnedStateForCanonicalRepair({
          canonicalKey: winner.canonicalKey,
          destinationDatabase,
          preferredEntry: selected.entry,
          preferredSessionKey: winner.sessionKey,
          source: winner,
          sourceEntries: [winner.entry],
          sourceKeys: [winner.sessionKey],
        });
      }
    },
    removals: createCanonicalDestinationRemovals(destinationStore, selected),
    skipMaintenance: true,
    storePath: destination.storePath,
    upserts: [{ entry: selected.entry, sessionKey: winner.canonicalKey }],
  });
  const archivedDirectories = new Set([
    ...preArchivedDirectories,
    ...winnerResult.archivedTranscriptDirectories,
  ]);

  for (const [sqlitePath, storeCandidates] of byDatabase) {
    if (sqlitePath === destination.sqlitePath) {
      continue;
    }
    const [storeCandidate] = storeCandidates;
    if (!storeCandidate) {
      continue;
    }
    const result = await applySessionEntryLifecycleMutation({
      agentId: storeCandidate.agentId,
      allowCanonicalRepair: true,
      removals: storeCandidates.map((candidate) =>
        createCanonicalRepairRemoval(candidate, {
          archiveRemovedTranscript: true,
          deleteOwnedWindows: true,
          deliveryCleanupKeys: [winner.canonicalKey],
        }),
      ),
      skipMaintenance: true,
      storePath: storeCandidate.storePath,
    });
    // Only the selected winner is copied. Stale loser data survives solely in its
    // verified archive, avoiding an ambiguous cross-store merge contract.
    for (const directory of result.archivedTranscriptDirectories) {
      archivedDirectories.add(directory);
    }
  }
  return [...archivedDirectories];
}

/** Doctor-owned durable repair; process-held incognito databases are intentionally excluded. */
export async function repairCanonicalSessionKeys(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<CanonicalSessionKeyRepairReport> {
  const env = params.env ?? process.env;
  const stores = listCanonicalSessionStores({
    cfg: params.cfg,
    env,
  });
  const archivedTranscriptDirectories = new Set<string>();
  let repairBatches = 0;
  let repairedGroups = 0;
  if (params.apply) {
    for (const store of stores) {
      setCanonicalSqliteSessionMainKey(
        openOpenClawAgentDatabase({ agentId: store.agentId, path: store.sqlitePath }),
        params.cfg.session?.mainKey,
      );
    }
  }
  const candidates = collectCanonicalSessionCandidates({ cfg: params.cfg, env }, stores);
  const repairGroups = groupRepairCandidates(candidates, { cfg: params.cfg, env });
  if (params.apply) {
    let index = 0;
    while (index < repairGroups.length) {
      const group = repairGroups[index];
      if (!group) {
        break;
      }
      const singleDatabaseGroup = resolveSingleDatabaseCanonicalRepairGroup(group.candidates, {
        cfg: params.cfg,
        env,
      });
      if (!singleDatabaseGroup) {
        for (const directory of await repairCanonicalSessionGroup(group.candidates, {
          cfg: params.cfg,
          env,
        })) {
          archivedTranscriptDirectories.add(directory);
        }
        index += 1;
        repairBatches += 1;
        repairedGroups += 1;
        continue;
      }
      const batch = [singleDatabaseGroup];
      index += 1;
      // Keep commits bounded and preserve the original order around cross-store moves, while
      // collapsing the repeated whole-store projections for the common same-database path.
      while (
        index < repairGroups.length &&
        batch.length < CANONICAL_SESSION_REPAIR_BATCH_GROUP_LIMIT
      ) {
        const nextGroup = repairGroups[index];
        if (!nextGroup) {
          break;
        }
        const nextSingleDatabaseGroup = resolveSingleDatabaseCanonicalRepairGroup(
          nextGroup.candidates,
          { cfg: params.cfg, env },
        );
        if (
          !nextSingleDatabaseGroup ||
          nextSingleDatabaseGroup.selected.destination.sqlitePath !==
            singleDatabaseGroup.selected.destination.sqlitePath
        ) {
          break;
        }
        batch.push(nextSingleDatabaseGroup);
        index += 1;
      }
      for (const directory of await repairCanonicalSessionGroupsInSingleDatabase(batch)) {
        archivedTranscriptDirectories.add(directory);
      }
      repairBatches += 1;
      repairedGroups += batch.length;
    }
  }
  return {
    archivedTranscriptDirectories: [...archivedTranscriptDirectories].toSorted(),
    foundGroups: repairGroups.length,
    repairBatches,
    removedRows: repairGroups.reduce((total, group) => total + group.removedRows, 0),
    repairedGroups,
    scannedStores: stores.length,
  };
}
