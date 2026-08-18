import crypto from "node:crypto";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { removePathWithinRoot } from "../../infra/fs-safe-remove.js";
import { FsSafeError, root, type ReadResult } from "../../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  assertInsideWorkspace,
  assertWorkspaceSkillSupportPathSetIsFileOnly,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { reconcileInterruptedSkillProposalApply } from "./reconcile-transition.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import {
  assertProposalId,
  MAX_PROPOSAL_SUPPORT_FILES,
  PROPOSAL_DRAFT_FILE,
} from "./store-record.js";
import { appendSkillProposalEvent, type NewSkillProposalEvent } from "./store-sqlite-event.js";
import {
  insertProposal,
  parseSkillProposalRow,
  readStoredProposal,
  updateProposal,
} from "./store-sqlite-record.js";
import { readSkillProposalRollback } from "./store-sqlite-rollback.js";
import {
  databaseOptions,
  ensureSkillWorkshopSchema,
  openSkillWorkshopStore,
  type SkillProposalRow,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import {
  SKILL_WORKSHOP_MANIFEST_SCHEMA,
  type SkillProposalManifest,
  type SkillProposalManifestEntry,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFile,
  type SkillProposalSupportFileInput,
  type SkillProposalEvent,
} from "./types.js";

const WORKSHOP_REL_DIR = "skill-workshop";
const PROPOSALS_REL_DIR = path.join(WORKSHOP_REL_DIR, "proposals");
const MAX_PROPOSAL_BYTES = 1024 * 1024;
const MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES = 2 * 1024 * 1024;
export {
  MAX_PROPOSAL_SUPPORT_FILES,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "./store-record.js";
export { hashSkillProposalContent } from "./proposal-hash.js";
export { readSkillProposalRollback };
export { withSkillProposalTargetLock } from "./target-lock.js";

type SkillProposalLookupScope = {
  agentId?: string;
  workspaceDir?: string;
};

type SkillProposalReadOptions = {
  config?: OpenClawConfig;
  reconcile?: boolean;
};

export type PreparedSkillProposalSupportFile = SkillProposalSupportFile & {
  content: string;
};

/** Creates a stable proposal id from skill name, date, and random suffix. */
export function createSkillProposalId(name: string, now = new Date()): string {
  const normalized = normalizeSkillIndexName(name) || "skill";
  const date = now.toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  return `${normalized.slice(0, 60)}-${date}-${suffix}`;
}

function contentSizeBytes(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function assertSkillProposalContentSize(content: string): void {
  if (contentSizeBytes(content) > MAX_PROPOSAL_BYTES) {
    throw new Error("Skill proposal is too large.");
  }
}

function resolveSkillWorkshopStateDir(options: SkillWorkshopStoreOptions = {}): string {
  return path.resolve(options.stateDir ?? resolveStateDir(options.env));
}

function proposalRelativeDir(proposalId: string): string {
  assertProposalId(proposalId);
  return path.join(PROPOSALS_REL_DIR, proposalId);
}

export function prepareSkillProposalSupportFiles(
  input: readonly SkillProposalSupportFileInput[] | undefined,
): PreparedSkillProposalSupportFile[] {
  if (!input || input.length === 0) {
    return [];
  }
  if (input.length > MAX_PROPOSAL_SUPPORT_FILES) {
    throw new Error(`A skill proposal can include at most ${MAX_PROPOSAL_SUPPORT_FILES} files.`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files: PreparedSkillProposalSupportFile[] = [];
  for (const file of input) {
    const filePath = normalizeWorkspaceSkillSupportPath(file.path);
    if (seen.has(filePath)) {
      throw new Error(`Duplicate support file path: ${filePath}`);
    }
    seen.add(filePath);
    const sizeBytes = contentSizeBytes(file.content);
    if (sizeBytes > MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES) {
      throw new Error(`Support file is too large: ${filePath}`);
    }
    if (file.content.includes("\0")) {
      throw new Error(`Support files must be UTF-8 text: ${filePath}`);
    }
    totalBytes += sizeBytes;
    if (totalBytes > MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES) {
      throw new Error("Skill proposal support files exceed the total size limit.");
    }
    files.push({
      path: filePath,
      sizeBytes,
      hash: hashSkillProposalContent(file.content),
      content: file.content,
    });
  }
  assertWorkspaceSkillSupportPathSetIsFileOnly(files.map((file) => file.path));
  return files;
}

export function resolveSkillProposalTarget(params: { workspaceDir: string; skillName: string }): {
  skillKey: string;
  skillDir: string;
  skillFile: string;
} {
  const skillKey = normalizeSkillIndexName(params.skillName);
  if (!skillKey) {
    throw new Error("Skill name must contain at least one letter or number.");
  }
  const skillDir = path.resolve(params.workspaceDir, "skills", skillKey);
  const skillFile = path.join(skillDir, "SKILL.md");
  assertInsideWorkspace(params.workspaceDir, skillDir, "skill directory");
  assertInsideWorkspace(params.workspaceDir, skillFile, "skill file");
  return { skillKey, skillDir, skillFile };
}

function isStoredProposalVisible(row: SkillProposalRow, scope: SkillProposalLookupScope): boolean {
  if (!scope.agentId) {
    return scope.workspaceDir
      ? path.resolve(row.workspace_dir) === path.resolve(scope.workspaceDir)
      : true;
  }
  if (row.owner_agent_id === scope.agentId) {
    return true;
  }
  return (
    row.owner_agent_id === null &&
    scope.workspaceDir !== undefined &&
    path.resolve(row.workspace_dir) === path.resolve(scope.workspaceDir)
  );
}

export class SkillProposalDraftMissingError extends Error {
  constructor(
    readonly proposalId: string,
    options?: ErrorOptions,
  ) {
    super(`Skill proposal draft is missing: ${proposalId}. Reject and re-propose it.`, options);
  }
}

export async function readSkillProposal(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
  scope: SkillProposalLookupScope = {},
  readOptions: SkillProposalReadOptions = {},
): Promise<SkillProposalReadResult | null> {
  let stored = readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  if (readOptions.reconcile !== false) {
    await reconcileInterruptedApply(proposalId, options, readOptions.config);
  }
  stored = readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  let draft: ReadResult;
  try {
    draft = await stateRoot.read(path.join(proposalRelativeDir(proposalId), PROPOSAL_DRAFT_FILE), {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_BYTES,
      symlinks: "reject",
    });
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      throw new SkillProposalDraftMissingError(proposalId, { cause: error });
    }
    throw error;
  }
  return {
    record: stored.record,
    revisionHash: hashSkillProposalRevision(stored.record),
    content: draft.buffer.toString("utf8"),
  };
}

export async function readSkillProposalRecord(
  proposalId: string,
  options: SkillWorkshopStoreOptions = {},
  scope: SkillProposalLookupScope = {},
  readOptions: SkillProposalReadOptions = {},
): Promise<SkillProposalRecord | null> {
  let stored = readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  if (readOptions.reconcile !== false) {
    await reconcileInterruptedApply(proposalId, options, readOptions.config);
  }
  stored = readStoredProposal(proposalId, options);
  return stored && isStoredProposalVisible(stored.row, scope) ? stored.record : null;
}

export async function writeSkillProposal(params: {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  workspaceDir: string;
  ownerAgentId?: string;
  maxPending: number;
  event?: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
}): Promise<SkillProposalEvent | undefined> {
  assertProposalId(params.record.id);
  assertSkillProposalContentSize(params.content);
  ensureSkillWorkshopSchema(params.store);
  const stateRoot = await root(resolveSkillWorkshopStateDir(params.store));
  const relativeDir = proposalRelativeDir(params.record.id);
  await stateRoot.mkdir(relativeDir);
  await stateRoot.write(path.join(relativeDir, PROPOSAL_DRAFT_FILE), params.content, {
    encoding: "utf8",
  });
  for (const file of params.supportFiles ?? []) {
    await stateRoot.write(path.join(relativeDir, file.path), file.content, {
      encoding: "utf8",
      mkdir: true,
    });
  }

  try {
    return runOpenClawStateWriteTransaction(
      ({ db }) => {
        const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("skill_workshop_proposals")
            .select("proposal_id")
            .where("proposal_id", "=", params.record.id),
        );
        if (existing) {
          throw new Error(`Skill proposal already exists: ${params.record.id}`);
        }
        const count = executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("skill_workshop_proposals")
            .select((eb) => eb.fn.countAll<number>().as("count"))
            .where("workspace_dir", "=", path.resolve(params.workspaceDir))
            .where("status", "in", ["pending", "quarantined"]),
        );
        if ((count?.count ?? 0) >= params.maxPending) {
          throw new Error(`Skill Workshop pending proposal limit reached (${params.maxPending}).`);
        }
        insertProposal(db, {
          record: params.record,
          ownerAgentId: params.ownerAgentId ?? params.record.origin?.agentId ?? null,
          workspaceDir: params.workspaceDir,
        });
        return params.event ? appendSkillProposalEvent(db, params.event) : undefined;
      },
      databaseOptions(params.store),
      { operationLabel: "skill-workshop.proposal.create" },
    );
  } catch (error) {
    await removePathWithinRoot({
      rootDir: resolveSkillWorkshopStateDir(params.store),
      relativePath: relativeDir,
      recursive: true,
    }).catch(() => undefined);
    throw error;
  }
}

export async function replaceSkillProposalDraft(params: {
  record: SkillProposalRecord;
  previousSupportFiles?: readonly SkillProposalSupportFile[];
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  event?: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
}): Promise<SkillProposalEvent | undefined> {
  assertProposalId(params.record.id);
  assertSkillProposalContentSize(params.content);
  const stateRoot = await root(resolveSkillWorkshopStateDir(params.store));
  const relativeDir = proposalRelativeDir(params.record.id);
  await stateRoot.write(path.join(relativeDir, PROPOSAL_DRAFT_FILE), params.content, {
    encoding: "utf8",
  });
  const nextSupportPaths = new Set<string>();
  for (const file of params.supportFiles ?? []) {
    nextSupportPaths.add(file.path);
    await stateRoot.write(path.join(relativeDir, file.path), file.content, {
      encoding: "utf8",
      mkdir: true,
    });
  }
  for (const file of params.previousSupportFiles ?? []) {
    const filePath = normalizeWorkspaceSkillSupportPath(file.path);
    if (!nextSupportPaths.has(filePath)) {
      await stateRoot.remove(path.join(relativeDir, filePath)).catch(() => undefined);
    }
  }
  return await updateSkillProposalRecord({
    record: params.record,
    store: params.store,
    invalidateRollback: true,
    event: params.event,
  });
}

export async function updateSkillProposalRecord(params: {
  record: SkillProposalRecord;
  store?: SkillWorkshopStoreOptions;
  invalidateRollback?: boolean;
  event?: NewSkillProposalEvent;
}): Promise<SkillProposalEvent | undefined> {
  assertProposalId(params.record.id);
  ensureSkillWorkshopSchema(params.store);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
      const current = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("skill_workshop_proposals")
          .selectAll()
          .where("proposal_id", "=", params.record.id),
      );
      if (!current || !parseSkillProposalRow(current)) {
        throw new Error(`Skill proposal not found: ${params.record.id}`);
      }
      if (params.invalidateRollback) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("skill_workshop_proposal_rollbacks")
            .where("proposal_id", "=", params.record.id),
        );
      }
      updateProposal(db, current, params.record);
      return params.event ? appendSkillProposalEvent(db, params.event) : undefined;
    },
    databaseOptions(params.store),
    { operationLabel: "skill-workshop.proposal.update" },
  );
}

