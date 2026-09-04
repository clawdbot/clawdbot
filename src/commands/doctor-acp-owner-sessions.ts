import {
  claimAcpSessionMetaForOwnerMigration,
  readAcpSessionMetaForOwnerMigration,
} from "../acp/runtime/session-meta-owner-migration.js";
import { readAcpSessionMetaForEntry } from "../acp/runtime/session-meta.js";
import { listAgentEntries } from "../agents/agent-scope-config.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import {
  applySessionEntryLifecycleMutation,
  copySessionOwnedStateForCanonicalRepair,
  ensureTranscriptGenerationsForCanonicalRepair,
  listCanonicalSessionRepairFacts,
  loadCanonicalSessionRepairEntries,
  loadExactSessionEntryReadOnly,
} from "../config/sessions/session-accessor.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  normalizeOptionalAgentId,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";

export type AcpOwnerSessionMigrationReport = {
  ambiguous: number;
  conflicts: number;
  eligible: number;
  migrated: number;
  warnings: string[];
};

type AcpOwnerMapping = { harnessAgentId: string; ownerAgentId: string };

function collectAcpOwnerMappings(cfg: OpenClawConfig): {
  ambiguousHarnesses: Map<string, string[]>;
  mappings: AcpOwnerMapping[];
} {
  const ownersByHarness = new Map<string, Set<string>>();
  for (const agent of listAgentEntries(cfg)) {
    if (agent.runtime?.type !== "acp") {
      continue;
    }
    const ownerAgentId = normalizeOptionalAgentId(agent.id);
    const harnessAgentId = normalizeOptionalAgentId(agent.runtime.acp?.agent) ?? ownerAgentId;
    if (!ownerAgentId || !harnessAgentId) {
      continue;
    }
    const owners = ownersByHarness.get(harnessAgentId) ?? new Set<string>();
    owners.add(ownerAgentId);
    ownersByHarness.set(harnessAgentId, owners);
  }
  const ambiguousHarnesses = new Map<string, string[]>();
  const mappings: AcpOwnerMapping[] = [];
  for (const [harnessAgentId, ownerSet] of ownersByHarness) {
    const owners = [...ownerSet].toSorted();
    if (owners.length !== 1) {
      ambiguousHarnesses.set(harnessAgentId, owners);
      continue;
    }
    if (owners[0] === harnessAgentId) {
      continue;
    }
    mappings.push({ harnessAgentId, ownerAgentId: owners[0]! });
  }
  return { ambiguousHarnesses, mappings };
}

function resolveCanonicalOwnerKey(sourceSessionKey: string, ownerAgentId: string): string {
  const parsed = parseAgentSessionKey(sourceSessionKey);
  return parsed?.rest
    ? `agent:${ownerAgentId}:${parsed.rest}`
    : toAgentStoreSessionKey({ agentId: ownerAgentId, requestKey: sourceSessionKey });
}

function sameSessionIdentity(left: SessionEntry, right: SessionEntry): boolean {
  return left.lifecycleRevision
    ? left.lifecycleRevision === right.lifecycleRevision
    : left.sessionId === right.sessionId;
}

async function moveSessionEntry(params: {
  env: NodeJS.ProcessEnv;
  entry: SessionEntry;
  sourceAgentId: string;
  sourceKey: string;
  sourceStorePath: string;
  targetAgentId: string;
  targetKey: string;
  targetStorePath: string;
}): Promise<void> {
  const target = loadExactSessionEntryReadOnly({
    agentId: params.targetAgentId,
    env: params.env,
    sessionKey: params.targetKey,
    storePath: params.targetStorePath,
  })?.entry;
  if (!target) {
    await ensureTranscriptGenerationsForCanonicalRepair([
      {
        agentId: params.sourceAgentId,
        entry: params.entry,
        sessionKey: params.sourceKey,
        storePath: params.sourceStorePath,
      },
    ]);
    await applySessionEntryLifecycleMutation({
      agentId: params.targetAgentId,
      allowCanonicalRepair: true,
      afterUpsertsInTransaction: (database) => {
        copySessionOwnedStateForCanonicalRepair({
          canonicalKey: params.targetKey,
          destinationDatabase: database,
          preferredEntry: params.entry,
          preferredSessionKey: params.sourceKey,
          source: { agentId: params.sourceAgentId, storePath: params.sourceStorePath },
          sourceEntries: [params.entry],
          sourceKeys: [params.sourceKey],
        });
      },
      skipMaintenance: true,
      storePath: params.targetStorePath,
      upserts: [{ entry: params.entry, sessionKey: params.targetKey }],
    });
  }
  await applySessionEntryLifecycleMutation({
    agentId: params.sourceAgentId,
    allowCanonicalRepair: true,
    removals: [
      {
        archiveRemovedTranscript: true,
        deleteOwnedWindows: true,
        exactStoredKey: true,
        expectedEntry: params.entry,
        sessionKey: params.sourceKey,
      },
    ],
    skipMaintenance: true,
    storePath: params.sourceStorePath,
  });
}

