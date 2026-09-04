import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode, isMissingPathError } from "../infra/errors.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import { pathExists, root, type Root } from "../infra/fs-safe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { movePathWithCopyFallback } from "../infra/replace-file.js";
import {
  parseSkillProposalRow,
  readStoredProposal,
  updateProposal,
} from "../skills/workshop/store-sqlite-record.js";
import { openSkillWorkshopStore } from "../skills/workshop/store-sqlite-schema.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposal,
  readSkillProposalRecord,
  readSkillProposalRollback,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "../skills/workshop/store.js";
import type { SkillProposalRecord, SkillProposalRollback } from "../skills/workshop/types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import {
  listPendingLegacyCollectionBackupRoots,
  migrateLegacyCollectionBackups,
} from "./doctor-skill-workshop-collection-backups.js";
import {
  inferOwnerAgentId,
  planWorkshopRelocation,
  resolveLegacyWorkshopWorkspaceDir,
  type LegacyWorkshopProposal,
  type WorkshopProposalUpdate,
} from "./doctor-skill-workshop-relocation.js";
import {
  finishWorkshopWorkspaceRelocations,
  prepareWorkshopWorkspaceRelocation,
} from "./doctor-skill-workshop-workspaces.js";

const WORKSHOP_DIR = "skill-workshop";
const PROPOSALS_DIR = `${WORKSHOP_DIR}/proposals`;
const MANIFEST_PATH = `${WORKSHOP_DIR}/proposals.json`;
// Doctor-owned recovery archive for orphaned or incomplete legacy proposal
// directories that cannot be imported. Relocating them out of active discovery
// lets Doctor converge instead of retrying the same impossible migration on
// every run, while preserving any remaining artifacts for manual recovery.
const RECOVERY_DIR = `${WORKSHOP_DIR}/recovery`;
const RECOVERY_PROPOSALS_DIR = `${RECOVERY_DIR}/proposals`;
const MAX_RECORD_BYTES = 1024 * 1024;
// Legacy rollback JSON can expand control characters sixfold across 1 MiB of
// SKILL.md plus 64 existing 256 KiB support targets.
const MAX_ROLLBACK_BYTES = 128 * 1024 * 1024;
const PROPOSAL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{5,120}$/;

type MigrationResult = {
  changes: string[];
  warnings: string[];
  detected: number;
  migrated: number;
};

type WorkshopRelocationResult = {
  movedSkills: number;
  retargetedProposals: number;
  staleProposals: number;
  migratedBackupRoots: number;
  warnings: string[];
};

export type LegacyWorkshopMigrationInspection = {
  externalProposalCount: number;
  externalProposalCountsByAgent: Record<string, number>;
  legacyBackupRootCount: number;
};

async function readJson(rootDir: Root, relativePath: string, maxBytes: number): Promise<unknown> {
  const read = await rootDir.read(relativePath, {
    hardlinks: "reject",
    maxBytes,
    symlinks: "reject",
  });
  return JSON.parse(read.buffer.toString("utf8"));
}

