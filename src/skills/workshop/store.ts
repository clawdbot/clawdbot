import crypto from "node:crypto";
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { FsSafeError, root, type Root } from "../../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../infra/kysely-sync.js";
import { logWarn } from "../../logger.js";
import { runOpenClawStateWriteTransaction } from "../../state/openclaw-state-db.js";
import { normalizeSkillIndexName } from "../discovery/skill-index.js";
import {
  assertInsideSkillsRoot,
  assertWorkspaceSkillSupportPathSetIsFileOnly,
  MAX_WORKSPACE_SKILL_SUPPORT_FILE_BYTES,
  normalizeWorkspaceSkillSupportPath,
} from "../lifecycle/workspace-skill-write.js";
import {
  cleanupSkillProposalGenerations,
  discardSkillProposalGeneration,
  proposalBundleRelativePath,
  resolveSkillWorkshopStateDir,
  stageSkillProposalGeneration,
} from "./proposal-generation.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { reconcileInterruptedSkillProposalApply } from "./reconcile-transition.js";
import { hashSkillProposalRevision } from "./revision-hash.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
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
  type SkillWorkshopDirectoryStoreOptions,
  type SkillWorkshopDatabase,
  type SkillWorkshopStoreOptions,
} from "./store-sqlite-schema.js";
import {
  commitPendingSkillProposalTransition,
  readCommittedSkillProposalTransition,
} from "./store-sqlite-transition.js";
import { withSkillProposalTargetLock } from "./target-lock.js";
import {
  SKILL_WORKSHOP_MANIFEST_SCHEMA,
  type PreparedSkillProposalSupportFile,
  type SkillProposalManifest,
  type SkillProposalManifestEntry,
  type SkillProposalReadResult,
  type SkillProposalRecord,
  type SkillProposalRollback,
  type SkillProposalSupportFileInput,
  type SkillProposalEvent,
} from "./types.js";

const MAX_PROPOSAL_BYTES = 1024 * 1024;
const MAX_PROPOSAL_SUPPORT_FILES_TOTAL_BYTES = 2 * 1024 * 1024;
export {
  MAX_PROPOSAL_SUPPORT_FILES,
  validateSkillProposalRecord,
  validateSkillProposalRollback,
} from "./store-record.js";
export { hashSkillProposalContent } from "./proposal-hash.js";
export { readSkillProposalRollback };
export { withSkillProposalTargetLock };

type SkillProposalLookupScope = {
  agentId?: string;
};

type SkillProposalReadOptions = {
  config: OpenClawConfig;
  reconcile?: boolean;
};

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

export function resolveSkillProposalTarget(params: {
  skillName: string;
  config: OpenClawConfig;
  agentId: string;
  env?: NodeJS.ProcessEnv;
}): {
  skillKey: string;
  skillDir: string;
  skillFile: string;
} {
  const skillKey = normalizeSkillIndexName(params.skillName);
  if (!skillKey) {
    throw new Error("Skill name must contain at least one letter or number.");
  }
  const skillsRoot = resolveWorkshopSkillsDir(params.config, params.agentId, params.env);
  const skillDir = path.resolve(skillsRoot, skillKey);
  const skillFile = path.join(skillDir, "SKILL.md");
  assertInsideSkillsRoot(skillsRoot, skillDir, "skill directory");
  assertInsideSkillsRoot(skillsRoot, skillFile, "skill file");
  return { skillKey, skillDir, skillFile };
}

function isStoredProposalVisible(row: SkillProposalRow, scope: SkillProposalLookupScope): boolean {
  return row.owner_agent_id !== null && (!scope.agentId || row.owner_agent_id === scope.agentId);
}

export class SkillProposalDraftMissingError extends Error {
  constructor(
    readonly proposalId: string,
    options?: ErrorOptions,
  ) {
    super(
      `Skill proposal draft is missing: ${proposalId}. Run openclaw doctor --fix for recovery.`,
      options,
    );
  }
}

export async function readSkillProposal(
  proposalId: string,
  options: SkillWorkshopDirectoryStoreOptions,
  scope: SkillProposalLookupScope,
  readOptions: SkillProposalReadOptions,
): Promise<SkillProposalReadResult | null> {
  let stored = readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  const scopedOptions = {
    ...options,
    config: readOptions.config,
    ...(scope.agentId
      ? { agentId: scope.agentId }
      : stored.row.owner_agent_id
        ? { agentId: stored.row.owner_agent_id }
        : {}),
  };
  if (readOptions.reconcile === false) {
    return await readSkillProposalBundle(stored.record, options);
  }
  if (await reconcileInterruptedApply(proposalId, scopedOptions)) {
    stored = readStoredProposal(proposalId, options);
    if (!stored || !isStoredProposalVisible(stored.row, scope)) {
      return null;
    }
  }
  return await withSkillProposalTargetLock(
    stored.record,
    async () => {
      const current = readStoredProposal(proposalId, options);
      return current && isStoredProposalVisible(current.row, scope)
        ? await readSkillProposalBundle(current.record, options)
        : null;
    },
    scopedOptions,
  );
}