function listStoredProposals(
  options: SkillWorkshopStoreOptions,
  scope: SkillProposalLookupScope,
): Array<{ record: SkillProposalRecord; row: SkillProposalRow }> {
  const { database, kysely } = openSkillWorkshopStore(options);
  let query = kysely.selectFrom("skill_workshop_proposals").selectAll();
  if (scope.agentId) {
    query = query.where((eb) =>
      eb.or([
        eb("owner_agent_id", "=", scope.agentId!),
        ...(scope.workspaceDir
          ? [
              eb.and([
                eb("owner_agent_id", "is", null),
                eb("workspace_dir", "=", path.resolve(scope.workspaceDir)),
              ]),
            ]
          : []),
      ]),
    );
  } else if (scope.workspaceDir) {
    query = query.where("workspace_dir", "=", path.resolve(scope.workspaceDir));
  }
  return executeSqliteQuerySync(
    database.db,
    query.orderBy("updated_at", "desc").orderBy("proposal_id", "asc"),
  ).rows.flatMap((row) => {
    const record = parseSkillProposalRow(row);
    return record ? [{ record, row }] : [];
  });
}

export async function readSkillProposalManifest(
  options: SkillWorkshopStoreOptions = {},
  scope: SkillProposalLookupScope = {},
): Promise<SkillProposalManifest> {
  const before = listStoredProposals(options, scope);
  await Promise.all(
    before
      .filter(({ record }) => record.status === "pending")
      .map(({ record }) => reconcileInterruptedApply(record.id, options)),
  );
  const proposals = listStoredProposals(options, scope).map(({ record, row }) =>
    manifestEntryFromRecord(record, row.workspace_dir, scope.workspaceDir),
  );
  return {
    schema: SKILL_WORKSHOP_MANIFEST_SCHEMA,
    updatedAt: proposals[0]?.updatedAt ?? new Date(0).toISOString(),
    proposals,
  };
}