export async function inspectLegacySkillWorkshopMigration(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyWorkshopMigrationInspection> {
  const env = params.env ?? process.env;
  const database = await openExistingOpenClawStateDatabaseReadOnly({ env });
  let records: LegacyWorkshopProposal[] = [];
  try {
    if (database && tableExists(database.db, "skill_workshop_proposals")) {
      const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(
        database.db,
      );
      const rows = executeSqliteQuerySync(
        database.db,
        kysely.selectFrom("skill_workshop_proposals").select(["record_json", "owner_agent_id"]),
      ).rows;
      records = rows.flatMap((row) => {
        try {
          const parsed = validateSkillProposalRecord(JSON.parse(row.record_json));
          return parsed.ok ? [{ record: parsed.value, ownerAgentId: row.owner_agent_id }] : [];
        } catch {
          return [];
        }
      });
    }
  } finally {
    database?.walMaintenance.close();
  }
  const plan = await planWorkshopRelocation(records, params.config, env);
  const backups = await listPendingLegacyCollectionBackupRoots(params.config, env);
  return {
    externalProposalCount: plan.externalProposalCount,
    externalProposalCountsByAgent: plan.externalProposalCountsByAgent,
    legacyBackupRootCount: backups.length,
  };
}

async function relocateLegacyWorkshopTargets(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): Promise<WorkshopRelocationResult> {
  const { database, kysely } = openSkillWorkshopStore({ env });
  const rows = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("skill_workshop_proposals").selectAll(),
  ).rows;
  const initialRows = new Map(rows.map((row) => [row.proposal_id, row]));
  const records = rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record ? [{ record, ownerAgentId: row.owner_agent_id }] : [];
  });
  let retargetedProposals = 0;
  let staleProposals = 0;
  const persistUpdates = (updates: WorkshopProposalUpdate[]): void => {
    if (updates.length === 0) {
      return;
    }
    // Every proposal for one moved skill must commit together. Otherwise a
    // retry loses the create row that proves where its pending updates belong.
    runOpenClawStateWriteTransaction(
      ({ db }) => {
        for (const update of updates) {
          const expected = initialRows.get(update.record.id);
          const current = readStoredProposal(update.record.id, { env });
          if (
            !current ||
            current.row.record_json !== expected?.record_json ||
            current.row.owner_agent_id !== expected?.owner_agent_id
          ) {
            throw new Error(`Skill proposal changed during relocation: ${update.record.id}`);
          }
          updateProposal(db, current.row, update.record, update.ownerAgentId);
        }
      },
      { env },
      { operationLabel: "skill-workshop.relocation.commit" },
    );
    for (const update of updates) {
      if (update.record.status === "stale") {
        staleProposals += 1;
      } else {
        retargetedProposals += 1;
      }
    }
  };
  const plan = await planWorkshopRelocation(records, config, env);
  const workspaceMoves = new Map<string, typeof plan.moves>();
  for (const move of plan.moves) {
    const moves = workspaceMoves.get(move.workspaceDir) ?? [];
    moves.push(move);
    workspaceMoves.set(move.workspaceDir, moves);
  }
  for (const [workspaceDir, moves] of workspaceMoves) {
    await prepareWorkshopWorkspaceRelocation(workspaceDir, moves, env);
  }
  for (const move of plan.moves) {
    if (move.operation === "move") {
      await fs.mkdir(path.dirname(move.destination), { recursive: true });
      await movePathWithCopyFallback({ from: move.source, to: move.destination });
    } else if (move.operation === "remove-source") {
      await fs.rm(move.source, { recursive: true, force: false });
    }
    persistUpdates(move.updates);
  }
  persistUpdates(plan.updates);
  await finishWorkshopWorkspaceRelocations(env);
  const backupMigration = await migrateLegacyCollectionBackups(config, env);
  return {
    movedSkills: plan.moves.filter((move) => move.operation === "move").length,
    retargetedProposals,
    staleProposals,
    migratedBackupRoots: backupMigration.migrated,
    warnings: [...plan.warnings, ...backupMigration.warnings],
  };
}