export async function readSkillProposalRecord(
  proposalId: string,
  options: SkillWorkshopDirectoryStoreOptions,
  scope: SkillProposalLookupScope,
  readOptions: SkillProposalReadOptions,
): Promise<SkillProposalRecord | null> {
  let stored = readStoredProposal(proposalId, options);
  if (!stored || !isStoredProposalVisible(stored.row, scope)) {
    return null;
  }
  const scopedOptions = {
    ...options,
    config: readOptions.config,
    ...(scope.agentId
      ? { agentId: scope.agentId }
      : stored.row.owner_agent_id
        ? { agentId: stored.row.owner_agent_id }
        : {}),
  };
  if (readOptions.reconcile !== false) {
    await reconcileInterruptedApply(proposalId, scopedOptions);
  }
  stored = readStoredProposal(proposalId, options);
  return stored && isStoredProposalVisible(stored.row, scope) ? stored.record : null;
}

export async function writeSkillProposal(params: {
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  ownerAgentId: string;
  maxPending: number;
  event: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
}): Promise<SkillProposalEvent> {
  assertProposalId(params.record.id);
  assertSkillProposalContentSize(params.content);
  ensureSkillWorkshopSchema(params.store);
  await stageSkillProposalGeneration(params);

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
            .where("owner_agent_id", "=", params.ownerAgentId)
            .where("status", "in", ["pending", "quarantined"]),
        );
        if ((count?.count ?? 0) >= params.maxPending) {
          throw new Error(`Skill Workshop pending proposal limit reached (${params.maxPending}).`);
        }
        insertProposal(db, {
          record: params.record,
          ownerAgentId: params.ownerAgentId,
        });
        return appendSkillProposalEvent(db, params.event);
      },
      databaseOptions(params.store),
      { operationLabel: "skill-workshop.proposal.create" },
    );
  } catch (error) {
    const committed = readCommittedSkillProposalTransition({
      record: params.record,
      event: params.event,
      store: params.store,
    });
    if (committed) {
      return committed.event;
    }
    const authoritative = readStoredProposal(params.record.id, params.store);
    if (authoritative?.row.record_json === JSON.stringify(params.record)) {
      throw new Error("Created Skill Workshop proposal is missing its committed event.", {
        cause: error,
      });
    }
    await discardSkillProposalGeneration(params.record, params.store).catch(() => undefined);
    throw error;
  }
}

export async function replaceSkillProposalDraft(params: {
  expected: SkillProposalRecord;
  record: SkillProposalRecord;
  content: string;
  supportFiles?: readonly PreparedSkillProposalSupportFile[];
  event: NewSkillProposalEvent;
  store?: SkillWorkshopStoreOptions;
}): Promise<SkillProposalEvent> {
  assertProposalId(params.record.id);
  assertSkillProposalContentSize(params.content);
  await cleanupSkillProposalGenerations(params.expected, params.store).catch((error: unknown) => {
    logWarn(`skill-workshop: failed to clean unowned proposal generations: ${String(error)}`);
  });
  await stageSkillProposalGeneration(params);

  let commit;
  try {
    commit = commitPendingSkillProposalTransition({
      expected: params.expected,
      record: params.record,
      event: params.event,
      store: params.store,
      operationLabel: "skill-workshop.revision.commit",
      invalidateRollback: true,
    });
  } catch (error) {
    const committed = readCommittedSkillProposalTransition({
      record: params.record,
      event: params.event,
      store: params.store,
    });
    if (!committed) {
      const authoritative = readStoredProposal(params.record.id, params.store);
      if (authoritative?.row.record_json === JSON.stringify(params.record)) {
        throw new Error("Revised Skill Workshop proposal is missing its committed event.", {
          cause: error,
        });
      }
      await discardSkillProposalGeneration(params.record, params.store).catch(() => undefined);
      throw error;
    }
    commit = committed;
  }
  if (commit.state === "conflict") {
    await discardSkillProposalGeneration(params.record, params.store).catch(() => undefined);
    throw new Error("Skill proposal changed before revision commit.");
  }
  await cleanupSkillProposalGenerations(params.record, params.store).catch((error: unknown) => {
    logWarn(`skill-workshop: failed to retire prior proposal generation: ${String(error)}`);
  });
  return commit.event;
}

