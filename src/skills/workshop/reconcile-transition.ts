import path from "node:path";
import {
  normalizeWorkspaceSkillSupportPath,
  prepareWorkspaceSkillRestoration,
  readWorkspaceSkillFile,
  readWorkspaceSupportFile,
  restoreWorkspaceSkillMutation,
} from "../lifecycle/workspace-skill-write.js";
import { bumpSkillsSnapshotVersion } from "../runtime/refresh-state.js";
import { stripProposalFrontmatterForSkill } from "./frontmatter.js";
import { createSkillProposalEvent } from "./plugin-hooks.js";
import { hashSkillProposalContent } from "./proposal-hash.js";
import { resolveWorkshopSkillsDir } from "./skills-root.js";
import { readStoredProposal } from "./store-sqlite-record.js";
import { clearSkillProposalRollback, readSkillProposalRollback } from "./store-sqlite-rollback.js";
import type { SkillWorkshopStoreOptions } from "./store-sqlite-schema.js";
import { commitPendingSkillProposalTransition } from "./store-sqlite-transition.js";
import { withSkillProposalCommitLock } from "./target-lock.js";
import type { SkillProposalRecord, SkillProposalRollback } from "./types.js";

export async function reconcileInterruptedSkillProposalApply(params: {
  record: SkillProposalRecord;
  expectedRecordJson: string;
  draftContent: string;
  store?: SkillWorkshopStoreOptions;
}): Promise<boolean> {
  return await withSkillProposalCommitLock(
    params.record,
    async () => {
      const stored = readStoredProposal(params.record.id, params.store);
      if (
        !stored ||
        stored.record.status !== "pending" ||
        stored.row.record_json !== params.expectedRecordJson
      ) {
        return false;
      }
      const rollback = await readSkillProposalRollback(params.record.id, params.store);
      if (!rollback || !resolveRecoveryRollback(stored.record, rollback)) {
        return false;
      }
      if (hashSkillProposalContent(params.draftContent) !== stored.record.draftHash) {
        return false;
      }
      let proposedContent: string;
      try {
        proposedContent = stripProposalFrontmatterForSkill(params.draftContent);
      } catch {
        return false;
      }
      const recovery = await inspectInterruptedApplyState({
        record: stored.record,
        rollback,
        proposedContent,
      }).catch(() => null);
      if (!recovery) {
        return false;
      }
      if (recovery.state === "proposed") {
        const now = new Date().toISOString();
        const applied: SkillProposalRecord = {
          ...stored.record,
          status: "applied",
          updatedAt: now,
          appliedAt: now,
        };
        const commit = commitPendingSkillProposalTransition({
          expected: stored.record,
          record: applied,
          event: createSkillProposalEvent({
            record: applied,
            type: "applied",
            occurredAt: now,
            payload: { recovered: true },
          }),
          store: params.store,
          operationLabel: "skill-workshop.apply.reconcile",
        });
        if (commit.state !== "committed") {
          return false;
        }
        bumpSkillsSnapshotVersion({
          reason: "workshop",
          changedPath: stored.record.target.skillFile,
        });
        return true;
      }
      if (recovery.state === "partial") {
        const restoration = await prepareWorkspaceSkillRestoration({
          skillsRoot: resolveStoreWorkshopSkillsDir(params.store),
          skillDir: stored.record.target.skillDir,
          skillFile: stored.record.target.skillFile,
          previousContent: rollback.previousContent ?? null,
          proposedContentHash: hashSkillProposalContent(proposedContent),
          supportFiles: recovery.supportFiles,
          mode: stored.record.kind,
        });
        try {
          await restoreWorkspaceSkillMutation(restoration);
        } finally {
          // Restoration attempts can partially succeed before reporting an
          // aggregate error, so invalidate readers even on a failed recovery.
          bumpSkillsSnapshotVersion({
            reason: "workshop",
            changedPath: stored.record.target.skillFile,
          });
        }
      }
      return await clearSkillProposalRollback({
        proposalId: stored.record.id,
        expectedRecordJson: params.expectedRecordJson,
        store: params.store,
      });
    },
    params.store,
  ).catch(() => false);
}

function resolveStoreWorkshopSkillsDir(store: SkillWorkshopStoreOptions | undefined): string {
  if (!store?.agentId) {
    throw new Error("Skill Workshop recovery requires the active agent id.");
  }
  return resolveWorkshopSkillsDir(store.config ?? {}, store.agentId, store.env);
}

