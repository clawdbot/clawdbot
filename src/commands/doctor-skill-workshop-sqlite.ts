/** Doctor-owned migration of Skill Workshop proposal metadata into shared SQLite. */
import path from "node:path";
import {
  listAgentIds,
  resolveAgentWorkspaceDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { removePathWithinRoot } from "../infra/fs-safe-remove.js";
import { pathExists, root, type Root } from "../infra/fs-safe.js";
import { normalizeAgentId, resolveAgentIdFromSessionKey } from "../routing/session-key.js";
import {
  hashSkillProposalContent,
  importLegacySkillProposal,
  parseSkillProposalRecord,
  parseSkillProposalRollback,
  readSkillProposalRecord,
  readSkillProposalRollback,
} from "../skills/workshop/store.js";
import type { SkillProposalRecord, SkillProposalRollback } from "../skills/workshop/types.js";

const WORKSHOP_DIR = "skill-workshop";
const PROPOSALS_DIR = `${WORKSHOP_DIR}/proposals`;
const MANIFEST_PATH = `${WORKSHOP_DIR}/proposals.json`;
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

function isNotFoundError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "not-found" || code === "ENOENT";
}

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

function configuredAgentIds(config: OpenClawConfig): string[] {
  return [
    ...new Set([resolveDefaultAgentId(config), ...listAgentIds(config)].map(normalizeAgentId)),
  ];
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
    try {
      return resolveAgentIdFromSessionKey(
        params.record.origin.sessionKey,
        resolveDefaultAgentId(params.config),
      );
    } catch {
      // Fall through to the workspace and single-agent evidence below.
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
    const rollback = parseSkillProposalRollback(
      await readJson(stateRoot, `${PROPOSALS_DIR}/${proposalId}/rollback.json`, MAX_ROLLBACK_BYTES),
    );
    if (!rollback || rollback.proposalId !== proposalId) {
      throw new Error("invalid rollback metadata");
    }
    return rollback;
  } catch (error) {
    if (isNotFoundError(error)) {
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
  const imported = await readSkillProposalRecord(params.record.id, { env: params.env });
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
  const record = parseSkillProposalRecord(
    await readJson(params.stateRoot, `${proposalDir}/proposal.json`, MAX_RECORD_BYTES),
  );
  if (!record || record.id !== params.proposalId) {
    throw new Error("invalid proposal metadata");
  }
  const draft = await params.stateRoot.read(`${proposalDir}/PROPOSAL.md`, {
    hardlinks: "reject",
    maxBytes: MAX_RECORD_BYTES,
    symlinks: "reject",
  });
  if (hashSkillProposalContent(draft.buffer.toString("utf8")) !== record.draftHash) {
    throw new Error("proposal draft hash does not match proposal metadata");
  }
  const rollback = await readLegacyRollback(params.stateRoot, params.proposalId);
  const workspaceDir = proposalWorkspace(record);
  const ownerAgentId = inferOwnerAgentId({
    config: params.config,
    env: params.env,
    record,
    workspaceDir,
  });
  if (!ownerAgentId) {
    throw new Error(
      "owning agent could not be inferred; legacy metadata was retained for manual recovery",
    );
  }
  const result = importLegacySkillProposal({
    record,
    rollback,
    ownerAgentId,
    workspaceDir,
    store: { env: params.env },
  });
  await verifyImportedProposal({ env: params.env, record, rollback });
  if (rollback) {
    await params.stateRoot.remove(`${proposalDir}/rollback.json`);
  }
  await params.stateRoot.remove(`${proposalDir}/proposal.json`);
  return result;
}

/** Import verified legacy proposal sidecars, then remove only the imported JSON metadata. */
export async function migrateLegacySkillWorkshopProposals(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<MigrationResult> {
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env);
  if (!(await pathExists(path.join(stateDir, PROPOSALS_DIR)))) {
    if (!(await pathExists(path.join(stateDir, MANIFEST_PATH)))) {
      return { changes: [], warnings: [], detected: 0, migrated: 0 };
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
  let migrated = 0;
  for (const proposalId of proposalIds) {
    try {
      await migrateProposal({
        config: params.config,
        env,
        proposalId,
        stateRoot,
      });
      migrated += 1;
    } catch (error) {
      if (isNotFoundError(error)) {
        if (await readSkillProposalRecord(proposalId, { env })) {
          continue;
        }
      }
      warnings.push(`Failed to migrate Skill Workshop proposal ${proposalId}: ${String(error)}`);
    }
  }
  await removePathWithinRoot({ rootDir: stateDir, relativePath: MANIFEST_PATH }).catch(
    (error: unknown) => {
      if (!isNotFoundError(error)) {
        warnings.push(`Failed to remove legacy Skill Workshop proposal index: ${String(error)}`);
      }
    },
  );
  return {
    changes:
      migrated > 0
        ? [
            `Migrated ${migrated} Skill Workshop proposal${migrated === 1 ? "" : "s"} into shared SQLite.`,
          ]
        : [],
    warnings,
    detected: proposalIds.length,
    migrated,
  };
}