/** Doctor-only ACP owner migration. Runtime never reads or promotes legacy harness rows. */
export async function migrateLegacyAcpOwnerSessions(params: {
  apply: boolean;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<AcpOwnerSessionMigrationReport> {
  const env = params.env ?? process.env;
  const { ambiguousHarnesses, mappings } = collectAcpOwnerMappings(params.cfg);
  const warnings = [...ambiguousHarnesses].map(
    ([harness, owners]) =>
      `ACP harness "${harness}" is configured for multiple owners (${owners.join(", ")}); legacy sessions were not migrated. Configure exactly one owner or migrate the records manually.`,
  );
  let ambiguous = ambiguousHarnesses.size;
  let conflicts = 0;
  let eligible = 0;
  let migrated = 0;
  for (const { harnessAgentId, ownerAgentId } of mappings) {
    const sourceStorePath = resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: harnessAgentId,
      env,
    });
    const targetStorePath = resolveSessionStorePathCore(params.cfg.session?.store, {
      agentId: ownerAgentId,
      env,
    });
    const sourceScope = { agentId: harnessAgentId, storePath: sourceStorePath };
    const sourceFacts = listCanonicalSessionRepairFacts(sourceScope);
    for (const { entry, sessionKey: sourceKey } of loadCanonicalSessionRepairEntries(
      sourceScope,
      sourceFacts,
    )) {
      const parsed = parseAgentSessionKey(sourceKey);
      if (parsed?.agentId && parsed.agentId !== harnessAgentId) {
        continue;
      }
      const targetKey = resolveCanonicalOwnerKey(sourceKey, ownerAgentId);
      const sourceMeta = readAcpSessionMetaForOwnerMigration({
        agentId: harnessAgentId,
        cfg: params.cfg,
        entry,
        env,
        sessionKey: sourceKey,
      });
      const targetMeta = readAcpSessionMetaForEntry({
        agentId: ownerAgentId,
        cfg: params.cfg,
        entry,
        env,
        sessionKey: targetKey,
      });
      const meta = sourceMeta ?? targetMeta;
      if (meta?.agent !== harnessAgentId) {
        continue;
      }
      if (!parsed && sourceStorePath === targetStorePath) {
        ambiguous += 1;
        warnings.push(
          `Legacy ACP session "${sourceKey}" shares the owner and harness store, so its owner is ambiguous; no change was made.`,
        );
        continue;
      }
      const targetEntry = loadExactSessionEntryReadOnly({
        agentId: ownerAgentId,
        env,
        sessionKey: targetKey,
        storePath: targetStorePath,
      })?.entry;
      if (targetEntry && !sameSessionIdentity(targetEntry, entry)) {
        conflicts += 1;
        warnings.push(
          `Canonical ACP session "${targetKey}" already exists with a different identity; legacy source "${sourceKey}" was left unchanged.`,
        );
        continue;
      }
      eligible += 1;
      if (!params.apply) {
        continue;
      }
      const claim = claimAcpSessionMetaForOwnerMigration({
        cfg: params.cfg,
        entry,
        env,
        expectedAgent: harnessAgentId,
        sourceAgentId: harnessAgentId,
        sourceSessionKey: sourceKey,
        targetAgentId: ownerAgentId,
        targetSessionKey: targetKey,
      });
      if (claim === "conflict" || claim === "missing") {
        conflicts += 1;
        warnings.push(
          `ACP metadata for legacy session "${sourceKey}" could not be claimed for owner "${ownerAgentId}"; no session row was moved.`,
        );
        continue;
      }
      await moveSessionEntry({
        env,
        entry,
        sourceAgentId: harnessAgentId,
        sourceKey,
        sourceStorePath,
        targetAgentId: ownerAgentId,
        targetKey,
        targetStorePath,
      });
      migrated += 1;
    }
  }
  return { ambiguous, conflicts, eligible, migrated, warnings };
}
