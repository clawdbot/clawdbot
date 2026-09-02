/** Doctor-owned migration of Skill Workshop proposal metadata into shared SQLite. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { listAgentIds, resolveAgentWorkspaceDir } from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isMissingPathError } from "../infra/errors.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import { pathExists, root, type Root } from "../infra/fs-safe.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSkillCollectionBackupRoot } from "../skills/workshop/collection-paths.js";
import { resolveWorkshopSkillsDir } from "../skills/workshop/skills-root.js";
import { parseSkillProposalRow } from "../skills/workshop/store-sqlite-record.js";
import { openSkillWorkshopStore } from "../skills/workshop/store-sqlite-schema.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  readSkillProposal,
  readSkillProposalRecord,
  readSkillProposalRollback,
  resolveSkillProposalTarget,
  updateSkillProposalRecord,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "../skills/workshop/store.js";
import type { SkillProposalRecord, SkillProposalRollback } from "../skills/workshop/types.js";
import { tableExists } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateDatabase } from "../state/openclaw-state-db.generated.js";
import { openExistingOpenClawStateDatabaseReadOnly } from "../state/openclaw-state-db.js";

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
  removedBackupRoots: number;
};

export type LegacyWorkshopMigrationInspection = {
  externalProposalCount: number;
  legacyBackupRootCount: number;
};

async function readJson(rootDir: Root, relativePath: string, maxBytes: number): Promise<unknown> {
  const read = await rootDir.read(relativePath, {
    hardlinks: "reject",
    maxBytes,
    symlinks: "reject",
  });
  return JSON.parse(read.buffer.toString("utf8")) as unknown;
}

function proposalWorkspace(record: SkillProposalRecord): string {
  return path.dirname(path.dirname(path.resolve(record.target.skillDir)));
}

function isInsideWorkshopRoot(workshopRoot: string, skillDir: string): boolean {
  const resolvedRoot = path.resolve(workshopRoot);
  const resolvedSkillDir = path.resolve(skillDir);
  return resolvedSkillDir === resolvedRoot || isPathInside(resolvedRoot, resolvedSkillDir);
}

function retargetWorkshopProposal(
  record: SkillProposalRecord,
  target: ReturnType<typeof resolveSkillProposalTarget>,
): SkillProposalRecord {
  return {
    ...record,
    target: {
      ...record.target,
      skillDir: target.skillDir,
      skillFile: target.skillFile,
      source: "openclaw-workshop",
    },
    updatedAt: new Date().toISOString(),
  };
}

function staleWorkshopProposal(record: SkillProposalRecord, reason: string): SkillProposalRecord {
  const now = new Date().toISOString();
  return {
    ...record,
    status: "stale",
    updatedAt: now,
    staleAt: now,
    statusReason: reason,
  };
}

async function moveWorkshopSkillDirectory(source: string, destination: string): Promise<void> {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.rename(source, destination);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") {
      throw error;
    }
    await fs.cp(source, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
      preserveTimestamps: true,
    });
    await fs.rm(source, { recursive: true, force: false });
  }
}

async function listLegacyCollectionBackupRoots(
  env: NodeJS.ProcessEnv,
): Promise<{ backupRoot: string; names: string[] }> {
  const backupRoot = resolveSkillCollectionBackupRoot(env);
  if (!(await pathExists(backupRoot))) {
    return { backupRoot, names: [] };
  }
  const names = (await fs.readdir(backupRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/u.test(entry.name))
    .map((entry) => entry.name);
  return { backupRoot, names };
}

export async function inspectLegacySkillWorkshopMigration(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LegacyWorkshopMigrationInspection> {
  const database = await openExistingOpenClawStateDatabaseReadOnly({ env });
  let records: SkillProposalRecord[] = [];
  try {
    if (database && tableExists(database.db, "skill_workshop_proposals")) {
      const kysely = getNodeSqliteKysely<Pick<OpenClawStateDatabase, "skill_workshop_proposals">>(
        database.db,
      );
      const rows = executeSqliteQuerySync(
        database.db,
        kysely.selectFrom("skill_workshop_proposals").select("record_json"),
      ).rows;
      records = rows.flatMap((row) => {
        try {
          const parsed = validateSkillProposalRecord(JSON.parse(row.record_json) as unknown);
          return parsed.ok ? [parsed.value] : [];
        } catch {
          return [];
        }
      });
    }
  } finally {
    database?.walMaintenance.close();
  }
  const plan = await planWorkshopRelocation(records, env);
  const backups = await listLegacyCollectionBackupRoots(env);
  return {
    externalProposalCount:
      plan.updates.length + plan.moves.reduce((count, move) => count + move.updates.length, 0),
    legacyBackupRootCount: backups.names.length,
  };
}

async function planWorkshopRelocation(
  records: SkillProposalRecord[],
  env: NodeJS.ProcessEnv,
): Promise<{
  moves: Array<{
    source: string;
    destination: string;
    adopted: boolean;
    updates: SkillProposalRecord[];
  }>;
  updates: SkillProposalRecord[];
}> {
  const workshopRoot = resolveWorkshopSkillsDir(env);
  const external = records.filter(
    (record) => !isInsideWorkshopRoot(workshopRoot, record.target.skillDir),
  );
  const movesBySource = new Map<string, { destination: string; adopted: boolean }>();
  const staleReasons = new Map<string, string>();
  for (const record of external) {
    if (record.kind !== "create" || record.status !== "applied") {
      continue;
    }
    const source = path.resolve(record.target.skillDir);
    if (movesBySource.has(source)) {
      continue;
    }
    const target = resolveSkillProposalTarget({ skillName: record.target.skillKey, env });
    let sourceStat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
    try {
      sourceStat = await fs.lstat(source);
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }
    if (sourceStat?.isSymbolicLink()) {
      staleReasons.set(
        record.id,
        `Skill Workshop no longer writes through symlinked skills; ${source} stays a workspace skill.`,
      );
      continue;
    }
    if (!sourceStat) {
      // The move is durable before metadata persistence; on rerun, adopt the existing destination.
      if (await pathExists(target.skillFile)) {
        movesBySource.set(source, { destination: target.skillDir, adopted: true });
      }
      continue;
    }
    if (await pathExists(target.skillDir)) {
      staleReasons.set(
        record.id,
        `Skill Workshop relocation conflict: destination already exists at ${target.skillDir}.`,
      );
      continue;
    }
    movesBySource.set(source, { destination: target.skillDir, adopted: false });
  }

  const movesByDestination = new Map<string, string[]>();
  for (const [source, move] of movesBySource) {
    const sources = movesByDestination.get(move.destination) ?? [];
    sources.push(source);
    movesByDestination.set(move.destination, sources);
  }
  for (const [destination, sources] of movesByDestination) {
    if (sources.length < 2) {
      continue;
    }
    const conflictReason = `Skill Workshop relocation conflict: sources ${sources.toSorted().join(", ")} map to the same destination ${destination}.`;
    for (const record of external) {
      if (sources.includes(path.resolve(record.target.skillDir))) {
        staleReasons.set(record.id, conflictReason);
      }
    }
    for (const source of sources) {
      movesBySource.delete(source);
    }
  }

  const updates: SkillProposalRecord[] = [];
  const updatesBySource = new Map<string, SkillProposalRecord[]>();
  for (const record of external) {
    const source = path.resolve(record.target.skillDir);
    const move = movesBySource.get(source);
    const conflictReason = staleReasons.get(record.id);
    if (move) {
      const sourceUpdates = updatesBySource.get(source) ?? [];
      sourceUpdates.push(
        retargetWorkshopProposal(record, {
          skillKey: record.target.skillKey,
          skillDir: move.destination,
          skillFile: path.join(move.destination, "SKILL.md"),
        }),
      );
      updatesBySource.set(source, sourceUpdates);
      continue;
    }
    if (conflictReason) {
      updates.push(staleWorkshopProposal(record, conflictReason));
      continue;
    }
    if (record.status === "pending" && record.kind === "create") {
      updates.push(
        retargetWorkshopProposal(
          record,
          resolveSkillProposalTarget({ skillName: record.target.skillKey, env }),
        ),
      );
      continue;
    }
    if (record.status === "pending" && record.kind === "update") {
      updates.push(
        staleWorkshopProposal(
          record,
          "Skill Workshop no longer edits skills outside its own directory.",
        ),
      );
    }
  }
  return {
    moves: [...movesBySource].map(([source, move]) => ({
      source,
      destination: move.destination,
      adopted: move.adopted,
      updates: updatesBySource.get(source) ?? [],
    })),
    updates,
  };
}

async function relocateLegacyWorkshopTargets(
  env: NodeJS.ProcessEnv,
): Promise<WorkshopRelocationResult> {
  const { database, kysely } = openSkillWorkshopStore({ env });
  const records = executeSqliteQuerySync(
    database.db,
    kysely.selectFrom("skill_workshop_proposals").selectAll(),
  ).rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record ? [record] : [];
  });
  let retargetedProposals = 0;
  let staleProposals = 0;
  const persistUpdates = async (updates: SkillProposalRecord[]): Promise<void> => {
    for (const record of updates) {
      if (record.status === "stale") {
        staleProposals += 1;
      } else {
        retargetedProposals += 1;
      }
      await updateSkillProposalRecord({ record, store: { env } });
    }
  };
  const plan = await planWorkshopRelocation(records, env);
  for (const move of plan.moves) {
    if (!move.adopted) {
      await moveWorkshopSkillDirectory(move.source, move.destination);
    }
    await persistUpdates(move.updates);
  }
  await persistUpdates(plan.updates);
  const backups = await listLegacyCollectionBackupRoots(env);
  for (const name of backups.names) {
    await removePathWithinRoot({
      rootDir: backups.backupRoot,
      relativePath: name,
      recursive: true,
      force: true,
    });
  }
  return {
    movedSkills: plan.moves.filter((move) => !move.adopted).length,
    retargetedProposals,
    staleProposals,
    removedBackupRoots: backups.names.length,
  };
}

function configuredAgentIds(config: OpenClawConfig): string[] {
  return listAgentIds(config);
}

function inferOwnerAgentId(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  record: SkillProposalRecord;
  workspaceDir: string;
}): string | undefined {
  if (params.record.origin?.agentId) {
    return normalizeAgentId(params.record.origin.agentId);
  }
  if (params.record.origin?.sessionKey) {
    const sessionAgentId = parseAgentSessionKey(params.record.origin.sessionKey)?.agentId;
    if (sessionAgentId) {
      return normalizeAgentId(sessionAgentId);
    }
  }
  const agentIds = configuredAgentIds(params.config);
  const workspaceMatches = agentIds.filter(
    (agentId) =>
      path.resolve(resolveAgentWorkspaceDir(params.config, agentId, params.env)) ===
      path.resolve(params.workspaceDir),
  );
  if (workspaceMatches.length === 1) {
    return workspaceMatches[0];
  }
  return agentIds.length === 1 ? agentIds[0] : undefined;
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

async function verifyImportedProposal(params: {
  env: NodeJS.ProcessEnv;
  record: SkillProposalRecord;
  rollback?: SkillProposalRollback;
}): Promise<void> {
  const imported = (
    await readSkillProposal(params.record.id, { env: params.env }, {}, { reconcile: false })
  )?.record;
  if (
    !imported ||
    imported.draftHash !== params.record.draftHash ||
    imported.target.skillFile !== params.record.target.skillFile
  ) {
    throw new Error("SQLite verification failed");
  }
  if (
    params.rollback &&
    !(await readSkillProposalRollback(params.record.id, { env: params.env }))
  ) {
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
  const workspaceDir = proposalWorkspace(record.value);
  const ownerAgentId = inferOwnerAgentId({
    config: params.config,
    env: params.env,
    record: record.value,
    workspaceDir,
  });
  if (!ownerAgentId) {
    throw new Error(
      "owning agent could not be inferred; legacy metadata was retained for manual recovery",
    );
  }
  const result = importLegacySkillProposal({
    record: record.value,
    rollback,
    ownerAgentId,
    store: { env: params.env },
  });
  await verifyImportedProposal({ env: params.env, record: record.value, rollback });
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
    if ((error as NodeJS.ErrnoException).code === "not-found") {
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
      if (await readSkillProposalRecord(proposalId, { env }, {}, { reconcile: false })) {
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
  const relocation = await relocateLegacyWorkshopTargets(env);
  return {
    ...sidecars,
    changes: [...sidecars.changes, ...formatWorkshopRelocationChanges(relocation)],
  };
}

function formatWorkshopRelocationChanges(result: WorkshopRelocationResult): string[] {
  if (
    result.movedSkills === 0 &&
    result.retargetedProposals === 0 &&
    result.staleProposals === 0 &&
    result.removedBackupRoots === 0
  ) {
    return [];
  }
  return [
    `Relocated ${result.movedSkills} Skill Workshop skill${result.movedSkills === 1 ? "" : "s"}, retargeted ${result.retargetedProposals} proposal${result.retargetedProposals === 1 ? "" : "s"}, marked ${result.staleProposals} stale, and removed ${result.removedBackupRoots} legacy collection backup root${result.removedBackupRoots === 1 ? "" : "s"}.`,
  ];
}