async function reconcileInterruptedApply(
  proposalId: string,
  options: SkillWorkshopStoreOptions,
  config?: OpenClawConfig,
): Promise<boolean> {
  const stored = readStoredProposal(proposalId, options);
  if (!stored || stored.record.status !== "pending") {
    return false;
  }
  // Avoid acquiring the target lock on ordinary reads. Apply and revise reread
  // proposals while already holding that lock.
  if (!(await readSkillProposalRollback(proposalId, options))) {
    return false;
  }
  let draftContent: string;
  try {
    const stateRoot = await root(resolveSkillWorkshopStateDir(options));
    const draft = await stateRoot.read(
      path.join(proposalRelativeDir(proposalId), PROPOSAL_DRAFT_FILE),
      { hardlinks: "reject", maxBytes: MAX_PROPOSAL_BYTES, symlinks: "reject" },
    );
    draftContent = draft.buffer.toString("utf8");
  } catch {
    return false;
  }
  return await reconcileInterruptedSkillProposalApply({
    record: stored.record,
    expectedRecordJson: stored.row.record_json,
    draftContent,
    workspaceDir: stored.row.workspace_dir,
    ...(config ? { config } : {}),
    store: options,
  });
}

export async function readProposalSupportFiles(
  record: SkillProposalRecord,
  options: SkillWorkshopStoreOptions = {},
): Promise<PreparedSkillProposalSupportFile[]> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  const out: PreparedSkillProposalSupportFile[] = [];
  for (const file of record.supportFiles ?? []) {
    const filePath = normalizeWorkspaceSkillSupportPath(file.path);
    const read = await stateRoot.read(path.join(proposalRelativeDir(record.id), filePath), {
      hardlinks: "reject",
      maxBytes: MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
      symlinks: "reject",
    });
    const content = read.buffer.toString("utf8");
    const sizeBytes = contentSizeBytes(content);
    const hash = hashSkillProposalContent(content);
    if (file.sizeBytes !== sizeBytes || file.hash !== hash) {
      throw new Error(`Proposal support file changed without updating metadata: ${filePath}`);
    }
    out.push({ path: filePath, sizeBytes, hash, content });
  }
  assertWorkspaceSkillSupportPathSetIsFileOnly(out.map((file) => file.path));
  return out;
}