async function readLegacyRollback(
  stateRoot: Root,
  proposalId: string,
): Promise<SkillProposalRollback | undefined> {
  try {
    const rollback = validateSkillProposalRollback(
      await readJson(stateRoot, `${PROPOSALS_DIR}/${proposalId}/rollback.json`, MAX_ROLLBACK_BYTES),
    );
    if (!rollback.ok) {
      throw new Error(rollback.error.message);
    }
    if (rollback.value.proposalId !== proposalId) {
      throw new Error("invalid rollback metadata");
    }
    return rollback.value;
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

async function verifyImportedProposal(
  config: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  record: SkillProposalRecord,
  rollback?: SkillProposalRollback,
): Promise<void> {
  const imported = (
    await readSkillProposal(record.id, { config, env }, {}, { config, reconcile: false })
  )?.record;
  if (
    !imported ||
    imported.draftHash !== record.draftHash ||
    imported.target.skillFile !== record.target.skillFile
  ) {
    throw new Error("SQLite verification failed");
  }
  if (rollback && !(await readSkillProposalRollback(record.id, { env }))) {
    throw new Error("SQLite rollback verification failed");
  }
}

async function migrateProposal(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  proposalId: string;
  stateRoot: Root;
}): Promise<"imported" | "already-imported"> {
  const proposalDir = `${PROPOSALS_DIR}/${params.proposalId}`;
  const record = validateSkillProposalRecord(
    await readJson(params.stateRoot, `${proposalDir}/proposal.json`, MAX_RECORD_BYTES),
  );
  if (!record.ok) {
    throw new Error(record.error.message);
  }
  if (record.value.id !== params.proposalId) {
    throw new Error("invalid proposal metadata");
  }
  const draft = await params.stateRoot.read(`${proposalDir}/PROPOSAL.md`, {
    hardlinks: "reject",
    maxBytes: MAX_RECORD_BYTES,
    symlinks: "reject",
  });
  if (hashSkillProposalContent(draft.buffer.toString("utf8")) !== record.value.draftHash) {
    throw new Error("proposal draft hash does not match proposal metadata");
  }
  const rollback = await readLegacyRollback(params.stateRoot, params.proposalId);
  const owner = inferOwnerAgentId({
    config: params.config,
    env: params.env,
    record: record.value,
    workspaceDir: resolveLegacyWorkshopWorkspaceDir(
      record.value.target.skillDir,
      params.config,
      params.env,
    ),
  });
  if (!owner.ownerAgentId) {
    throw new Error(
      owner.unconfiguredOwnerAgentId
        ? `owning agent "${owner.unconfiguredOwnerAgentId}" is not configured; legacy metadata was retained for manual recovery`
        : "owning agent could not be inferred; legacy metadata was retained for manual recovery",
    );
  }
  const result = importLegacySkillProposal({
    record: record.value,
    rollback,
    ownerAgentId: owner.ownerAgentId,
    store: { env: params.env },
  });
  await verifyImportedProposal(params.config, params.env, record.value, rollback);
  if (rollback) {
    await params.stateRoot.remove(`${proposalDir}/rollback.json`);
  }
  await params.stateRoot.remove(`${proposalDir}/proposal.json`);
  return result;
}

type OrphanDisposition = { kind: "removed-empty" } | { kind: "quarantined"; recoveryPath: string };

/**
 * Reconcile a confirmed-incomplete legacy proposal directory that cannot be
 * imported so Doctor converges on the next run. Empty directories are removed
 * directly; non-empty directories are relocated into the Doctor-owned recovery
 * archive under the state directory, preserving any remaining artifacts.
 */
async function reconcileIncompleteProposal(params: {
  proposalId: string;
  proposalDir: string;
  stateRoot: Root;
}): Promise<OrphanDisposition> {
  const entries = await params.stateRoot.list(params.proposalDir, { withFileTypes: true });
  if (entries.length === 0) {
    await params.stateRoot.remove(params.proposalDir);
    return { kind: "removed-empty" };
  }
  await params.stateRoot.mkdir(RECOVERY_PROPOSALS_DIR);
  // A unique target preserves earlier recovery artifacts without an unsafe
  // check-then-replace window. The fs-safe move pins both directory parents.
  const recoveryPath = `${RECOVERY_PROPOSALS_DIR}/${params.proposalId}-${randomUUID()}`;
  await params.stateRoot.move(params.proposalDir, recoveryPath, { overwrite: true });
  return { kind: "quarantined", recoveryPath };
}

/** Import verified legacy proposal sidecars, then remove only the imported JSON metadata. */
async function importLegacySkillProposalSidecars(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  if (!(await pathExists(path.join(stateDir, PROPOSALS_DIR)))) {
    if (!(await pathExists(path.join(stateDir, MANIFEST_PATH)))) {
      return {
        changes: [],
        warnings: [],
        detected: 0,
        migrated: 0,
      };
    }
    await removePathWithinRoot({ rootDir: stateDir, relativePath: MANIFEST_PATH });
    return {
      changes: ["Removed the empty legacy Skill Workshop proposal index."],
      warnings: [],
      detected: 0,
      migrated: 0,
    };
  }
  const stateRoot = await root(stateDir);
  let entries;
  try {
    entries = await stateRoot.list(PROPOSALS_DIR, { withFileTypes: true });
  } catch (error) {
    if (hasErrnoCode(error, "not-found")) {
      return { changes: [], warnings: [], detected: 0, migrated: 0 };
    }
    return {
      changes: [],
      warnings: [`Failed to inspect legacy Skill Workshop proposals: ${String(error)}`],
      detected: 0,
      migrated: 0,
    };
  }

  const proposalIds = entries
    .filter((entry) => entry.isDirectory && PROPOSAL_ID_PATTERN.test(entry.name))
    .map((entry) => entry.name)
    .toSorted((left, right) => left.localeCompare(right));
  const warnings: string[] = [];
  const changes: string[] = [];
  const readStore = { config: params.config, env };
  const readOptions = { config: params.config, reconcile: false };
  let migrated = 0;
  for (const proposalId of proposalIds) {
    const proposalDir = `${PROPOSALS_DIR}/${proposalId}`;
    try {
      await migrateProposal({
        config: params.config,
        env,
        proposalId,
        stateRoot,
      });
      migrated += 1;
      continue;
    } catch (error) {
      if (!isMissingPathError(error)) {
        warnings.push(`Failed to migrate Skill Workshop proposal ${proposalId}: ${String(error)}`);
        continue;
      }
      if (await readSkillProposalRecord(proposalId, readStore, {}, readOptions)) {
        continue;
      }
      try {
        const disposition = await reconcileIncompleteProposal({
          proposalId,
          proposalDir,
          stateRoot,
        });
        changes.push(
          disposition.kind === "removed-empty"
            ? `Removed empty legacy Skill Workshop proposal directory ${proposalId}.`
            : `Quarantined incomplete Skill Workshop proposal ${proposalId} to ${disposition.recoveryPath} for manual recovery.`,
        );
      } catch (reconcileError) {
        warnings.push(
          `Could not quarantine incomplete Skill Workshop proposal ${proposalId}: ${String(
            reconcileError,
          )}. Manually move ${proposalDir} to ${RECOVERY_PROPOSALS_DIR} to recover it.`,
        );
      }
    }
  }
  await removePathWithinRoot({ rootDir: stateDir, relativePath: MANIFEST_PATH }).catch(
    (error: unknown) => {
      if (!isMissingPathError(error)) {
        warnings.push(`Failed to remove legacy Skill Workshop proposal index: ${String(error)}`);
      }
    },
  );
  const migrationChange =
    migrated > 0
      ? `Migrated ${migrated} Skill Workshop proposal${migrated === 1 ? "" : "s"} into shared SQLite.`
      : null;
  return {
    changes: [...(migrationChange ? [migrationChange] : []), ...changes],
    warnings,
    detected: proposalIds.length,
    migrated,
  };
}

export async function migrateLegacySkillWorkshopProposals(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  const sidecars = await importLegacySkillProposalSidecars({ config: params.config, env });
  const relocation = await relocateLegacyWorkshopTargets(params.config, env);
  const relocationChanges =
    relocation.movedSkills > 0 ||
    relocation.retargetedProposals > 0 ||
    relocation.staleProposals > 0 ||
    relocation.migratedBackupRoots > 0
      ? [
          `Relocated ${relocation.movedSkills} Skill Workshop skill${relocation.movedSkills === 1 ? "" : "s"}, retargeted ${relocation.retargetedProposals} proposal${relocation.retargetedProposals === 1 ? "" : "s"}, marked ${relocation.staleProposals} stale, and migrated ${relocation.migratedBackupRoots} legacy collection backup root${relocation.migratedBackupRoots === 1 ? "" : "s"}.`,
        ]
      : [];
  return {
    ...sidecars,
    changes: [...sidecars.changes, ...relocationChanges],
    warnings: [...sidecars.warnings, ...relocation.warnings],
  };
}
