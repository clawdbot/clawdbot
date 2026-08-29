import fs from "node:fs";
import { resolveAgentMainSessionKey } from "../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  listCanonicalSessionRepairFacts,
  type CanonicalSessionRepairFact,
} from "../config/sessions/session-accessor.js";
import { resolveDeliveryProvenCanonicalSessionKey } from "../config/sessions/store-entry.js";
import { resolveAllAgentSessionStoreTargetsSync } from "../config/sessions/targets.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "../gateway/session-store-key.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { applyCanonicalOwnerEvidence } from "./doctor-session-canonical-owner-evidence.js";
import { resolveTargetSqlitePath } from "./doctor-session-sqlite-readers.js";

export type CanonicalSessionCandidate = {
  agentId: string;
  canonicalKey: string;
  entry: SessionEntry;
  expectedEntry: SessionEntry;
  ownerEvidenceOnly: boolean;
  rawEntryJson?: string;
  sessionKey: string;
  sqlitePath: string;
  storePath: string;
};

export type CanonicalSessionCandidateFact = Omit<
  CanonicalSessionCandidate,
  "entry" | "expectedEntry" | "rawEntryJson"
> & {
  inventoryFact: CanonicalSessionRepairFact;
  lineageRepairRequired: boolean;
  normalizedForkSourceSessionKey?: string;
  normalizedParentSessionKey?: string;
  normalizedSpawnedBy?: string;
};

type CanonicalSessionRepairGroup = {
  candidates: CanonicalSessionCandidateFact[];
  removedRows: number;
};

type CanonicalSessionStore = {
  agentId: string;
  sqlitePath: string;
  storePath: string;
};

export function listCanonicalSessionStores(params: {
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

function collectCanonicalSessionCandidateFacts(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  stores: readonly CanonicalSessionStore[],
): CanonicalSessionCandidateFact[] {
  const inventory = stores.flatMap((target) =>
    listCanonicalSessionRepairFacts({
      agentId: target.agentId,
      storePath: target.storePath,
    }).map((inventoryFact) => {
      const { canonicalOwnerSessionKey, sessionKey } = inventoryFact;
      const storedKey = resolveStoredSessionKeyForAgentStore({
        cfg: params.cfg,
        agentId: target.agentId,
        sessionKey,
      });
      return {
        canonicalKey: storedKey
          ? resolveDeliveryProvenCanonicalSessionKey(storedKey, inventoryFact)
          : resolveAgentMainSessionKey({ cfg: params.cfg, agentId: target.agentId }),
        canonicalOwnerSessionKey,
        inventoryFact,
        sessionKey,
        storedKey,
        target,
      };
    }),
  );
  const canonicalKeysByStoredKey = applyCanonicalOwnerEvidence(inventory);
  return inventory.map(
    ({ canonicalKey, canonicalOwnerSessionKey, inventoryFact, sessionKey, target }) => {
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
      const parentSessionKey = canonicalizeLineageKey(inventoryFact.parentSessionKey);
      const spawnedBy = canonicalizeLineageKey(inventoryFact.spawnedBy);
      const forkSourceSessionKey = canonicalizeLineageKey(inventoryFact.forkSourceSessionKey);
      return Object.assign(
        {
          agentId: target.agentId,
          canonicalKey,
          inventoryFact,
          lineageRepairRequired:
            parentSessionKey !== inventoryFact.parentSessionKey ||
            spawnedBy !== inventoryFact.spawnedBy ||
            forkSourceSessionKey !== inventoryFact.forkSourceSessionKey,
          ownerEvidenceOnly: canonicalOwnerSessionKey !== undefined,
          sessionKey,
          sqlitePath: target.sqlitePath,
          storePath: target.storePath,
        },
        forkSourceSessionKey ? { normalizedForkSourceSessionKey: forkSourceSessionKey } : {},
        parentSessionKey ? { normalizedParentSessionKey: parentSessionKey } : {},
        spawnedBy ? { normalizedSpawnedBy: spawnedBy } : {},
      );
    },
  );
}

export function resolveCanonicalSessionDestination(params: {
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

function groupRepairCandidates(
  candidates: readonly CanonicalSessionCandidateFact[],
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
): CanonicalSessionRepairGroup[] {
  const byCanonicalKey = new Map<string, CanonicalSessionCandidateFact[]>();
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
    const first = group[0]!;
    const destination = resolveCanonicalSessionDestination({
      canonicalKey: first.canonicalKey,
      cfg: params.cfg,
      env: params.env,
      sourceAgentId: first.agentId,
    });
    const repairRequired =
      group.length > 1 ||
      group.some(
        (candidate) =>
          candidate.inventoryFact.rawCompareRequired ||
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

export function collectCanonicalSessionRepairGroups(
  params: { cfg: OpenClawConfig; env: NodeJS.ProcessEnv },
  stores: readonly CanonicalSessionStore[],
): CanonicalSessionRepairGroup[] {
  return groupRepairCandidates(collectCanonicalSessionCandidateFacts(params, stores), params);
}