export function importLegacySkillProposal(params: {
  record: SkillProposalRecord;
  rollback?: SkillProposalRollback;
  ownerAgentId?: string;
  workspaceDir: string;
  store?: SkillWorkshopStoreOptions;
}): "imported" | "already-imported" {
  assertProposalId(params.record.id);
  ensureSkillWorkshopSchema(params.store);
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const kysely = getNodeSqliteKysely<SkillWorkshopDatabase>(db);
      const current = executeSqliteQueryTakeFirstSync(
        db,
        kysely
          .selectFrom("skill_workshop_proposals")
          .selectAll()
          .where("proposal_id", "=", params.record.id),
      );
      if (current) {
        const existing = parseSkillProposalRow(current);
        if (
          !existing ||
          existing.draftHash !== params.record.draftHash ||
          existing.target.skillFile !== params.record.target.skillFile
        ) {
          throw new Error(`Legacy skill proposal conflicts with SQLite: ${params.record.id}`);
        }
      } else {
        insertProposal(db, {
          record: params.record,
          ownerAgentId: params.ownerAgentId ?? params.record.origin?.agentId ?? null,
          workspaceDir: params.workspaceDir,
        });
      }
      if (params.rollback) {
        executeSqliteQuerySync(
          db,
          kysely
            .insertInto("skill_workshop_proposal_rollbacks")
            .values({
              proposal_id: params.record.id,
              written_at: params.rollback.writtenAt,
              target_skill_file: params.rollback.targetSkillFile,
              action: params.rollback.action,
              previous_content_hash: params.rollback.previousContentHash ?? null,
              previous_content: params.rollback.previousContent ?? null,
              support_files_json: params.rollback.supportFiles
                ? JSON.stringify(params.rollback.supportFiles)
                : null,
            })
            .onConflict((conflict) => conflict.column("proposal_id").doNothing()),
        );
      }
      return current ? "already-imported" : "imported";
    },
    databaseOptions(params.store),
    { operationLabel: "doctor.skill-workshop.import" },
  );
}

function manifestEntryFromRecord(
  record: SkillProposalRecord,
  boundWorkspaceDir: string,
  currentWorkspaceDir?: string,
): SkillProposalManifestEntry {
  const workspaceMismatch =
    currentWorkspaceDir !== undefined &&
    path.resolve(boundWorkspaceDir) !== path.resolve(currentWorkspaceDir);
  return {
    id: record.id,
    kind: record.kind,
    status: record.status,
    title: record.title,
    description: record.description,
    skillName: record.target.skillName,
    skillKey: record.target.skillKey,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    scanState: record.scan.state,
    ...(workspaceMismatch ? { workspaceMismatch: true } : {}),
  };
}
