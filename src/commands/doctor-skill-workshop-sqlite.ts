import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { assertWorkspaceStateMigrationReady } from "../agents/workspace-legacy-state.js";
import { resolveCanonicalWorkspacePath } from "../agents/workspace-state-identity.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasErrnoCode, isMissingPathError } from "../infra/errors.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import { pathExists, root, type Root } from "../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import { movePathWithCopyFallback } from "../infra/replace-file.js";
import { acquireStateDatabaseCoordinator } from "../infra/state-database-coordinator.js";
import { reconcileInterruptedSkillProposalApply } from "../skills/workshop/reconcile-transition.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import {
  parseSkillProposalRow,
  readStoredProposal,
  updateProposal,
} from "../skills/workshop/store-sqlite-record.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposal,
  readSkillProposalBundle,
  readSkillProposalRollback,
  resolveSkillProposalTarget,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "../skills/workshop/store.js";
import type { SkillProposalRecord, SkillProposalRollback } from "../skills/workshop/types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  listPendingLegacyCollectionBackupRoots,
  migrateLegacyCollectionBackups,
} from "./doctor-skill-workshop-collection-backups.js";
import {
  inferOwnerAgentId,
  planWorkshopRelocation,
  readLegacyWorkshopSourceStat,
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
// Preserve incomplete proposal artifacts outside active discovery so Doctor
// does not retry an impossible import on every run.
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
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(
    database.db,
  );
  // Planning must not initialize optional Workshop tables or indexes on a no-op
  // startup. Actual proposal writes retain their feature-owned schema ensure.
  const readRows = () =>
    tableExists(database.db, "skill_workshop_proposals")
      ? executeSqliteQuerySync(
          database.db,
          kysely.selectFrom("skill_workshop_proposals").selectAll(),
        ).rows
      : [];
  const deferredSources = new Set<string>();
  const recoveryWarnings: string[] = [];
  // Settle writes while their proposal and rollback still name the same files.
  // Recovery can establish a create's ownership or restore a partial update.
  for (const row of readRows()) {
    const record = parseSkillProposalRow(row);
    if (!record || record.status !== "pending") {
      continue;
    }
    const workspaceDir = resolveLegacyWorkshopWorkspaceDir(record.target.skillDir, config, env);
    const { ownerAgentId } = inferOwnerAgentId({
      record,
      config,
      env,
      workspaceDir,
      rowOwnerAgentId: row.owner_agent_id,
    });
    if (
      !workspaceDir ||
      !ownerAgentId ||
      isPathInside(resolveWorkshopSkillsDir(config, ownerAgentId, env), record.target.skillDir) ||
      !(await readSkillProposalRollback(record.id, { env }))
    ) {
      continue;
    }
    try {
      assertWorkspaceStateMigrationReady({ workspaceDirs: [workspaceDir], env });
      const sourceStat = await readLegacyWorkshopSourceStat(workspaceDir, record.target.skillDir);
      if (sourceStat?.isSymbolicLink()) {
        continue;
      }
      const skillsRoot = [
        path.join(workspaceDir, "skills"),
        path.join(workspaceDir, ".agents", "skills"),
      ].find((rootDir) => isPathInside(rootDir, record.target.skillDir));
      if (!skillsRoot) {
        throw new Error("the original skill root could not be verified");
      }
      const target = resolveSkillProposalTarget({
        skillName: record.target.skillKey,
        config,
        agentId: ownerAgentId,
        env,
      });
      if (!sourceStat && (await pathExists(target.skillDir))) {
        throw new Error("the original skill is missing and its destination already exists");
      }
      const store = { config, env, agentId: ownerAgentId };
      const proposal = await readSkillProposalBundle(record, store);
      const recovered = await reconcileInterruptedSkillProposalApply({
        record,
        expectedRecordJson: row.record_json,
        draftContent: proposal.content,
        skillsRoot,
        store,
      });
      if (!recovered) {
        throw new Error("the interrupted apply could not be verified or restored");
      }
    } catch (error) {
      // Moving the create claim alone would strand its pending update's recovery.
      deferredSources.add(resolveCanonicalWorkspacePath(record.target.skillDir));
      recoveryWarnings.push(
        `Skill Workshop did not relocate ${record.target.skillDir}: ${String(error)}. ` +
          `Recovery for proposal ${record.id} remains pending; check its files and saved proposal before retrying Doctor.`,
      );
    }
  }
  const rows = readRows();
  const initialRows = new Map(rows.map((row) => [row.proposal_id, row]));
  const records = rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record ? [{ record, ownerAgentId: row.owner_agent_id }] : [];
  });
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
  };
  const plan = await planWorkshopRelocation(records, config, env, deferredSources);
  const workspaceMoves = new Map<string, typeof plan.moves>();
  for (const move of plan.moves) {
    // Adopted sources are already absent. Only pending filesystem moves can
    // prove that this attempt will empty a newly attested workspace.
    if (move.operation === "adopt") {
      continue;
    }
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
  const updates = [...plan.updates, ...plan.moves.flatMap((move) => move.updates)];
  const staleProposals = updates.filter((update) => update.record.status === "stale").length;
  return {
    movedSkills: plan.moves.filter((move) => move.operation === "move").length,
    retargetedProposals: updates.length - staleProposals,
    staleProposals,
    migratedBackupRoots: backupMigration.migrated,
    warnings: [...recoveryWarnings, ...plan.warnings, ...backupMigration.warnings],
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
}): Promise<void> {
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
  importLegacySkillProposal({
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
}

async function reconcileIncompleteProposal(params: {
  proposalId: string;
  proposalDir: string;
  stateRoot: Root;
}): Promise<string> {
  const entries = await params.stateRoot.list(params.proposalDir, { withFileTypes: true });
  if (entries.length === 0) {
    await params.stateRoot.remove(params.proposalDir);
    return `Removed empty legacy Skill Workshop proposal directory ${params.proposalId}.`;
  }
  await params.stateRoot.mkdir(RECOVERY_PROPOSALS_DIR);
  // A unique target preserves earlier recovery artifacts without an unsafe
  // check-then-replace window. The fs-safe move pins both directory parents.
  const recoveryPath = `${RECOVERY_PROPOSALS_DIR}/${params.proposalId}-${randomUUID()}`;
  await params.stateRoot.move(params.proposalDir, recoveryPath, { overwrite: true });
  return `Quarantined incomplete Skill Workshop proposal ${params.proposalId} to ${recoveryPath} for manual recovery.`;
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
  const database = openOpenClawStateDatabase({ env });
  const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(
    database.db,
  );
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
      // Modern bundles have no legacy sidecar. Recognize their durable record
      // without entering the feature's schema-writing read facade.
      const stored = tableExists(database.db, "skill_workshop_proposals")
        ? executeSqliteQueryTakeFirstSync(
            database.db,
            kysely
              .selectFrom("skill_workshop_proposals")
              .selectAll()
              .where("proposal_id", "=", proposalId)
              .where("owner_agent_id", "is not", null),
          )
        : undefined;
      if (stored && parseSkillProposalRow(stored)) {
        continue;
      }
      try {
        changes.push(await reconcileIncompleteProposal({ proposalId, proposalDir, stateRoot }));
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
  if (migrated > 0) {
    changes.unshift(
      `Migrated ${migrated} Skill Workshop proposal${migrated === 1 ? "" : "s"} into shared SQLite.`,
    );
  }
  return {
    changes,
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
  // Plain Doctor can reach automatic migration without its repair scope.
  // Keep one owner through filesystem moves, receipt completion, and backup retirement.
  const coordinator = acquireStateDatabaseCoordinator({
    databasePath: resolveOpenClawStateSqlitePath(env),
  });
  try {
    const sidecars = await importLegacySkillProposalSidecars({ config: params.config, env });
    const relocation = await relocateLegacyWorkshopTargets(params.config, env);
    if (
      relocation.movedSkills > 0 ||
      relocation.retargetedProposals > 0 ||
      relocation.staleProposals > 0 ||
      relocation.migratedBackupRoots > 0
    ) {
      sidecars.changes.push(
        `Relocated ${relocation.movedSkills} Skill Workshop skill${relocation.movedSkills === 1 ? "" : "s"}, retargeted ${relocation.retargetedProposals} proposal${relocation.retargetedProposals === 1 ? "" : "s"}, marked ${relocation.staleProposals} stale, and migrated ${relocation.migratedBackupRoots} legacy collection backup root${relocation.migratedBackupRoots === 1 ? "" : "s"}.`,
      );
    }
    return {
      ...sidecars,
      warnings: [...sidecars.warnings, ...relocation.warnings],
    };
  } finally {
    coordinator.release();
  }
}
