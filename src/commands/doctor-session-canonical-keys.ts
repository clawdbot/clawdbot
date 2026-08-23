import {
  applySessionEntryLifecycleMutation,
  copySessionOwnedStateForCanonicalRepair,
  ensureTranscriptGenerationsForCanonicalRepair,
  listSessionGenerationIdsForCanonicalRepair,
  loadCanonicalSessionRepairEntries,
  loadTranscriptEvents,
  rehomeSessionDeliveryReferencesForCanonicalRepair,
  rehomeSessionDeliveryReferencesForCanonicalRepairBatch,
  type SessionEntryLifecycleRemoval,
} from "../config/sessions/session-accessor.js";
import { writeTranscriptArchive } from "../config/sessions/session-accessor.sqlite-archive.js";
import {
  copySessionNodeArtifactsForRepair,
  deleteSessionMembersForRepair,
} from "../config/sessions/session-accessor.sqlite-node-artifacts.js";
import { replaceSessionOwnerInTransaction } from "../config/sessions/session-accessor.sqlite-owner.js";
import { collectSessionStateIdsForEntry } from "../config/sessions/session-accessor.sqlite-references.js";
import { resolveSqliteTranscriptArchiveDirectory } from "../config/sessions/session-accessor.sqlite-scope.js";
import { setCanonicalSqliteSessionMainKey } from "../config/sessions/session-canonical-key.js";
import { serializeJsonlLines } from "../config/sessions/transcript-jsonl.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import {
  collectCanonicalSessionRepairGroups,
  listCanonicalSessionStores,
  resolveCanonicalSessionDestination,
  type CanonicalSessionCandidate,
  type CanonicalSessionCandidateFact,
} from "./doctor-session-canonical-candidates.js";

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

const CANONICAL_SESSION_REPAIR_BATCH_GROUP_LIMIT = 64;

function hydrateCanonicalSessionCandidate(
  fact: CanonicalSessionCandidateFact,
  loaded: ReturnType<typeof loadCanonicalSessionRepairEntries>[number],
): CanonicalSessionCandidate {
  const entry = { ...loaded.entry };
  if (fact.normalizedParentSessionKey) {
    entry.parentSessionKey = fact.normalizedParentSessionKey;
  } else {
    delete entry.parentSessionKey;
  }
  if (fact.normalizedSpawnedBy) {
    entry.spawnedBy = fact.normalizedSpawnedBy;
  } else {
    delete entry.spawnedBy;
  }
  if (entry.forkSource && fact.normalizedForkSourceSessionKey) {
    entry.forkSource = {
      ...entry.forkSource,
      sessionKey: fact.normalizedForkSourceSessionKey,
    };
  } else if (entry.forkSource?.sessionKey !== undefined) {
    // A present but empty-normalized key cannot survive strict runtime validation. Missing
    // legacy keys remain untouched so unrelated repair does not erase independent provenance.
    const { sessionKey: _invalidSessionKey, ...forkProvenance } = entry.forkSource;
    entry.forkSource = forkProvenance as typeof entry.forkSource;
  }
  return {
    agentId: fact.agentId,
    canonicalKey: fact.canonicalKey,
    entry,
    expectedEntry: loaded.entry,
    ownerEvidenceOnly: fact.ownerEvidenceOnly,
    ...(loaded.rawEntryJson !== undefined ? { rawEntryJson: loaded.rawEntryJson } : {}),
    sessionKey: fact.sessionKey,
    sqlitePath: fact.sqlitePath,
    storePath: fact.storePath,
  };
}

function hydrateCanonicalSessionCandidates(
  facts: readonly CanonicalSessionCandidateFact[],
): CanonicalSessionCandidate[] {
  const loaded = new Map<
    CanonicalSessionCandidateFact,
    ReturnType<typeof loadCanonicalSessionRepairEntries>[number]
  >();
  const byStore = new Map<string, CanonicalSessionCandidateFact[]>();
  for (const fact of facts) {
    const key = `${fact.agentId}\0${fact.storePath}`;
    byStore.set(key, [...(byStore.get(key) ?? []), fact]);
  }
  for (const group of byStore.values()) {
    const first = group[0];
    if (!first) {
      continue;
    }
    const entries = loadCanonicalSessionRepairEntries(
      { agentId: first.agentId, storePath: first.storePath },
      group.map((fact) => fact.inventoryFact),
    );
    group.forEach((fact, index) => loaded.set(fact, entries[index]!));
  }
  return facts.map((fact) => hydrateCanonicalSessionCandidate(fact, loaded.get(fact)!));
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
  const destination = resolveCanonicalSessionDestination({
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
  replaceSessionOwnerInTransaction(
    params.database,
    params.winner.canonicalKey,
    params.winner.entry.owner,
  );
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
  let repairGroups = collectCanonicalSessionRepairGroups({ cfg: params.cfg, env }, stores);
  const foundGroups = repairGroups.length;
  const removedRows = repairGroups.reduce((total, group) => total + group.removedRows, 0);
  if (params.apply) {
    while (repairGroups.length > 0) {
      const group = repairGroups[0];
      if (!group) {
        break;
      }
      const candidateGroups = repairGroups.slice(0, CANONICAL_SESSION_REPAIR_BATCH_GROUP_LIMIT);
      const hydrated = hydrateCanonicalSessionCandidates(
        candidateGroups.flatMap((candidateGroup) => candidateGroup.candidates),
      );
      let hydratedOffset = 0;
      const hydratedGroups = candidateGroups.map((candidateGroup) => {
        const candidates = hydrated.slice(
          hydratedOffset,
          hydratedOffset + candidateGroup.candidates.length,
        );
        hydratedOffset += candidateGroup.candidates.length;
        return candidates;
      });
      const candidates = hydratedGroups[0]!;
      const singleDatabaseGroup = resolveSingleDatabaseCanonicalRepairGroup(candidates, {
        cfg: params.cfg,
        env,
      });
      if (!singleDatabaseGroup) {
        for (const directory of await repairCanonicalSessionGroup(candidates, {
          cfg: params.cfg,
          env,
        })) {
          archivedTranscriptDirectories.add(directory);
        }
        repairBatches += 1;
        repairedGroups += 1;
        repairGroups = collectCanonicalSessionRepairGroups({ cfg: params.cfg, env }, stores);
        continue;
      }
      const batch = [singleDatabaseGroup];
      // Keep commits bounded and preserve the original order around cross-store moves, while
      // collapsing the repeated whole-store projections for the common same-database path.
      for (const nextCandidates of hydratedGroups.slice(1)) {
        const nextSingleDatabaseGroup = resolveSingleDatabaseCanonicalRepairGroup(nextCandidates, {
          cfg: params.cfg,
          env,
        });
        if (
          !nextSingleDatabaseGroup ||
          nextSingleDatabaseGroup.selected.destination.sqlitePath !==
            singleDatabaseGroup.selected.destination.sqlitePath
        ) {
          break;
        }
        batch.push(nextSingleDatabaseGroup);
      }
      for (const directory of await repairCanonicalSessionGroupsInSingleDatabase(batch)) {
        archivedTranscriptDirectories.add(directory);
      }
      repairBatches += 1;
      repairedGroups += batch.length;
      repairGroups = collectCanonicalSessionRepairGroups({ cfg: params.cfg, env }, stores);
    }
  }
  return {
    archivedTranscriptDirectories: [...archivedTranscriptDirectories].toSorted(),
    foundGroups,
    repairBatches,
    removedRows,
    repairedGroups,
    scannedStores: stores.length,
  };
}