export async function updateSkillProposalRecord(params: {
  record: SkillProposalRecord;
  ownerAgentId?: string;
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
      // Recovery only visits pending proposals. A dismissal must not strand
      // a partial install, including when its rollback metadata is damaged.
      if (
        current.status === "pending" &&
        (params.record.status === "rejected" || params.record.status === "quarantined") &&
        executeSqliteQueryTakeFirstSync(
          db,
          kysely
            .selectFrom("skill_workshop_proposal_rollbacks")
            .select("proposal_id")
            .where("proposal_id", "=", params.record.id),
        )
      ) {
        throw new Error(
          "Skill proposal has unfinished apply recovery. Run openclaw doctor --fix and restore the files it identifies before retrying.",
        );
      }
      if (params.invalidateRollback) {
        executeSqliteQuerySync(
          db,
          kysely
            .deleteFrom("skill_workshop_proposal_rollbacks")
            .where("proposal_id", "=", params.record.id),
        );
      }
      updateProposal(db, current, params.record, params.ownerAgentId);
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
    query = query.where("owner_agent_id", "=", scope.agentId);
  } else {
    query = query.where("owner_agent_id", "is not", null);
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
  options: SkillWorkshopDirectoryStoreOptions,
  scope: SkillProposalLookupScope = {},
): Promise<SkillProposalManifest> {
  const before = listStoredProposals(options, scope);
  await Promise.all(
    before
      .filter(({ record }) => record.status === "pending")
      .map(({ record, row }) =>
        reconcileInterruptedApply(record.id, {
          ...options,
          ...(scope.agentId
            ? { agentId: scope.agentId }
            : row.owner_agent_id
              ? { agentId: row.owner_agent_id }
              : {}),
        }),
      ),
  );
  const proposals = listStoredProposals(options, scope).map(({ record }) =>
    manifestEntryFromRecord(record),
  );
  return {
    schema: SKILL_WORKSHOP_MANIFEST_SCHEMA,
    updatedAt: proposals[0]?.updatedAt ?? new Date(0).toISOString(),
    proposals,
  };
}

async function reconcileInterruptedApply(
  proposalId: string,
  options: SkillWorkshopDirectoryStoreOptions,
): Promise<boolean> {
  const stored = readStoredProposal(proposalId, options);
  if (!stored || stored.record.status !== "pending" || !options.agentId) {
    return false;
  }
  // Avoid acquiring the target lock on ordinary reads. Apply and revise reread
  // proposals while already holding that lock.
  if (!(await readSkillProposalRollback(proposalId, options))) {
    return false;
  }
  let draftContent: string;
  try {
    draftContent = await readSkillProposalDraft(stored.record, options);
  } catch {
    return false;
  }
  return await reconcileInterruptedSkillProposalApply({
    record: stored.record,
    expectedRecordJson: stored.row.record_json,
    draftContent,
    skillsRoot: resolveWorkshopSkillsDir(options.config, options.agentId, options.env),
    store: options,
  });
}

async function readProposalSupportFiles(
  record: SkillProposalRecord,
  stateRoot: Root,
): Promise<PreparedSkillProposalSupportFile[]> {
  const out: PreparedSkillProposalSupportFile[] = [];
  for (const file of record.supportFiles ?? []) {
    const filePath = normalizeWorkspaceSkillSupportPath(file.path);
    const read = await stateRoot.read(proposalBundleRelativePath(record, filePath), {
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

export async function readSkillProposalDraft(
  record: SkillProposalRecord,
  options: SkillWorkshopStoreOptions,
): Promise<string> {
  const stateRoot = await root(resolveSkillWorkshopStateDir(options));
  try {
    const draft = await stateRoot.read(proposalBundleRelativePath(record, PROPOSAL_DRAFT_FILE), {
      hardlinks: "reject",
      maxBytes: MAX_PROPOSAL_BYTES,
      symlinks: "reject",
    });
    return draft.buffer.toString("utf8");
  } catch (error) {
    if (error instanceof FsSafeError && error.code === "not-found") {
      throw new SkillProposalDraftMissingError(record.id, { cause: error });
    }
    throw error;
  }
}

export async function readSkillProposalBundle(
  record: SkillProposalRecord,
  options: SkillWorkshopStoreOptions,
): Promise<SkillProposalReadResult> {
  const content = await readSkillProposalDraft(record, options);
  const supportFiles = await readProposalSupportFiles(
    record,
    await root(resolveSkillWorkshopStateDir(options)),
  );
  return {
    record,
    revisionHash: hashSkillProposalRevision(record),
    content,
    ...(supportFiles.length > 0 ? { supportFiles } : {}),
  };
}

export function importLegacySkillProposal(params: {
  record: SkillProposalRecord;
  rollback?: SkillProposalRollback;
  ownerAgentId: string;
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
          ownerAgentId: params.ownerAgentId,
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

function manifestEntryFromRecord(record: SkillProposalRecord): SkillProposalManifestEntry {
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
    revisionHash: hashSkillProposalRevision(record),
  };
}