type SkillProposalRecoverySupportFile = {
  path: string;
  previousContent: string | null;
  proposedContentHash: string;
};

function resolveRecoveryRollback(
  record: SkillProposalRecord,
  rollback: SkillProposalRollback,
): SkillProposalRollback | null {
  if (
    rollback.proposalId !== record.id ||
    rollback.action !== record.kind ||
    path.resolve(rollback.targetSkillFile) !== path.resolve(record.target.skillFile)
  ) {
    return null;
  }
  if (record.kind === "create") {
    if (rollback.previousContent !== undefined || rollback.previousContentHash !== undefined) {
      return null;
    }
  } else if (
    rollback.previousContent === undefined ||
    rollback.previousContentHash === undefined ||
    hashSkillProposalContent(rollback.previousContent) !== rollback.previousContentHash
  ) {
    return null;
  }
  const proposedSupport = new Map(
    (record.supportFiles ?? []).map((file) => [file.path, file] as const),
  );
  const rollbackSupport = new Set<string>();
  for (const file of rollback.supportFiles ?? []) {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeWorkspaceSkillSupportPath(file.path);
    } catch {
      return null;
    }
    if (
      normalizedPath !== file.path ||
      !proposedSupport.has(normalizedPath) ||
      rollbackSupport.has(normalizedPath) ||
      (file.existed &&
        (file.previousContent === undefined ||
          file.previousContentHash === undefined ||
          hashSkillProposalContent(file.previousContent) !== file.previousContentHash)) ||
      (!file.existed &&
        (file.previousContent !== undefined || file.previousContentHash !== undefined))
    ) {
      return null;
    }
    rollbackSupport.add(normalizedPath);
  }
  if ([...proposedSupport.keys()].some((filePath) => !rollbackSupport.has(filePath))) {
    return null;
  }
  return rollback;
}

async function inspectInterruptedApplyState(params: {
  record: SkillProposalRecord;
  rollback: SkillProposalRollback;
  proposedContent: string;
}): Promise<{
  state: "previous" | "proposed" | "partial";
  supportFiles: SkillProposalRecoverySupportFile[];
}> {
  const currentContent = await readWorkspaceSkillFile(params.record.target.skillFile);
  const mainState = classifyRecoveryFileState({
    currentContent,
    previousContent: params.rollback.previousContent ?? null,
    proposedHash: hashSkillProposalContent(params.proposedContent),
  });
  if (!mainState) {
    throw new Error("Interrupted Skill Workshop apply target does not match recovery facts.");
  }
  const rollbackSupport = new Map(
    (params.rollback.supportFiles ?? []).map((file) => [file.path, file] as const),
  );
  const supportFiles: SkillProposalRecoverySupportFile[] = [];
  const supportStates: Array<"previous" | "proposed"> = [];
  for (const file of params.record.supportFiles ?? []) {
    const rollbackFile = rollbackSupport.get(file.path);
    if (!rollbackFile) {
      throw new Error(`Missing rollback facts for support file: ${file.path}`);
    }
    const currentSupportContent = await readWorkspaceSupportFile({
      skillDir: params.record.target.skillDir,
      relativePath: file.path,
    });
    const previousSupportContent = rollbackFile.previousContent ?? null;
    const state = classifyRecoveryFileState({
      currentContent: currentSupportContent,
      previousContent: previousSupportContent,
      proposedHash: file.hash,
    });
    if (!state) {
      throw new Error(
        `Interrupted Skill Workshop support target does not match recovery facts: ${file.path}`,
      );
    }
    supportStates.push(state);
    supportFiles.push({
      path: file.path,
      previousContent: previousSupportContent,
      proposedContentHash: file.hash,
    });
  }
  const states = [mainState, ...supportStates];
  return {
    state: states.every((state) => state === "proposed")
      ? "proposed"
      : states.every((state) => state === "previous")
        ? "previous"
        : "partial",
    supportFiles,
  };
}

function classifyRecoveryFileState(params: {
  currentContent: string | null;
  previousContent: string | null;
  proposedHash: string;
}): "previous" | "proposed" | null {
  if (params.currentContent === params.previousContent) {
    return "previous";
  }
  if (
    params.currentContent !== null &&
    hashSkillProposalContent(params.currentContent) === params.proposedHash
  ) {
    return "proposed";
  }
  return null;
}
